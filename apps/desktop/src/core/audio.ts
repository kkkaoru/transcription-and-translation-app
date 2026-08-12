import {
  DEFAULT_AUDIO_CHUNK_MS,
  DEFAULT_SILENCE_GATE_DB,
  resolveChunkMs,
  resolveSilenceGate,
  type SilenceGateMode,
} from "./defaults";
import { pushDiagnosticEvent } from "./diagnostics";
import { recordPipelineDrop } from "./dropDiagnostics";
import { isVerbosePipelineLogging } from "./pipelineStages";
import type { AudioChunk, AudioInputDevice } from "./types";

/** Parapper / Rust pipeline expects mono PCM at this rate regardless of hardware. */
export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Minimum tail duration worth sending when capture stops before a full window.
 *
 * Very short tails are usually click/noise fragments and are rejected by the
 * backend anyway. Keeping the threshold at 160 ms preserves short utterances
 * without turning every stop into a tiny request.
 */
export const PARTIAL_FLUSH_MIN_MS = 160;

/**
 * Number of hardware-rate samples batched into one AudioWorklet message.
 * Rendering quanta are usually 128 samples; forwarding every quantum creates
 * hundreds of structured-clone messages per second at 48 kHz. A ~21 ms batch
 * keeps capture responsive while materially reducing main-thread wakeups.
 */
export const AUDIO_WORKLET_FRAME_SAMPLES = 1_024;
const WORKLET_FLUSH_TIMEOUT_MS = 100;
export const SCRIPT_PROCESSOR_BUFFER_SIZE = 4_096;

/**
 * Seed the next ASR request with the preceding speech window. A 640 ms window
 * is intentionally reused as context rather than making the first request
 * longer: the first caption still arrives after one configured window while
 * the following request can resolve words that straddle the boundary.
 *
 * Subsequent requests retain the complete accepted utterance (up to
 * {@link AUDIO_CONTEXT_MAX_DURATION_MS}), not only this one-window seed. That
 * makes a newest pending request self-contained when the latest-wins queue
 * replaces one or more intermediate requests.
 */
export const AUDIO_CONTEXT_OVERLAP_MS = 640;
/**
 * A pause at least as long as one capture window starts a new utterance. Short
 * pauses remain in the rolling context so natural word spacing does not split
 * a phrase.
 */
export const AUDIO_CONTEXT_RESET_SILENCE_MS = 640;
/** Hard bound for a contextual request (well below the 10 s WAV limit). */
export const AUDIO_CONTEXT_MAX_DURATION_MS = 3_200;

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

export type AudioChunkMetadata = Pick<AudioChunk, "utteranceId">;

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
  metadata: AudioChunkMetadata = {},
): AudioChunk => {
  const safeRate =
    Number.isFinite(inputSampleRate) && inputSampleRate > 0 ? inputSampleRate : TARGET_SAMPLE_RATE;
  const utteranceId = metadata.utteranceId?.trim();
  return {
    pcmBase64: pcm16ToBase64(float32ToPcm16(resampleLinear(samples, safeRate, TARGET_SAMPLE_RATE))),
    sampleRate: TARGET_SAMPLE_RATE,
    channels: 1,
    durationMs: clampDurationMs(samples.length, durationMs),
    ...(utteranceId ? { utteranceId } : {}),
  };
};

/** Return the real wall-clock duration represented by a sample tail. */
export const partialAudioDurationMs = (samplesLength: number, sampleRate: number): number => {
  if (
    !Number.isFinite(samplesLength) ||
    samplesLength <= 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    return 0;
  }
  return (samplesLength / sampleRate) * 1_000;
};

/** Whether a tail is long enough to be considered for a speech-aware flush. */
export const shouldFlushPartialAudio = (
  samplesLength: number,
  sampleRate: number,
  minimumDurationMs = PARTIAL_FLUSH_MIN_MS,
): boolean => {
  const durationMs = partialAudioDurationMs(samplesLength, sampleRate);
  const minimum = Number.isFinite(minimumDurationMs)
    ? Math.max(0, minimumDurationMs)
    : PARTIAL_FLUSH_MIN_MS;
  return durationMs > 0 && durationMs >= minimum;
};

export type RollingAudioContextOptions = {
  /** Lower bound for contextual duration (kept for overlap tuning compatibility). */
  overlapMs?: number;
  /** Reset the preceding samples after this much gated silence. */
  resetSilenceMs?: number;
  /** Maximum duration of a contextual request, including the current window. */
  maxDurationMs?: number;
};

export type RollingAudioContext = {
  /**
   * Append a speech-bearing window and return it with the preceding context.
   * The returned array is always a fresh copy owned by the caller.
   */
  append: (samples: Float32Array, sampleRate: number) => Float32Array;
  /** Record a gated-silent duration and clear context after the reset threshold. */
  markSilence: (durationMs: number) => void;
  /** Drop all context and silence state (capture/session boundary). */
  reset: () => void;
  /** Read-only snapshots used by diagnostics/tests without exposing mutable state. */
  getContextSamples: () => Float32Array;
  /** Avoid copying the context when callers only need to inspect presence. */
  hasContext: () => boolean;
  /** Hardware rate associated with the retained context, if any. */
  getSampleRate: () => number | null;
  getSilenceMs: () => number;
};

const safeAudioRate = (sampleRate: number): number =>
  Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : TARGET_SAMPLE_RATE;

const safeDurationOption = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;

/**
 * Build a bounded rolling PCM context for live ASR.
 *
 * Capture still emits one request every configured window. Every accepted
 * request includes all preceding speech from the current utterance, bounded
 * by `maxDurationMs`. Keeping the cumulative audio is important because the
 * latest-wins queue may replace several pending requests; the newest request
 * must still contain the samples that were present in the dropped requests.
 * Gated silence advances a pause clock but is never copied into the context.
 * A full-window pause (or sample-rate change) resets the context so a later
 * utterance cannot inherit stale audio.
 */
