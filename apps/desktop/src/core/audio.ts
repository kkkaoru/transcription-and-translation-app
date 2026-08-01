import { DEFAULT_AUDIO_CHUNK_MS, DEFAULT_SILENCE_GATE_DB } from "./defaults";
import type { AudioChunk, AudioInputDevice } from "./types";

/** Parapper / Rust pipeline expects mono PCM at this rate regardless of hardware. */
export const TARGET_SAMPLE_RATE = 16_000;

export const enumerateAudioInputDevices = async (): Promise<AudioInputDevice[]> => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  // Only surface real browser deviceIds. Fabricated IDs (e.g. "audio-input-1")
  // break getUserMedia when used with { exact: deviceId }. The UI always offers
  // an explicit "default" option for the system microphone.
  return devices
    .filter((device) => device.kind === "audioinput" && device.deviceId)
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      groupId: device.groupId,
    }));
};

export const resampleLinear = (
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array => {
  if (samples.length === 0) {
    return samples.slice();
  }
  // Invalid rates must not yield Infinity/NaN buffer sizes (WKWebView throws on huge allocs).
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    throw new Error(
      `invalid sample rate for resample: from=${String(fromRate)} to=${String(toRate)}`,
    );
  }
  if (fromRate === toRate) {
    return samples.slice();
  }
  const outputLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const output = new Float32Array(outputLength);
  const ratio = fromRate / toRate;
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * ratio;
    const left = Math.floor(sourcePosition);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = sourcePosition - left;
    /* c8 ignore next -- valid typed-array positions are always numeric. */
    output[index] = (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
  }
  return output;
};

export const float32ToPcm16 = (samples: Float32Array): Int16Array => {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    /* c8 ignore next -- the loop bounds guarantee a valid typed-array position. */
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  // Keep chunks modest: WKWebView / JSC rejects very large apply/spread arg lists.
  // Copy into a plain number[] so apply() never depends on TypedArray array-like support.
  const step = 0x2000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += step) {
    const slice = bytes.subarray(offset, Math.min(offset + step, bytes.length));
    const codes: number[] = new Array(slice.length);
    for (let index = 0; index < slice.length; index += 1) {
      codes[index] = slice[index] ?? 0;
    }
    binary += String.fromCharCode.apply(null, codes);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  throw new Error("base64 encoding is unavailable in this runtime");
};

export const pcm16ToBase64 = (samples: Int16Array): string =>
  bytesToBase64(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));

const clampDurationMs = (samplesLength: number, durationMs: number): number => {
  if (samplesLength === 0) {
    return 0;
  }
  const nominal = Number.isFinite(durationMs) ? durationMs : 1;
  // Rust pcm_base64_to_wav rejects duration_ms outside 1..=10_000.
  return Math.max(1, Math.min(10_000, Math.round(nominal)));
};

/**
 * Encode a float mono buffer as a mono 16 kHz PCM16 base64 chunk for the
 * Tauri pipeline. Hardware rates (e.g. 48 kHz AudioContext) are always
 * resampled — the `sampleRate` field on the chunk is never the hardware rate.
 */
export const makeAudioChunk = (
  samples: Float32Array,
  inputSampleRate: number,
  durationMs = Math.round((samples.length / Math.max(inputSampleRate, 1)) * 1000),
): AudioChunk => {
  const safeRate =
    Number.isFinite(inputSampleRate) && inputSampleRate > 0 ? inputSampleRate : TARGET_SAMPLE_RATE;
  return {
    pcmBase64: pcm16ToBase64(float32ToPcm16(resampleLinear(samples, safeRate, TARGET_SAMPLE_RATE))),
    sampleRate: TARGET_SAMPLE_RATE,
    channels: 1,
    durationMs: clampDurationMs(samples.length, durationMs),
  };
};

export const calculateRmsDb = (samples: Float32Array): number => {
  if (samples.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms <= Number.EPSILON ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
};

/** Peak absolute amplitude in a mono float buffer (0…1). */
export const calculatePeak = (samples: Float32Array): number => {
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) {
      peak = magnitude;
    }
  }
  return peak;
};

/**
 * Soft peak normalize for quiet-but-audible speech that already passed the
 * silence gate. Ambient noise is filtered before this runs; here we only lift
 * low speech peaks toward a modest target so Parapper is less likely to drop
 * short/quiet utterances as no-speech.
 *
 * Does not amplify when already near target peak, and caps gain to avoid
 * turning residual noise into harsh clipping.
 */