export const createRollingAudioContext = (
  options: RollingAudioContextOptions = {},
): RollingAudioContext => {
  const overlapMs = safeDurationOption(options.overlapMs, AUDIO_CONTEXT_OVERLAP_MS);
  const resetSilenceMs = safeDurationOption(options.resetSilenceMs, AUDIO_CONTEXT_RESET_SILENCE_MS);
  const maxDurationMs = Math.max(
    overlapMs,
    safeDurationOption(options.maxDurationMs, AUDIO_CONTEXT_MAX_DURATION_MS),
  );
  let context = new Float32Array(0);
  let contextRate: number | null = null;
  let silenceMs = 0;

  const reset = (): void => {
    context = new Float32Array(0);
    contextRate = null;
    silenceMs = 0;
  };

  return {
    append: (samples, sampleRate) => {
      if (samples.length === 0) {
        return samples.slice();
      }
      const rate = safeAudioRate(sampleRate);
      // A hardware-rate change means sample counts no longer represent the
      // same wall-clock overlap. Do not splice the two rates together.
      if (
        (contextRate !== null && contextRate !== rate) ||
        (resetSilenceMs > 0 && silenceMs >= resetSilenceMs)
      ) {
        context = new Float32Array(0);
      }
      contextRate = rate;
      silenceMs = 0;

      const maxSamples = Math.max(1, Math.round((rate * maxDurationMs) / 1_000));
      // Keep the current window whenever it fits. If a caller supplies a
      // window larger than the cap, retain its newest samples rather than
      // returning an oversized request that the WAV encoder would reject.
      const currentStart = Math.max(0, samples.length - maxSamples);
      const current = currentStart > 0 ? samples.slice(currentStart) : samples.slice();
      const roomForContext = Math.max(0, maxSamples - current.length);
      const contextLength = Math.min(context.length, roomForContext);
      const prefixStart = context.length - contextLength;
      const combined = new Float32Array(contextLength + current.length);
      if (contextLength > 0) {
        combined.set(context.subarray(prefixStart), 0);
      }
      combined.set(current, contextLength);

      // Store the complete bounded output, rather than only the current
      // window's tail. The returned array is caller-owned, so retain a second
      // copy to keep later normalization/encoding from mutating our history.
      context = combined.slice();
      return combined;
    },
    markSilence: (durationMs) => {
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return;
      }
      silenceMs = Math.min(Number.MAX_SAFE_INTEGER, silenceMs + durationMs);
      if (resetSilenceMs > 0 && silenceMs >= resetSilenceMs) {
        context = new Float32Array(0);
      }
    },
    reset,
    getContextSamples: () => context.slice(),
    hasContext: () => context.length > 0,
    getSampleRate: () => contextRate,
    getSilenceMs: () => silenceMs,
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

/**
 * Adaptive noise-floor gate.
 *
 * A fixed threshold (e.g. -50 dB) is wrong in both directions: quiet speech at
 * ~-54 dB in a normal ~-65 dB room is dropped by the old gate, and loud rooms
 * leak ambient through. Instead, track a rolling estimate of the ambient floor
 * from chunks that failed the gate and pass a chunk when it clears the floor
 * by {@link ADAPTIVE_GATE_MARGIN_DB}, with an absolute hard floor for digital
 * silence only.
 *
 * Floor update rules keep the estimate deterministic and speech-safe:
 * - only chunks at or below {@link ADAPTIVE_GATE_AMBIENT_CEILING_DB} may define
 *   ambient, so speech can never seed or raise the floor. While no such chunk
 *   has been seen the floor stays null and the gate fails open;
 * - warmup: floor = min of the first {@link ADAPTIVE_GATE_WARMUP_CHUNKS}
 *   ambient-eligible dB values (all chunks ≥ absolute floor pass during warmup
 *   so speech is never delayed at capture start);
 * - steady state: only *failed* chunks update the floor, and only when they
 *   are near the current floor (within {@link ADAPTIVE_GATE_FLOOR_ADMIT_DB}) —
 *   a below-threshold chunk that is clearly louder than ambient is treated as
 *   quiet speech and must not drag the floor upward. The floor drops instantly
 *   to new ambient minima and rises slowly (20 % of the gap per chunk);
 * - chunks at or below {@link ADAPTIVE_GATE_MIN_ABSOLUTE_DB} are digital
 *   silence: never passed and never treated as ambient.
 */
export const ADAPTIVE_GATE_MIN_ABSOLUTE_DB = -70;
/** Number of consecutive absolute-floor drops before surfacing a warning. */
export const ABSOLUTE_FLOOR_WARNING_CONSECUTIVE_CHUNKS = 3;
/**
 * Loudest chunk that may be treated as ambient. Speech is never this quiet, so
 * capping floor learning here stops a user who talks from the first chunk from
 * seeding the floor with their own voice (which would then gate that speech out
 * until they paused). Until a genuinely quiet chunk is seen the floor stays
 * null and the gate fails open — the backend soft-skips any noise-only window.
 *
 * The value is pinned by an invariant, not taste: the floor can never exceed
 * this ceiling, so the strictest reachable threshold is
 * `ceiling + ADAPTIVE_GATE_MARGIN_DB`. That must stay at or below the quietest
 * speech we promise to transcribe (-54.2 dBFS, the reported user level), or
 * quiet speech is silently dropped in moderately noisy rooms. -64 + 9 = -55.
 * Rooms with ambient above the ceiling simply never learn a floor and stay
 * fail-open, which is the safe side of the tradeoff.
 */
export const ADAPTIVE_GATE_AMBIENT_CEILING_DB = -64;
export const ADAPTIVE_GATE_WARMUP_CHUNKS = 2;
export const ADAPTIVE_GATE_MARGIN_DB = 9;
export const ADAPTIVE_GATE_FLOOR_ADMIT_DB = 3;
export const ADAPTIVE_GATE_RISE_RATIO = 0.2;

/**
 * Identify a hard-floor drop without treating malformed NaN readings as a
 * microphone-level warning. RMS of digital silence is -Infinity and is an
 * expected hard-floor drop, while positive Infinity/NaN are malformed.
 */
const isAbsoluteFloorDrop = (chunkDb: number): boolean =>
  chunkDb === Number.NEGATIVE_INFINITY ||
  (Number.isFinite(chunkDb) && chunkDb <= ADAPTIVE_GATE_MIN_ABSOLUTE_DB);

export interface AdaptiveSilenceGateState {
  /** Rolling ambient floor estimate in dBFS; null until warmup completes. */
  floorDb: number | null;
  /** Chunks fed so far (warmup phase when < ADAPTIVE_GATE_WARMUP_CHUNKS). */
  fedChunks: number;
}

export const createAdaptiveSilenceGate = (): AdaptiveSilenceGateState => ({
  floorDb: null,
  fedChunks: 0,
});

/** Feed one chunk dBFS value; must be called once per chunk, in order. */
export const updateAdaptiveSilenceGate = (
  state: AdaptiveSilenceGateState,
  chunkDb: number,
  passed: boolean,
): void => {
  if (!Number.isFinite(chunkDb) || chunkDb <= ADAPTIVE_GATE_MIN_ABSOLUTE_DB) {
    return;
  }
  // Only genuinely quiet chunks may define ambient. A chunk louder than the
  // ceiling is speech (or speech-like noise) and must never raise the floor,
  // even during warmup — otherwise talking from the first chunk poisons the
  // floor and silently gates out the whole first utterance.
  if (chunkDb > ADAPTIVE_GATE_AMBIENT_CEILING_DB) {
    state.fedChunks += 1;
    return;
  }
  if (state.floorDb === null || state.fedChunks < ADAPTIVE_GATE_WARMUP_CHUNKS) {
    // First ambient-eligible chunk always seeds the floor, even past warmup and
    // even though it passed (the gate fails open until ambient is known).
    state.floorDb = state.floorDb === null ? chunkDb : Math.min(state.floorDb, chunkDb);
  } else if (!passed) {
    const floor = state.floorDb;
    if (floor === null || chunkDb < floor) {
      state.floorDb = chunkDb;
    } else if (chunkDb < floor + ADAPTIVE_GATE_FLOOR_ADMIT_DB) {
      state.floorDb = floor + (chunkDb - floor) * ADAPTIVE_GATE_RISE_RATIO;
    }
  }
  state.fedChunks += 1;
};

/** True when the chunk is loud enough relative to the learned ambient floor. */
export const passesAdaptiveSilenceGate = (
  state: AdaptiveSilenceGateState,
  chunkDb: number,
): boolean => {
  if (!Number.isFinite(chunkDb) || chunkDb <= ADAPTIVE_GATE_MIN_ABSOLUTE_DB) {
    return false;
  }
  // Warmup: let chunks through so the floor can be established and speech at
  // capture start is never delayed; the absolute floor still blocks digital
  // silence. Backend soft-skips any noise-only windows that slip through.
  if (state.fedChunks < ADAPTIVE_GATE_WARMUP_CHUNKS) {
    return true;
  }
  const floor = state.floorDb;
  // No ambient sample observed yet (e.g. the user talks continuously from the
  // first chunk): fail open rather than guessing a floor from speech. The
  // backend soft-skips genuine no-speech windows, so passing costs a request;
  // gating here would silently drop the entire first utterance.
  if (floor === null) {
    return true;
  }
  return chunkDb >= floor + ADAPTIVE_GATE_MARGIN_DB;
};

export type MicrophoneConstraintMode =
  | "exact-device"
  | "exact-device-relaxed"
  | "ideal-device"
  | "default"
  | "default-relaxed"
  // Legacy aliases kept for diagnostics from older builds / tests.
  | "exact-device-raw"
  | "ideal-device-raw"
  | "default-raw";

export type CreateMicrophoneConstraintsOptions = {
  /** Prefer { ideal } over { exact } for the selected deviceId. */
  idealDevice?: boolean;
  /** Omit echoCancellation/noiseSuppression/autoGainControl overrides. */
  relaxProcessing?: boolean;
  /**
   * When true (default), enable browser noiseSuppression + echoCancellation.
   * When false, disable NS/AEC. AGC is controlled separately via autoGainControl.
   */
  noiseSuppression?: boolean;
  /**
   * When true (default), enable browser autoGainControl.
   * Independent from noiseSuppression so settings can toggle each feature.
   */
  autoGainControl?: boolean;
  /**
   * Optional allow-list from `mediaDevices.getSupportedConstraints()`.
   * Unsupported keys are omitted from the *initial* getUserMedia call — WKWebView
   * rejects unknown keys with "Invalid constraint". After permission is granted,
   * {@link applyMicrophoneProcessing} still tries to enable NS/AGC via applyConstraints.
   * `null` means "support unknown; include processing flags and rely on the fallback ladder".
   */
  supportedConstraints?: ReadonlySet<string> | null;
};

/** User-facing browser processing toggles (both default on). */
export type MicrophoneProcessingSettings = {
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

/**
 * Normalize a boolean legacy arg or partial settings into explicit NS/AGC flags.
 * Missing values default to enabled — permission-path filtering must not clear
 * the user's settings intent.
 */
export const resolveMicrophoneProcessing = (
  input?: Partial<MicrophoneProcessingSettings> | boolean | null,
): MicrophoneProcessingSettings => {
  if (typeof input === "boolean") {
    return { noiseSuppression: input, autoGainControl: true };
  }
  return {
    noiseSuppression: input?.noiseSuppression !== false,
    autoGainControl: input?.autoGainControl !== false,
  };
};

/** Read the browser's supported MediaTrackConstraints keys when available. */
export const readSupportedAudioConstraintKeys = (): ReadonlySet<string> | null => {
  try {
    const supported = navigator.mediaDevices?.getSupportedConstraints?.();
    if (!supported || typeof supported !== "object") {
      return null;
    }
    return new Set(
      Object.entries(supported as Record<string, boolean>)
        .filter(([, enabled]) => enabled)
        .map(([key]) => key),
    );
  } catch {
    return null;
  }
};

const assignProcessingConstraint = (
  audio: MediaTrackConstraints,
  key: "echoCancellation" | "noiseSuppression" | "autoGainControl",
  value: boolean,
  supported: ReadonlySet<string> | null | undefined,
): void => {
  // Known-unsupported keys must never be sent: WebKit throws TypeError
  // "Invalid constraint" instead of ignoring them.
  if (supported && !supported.has(key)) {
    return;
  }
  audio[key] = value;
};

/**
 * Desired browser processing flags from the app settings.
 * Both noiseSuppression and autoGainControl stay conceptually enabled when
 * their settings are on; the permission / applyConstraints path only skips
 * keys the WebView cannot accept.
 */
export const desiredAudioProcessingConstraints = (
  input?: Partial<MicrophoneProcessingSettings> | boolean | null,
): Pick<MediaTrackConstraints, "echoCancellation" | "noiseSuppression" | "autoGainControl"> => {
  const processing = resolveMicrophoneProcessing(input);
  return {
    // Echo cancellation follows the noise-suppression setting (one UI toggle).
    echoCancellation: processing.noiseSuppression,
    noiseSuppression: processing.noiseSuppression,
    autoGainControl: processing.autoGainControl,
  };
};

/**
 * Build getUserMedia constraints. Apply browser processing when noiseSuppression
 * is on. Callers should progressively fall back via {@link openMicrophoneStream}.
 *
 * Never set `channelCount`: WebKit/WKWebView does not support it and rejects the
 * request with "Invalid constraint". Mono is enforced later in the PCM path.
 *
 * Processing flags may be filtered for the *permission* request; after the stream
 * opens, {@link applyMicrophoneProcessing} re-applies NS/AGC when possible.
 */
export const createMicrophoneConstraints = (
  deviceId: string,
  options: CreateMicrophoneConstraintsOptions = {},
): MediaStreamConstraints => {
  const audio: MediaTrackConstraints = {};

  if (deviceId && deviceId !== "default") {
    audio.deviceId = options.idealDevice ? { ideal: deviceId } : { exact: deviceId };
  }

  if (!options.relaxProcessing) {
    const desired = desiredAudioProcessingConstraints({
      noiseSuppression: options.noiseSuppression,
      autoGainControl: options.autoGainControl,
    });
    const supported = options.supportedConstraints;
    assignProcessingConstraint(
      audio,
      "echoCancellation",
      desired.echoCancellation === true,
      supported,
    );
    assignProcessingConstraint(
      audio,
      "noiseSuppression",
      desired.noiseSuppression === true,
      supported,
    );
    assignProcessingConstraint(
      audio,
      "autoGainControl",
      desired.autoGainControl === true,
      supported,
    );
  }

  return {
    // Empty audio object is invalid in some WebViews; use `true` when no
    // device/processing keys were set (fully relaxed default mic).
    // Do not set `video: false`: some WKWebView builds reject the combined
    // audio+video constraint object with "Invalid constraint".
    audio: Object.keys(audio).length > 0 ? audio : true,
  };
};

/** Bare permission request that WKWebView / Tauri must accept to show the mic prompt. */
export const MICROPHONE_PERMISSION_CONSTRAINTS: MediaStreamConstraints = { audio: true };

/** Ordered constraint strategies used when opening a microphone. */
export const microphoneConstraintStrategies = (
  deviceId: string,
  processingInput: Partial<MicrophoneProcessingSettings> | boolean = true,
  supportedConstraints: ReadonlySet<string> | null = readSupportedAudioConstraintKeys(),
): Array<{ mode: MicrophoneConstraintMode; constraints: MediaStreamConstraints }> => {
  const strategies: Array<{ mode: MicrophoneConstraintMode; constraints: MediaStreamConstraints }> =
    [];
  const processing = resolveMicrophoneProcessing(processingInput);
  const processingOptions = { ...processing, supportedConstraints };
  if (deviceId && deviceId !== "default") {
    strategies.push({
      mode: "exact-device",
      constraints: createMicrophoneConstraints(deviceId, processingOptions),
    });
    strategies.push({
      mode: "exact-device-relaxed",
      constraints: createMicrophoneConstraints(deviceId, {
        relaxProcessing: true,
        ...processingOptions,
      }),
    });
    strategies.push({
      mode: "ideal-device",
      constraints: createMicrophoneConstraints(deviceId, {
        idealDevice: true,
        relaxProcessing: true,
        ...processingOptions,
      }),
    });
  } else {
    strategies.push({
      mode: "default",
      constraints: createMicrophoneConstraints("default", processingOptions),
    });
  }
  // Always finish with the permission-only request so a WKWebView that rejects
  // every typed constraint can still show the OS microphone prompt.
  strategies.push({
    mode: "default-relaxed",
    constraints: MICROPHONE_PERMISSION_CONSTRAINTS,
  });
  return strategies;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
};

const _isConstraintFailure = (error: unknown): boolean => {
  // WKWebView may surface unsupported constraint keys as TypeError, DOMException,
  // or a plain Error whose message is only "Invalid constraint".
  if (/invalid constraint/i.test(errorMessage(error))) {
    return true;
  }
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
 * After microphone permission is granted, enable the configured processing
 * features (noise suppression / AGC / echo cancellation) on the live track.
 *
 * WKWebView often rejects these keys on the initial getUserMedia call. Opening
 * with a permission-safe constraint first, then applying them here, keeps the
 * features enabled in settings without hard-failing startup. Each key is
 * applied individually so one unsupported flag cannot block the others.
 */
export const applyMicrophoneProcessing = async (
  stream: MediaStream,
  processingInput: Partial<MicrophoneProcessingSettings> | boolean = true,
): Promise<MediaTrackConstraints> => {
  const track = stream.getAudioTracks()[0];
  const desired = desiredAudioProcessingConstraints(processingInput);
  const applied: MediaTrackConstraints = {};
  if (!track || typeof track.applyConstraints !== "function") {
    return applied;
  }

  const candidates: Array<["echoCancellation" | "noiseSuppression" | "autoGainControl", boolean]> =
    [
      ["echoCancellation", desired.echoCancellation === true],
      ["noiseSuppression", desired.noiseSuppression === true],
      ["autoGainControl", desired.autoGainControl === true],
    ];

  for (const [key, value] of candidates) {
    try {
      await track.applyConstraints({ [key]: value });
      applied[key] = value;
    } catch {
      // One unsupported key must not block the others.
    }
  }
  return applied;
};

/**
 * Open a microphone, prioritizing a successful permission grant on WKWebView.
 *
 * Flow:
 * 1. Always request `{ audio: true }` first so the OS mic prompt can appear.
 * 2. Retarget to the selected device when possible (non-fatal).
 * 3. Apply noiseSuppression / AGC from settings on the live track afterward.
 */
export const openMicrophoneStream = async (
  deviceId: string,
  processingInput: Partial<MicrophoneProcessingSettings> | boolean = true,
): Promise<{ stream: MediaStream; mode: MicrophoneConstraintMode }> => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new AudioCaptureError("microphone-unavailable");
  }

  const processing = resolveMicrophoneProcessing(processingInput);
  let opened: { stream: MediaStream; mode: MicrophoneConstraintMode };

  try {
    // Permission-first: never send processing flags or `video: false` here.
    // WKWebView rejects unsupported keys with "Invalid constraint" and that
    // previously blocked the OS microphone prompt entirely.
    const stream = await navigator.mediaDevices.getUserMedia(MICROPHONE_PERMISSION_CONSTRAINTS);
    opened = { stream, mode: "default-relaxed" };
  } catch (error) {
    // Do not retry after an explicit denial — a second prompt will not help.
    if (
      typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "SecurityError")
    ) {
      throw error;
    }
    // Absolute last chance: empty audio object (some WebViews accept this).
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {} });
      opened = { stream, mode: "default-relaxed" };
    } catch {
      throw error;
    }
  }

  if (deviceId && deviceId !== "default") {
    for (const attempt of [
      { mode: "exact-device-relaxed" as const, audio: { deviceId: { exact: deviceId } } },
      { mode: "ideal-device" as const, audio: { deviceId: { ideal: deviceId } } },
      { mode: "ideal-device" as const, audio: { deviceId } },
    ]) {
      try {
        const next = await navigator.mediaDevices.getUserMedia({ audio: attempt.audio });
        for (const track of opened.stream.getTracks()) {
          try {
            track.stop();
          } catch {
            // ignore
          }
        }
        opened = { stream: next, mode: attempt.mode };
        break;
      } catch {
        // Keep the already-granted permission stream.
      }
    }
  } else {
    // Optional upgrade: try the configured processing flags on a fresh open.
    // Failure is ignored — we already hold a working permission stream.
    try {
      const upgraded = await navigator.mediaDevices.getUserMedia(
        createMicrophoneConstraints("default", {
          ...processing,
          supportedConstraints: readSupportedAudioConstraintKeys(),
        }),
      );
      for (const track of opened.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      opened = { stream: upgraded, mode: "default" };
    } catch {
      // Keep permission-only stream.
    }
  }

  try {
    await applyMicrophoneProcessing(opened.stream, processing);
  } catch {
    // Processing is best-effort; capture must continue with the granted mic.
  }
  return opened;
};

export type AudioCaptureErrorCode =
  | "audio-context-failed"
  | "microphone-unavailable"
  | "microphone-track-ended"
  | "microphone-track-muted"
  | "audio-context-suspended"
  /**
   * Capture graph is live (status=capturing) but the AudioWorklet/ScriptProcessor
   * never delivered samples. Common with a zombie WKWebView AudioContext or a
   * MediaStreamSource that never schedules render quanta.
   */
  | "microphone-no-frames"
  /** A legacy/chunk callback rejected while capture was flushing or processing audio. */
  | "audio-chunk-delivery-failed"
  /** Continuous Parapper PCM delivery failed; this is not an AudioContext failure. */
  | "parapper-transport-failed";

/** Non-zero so WKWebView keeps scheduling a "silent" capture graph. */
const AUDIO_GRAPH_KEEPALIVE_GAIN = 1e-5;

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

export type { SilenceGateMode } from "./defaults";

export type AudioCaptureDiagnostics = {
  active: boolean;
  captureMode: AudioCaptureMode;
  constraintMode: MicrophoneConstraintMode | null;
  contextState: string | null;
  sampleRate: number | null;
  trackReadyState: string | null;
  trackLabel: string | null;
  trackMuted: boolean | null;
  /** Number of mute lifecycle events observed for the active microphone track. */
  trackMuteEvents: number;
  lastTrackMuteAt: string | null;
  deviceIdRequested: string | null;
  /** Device-list changes are diagnostic only; capture never silently reconnects. */
  deviceChangeEvents: number;
  lastDeviceChangeAt: string | null;
  contextStateChanges: number;
  /** Bounded best-effort resumes triggered by a suspended AudioContext. */
  contextRecoveryAttempts: number;
  lastContextStateChangeAt: string | null;
  /** Most recent RMS level in dBFS while capturing; null when idle. */
  lastRmsDb: number | null;
  /** RMS of the last chunk that passed the silence gate (pre-normalize). */
  lastAcceptedRmsDb: number | null;
  /** Soft peak-normalize gain applied to the last accepted chunk (1 = none). */
  lastAcceptedGain: number | null;
  /** Which silence gate is active: adaptive floor (default) or fixed dB. */
  gateMode: SilenceGateMode | null;
  /** Learned ambient floor estimate for the adaptive gate, in dBFS. */
  adaptiveFloorDb: number | null;
  /** Fixed gate threshold in dBFS, populated when gateMode is "fixed". */
  fixedGateDb: number | null;
  chunksAccepted: number;
  chunksDroppedSilent: number;
  /** Number of adaptive-gate chunks rejected by the absolute floor. */
  absoluteFloorDrops: number;
  /** Current consecutive absolute-floor drop streak. */
  consecutiveAbsoluteFloorDrops: number;
  /** Most recent absolute-floor drop timestamp. */
  lastAbsoluteFloorDropAt: string | null;
  /** Frames that could not be delivered to the continuous Parapper transport. */
  streamFramesDropped: number;
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
  trackMuteEvents: 0,
  lastTrackMuteAt: null,
  deviceIdRequested: null,
  deviceChangeEvents: 0,
  lastDeviceChangeAt: null,
  contextStateChanges: 0,
  contextRecoveryAttempts: 0,
  lastContextStateChangeAt: null,
  lastRmsDb: null,
  lastAcceptedRmsDb: null,
  lastAcceptedGain: null,
  gateMode: null,
  adaptiveFloorDb: null,
  fixedGateDb: null,
  chunksAccepted: 0,
  chunksDroppedSilent: 0,
  absoluteFloorDrops: 0,
  consecutiveAbsoluteFloorDrops: 0,
  lastAbsoluteFloorDropAt: null,
  streamFramesDropped: 0,
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
    diagnostics.trackMuteEvents > 0 ? `muteEvents=${diagnostics.trackMuteEvents}` : null,
    diagnostics.deviceChangeEvents > 0 ? `deviceChanges=${diagnostics.deviceChangeEvents}` : null,
    diagnostics.contextStateChanges > 0
      ? `contextChanges=${diagnostics.contextStateChanges}`
      : null,
    diagnostics.contextRecoveryAttempts > 0
      ? `contextRecovery=${diagnostics.contextRecoveryAttempts}`
      : null,
    diagnostics.lastRmsDb !== null && Number.isFinite(diagnostics.lastRmsDb)
      ? `rms=${diagnostics.lastRmsDb.toFixed(1)}dB`
      : null,
    diagnostics.lastAcceptedRmsDb !== null && Number.isFinite(diagnostics.lastAcceptedRmsDb)
      ? `acceptedRms=${diagnostics.lastAcceptedRmsDb.toFixed(1)}dB`
      : null,
    diagnostics.gateMode
      ? diagnostics.gateMode === "adaptive"
        ? `gate=adaptive${diagnostics.adaptiveFloorDb !== null ? `·floor=${diagnostics.adaptiveFloorDb.toFixed(1)}dB` : ""}`
        : `gate=fixed(${diagnostics.fixedGateDb?.toFixed(1) ?? "?"}dB)`
      : null,
    diagnostics.lastAcceptedGain !== null &&
    Number.isFinite(diagnostics.lastAcceptedGain) &&
    diagnostics.lastAcceptedGain > 1.05
      ? `gain=${diagnostics.lastAcceptedGain.toFixed(2)}x`
      : null,
    diagnostics.chunksAccepted > 0 ? `chunks=${diagnostics.chunksAccepted}` : null,
    diagnostics.chunksDroppedSilent > 0 ? `silent=${diagnostics.chunksDroppedSilent}` : null,
    diagnostics.absoluteFloorDrops > 0 ? `floorDrops=${diagnostics.absoluteFloorDrops}` : null,
    diagnostics.consecutiveAbsoluteFloorDrops > 0
      ? `floorStreak=${diagnostics.consecutiveAbsoluteFloorDrops}`
      : null,
    diagnostics.streamFramesDropped > 0 ? `streamDropped=${diagnostics.streamFramesDropped}` : null,
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
    return new AudioContextCtor({
      sampleRate: TARGET_SAMPLE_RATE,
      latencyHint: "interactive",
    });
  } catch {
    try {
      // Some WebViews reject a forced sample rate but still accept latencyHint.
      return new AudioContextCtor({ latencyHint: "interactive" });
    } catch {
      return new AudioContextCtor();
    }
  }
};