export const applyPeakNormalize = (
  samples: Float32Array,
  targetPeak = 0.35,
  maxGain = 8,
): { samples: Float32Array; gain: number; peak: number } => {
  const peak = calculatePeak(samples);
  if (!(peak > 1e-6) || !(targetPeak > 0) || peak >= targetPeak) {
    return { samples, gain: 1, peak };
  }
  const gain = Math.min(maxGain, targetPeak / peak);
  if (!(gain > 1.05)) {
    return { samples, gain: 1, peak };
  }
  const output = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    /* c8 ignore next -- loop bounds guarantee a valid typed-array position. */
    const value = (samples[index] ?? 0) * gain;
    output[index] = Math.max(-1, Math.min(1, value));
  }
  return { samples: output, gain, peak };
};

/** True when RMS is loud enough to enqueue (not ambient / digital silence). */
export const passesSilenceGate = (
  rmsDb: number,
  gateDb: number = DEFAULT_SILENCE_GATE_DB,
): boolean => Number.isFinite(rmsDb) && rmsDb >= gateDb;

export type MicrophoneConstraintMode =
  | "exact-device-raw"
  | "ideal-device-raw"
  | "default-raw"
  | "default-relaxed";

export type CreateMicrophoneConstraintsOptions = {
  /** Prefer { ideal } over { exact } for the selected deviceId. */
  idealDevice?: boolean;
  /** Omit echoCancellation/noiseSuppression/autoGainControl overrides. */
  relaxProcessing?: boolean;
};

/**
 * Build getUserMedia constraints. Prefer raw mono capture when the platform allows it;
 * callers should progressively fall back via {@link openMicrophoneStream}.
 */
export const createMicrophoneConstraints = (
  deviceId: string,
  options: CreateMicrophoneConstraintsOptions = {},
): MediaStreamConstraints => {
  const audio: MediaTrackConstraints = {
    channelCount: { ideal: 1 },
  };

  if (deviceId && deviceId !== "default") {
    audio.deviceId = options.idealDevice ? { ideal: deviceId } : { exact: deviceId };
  }

  if (!options.relaxProcessing) {
    // Prefer unprocessed PCM for ASR (no AEC/NS coloring), but keep browser AGC
    // so quiet mics are not stuck at ~-54 dBFS ambient (Parapper transcript_missing).
    // Some WebViews reject these flags — callers must fall back with
    // relaxProcessing: true on OverconstrainedError.
    audio.echoCancellation = false;
    audio.noiseSuppression = false;
    audio.autoGainControl = true;
  }

  return {
    audio,
    video: false,
  };
};

/** Ordered constraint strategies used when opening a microphone. */
export const microphoneConstraintStrategies = (
  deviceId: string,
): Array<{ mode: MicrophoneConstraintMode; constraints: MediaStreamConstraints }> => {
  const strategies: Array<{ mode: MicrophoneConstraintMode; constraints: MediaStreamConstraints }> =
    [];
  if (deviceId && deviceId !== "default") {
    strategies.push({
      mode: "exact-device-raw",
      constraints: createMicrophoneConstraints(deviceId),
    });
    strategies.push({
      mode: "ideal-device-raw",
      constraints: createMicrophoneConstraints(deviceId, { idealDevice: true }),
    });
  }
  strategies.push({
    mode: "default-raw",
    constraints: createMicrophoneConstraints("default"),
  });
  strategies.push({
    mode: "default-relaxed",
    constraints: createMicrophoneConstraints("default", { relaxProcessing: true }),
  });
  return strategies;
};

const isConstraintFailure = (error: unknown): boolean => {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return (
      error.name === "OverconstrainedError" ||
      error.name === "NotFoundError" ||
      error.name === "NotReadableError" ||
      error.name === "TypeError"
    );
  }
  return error instanceof TypeError;
};

/**
 * Open a microphone with progressive constraint relaxation so stale deviceIds and
 * unsupported raw-audio flags do not hard-fail capture on Tauri/WKWebView.
 */
export const openMicrophoneStream = async (
  deviceId: string,
): Promise<{ stream: MediaStream; mode: MicrophoneConstraintMode }> => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new AudioCaptureError("microphone-unavailable");
  }

  const strategies = microphoneConstraintStrategies(deviceId);
  let lastError: unknown;

  for (let index = 0; index < strategies.length; index += 1) {
    const strategy = strategies[index];
    if (!strategy) {
      continue;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(strategy.constraints);
      return { stream, mode: strategy.mode };
    } catch (error) {
      lastError = error;
      const hasMore = index < strategies.length - 1;
      // Permission / busy failures must surface immediately — further strategies
      // will not help and may re-prompt or hang.
      if (!hasMore || !isConstraintFailure(error)) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new AudioCaptureError("microphone-unavailable", lastError);
};

export type AudioCaptureErrorCode =
  | "audio-context-failed"
  | "microphone-unavailable"
  | "microphone-track-ended"
  | "audio-context-suspended";

export class AudioCaptureError extends Error {
  public readonly code: AudioCaptureErrorCode;
  public readonly causeError?: unknown;

  public constructor(code: AudioCaptureErrorCode, cause?: unknown) {
    const detail =
      cause instanceof Error && cause.message
        ? `${code}: ${cause.message}`
        : typeof cause === "string" && cause.trim()
          ? `${code}: ${cause.trim()}`
          : code;
    super(detail);
    this.name = "AudioCaptureError";
    this.code = code;
    this.causeError = cause;
  }
}

export type AudioCaptureMode = "worklet" | "script-processor" | "none";

export type AudioCaptureDiagnostics = {
  active: boolean;
  captureMode: AudioCaptureMode;
  constraintMode: MicrophoneConstraintMode | null;
  contextState: string | null;
  sampleRate: number | null;
  trackReadyState: string | null;
  trackLabel: string | null;
  trackMuted: boolean | null;
  deviceIdRequested: string | null;
  /** Most recent RMS level in dBFS while capturing; null when idle. */
  lastRmsDb: number | null;
  /** RMS of the last chunk that passed the silence gate (pre-normalize). */
  lastAcceptedRmsDb: number | null;
  /** Soft peak-normalize gain applied to the last accepted chunk (1 = none). */
  lastAcceptedGain: number | null;
  chunksAccepted: number;
  chunksDroppedSilent: number;
  lastError: string | null;
  lastErrorCode: AudioCaptureErrorCode | string | null;
  lastErrorAt: string | null;
};

const emptyDiagnostics = (): AudioCaptureDiagnostics => ({
  active: false,
  captureMode: "none",
  constraintMode: null,
  contextState: null,
  sampleRate: null,
  trackReadyState: null,
  trackLabel: null,
  trackMuted: null,
  deviceIdRequested: null,
  lastRmsDb: null,
  lastAcceptedRmsDb: null,
  lastAcceptedGain: null,
  chunksAccepted: 0,
  chunksDroppedSilent: 0,
  lastError: null,
  lastErrorCode: null,
  lastErrorAt: null,
});

/** Module-level snapshot for the Debug panel (survives component remounts). */
let lastCaptureDiagnostics: AudioCaptureDiagnostics = emptyDiagnostics();

export const getLastAudioCaptureDiagnostics = (): AudioCaptureDiagnostics => ({
  ...lastCaptureDiagnostics,
});

export const formatAudioCaptureDiagnostics = (
  diagnostics: AudioCaptureDiagnostics = lastCaptureDiagnostics,
): string => {
  const parts = [
    diagnostics.lastError ? `error=${diagnostics.lastError}` : null,
    diagnostics.captureMode !== "none" ? `mode=${diagnostics.captureMode}` : null,
    diagnostics.constraintMode ? `constraints=${diagnostics.constraintMode}` : null,
    diagnostics.contextState ? `context=${diagnostics.contextState}` : null,
    diagnostics.sampleRate ? `sr=${diagnostics.sampleRate}` : null,
    // Encode target is always TARGET_SAMPLE_RATE; hardware sr may differ (e.g. 48k).
    diagnostics.active ? `encodeSr=${TARGET_SAMPLE_RATE}` : null,
    diagnostics.trackReadyState ? `track=${diagnostics.trackReadyState}` : null,
    diagnostics.trackMuted === true ? "muted" : null,
    diagnostics.lastRmsDb !== null && Number.isFinite(diagnostics.lastRmsDb)
      ? `rms=${diagnostics.lastRmsDb.toFixed(1)}dB`
      : null,
    diagnostics.lastAcceptedRmsDb !== null && Number.isFinite(diagnostics.lastAcceptedRmsDb)
      ? `acceptedRms=${diagnostics.lastAcceptedRmsDb.toFixed(1)}dB`
      : null,
    diagnostics.lastAcceptedGain !== null &&
    Number.isFinite(diagnostics.lastAcceptedGain) &&
    diagnostics.lastAcceptedGain > 1.05
      ? `gain=${diagnostics.lastAcceptedGain.toFixed(2)}x`
      : null,
    diagnostics.chunksAccepted > 0 ? `chunks=${diagnostics.chunksAccepted}` : null,
    diagnostics.chunksDroppedSilent > 0 ? `silent=${diagnostics.chunksDroppedSilent}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
};

/**
 * Briefly open the default microphone so the OS grants permission and
 * `enumerateDevices` can return stable deviceIds + labels. The temporary
 * stream is stopped immediately.
 */
export const ensureMicrophoneAccess = async (): Promise<MicrophoneConstraintMode> => {
  const { stream, mode } = await openMicrophoneStream("default");
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
  return mode;
};

/** Map dBFS (-80…0) to a 0–1 UI level meter fill. */
export const rmsDbToMeterLevel = (db: number | null | undefined): number => {
  if (db === null || db === undefined || !Number.isFinite(db)) {
    return 0;
  }
  const floor = -60;
  const ceiling = -6;
  if (db <= floor) {
    return 0;
  }
  if (db >= ceiling) {
    return 1;
  }
  return (db - floor) / (ceiling - floor);
};

const createAudioContext = (): AudioContext => {
  const AudioContextCtor =
    typeof AudioContext === "function"
      ? AudioContext
      : (
          globalThis as typeof globalThis & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;
  if (typeof AudioContextCtor !== "function") {
    throw new AudioCaptureError("audio-context-failed");
  }

  try {
    return new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    return new AudioContextCtor();
  }
};

type ChunkHandler = (chunk: AudioChunk) => void | Promise<void>;
type CaptureErrorHandler = (error: AudioCaptureError) => void;
type LevelHandler = (rmsDb: number) => void;

const toCaptureError = (error: unknown): AudioCaptureError => {
  if (error instanceof AudioCaptureError) {
    return error;
  }
  const micFailure =
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    (error.name === "NotAllowedError" ||
      error.name === "SecurityError" ||
      error.name === "NotFoundError" ||
      error.name === "NotReadableError" ||
      error.name === "OverconstrainedError" ||
      error.name === "AbortError");
  return new AudioCaptureError(
    micFailure ? "microphone-unavailable" : "audio-context-failed",
    error,
  );
};

/* c8 ignore start -- browser/Tauri media graph; pure PCM functions are covered below. */
export class MicrophoneCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private pending = new Float32Array(0);
  private handler: ChunkHandler | null = null;
  private errorHandler: CaptureErrorHandler | null = null;
  private levelHandler: LevelHandler | null = null;
  private chunkMs = DEFAULT_AUDIO_CHUNK_MS;
  private silenceGateDb = DEFAULT_SILENCE_GATE_DB;
  private captureMode: AudioCaptureMode = "none";
  private constraintMode: MicrophoneConstraintMode | null = null;
  private deviceIdRequested: string | null = null;
  private trackEndedListener: (() => void) | null = null;
  private disposed = false;
  private lastRmsDb: number | null = null;
  private lastAcceptedRmsDb: number | null = null;
  private lastAcceptedGain: number | null = null;
  private chunksAccepted = 0;
  private chunksDroppedSilent = 0;
  private levelEmitAt = 0;
  /** True once getUserMedia + AudioContext are held and ready for graph wiring. */
  private hardwareReady = false;

  public getDiagnostics(): AudioCaptureDiagnostics {
    const track = this.stream?.getAudioTracks()[0] ?? null;
    return {
      active: this.stream !== null && this.context !== null && !this.disposed,
      captureMode: this.captureMode,
      constraintMode: this.constraintMode,
      contextState: this.context?.state ?? null,
      sampleRate: this.context?.sampleRate ?? null,
      trackReadyState: track?.readyState ?? null,
      trackLabel: track?.label || null,
      trackMuted: track ? track.muted : null,
      deviceIdRequested: this.deviceIdRequested,
      lastRmsDb: this.lastRmsDb,
      lastAcceptedRmsDb: this.lastAcceptedRmsDb,
      lastAcceptedGain: this.lastAcceptedGain,
      chunksAccepted: this.chunksAccepted,
      chunksDroppedSilent: this.chunksDroppedSilent,
      lastError: lastCaptureDiagnostics.lastError,
      lastErrorCode: lastCaptureDiagnostics.lastErrorCode,
      lastErrorAt: lastCaptureDiagnostics.lastErrorAt,
    };
  }

  /**
   * Create (and kick off resume of) an AudioContext under a user gesture.
   * Call this synchronously from a click handler before long backend awaits —
   * WKWebView often leaves contexts suspended when resume() runs only after
   * multi-second sidecar/model startup.
   */
  public primeAudioContext(): void {
    this.disposed = false;
    if (this.context && this.context.state !== "closed") {
      if (this.context.state === "suspended") {
        void this.context.resume().catch(() => undefined);
      }
      return;
    }
    this.context = createAudioContext();
    if (this.context.state === "suspended") {
      void this.context.resume().catch(() => undefined);
    }
  }

  /**
   * Open the microphone and ensure AudioContext is running. Safe to call after
   * releasing a previous capture session; may be overlapped with backend prep.
   */
  public async prepareInput(deviceId: string): Promise<void> {
    this.disposed = false;
    const previousDeviceId = this.deviceIdRequested;
    this.deviceIdRequested = deviceId;

    try {
      this.primeAudioContext();
      await this.ensureContextRunning();

      const liveTrack = this.stream?.getAudioTracks()[0];
      const reusable =
        this.hardwareReady &&
        this.stream !== null &&
        liveTrack?.readyState === "live" &&
        previousDeviceId === deviceId;
      if (!reusable) {
        // Drop any stale stream before requesting a new one.
        this.unbindTrackEnded();
        for (const track of this.stream?.getTracks() ?? []) {
          try {
            track.stop();
          } catch {
            // ignore
          }
        }
        this.stream = null;
        this.hardwareReady = false;

        const opened = await openMicrophoneStream(deviceId);
        if (this.disposed) {
          for (const track of opened.stream.getTracks()) {
            try {
              track.stop();
            } catch {
              // ignore
            }
          }
          throw new AudioCaptureError(
            "microphone-unavailable",
            "capture was cancelled while opening the microphone",
          );
        }
        this.stream = opened.stream;
        this.constraintMode = opened.mode;
        this.bindTrackEnded(this.stream);
        this.hardwareReady = true;
      }

      // getUserMedia is async — re-assert running after the gap.
      await this.ensureContextRunning();
      this.publishDiagnostics(null);
    } catch (error) {
      const captureError = toCaptureError(error);
      this.publishDiagnostics(captureError);
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  public async start(
    deviceId: string,
    chunkMs: number,
    silenceGateDb: number,
    handler: ChunkHandler,
    onError?: CaptureErrorHandler,
    onLevel?: LevelHandler,
  ): Promise<void> {
    this.disposed = false;
    this.handler = handler;
    this.errorHandler = onError ?? null;
    this.levelHandler = onLevel ?? null;
    this.chunkMs = chunkMs;
    this.silenceGateDb = silenceGateDb;
    this.lastRmsDb = null;
    this.lastAcceptedRmsDb = null;
    this.lastAcceptedGain = null;
    this.chunksAccepted = 0;
    this.chunksDroppedSilent = 0;
    this.levelEmitAt = 0;
    this.pending = new Float32Array(0);

    try {
      const liveTrack = this.stream?.getAudioTracks()[0];
      const prepared =
        this.hardwareReady &&
        this.stream !== null &&
        this.context !== null &&
        this.context.state !== "closed" &&
        liveTrack?.readyState === "live" &&
        this.deviceIdRequested === deviceId;

      if (!prepared) {
        // Standalone start() path (tests / callers that skip prepareInput).
        this.teardownGraphNodes();
        this.source = null;
        await this.prepareInput(deviceId);
      } else {
        // Reuse hardware from prepareInput; clear any half-wired graph.
        this.teardownGraphNodes();
        this.source = null;
        this.deviceIdRequested = deviceId;
      }

      if (!this.context || !this.stream) {
        throw new AudioCaptureError("microphone-unavailable");
      }

      this.source = this.context.createMediaStreamSource(this.stream);

      // Prefer AudioWorklet, but CSP / WebView restrictions on blob: modules are common
      // in Tauri. Fall back to ScriptProcessor so capture still works.
      let started = false;
      if (this.context.audioWorklet) {
        try {
          await this.startWorklet();
          this.captureMode = "worklet";
          started = true;
        } catch {
          this.teardownGraphNodes();
          this.source = this.context.createMediaStreamSource(this.stream);
        }
      }
      if (!started) {
        this.startScriptProcessor();
        this.captureMode = "script-processor";
      }

      await this.ensureContextRunning();
      this.publishDiagnostics(null);
    } catch (error) {
      // Keep the original rejection (DOMException names, etc.) so the UI can map
      // NotAllowedError / NotFoundError. Only synthesize AudioCaptureError when
      // the failure has no browser-native type.
      this.publishDiagnostics(toCaptureError(error));
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.disposed = true;
    this.handler = null;
    this.errorHandler = null;
    this.levelHandler = null;
    this.hardwareReady = false;
    this.unbindTrackEnded();
    this.teardownGraphNodes();

    for (const track of this.stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // Ignore double-stop / already-ended tracks.
      }
    }

    const context = this.context;
    this.context = null;
    this.stream = null;
    this.source = null;
    this.captureMode = "none";
    this.constraintMode = null;
    this.deviceIdRequested = null;
    this.pending = new Float32Array(0);
    this.lastRmsDb = null;
    this.lastAcceptedRmsDb = null;
    this.lastAcceptedGain = null;

    if (context) {
      try {
        if (context.state !== "closed") {
          await context.close();
        }
      } catch {
        // Closing a partially torn-down context must not block stop().
      }
    }

    this.publishDiagnostics(lastCaptureDiagnostics.lastErrorCode ? undefined : null);
  }

  private async ensureContextRunning(): Promise<void> {
    if (!this.context || this.context.state === "closed") {
      throw new AudioCaptureError("audio-context-failed", "AudioContext is missing or closed");
    }
    if (this.context.state === "suspended") {
      try {
        await this.context.resume();
      } catch (error) {
        throw new AudioCaptureError("audio-context-suspended", error);
      }
    }
    if (this.context.state === "suspended") {
      throw new AudioCaptureError(
        "audio-context-suspended",
        "AudioContext remained suspended after resume()",
      );
    }
  }

  private teardownGraphNodes(): void {
    try {
      if (this.worklet?.port) {
        this.worklet.port.onmessage = null;
      }
    } catch {
      // ignore
    }
    try {
      this.worklet?.disconnect();
    } catch {
      // ignore
    }
    try {
      if (this.processor) {
        this.processor.onaudioprocess = null;
      }
      this.processor?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.sink?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.source?.disconnect();
    } catch {
      // ignore
    }
    this.worklet = null;
    this.processor = null;
    this.sink = null;
  }

  private bindTrackEnded(stream: MediaStream): void {
    this.unbindTrackEnded();
    const track = stream.getAudioTracks()[0];
    if (!track) {
      return;
    }
    const onEnded = () => {
      if (this.disposed) {
        return;
      }
      const error = new AudioCaptureError(
        "microphone-track-ended",
        track.label ? `track ended: ${track.label}` : "microphone track ended",
      );
      this.publishDiagnostics(error);
      this.errorHandler?.(error);
    };
    track.addEventListener("ended", onEnded);
    this.trackEndedListener = () => {
      track.removeEventListener("ended", onEnded);
    };
  }

  private unbindTrackEnded(): void {
    this.trackEndedListener?.();
    this.trackEndedListener = null;
  }

  private publishDiagnostics(error: AudioCaptureError | null | undefined): void {
    const snapshot = this.getDiagnostics();
    if (error === null) {
      snapshot.lastError = null;
      snapshot.lastErrorCode = null;
      snapshot.lastErrorAt = null;
    } else if (error instanceof AudioCaptureError) {
      snapshot.lastError = error.message;
      snapshot.lastErrorCode = error.code;
      snapshot.lastErrorAt = new Date().toISOString();
    }
    // error === undefined keeps the previous lastError while refreshing live fields.
    if (error === undefined) {
      snapshot.lastError = lastCaptureDiagnostics.lastError;
      snapshot.lastErrorCode = lastCaptureDiagnostics.lastErrorCode;
      snapshot.lastErrorAt = lastCaptureDiagnostics.lastErrorAt;
    }
    lastCaptureDiagnostics = snapshot;
  }

  private async startWorklet(): Promise<void> {
    if (!this.context || !this.source) {
      throw new AudioCaptureError("audio-context-failed");
    }
    const processorSource = `
      class CaptionBridgeCaptureProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const channel = inputs[0] && inputs[0][0];
          if (channel) this.port.postMessage(channel.slice());
          return true;
        }
      }
      registerProcessor('caption-bridge-capture', CaptionBridgeCaptureProcessor);
    `;
    const blob = new Blob([processorSource], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await this.context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.worklet = new AudioWorkletNode(this.context, "caption-bridge-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.acceptSamples(event.data);
    };
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.worklet);
    this.worklet.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  private startScriptProcessor(): void {
    if (!this.context || !this.source) {
      throw new AudioCaptureError("audio-context-failed");
    }
    this.processor = this.context.createScriptProcessor(4_096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      // Copy: the AudioBuffer channel view is reused across callbacks.
      this.acceptSamples(event.inputBuffer.getChannelData(0).slice());
    };
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  private acceptSamples(samples: Float32Array): void {
    if (this.disposed || !this.handler || samples.length === 0) {
      return;
    }

    // Live level meter: throttle UI callbacks so React is not flooded every audio quantum.
    const instantDb = calculateRmsDb(samples);
    this.lastRmsDb = instantDb;
    const now =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    if (this.levelHandler && now - this.levelEmitAt >= 80) {
      this.levelEmitAt = now;
      try {
        this.levelHandler(instantDb);
      } catch {
        // Level UI must never break capture.
      }
    }

    const next = new Float32Array(this.pending.length + samples.length);
    next.set(this.pending);
    next.set(samples, this.pending.length);
    this.pending = next;
    const sampleRate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
    const chunkSize = Math.max(1, Math.round((sampleRate * this.chunkMs) / 1000));
    while (this.pending.length >= chunkSize) {
      const chunk = this.pending.slice(0, chunkSize);
      this.pending = this.pending.slice(chunkSize);
      const chunkDb = calculateRmsDb(chunk);
      // Gate on hardware-rate RMS before encode; makeAudioChunk always emits 16 kHz mono.
      if (passesSilenceGate(chunkDb, this.silenceGateDb)) {
        // Quiet speech that cleared the gate still benefits from modest peak lift
        // before 16 kHz encode (ambient ~-54 dB never reaches here with gate -50).
        const normalized = applyPeakNormalize(chunk);
        this.chunksAccepted += 1;
        this.lastAcceptedRmsDb = chunkDb;
        this.lastAcceptedGain = normalized.gain;
        if (typeof console !== "undefined" && typeof console.debug === "function") {
          // biome-ignore lint/suspicious/noConsole: debug audio capture metrics
          // biome-ignore lint/suspicious/noConsole: debug audio capture metrics
          console.debug("[audio] chunk accepted", {
            rmsDb: Number(chunkDb.toFixed(1)),
            peak: Number(normalized.peak.toFixed(4)),
            gain: Number(normalized.gain.toFixed(2)),
            chunkMs: this.chunkMs,
            sampleRate,
            accepted: this.chunksAccepted,
            silentDrops: this.chunksDroppedSilent,
          });
        }
        void this.handler?.(makeAudioChunk(normalized.samples, sampleRate, this.chunkMs));
      } else {
        this.chunksDroppedSilent += 1;
        if (this.chunksDroppedSilent <= 3 || this.chunksDroppedSilent % 20 === 0) {
          if (typeof console !== "undefined" && typeof console.debug === "function") {
            // biome-ignore lint/suspicious/noConsole: debug audio capture metrics
            // biome-ignore lint/suspicious/noConsole: debug audio capture metrics
            console.debug("[audio] chunk dropped (silence gate)", {
              rmsDb: Number.isFinite(chunkDb) ? Number(chunkDb.toFixed(1)) : chunkDb,
              gateDb: this.silenceGateDb,
              silentDrops: this.chunksDroppedSilent,
            });
          }
        }
      }
      // Keep chunk counters visible on the debug snapshot without forcing a full re-render path.
      if ((this.chunksAccepted + this.chunksDroppedSilent) % 4 === 0) {
        this.publishDiagnostics(undefined);
      }
    }
  }
}
/* c8 ignore stop */