type ChunkHandler = (chunk: AudioChunk) => void | Promise<void>;
/** Raw mono PCM16 frames for a continuous Parapper session. */
export type PcmStreamHandler = (frame: Uint8Array) => void;
type CaptureErrorHandler = (error: AudioCaptureError) => void;
type LevelHandler = (rmsDb: number) => void;

const isMicrophoneConstraintError = (error: unknown): boolean => {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return (
      error.name === "NotAllowedError" ||
      error.name === "SecurityError" ||
      error.name === "NotFoundError" ||
      error.name === "NotReadableError" ||
      error.name === "OverconstrainedError" ||
      error.name === "AbortError" ||
      // WKWebView rejects unsupported MediaTrackConstraints with TypeError.
      error.name === "TypeError"
    );
  }
  if (error instanceof TypeError) {
    return true;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /invalid constraint/i.test(message);
};

const toCaptureError = (error: unknown): AudioCaptureError => {
  if (error instanceof AudioCaptureError) {
    return error;
  }
  return new AudioCaptureError(
    isMicrophoneConstraintError(error) ? "microphone-unavailable" : "audio-context-failed",
    error,
  );
};

let fallbackUtteranceCounter = 0;

/** Generate a per-capture-session key without requiring Web Crypto in tests. */
const createUtteranceId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // Fall through to a monotonic local key in restricted WebViews.
    }
  }
  fallbackUtteranceCounter += 1;
  return `utterance-${Date.now().toString(36)}-${fallbackUtteranceCounter.toString(36)}`;
};

/* c8 ignore start -- browser/Tauri media graph; pure PCM functions are covered below. */
/** Optional per-session capture tuning (not part of the persistent config). */
export type StartCaptureOptions = {
  /**
   * When false, use the fixed `silenceGateDb` threshold. Defaults to true
   * (adaptive noise-floor gate) when the option is omitted.
   */
  adaptiveGate?: boolean;
  /**
   * Optional continuous PCM path. When set, every captured frame (including
   * silence) is resampled to 16 kHz PCM16 and delivered before the legacy
   * speech gate. This is the path used by the persistent Parapper session;
   * the legacy `handler` remains available for browser/HTTP callers.
   */
  streamPcmHandler?: PcmStreamHandler;
};

export class MicrophoneCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private pending = new Float32Array(0);
  /** Cumulative accepted speech retained for the next request (not gated silence). */
  private rollingContext: RollingAudioContext = createRollingAudioContext();
  /** Stable key shared by overlapping requests in one spoken utterance. */
  private utteranceId: string | null = null;
  private handler: ChunkHandler | null = null;
  private streamPcmHandler: PcmStreamHandler | null = null;
  private errorHandler: CaptureErrorHandler | null = null;
  private levelHandler: LevelHandler | null = null;
  private chunkMs = DEFAULT_AUDIO_CHUNK_MS;
  private silenceGateDb = DEFAULT_SILENCE_GATE_DB;
  private processing: MicrophoneProcessingSettings = {
    noiseSuppression: true,
    autoGainControl: true,
  };
  private gateMode: SilenceGateMode = "adaptive";
  private adaptiveGate: AdaptiveSilenceGateState = createAdaptiveSilenceGate();
  private captureMode: AudioCaptureMode = "none";
  private constraintMode: MicrophoneConstraintMode | null = null;
  private deviceIdRequested: string | null = null;
  private trackEndedListener: (() => void) | null = null;
  private contextStateListener: (() => void) | null = null;
  private deviceChangeListener: (() => void) | null = null;
  private contextRecovery: Promise<void> | null = null;
  private workletFlushResolve: (() => void) | null = null;
  private workletFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private workletProcessorErrorReported = false;
  private disposed = false;
  private lastRmsDb: number | null = null;
  private lastAcceptedRmsDb: number | null = null;
  private lastAcceptedGain: number | null = null;
  private chunksAccepted = 0;
  private chunksDroppedSilent = 0;
  private absoluteFloorDrops = 0;
  private consecutiveAbsoluteFloorDrops = 0;
  private lastAbsoluteFloorDropAt: string | null = null;
  private streamFramesDropped = 0;
  private trackMuteEvents = 0;
  private lastTrackMuteAt: string | null = null;
  private deviceChangeEvents = 0;
  private lastDeviceChangeAt: string | null = null;
  private contextStateChanges = 0;
  private contextRecoveryAttempts = 0;
  private lastContextStateChangeAt: string | null = null;
  private levelEmitAt = 0;
  /** Samples accepted by the live graph since the latest start(). */
  private framesReceived = 0;
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
      trackMuteEvents: this.trackMuteEvents,
      lastTrackMuteAt: this.lastTrackMuteAt,
      deviceIdRequested: this.deviceIdRequested,
      deviceChangeEvents: this.deviceChangeEvents,
      lastDeviceChangeAt: this.lastDeviceChangeAt,
      contextStateChanges: this.contextStateChanges,
      contextRecoveryAttempts: this.contextRecoveryAttempts,
      lastContextStateChangeAt: this.lastContextStateChangeAt,
      lastRmsDb: this.lastRmsDb,
      lastAcceptedRmsDb: this.lastAcceptedRmsDb,
      lastAcceptedGain: this.lastAcceptedGain,
      gateMode: this.gateMode,
      adaptiveFloorDb: this.adaptiveGate.floorDb,
      fixedGateDb: this.gateMode === "fixed" ? this.silenceGateDb : null,
      chunksAccepted: this.chunksAccepted,
      chunksDroppedSilent: this.chunksDroppedSilent,
      absoluteFloorDrops: this.absoluteFloorDrops,
      consecutiveAbsoluteFloorDrops: this.consecutiveAbsoluteFloorDrops,
      lastAbsoluteFloorDropAt: this.lastAbsoluteFloorDropAt,
      streamFramesDropped: this.streamFramesDropped,
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
      this.bindContextStateChange(this.context);
      if (this.context.state === "suspended") {
        void this.context.resume().catch(() => undefined);
      }
      return;
    }
    this.context = createAudioContext();
    this.bindContextStateChange(this.context);
    if (this.context.state === "suspended") {
      void this.context.resume().catch(() => undefined);
    }
  }

  /**
   * Open the microphone and ensure AudioContext is running. Safe to call after
   * releasing a previous capture session; may be overlapped with backend prep.
   */
  public async prepareInput(
    deviceId: string,
    processingInput: Partial<MicrophoneProcessingSettings> | boolean = true,
  ): Promise<void> {
    this.disposed = false;
    const previousDeviceId = this.deviceIdRequested;
    const previousProcessing = this.processing;
    const processing = resolveMicrophoneProcessing(processingInput);
    this.deviceIdRequested = deviceId;
    this.processing = processing;

    try {
      this.primeAudioContext();
      await this.ensureContextRunning();

      const liveTrack = this.stream?.getAudioTracks()[0];
      const reusable =
        this.hardwareReady &&
        this.stream !== null &&
        liveTrack?.readyState === "live" &&
        previousDeviceId === deviceId &&
        previousProcessing.noiseSuppression === processing.noiseSuppression &&
        previousProcessing.autoGainControl === processing.autoGainControl;
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

        const opened = await openMicrophoneStream(deviceId, processing);
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
        this.bindDeviceChange();
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
    handler: ChunkHandler | null,
    onError?: CaptureErrorHandler,
    onLevel?: LevelHandler,
    processingInput: Partial<MicrophoneProcessingSettings> | boolean = true,
    options?: StartCaptureOptions,
  ): Promise<void> {
    const previousProcessing = this.processing;
    const processing = resolveMicrophoneProcessing(processingInput);
    this.disposed = false;
    this.handler = handler;
    this.streamPcmHandler = options?.streamPcmHandler ?? null;
    this.errorHandler = onError ?? null;
    this.levelHandler = onLevel ?? null;
    this.chunkMs = resolveChunkMs(chunkMs);
    const resolvedGate = resolveSilenceGate(options?.adaptiveGate, silenceGateDb);
    this.silenceGateDb = resolvedGate.fixedGateDb ?? DEFAULT_SILENCE_GATE_DB;
    this.processing = processing;
    // Adaptive noise-floor gating is the default; use the shared resolver so
    // persisted settings and live capture cannot disagree on the active policy.
    this.gateMode = resolvedGate.mode;
    this.adaptiveGate = createAdaptiveSilenceGate();
    this.lastRmsDb = null;
    this.lastAcceptedRmsDb = null;
    this.lastAcceptedGain = null;
    this.chunksAccepted = 0;
    this.chunksDroppedSilent = 0;
    this.absoluteFloorDrops = 0;
    this.consecutiveAbsoluteFloorDrops = 0;
    this.lastAbsoluteFloorDropAt = null;
    this.streamFramesDropped = 0;
    this.trackMuteEvents = 0;
    this.lastTrackMuteAt = null;
    this.deviceChangeEvents = 0;
    this.lastDeviceChangeAt = null;
    this.contextStateChanges = 0;
    this.contextRecoveryAttempts = 0;
    this.lastContextStateChangeAt = null;
    this.levelEmitAt = 0;
    this.framesReceived = 0;
    this.pending = new Float32Array(0);
    this.rollingContext.reset();
    this.utteranceId = null;

    try {
      const liveTrack = this.stream?.getAudioTracks()[0];
      const prepared =
        this.hardwareReady &&
        this.stream !== null &&
        this.context !== null &&
        this.context.state !== "closed" &&
        liveTrack?.readyState === "live" &&
        this.deviceIdRequested === deviceId &&
        previousProcessing.noiseSuppression === processing.noiseSuppression &&
        previousProcessing.autoGainControl === processing.autoGainControl;

      if (!prepared) {
        // Standalone start() path (tests / callers that skip prepareInput).
        this.teardownGraphNodes();
        this.source = null;
        await this.prepareInput(deviceId, processing);
      } else {
        // Reuse hardware from prepareInput; clear any half-wired graph.
        this.teardownGraphNodes();
        this.source = null;
        this.deviceIdRequested = deviceId;
      }

      if (!this.context || !this.stream) {
        throw new AudioCaptureError("microphone-unavailable");
      }

      // Resume before wiring MediaStreamSource. A suspended context at
      // createMediaStreamSource time can leave WKWebView with a live track but
      // no render quanta (UI stuck on "入力待機…" / Waiting for input).
      await this.ensureContextRunning();

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
      await this.ensureAudioFramesFlowing();
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
    // Return any sub-frame held inside the AudioWorklet before disabling input.
    // Otherwise a short utterance ending between render quanta is discarded
    // before the main-thread tail flush can preserve it.
    await this.flushWorkletTail();
    this.disposed = true;
    // Stop accepting new worklet/script-processor frames, but keep the
    // current handler and context alive long enough to deliver a speech-aware
    // tail. The helper takes ownership of `pending` synchronously so a
    // concurrent stop() cannot flush the same samples twice.
    try {
      await this.flushPendingPartial(1);
    } catch (error) {
      // A rejected final tail must be visible, but must never skip hardware
      // cleanup. This method deliberately resolves after teardown below.
      this.reportCaptureFailure(
        error instanceof AudioCaptureError
          ? error
          : new AudioCaptureError("audio-chunk-delivery-failed", error),
      );
    }
    this.handler = null;
    this.streamPcmHandler = null;
    this.errorHandler = null;
    this.levelHandler = null;
    this.hardwareReady = false;
    this.unbindTrackEnded();
    this.unbindDeviceChange();
    this.unbindContextStateChange();
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
    this.rollingContext.reset();
    this.utteranceId = null;
    this.lastRmsDb = null;
    this.lastAcceptedRmsDb = null;
    this.lastAcceptedGain = null;
    this.gateMode = "adaptive";
    this.adaptiveGate = createAdaptiveSilenceGate();
    this.consecutiveAbsoluteFloorDrops = 0;
    this.contextRecovery = null;
    this.finishWorkletFlush();

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

  private async flushWorkletTail(): Promise<void> {
    const worklet = this.worklet;
    if (!worklet) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.finishWorkletFlush();
      this.workletFlushResolve = resolve;
      this.workletFlushTimer = setTimeout(
        () => this.finishWorkletFlush(),
        WORKLET_FLUSH_TIMEOUT_MS,
      );
      try {
        worklet.port.postMessage({ type: "flush" });
      } catch {
        this.finishWorkletFlush();
      }
    });
  }

  private finishWorkletFlush(): void {
    if (this.workletFlushTimer !== null) {
      clearTimeout(this.workletFlushTimer);
      this.workletFlushTimer = null;
    }
    const resolve = this.workletFlushResolve;
    this.workletFlushResolve = null;
    resolve?.();
  }

  /**
   * Record a gated chunk and surface a bounded warning for a persistently
   * silent input. A brief pause remains a quiet counter; a repeated hard-floor
   * streak is actionable (muted track, wrong device, or a failed audio graph).
   */
  private recordSilentDrop(chunkDb: number): void {
    this.chunksDroppedSilent += 1;
    const absoluteFloorDrop = this.gateMode === "adaptive" && isAbsoluteFloorDrop(chunkDb);
    recordPipelineDrop("audio", 1, absoluteFloorDrop ? "absolute-floor" : "silence-gate");
    if (!absoluteFloorDrop) {
      this.consecutiveAbsoluteFloorDrops = 0;
      return;
    }

    this.absoluteFloorDrops += 1;
    this.consecutiveAbsoluteFloorDrops += 1;
    this.lastAbsoluteFloorDropAt = new Date().toISOString();
    if (this.consecutiveAbsoluteFloorDrops !== ABSOLUTE_FLOOR_WARNING_CONSECUTIVE_CHUNKS) {
      return;
    }

    const level = Number.isFinite(chunkDb) ? `${chunkDb.toFixed(1)}dB` : String(chunkDb);
    const detail = [
      `rms=${level}`,
      `floor=${ADAPTIVE_GATE_MIN_ABSOLUTE_DB.toFixed(1)}dBFS`,
      `streak=${this.consecutiveAbsoluteFloorDrops}`,
      `drops=${this.absoluteFloorDrops}`,
    ].join(" · ");
    try {
      pushDiagnosticEvent("audio", "Absolute floor drop warning", detail);
    } catch {
      // Diagnostics are best-effort; never throw from an audio callback.
    }
  }

  /**
   * Send the final sub-window when it contains enough real audio to plausibly
   * contain speech. This intentionally reuses the active silence-gate policy;
   * stopping after a pause must not turn ambient tail noise into an ASR request.
   */
  private async flushPendingPartial(minimumDurationMs = PARTIAL_FLUSH_MIN_MS): Promise<void> {
    const pending = this.pending;
    // Clear ownership before awaiting the handler. A re-entrant/concurrent
    // stop() then observes an empty tail and cannot emit a duplicate chunk.
    this.pending = new Float32Array(0);
    const handler = this.handler;
    const sampleRate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
    if (!handler || !shouldFlushPartialAudio(pending.length, sampleRate, minimumDurationMs)) {
      return;
    }

    const durationMs = partialAudioDurationMs(pending.length, sampleRate);
    const chunkDb = calculateRmsDb(pending);
    const passed =
      this.gateMode === "adaptive"
        ? passesAdaptiveSilenceGate(this.adaptiveGate, chunkDb)
        : passesSilenceGate(chunkDb, this.silenceGateDb);
    if (this.gateMode === "adaptive") {
      updateAdaptiveSilenceGate(this.adaptiveGate, chunkDb, passed);
    }
    if (!passed) {
      this.rollingContext.markSilence(durationMs);
      if (!this.rollingContext.hasContext()) {
        this.utteranceId = null;
      }
      this.recordSilentDrop(chunkDb);
      this.publishDiagnostics(undefined);
      return;
    }

    const utteranceId = this.ensureUtteranceId(sampleRate);
    const contextual = this.rollingContext.append(pending, sampleRate);
    const contextualDurationMs = partialAudioDurationMs(contextual.length, sampleRate);
    const normalized = applyPeakNormalize(contextual);
    this.chunksAccepted += 1;
    this.consecutiveAbsoluteFloorDrops = 0;
    this.lastAcceptedRmsDb = chunkDb;
    this.lastAcceptedGain = normalized.gain;
    try {
      // Await the final callback so stop() cannot tear down the capture before
      // the short utterance reaches the processor. Use the contextual duration
      // (rather than the configured full-window duration) in the encoded chunk.
      await Promise.resolve(
        handler(
          makeAudioChunk(normalized.samples, sampleRate, contextualDurationMs, { utteranceId }),
        ),
      );
    } catch (error) {
      throw new AudioCaptureError("audio-chunk-delivery-failed", error);
    }
    this.publishDiagnostics(undefined);
  }

  /**
   * Return the stable key for the next speech window, rotating it whenever the
   * rolling context was cleared or the hardware sample rate changed.
   */
  private ensureUtteranceId(sampleRate: number): string {
    const rate = safeAudioRate(sampleRate);
    const contextRate = this.rollingContext.getSampleRate();
    if (
      this.utteranceId === null ||
      !this.rollingContext.hasContext() ||
      (contextRate !== null && contextRate !== rate)
    ) {
      this.utteranceId = createUtteranceId();
    }
    return this.utteranceId;
  }

  private async ensureContextRunning(): Promise<void> {
    if (!this.context || this.context.state === "closed") {
      throw new AudioCaptureError("audio-context-failed", "AudioContext is missing or closed");
    }
    // WKWebView may report "interrupted" (or other non-running states) after
    // focus/device changes. Treat anything other than running as recoverable.
    if (this.context.state !== "running") {
      try {
        // suspend→resume forces a clean internal reset for zombie contexts that
        // report suspended but no longer schedule render quanta.
        if (this.context.state === "suspended") {
          try {
            await this.context.suspend();
          } catch {
            // ignore — some hosts reject suspend while already suspended
          }
        }
        await this.context.resume();
      } catch (error) {
        throw new AudioCaptureError("audio-context-suspended", error);
      }
    }
    if (this.context.state !== "running") {
      throw new AudioCaptureError(
        "audio-context-suspended",
        `AudioContext remained ${this.context.state} after resume()`,
      );
    }
  }

  /**
   * Confirm the capture graph is delivering samples. A live MediaStreamTrack
   * with a non-running render quantum leaves the UI on "Waiting for input…"
   * forever; recover once, then fail loudly.
   *
   * Skipped under Vitest: unit tests use stub AudioContext graphs that never
   * schedule render quanta.
   */
  private async ensureAudioFramesFlowing(): Promise<void> {
    if (
      typeof process !== "undefined" &&
      (process.env["VITEST"] === "true" || process.env["NODE_ENV"] === "test")
    ) {
      return;
    }
    if (await this.waitForAudioFrames(350)) {
      return;
    }
    if (this.disposed || !this.context || !this.stream) {
      return;
    }
    this.contextRecoveryAttempts += 1;
    try {
      await this.context.suspend();
    } catch {
      // ignore
    }
    await this.ensureContextRunning();
    if (await this.waitForAudioFrames(350)) {
      return;
    }
    if (this.disposed || !this.context || !this.stream) {
      return;
    }
    // Worklet can look healthy while never scheduling; fall back once.
    if (this.captureMode === "worklet") {
      this.teardownGraphNodes();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.startScriptProcessor();
      this.captureMode = "script-processor";
      await this.ensureContextRunning();
      if (await this.waitForAudioFrames(400)) {
        return;
      }
    }
    const track = this.stream.getAudioTracks()[0];
    const detail = [
      `context=${this.context.state}`,
      `mode=${this.captureMode}`,
      track ? `track=${track.readyState}` : null,
      track?.muted ? "muted" : null,
      track?.label ? `label=${track.label}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    throw new AudioCaptureError(
      "microphone-no-frames",
      detail || "no audio frames from capture graph",
    );
  }

  private async waitForAudioFrames(timeoutMs: number): Promise<boolean> {
    const baseline = this.framesReceived;
    const deadline =
      (typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now()) + timeoutMs;
    while (
      (typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now()) < deadline
    ) {
      if (this.disposed) {
        return false;
      }
      if (this.framesReceived > baseline) {
        return true;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 40);
      });
    }
    return this.framesReceived > baseline;
  }

  private teardownGraphNodes(): void {
    try {
      if (this.worklet?.port) {
        this.worklet.port.onmessage = null;
      }
      if (this.worklet) {
        this.worklet.onprocessorerror = null;
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
    this.workletProcessorErrorReported = false;
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
    const onMute = () => {
      if (this.disposed) {
        return;
      }
      this.trackMuteEvents += 1;
      this.lastTrackMuteAt = new Date().toISOString();
      // Muting can be transient (for example, while macOS switches inputs), so
      // record it without forcing the owner to stop a session that may recover.
      this.publishDiagnostics(
        new AudioCaptureError(
          "microphone-track-muted",
          track.label ? `track muted: ${track.label}` : "microphone track muted",
        ),
      );
    };
    const onUnmute = () => {
      if (this.disposed) {
        return;
      }
      this.lastTrackMuteAt = new Date().toISOString();
      this.clearLastErrorIf("microphone-track-muted");
      this.publishDiagnostics(undefined);
    };
    track.addEventListener("ended", onEnded);
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    this.trackEndedListener = () => {
      track.removeEventListener("ended", onEnded);
      track.removeEventListener("mute", onMute);
      track.removeEventListener("unmute", onUnmute);
    };
  }

  private unbindTrackEnded(): void {
    this.trackEndedListener?.();
    this.trackEndedListener = null;
  }

  /** Publish AudioContext transitions and make one bounded resume attempt. */
  private bindContextStateChange(context: AudioContext): void {
    this.unbindContextStateChange();
    const onStateChange = () => {
      if (this.disposed || this.context !== context) {
        return;
      }
      this.contextStateChanges += 1;
      this.lastContextStateChangeAt = new Date().toISOString();
      this.publishDiagnostics(undefined);
      if (context.state === "closed") {
        this.reportCaptureFailure(
          new AudioCaptureError("audio-context-failed", "AudioContext closed unexpectedly"),
        );
        return;
      }
      if (context.state === "suspended") {
        this.recoverSuspendedContext(context);
      }
    };
    context.addEventListener("statechange", onStateChange);
    this.contextStateListener = () => context.removeEventListener("statechange", onStateChange);
  }

  private unbindContextStateChange(): void {
    this.contextStateListener?.();
    this.contextStateListener = null;
  }

  private recoverSuspendedContext(context: AudioContext): void {
    if (this.contextRecovery || this.disposed || this.context !== context) {
      return;
    }
    this.contextRecoveryAttempts += 1;
    this.contextRecovery = Promise.resolve()
      .then(() => context.resume())
      .then(() => {
        if (this.disposed || this.context !== context) {
          return;
        }
        if (context.state === "suspended") {
          this.reportCaptureFailure(
            new AudioCaptureError(
              "audio-context-suspended",
              "AudioContext remained suspended after lifecycle recovery",
            ),
          );
          return;
        }
        this.publishDiagnostics(undefined);
      })
      .catch((error: unknown) => {
        if (!this.disposed && this.context === context) {
          this.reportCaptureFailure(new AudioCaptureError("audio-context-suspended", error));
        }
      })
      .finally(() => {
        if (this.context === context) {
          this.contextRecovery = null;
        }
      });
  }

  /** Device changes are observable, but automatic reconnect would violate user intent. */
  private bindDeviceChange(): void {
    this.unbindDeviceChange();
    const mediaDevices = typeof navigator === "undefined" ? null : navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) {
      return;
    }
    const onDeviceChange = () => {
      if (this.disposed) {
        return;
      }
      this.deviceChangeEvents += 1;
      this.lastDeviceChangeAt = new Date().toISOString();
      this.publishDiagnostics(undefined);
    };
    mediaDevices.addEventListener("devicechange", onDeviceChange);
    this.deviceChangeListener = () =>
      mediaDevices.removeEventListener("devicechange", onDeviceChange);
  }

  private unbindDeviceChange(): void {
    this.deviceChangeListener?.();
    this.deviceChangeListener = null;
  }

  private reportCaptureFailure(error: AudioCaptureError): void {
    this.publishDiagnostics(error);
    this.errorHandler?.(error);
  }

  private clearLastErrorIf(code: AudioCaptureErrorCode): void {
    if (lastCaptureDiagnostics.lastErrorCode !== code) {
      return;
    }
    lastCaptureDiagnostics = {
      ...lastCaptureDiagnostics,
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
    };
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
      const FRAME_SIZE = ${AUDIO_WORKLET_FRAME_SAMPLES};
      class CaptionBridgeCaptureProcessor extends AudioWorkletProcessor {
        constructor(options) {
          super();
          const configured = options && options.processorOptions
            ? options.processorOptions.frameSize
            : FRAME_SIZE;
          this.frameSize = Number.isFinite(configured) && configured > 0
            ? Math.floor(configured)
            : FRAME_SIZE;
          this.frame = new Float32Array(this.frameSize);
          this.offset = 0;
          this.port.onmessage = (event) => {
            if (!event || !event.data || event.data.type !== 'flush') return;
            if (this.offset > 0) {
              const frame = this.frame.slice(0, this.offset);
              this.port.postMessage(frame.buffer, [frame.buffer]);
              this.frame = new Float32Array(this.frameSize);
              this.offset = 0;
            }
            this.port.postMessage({ type: 'flushed' });
          };
        }
        process(inputs) {
          const channel = inputs[0] && inputs[0][0];
          if (!channel) return true;
          let sourceOffset = 0;
          while (sourceOffset < channel.length) {
            const remaining = this.frameSize - this.offset;
            const available = channel.length - sourceOffset;
            const count = Math.min(remaining, available);
            this.frame.set(channel.subarray(sourceOffset, sourceOffset + count), this.offset);
            this.offset += count;
            sourceOffset += count;
            if (this.offset === this.frameSize) {
              const frame = this.frame;
              // Transfer ownership instead of cloning each render quantum.
              this.port.postMessage(frame.buffer, [frame.buffer]);
              this.frame = new Float32Array(this.frameSize);
              this.offset = 0;
            }
          }
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
      channelCountMode: "explicit",
      processorOptions: { frameSize: AUDIO_WORKLET_FRAME_SAMPLES },
    });
    this.bindWorkletProcessorError(this.worklet);
    this.worklet.port.onmessage = (
      event: MessageEvent<Float32Array | ArrayBuffer | { type?: string }>,
    ) => {
      try {
        if (event.data && typeof event.data === "object" && "type" in event.data) {
          if (event.data.type === "flushed") {
            this.finishWorkletFlush();
          }
          return;
        }
        // New worklet versions transfer an ArrayBuffer. Keep accepting a typed
        // view for compatibility with cached/older modules in a running WebView.
        if (event.data instanceof ArrayBuffer) {
          this.acceptSamples(new Float32Array(event.data));
        } else if (event.data instanceof Float32Array) {
          this.acceptSamples(event.data);
        }
      } catch (error) {
        // A message event is an audio callback boundary: report rather than
        // allowing a malformed frame/consumer to escape into the WebView.
        this.reportCaptureFailure(new AudioCaptureError("audio-chunk-delivery-failed", error));
      }
    };
    this.sink = this.context.createGain();
    this.sink.gain.value = AUDIO_GRAPH_KEEPALIVE_GAIN;
    this.source.connect(this.worklet);
    this.worklet.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  /** Report a terminal AudioWorklet processor crash once for this node. */
  private bindWorkletProcessorError(worklet: AudioWorkletNode): void {
    this.workletProcessorErrorReported = false;
    worklet.onprocessorerror = (event) => {
      if (this.disposed || this.worklet !== worklet || this.workletProcessorErrorReported) {
        return;
      }
      this.workletProcessorErrorReported = true;
      const detail = event.message?.trim() || "AudioWorklet processor stopped unexpectedly";
      // A continuous Parapper session has lost its PCM producer; legacy mode
      // instead lost a chunk-delivery node. Both cases are terminal and use
      // the existing owner teardown path, but retain their actionable codes.
      const code = this.streamPcmHandler
        ? "parapper-transport-failed"
        : "audio-chunk-delivery-failed";
      this.reportCaptureFailure(new AudioCaptureError(code, detail));
    };
  }

  private startScriptProcessor(): void {
    if (!this.context || !this.source) {
      throw new AudioCaptureError("audio-context-failed");
    }
    this.processor = this.context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
    this.processor.onaudioprocess = (event) => {
      try {
        // Copy: the AudioBuffer channel view is reused across callbacks.
        this.acceptSamples(event.inputBuffer.getChannelData(0).slice());
      } catch (error) {
        // Browser audio callbacks must never throw into the rendering thread.
        // Disable this node before notifying the owner so a broken callback
        // cannot produce an unbounded stream of repeated failures.
        if (this.processor) {
          this.processor.onaudioprocess = null;
        }
        this.reportCaptureFailure(new AudioCaptureError("audio-chunk-delivery-failed", error));
      }
    };
    this.sink = this.context.createGain();
    this.sink.gain.value = AUDIO_GRAPH_KEEPALIVE_GAIN;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  private acceptSamples(samples: Float32Array | ArrayBuffer): void {
    const frame = samples instanceof Float32Array ? samples : new Float32Array(samples);
    if (this.disposed || (!this.handler && !this.streamPcmHandler) || frame.length === 0) {
      return;
    }
    this.framesReceived += 1;

    // Live level meter: throttle UI callbacks so React is not flooded every audio quantum.
    const instantDb = calculateRmsDb(frame);
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

    // The continuous stream intentionally bypasses the renderer's RMS gate.
    // Parapper must observe the silence frames itself so its VAD, segmenter and
    // Turn detector can apply the configured timing and hysteresis. The
    // existing gate below remains active for legacy chunk callers/diagnostics.
    const streamPcmHandler = this.streamPcmHandler;
    if (streamPcmHandler) {
      try {
        const sampleRate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
        const target = resampleLinear(frame, sampleRate, TARGET_SAMPLE_RATE);
        const pcm = float32ToPcm16(target);
        streamPcmHandler(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice());
      } catch (error) {
        // A transport failure must not be retried on every audio quantum. Stop
        // forwarding frames and let the owner tear down the capture/session.
        this.streamPcmHandler = null;
        this.streamFramesDropped += 1;
        recordPipelineDrop("audio", 1, "stream-frame-delivery-failed");
        this.reportCaptureFailure(new AudioCaptureError("parapper-transport-failed", error));
      }
    }

    // In continuous mode the native Parapper VAD owns speech/silence
    // decisions. Do not also run the legacy renderer gate or report its drops
    // in diagnostics when there is no chunk handler.
    if (!this.handler) {
      return;
    }

    const next = new Float32Array(this.pending.length + frame.length);
    next.set(this.pending);
    next.set(frame, this.pending.length);
    this.pending = next;
    const sampleRate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
    // Re-normalize here as a final boundary check: private/test/legacy callers
    // can mutate a capture instance after start(), and a bad value must not
    // either make the while condition permanently false or flood one-sample
    // chunks into the legacy ASR queue.
    const chunkMs = resolveChunkMs(this.chunkMs);
    this.chunkMs = chunkMs;
    const chunkSize = Math.max(1, Math.round((sampleRate * chunkMs) / 1000));
    while (this.pending.length >= chunkSize) {
      const chunk = this.pending.slice(0, chunkSize);
      this.pending = this.pending.slice(chunkSize);
      const chunkDb = calculateRmsDb(chunk);
      // Adaptive floor gate by default: -54 dB speech over a -65 dB room floor
      // passes while ambient is rejected; silenceGateDb is the fixed fallback.
      const passed =
        this.gateMode === "adaptive"
          ? passesAdaptiveSilenceGate(this.adaptiveGate, chunkDb)
          : passesSilenceGate(chunkDb, this.silenceGateDb);
      // Do not learn an adaptive floor while the fixed gate is selected. This
      // keeps diagnostics truthful and prevents a future mode toggle from
      // inheriting stale samples from a different policy.
      if (this.gateMode === "adaptive") {
        updateAdaptiveSilenceGate(this.adaptiveGate, chunkDb, passed);
      }
      if (passed) {
        // Quiet speech that cleared the gate still benefits from modest peak
        // lift before 16 kHz encode (ambient ~-54 dB in a -65 dB room passes
        // the adaptive gate, so Parapper gets a boosted signal, not silence).
        const utteranceId = this.ensureUtteranceId(sampleRate);
        const contextual = this.rollingContext.append(chunk, sampleRate);
        const contextualDurationMs = partialAudioDurationMs(contextual.length, sampleRate);
        const normalized = applyPeakNormalize(contextual);
        this.chunksAccepted += 1;
        this.consecutiveAbsoluteFloorDrops = 0;
        this.lastAcceptedRmsDb = chunkDb;
        this.lastAcceptedGain = normalized.gain;
        if (isVerbosePipelineLogging()) {
          // biome-ignore lint/suspicious/noConsole: debug audio capture metrics
          if (typeof console !== "undefined" && typeof console.debug === "function") {
            // biome-ignore lint/suspicious/noConsole: debug audio capture metrics
            console.debug("[audio] chunk accepted", {
              rmsDb: Number(chunkDb.toFixed(1)),
              peak: Number(normalized.peak.toFixed(4)),
              gain: Number(normalized.gain.toFixed(2)),
              chunkMs: this.chunkMs,
              contextMs: Number(contextualDurationMs.toFixed(1)),
              sampleRate,
              gateMode: this.gateMode,
              adaptiveFloorDb:
                this.adaptiveGate.floorDb === null
                  ? null
                  : Number(this.adaptiveGate.floorDb.toFixed(1)),
              accepted: this.chunksAccepted,
              silentDrops: this.chunksDroppedSilent,
            });
          }
        }
        this.deliverChunk(
          makeAudioChunk(normalized.samples, sampleRate, contextualDurationMs, { utteranceId }),
        );
      } else {
        this.rollingContext.markSilence(partialAudioDurationMs(chunk.length, sampleRate));
        if (!this.rollingContext.hasContext()) {
          // The next accepted window starts a new utterance after a full gated
          // pause; do not let it reuse the prior request's correlation key.
          this.utteranceId = null;
        }
        this.recordSilentDrop(chunkDb);
        if (
          isVerbosePipelineLogging() &&
          (this.chunksDroppedSilent <= 3 || this.chunksDroppedSilent % 20 === 0)
        ) {
          // biome-ignore lint/suspicious/noConsole: debug audio capture metrics
          if (typeof console !== "undefined" && typeof console.debug === "function") {
            // biome-ignore lint/suspicious/noConsole: debug audio capture metrics
            console.debug("[audio] chunk dropped (silence gate)", {
              rmsDb: Number.isFinite(chunkDb) ? Number(chunkDb.toFixed(1)) : chunkDb,
              gateMode: this.gateMode,
              silenceGateDb: this.silenceGateDb,
              adaptiveFloorDb:
                this.adaptiveGate.floorDb === null
                  ? null
                  : Number(this.adaptiveGate.floorDb.toFixed(1)),
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

  /**
   * Deliver an accepted legacy chunk without allowing a consumer exception to
   * escape an AudioWorklet/ScriptProcessor callback. A rejected consumer means
   * the chunk was lost, so disable further legacy delivery and surface it.
   */
  private deliverChunk(chunk: AudioChunk): void {
    const handler = this.handler;
    if (!handler) {
      return;
    }
    try {
      const delivery = handler(chunk);
      if (delivery && typeof delivery.then === "function") {
        void delivery.catch((error: unknown) => this.handleChunkDeliveryFailure(error));
      }
    } catch (error) {
      this.handleChunkDeliveryFailure(error);
    }
  }

  private handleChunkDeliveryFailure(error: unknown): void {
    if (!this.handler) {
      return;
    }
    // A broken consumer should not repeatedly reject every capture window
    // while the owner tears down the session.
    this.handler = null;
    this.reportCaptureFailure(new AudioCaptureError("audio-chunk-delivery-failed", error));
  }
}
/* c8 ignore stop */
