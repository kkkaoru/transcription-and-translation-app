import type { ComparisonAuth } from "./contract";
import { blobToPcm16Mono, pcm16ToWavBytes } from "./pcm-wav";
import { transcribeWorkersAiAsr } from "./workers-ai-asr-client";
import { audioSecondsFromPcmLength } from "./workers-ai-asr-cost";
import { SileroWasmVadEngine } from "./workers-ai-asr-silero";
import { SILERO_FALLBACK_NOTICE_JA } from "./workers-ai-asr-silero-paths";
import {
  audioContextConstructor,
  getUserMediaErrorMessageJa,
  hasMediaRecorderSupport,
  isWorkersAiAsrCaptureSupported,
  WORKERS_AI_ASR_GRAPH_UNAVAILABLE_JA,
  wavFileFromPcmFloat32,
} from "./workers-ai-asr-support";
import {
  EnergyVadEngine,
  resampleMono,
  SILERO_CHUNK_SAMPLES,
  SILERO_SAMPLE_RATE,
  type VadEngine,
  type VadResult,
  WORKERS_AI_ASR_VAD_DEFAULTS,
  WorkersAiAsrVad,
  type WorkersAiAsrVadEvent,
} from "./workers-ai-asr-vad";

export type WorkersAiAsrState = "idle" | "starting" | "listening" | "stopping" | "error";
export type WorkersAiAsrVadBackend = "silero" | "energy";

export interface WorkersAiAsrTranscriptUpdate {
  interimText: string;
}

export interface WorkersAiAsrUtteranceFinal {
  text: string;
  audioSeconds: number;
}

export interface WorkersAiAsrControllerOptions {
  language: string;
  endpointUrl?: string;
  auth?: ComparisonAuth;
  /** Test seam: skip Silero ONNX/ORT download. Production leaves this unset. */
  disableSilero?: boolean;
  /** Test seam: inject a VAD engine (Silero mock or energy). */
  vadEngine?: VadEngine;
  /** Test seam: custom Silero loader. Production uses onnxruntime-web WASM. */
  sileroLoader?: () => Promise<VadEngine>;
  onStateChange?: (state: WorkersAiAsrState) => void;
  onTranscript?: (update: WorkersAiAsrTranscriptUpdate) => void;
  onVadNotice?: (message: string) => void;
  onFinalText?: (text: string) => void;
  onUtteranceFinal?: (payload: WorkersAiAsrUtteranceFinal) => void;
  onError?: (message: string) => void;
}

type NavigatorWithMedia = Navigator & {
  mediaDevices?: {
    getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  };
};

const PCM_TAP_BUFFER_SIZE = 4096;
const RECORDING_TIMESLICE_MS = 250;
const RECORDING_INTERIM = "録音中…";
const TRANSCRIBING_INTERIM = "認識中…";

export class WorkersAiAsrController {
  readonly supported: boolean;

  private readonly options: WorkersAiAsrControllerOptions;
  private readonly vad = new WorkersAiAsrVad();
  private engine: VadEngine | null = null;
  private engineKind: WorkersAiAsrVadBackend = "energy";
  private state: WorkersAiAsrState = "idle";
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private audioContext: AudioContext | null = null;
  private pcmTap: ScriptProcessorNode | null = null;
  private pcmSource: MediaStreamAudioSourceNode | null = null;
  private tapGain: GainNode | null = null;
  private tapDestination: MediaStreamAudioDestinationNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserTimer: ReturnType<typeof setInterval> | null = null;
  private resampleRemainder = new Float32Array(0);
  private sileroRemainder = new Float32Array(0);
  private pcmFrames: Float32Array[] = [];
  private capturingPcm = false;
  private requestedStop = false;
  private captureActive = false;
  private flushing = false;
  private hadCommittedSpeech = false;
  private disposed = false;

  public constructor(language: string, options: WorkersAiAsrControllerOptions) {
    this.options = { ...options, language };
    this.supported = isWorkersAiAsrCaptureSupported();
  }

  public get currentState(): WorkersAiAsrState {
    return this.state;
  }

  public get vadBackend(): WorkersAiAsrVadBackend {
    return this.engineKind;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public matchesTransport(endpointUrl?: string, auth?: ComparisonAuth): boolean {
    return (
      (this.options.endpointUrl ?? "") === (endpointUrl ?? "") &&
      (this.options.auth?.scheme ?? "none") === (auth?.scheme ?? "none") &&
      (this.options.auth?.token ?? "") === (auth?.token ?? "")
    );
  }

  public setLanguage(language: string): void {
    this.options.language = language.trim() || this.options.language;
  }

  public async start(): Promise<void> {
    if (
      this.disposed ||
      !this.supported ||
      this.state === "listening" ||
      this.state === "starting"
    ) {
      return;
    }
    this.requestedStop = false;
    this.captureActive = true;
    this.hadCommittedSpeech = false;
    this.vad.reset();
    this.setState("starting");
    try {
      const getUserMedia = (navigator as NavigatorWithMedia).mediaDevices?.getUserMedia;
      if (!getUserMedia) {
        throw new Error("マイクを開始できません");
      }
      this.stream = await getUserMedia({ audio: true });
      if (this.shouldAbortStart()) {
        this.stopTracks();
        return;
      }
      try {
        await this.setupAudioGraph(this.stream);
      } catch {
        if (hasMediaRecorderSupport()) {
          this.ensureTimesliceRecorder();
        } else {
          throw new Error(WORKERS_AI_ASR_GRAPH_UNAVAILABLE_JA);
        }
      }
      if (this.shouldAbortStart()) {
        return;
      }
      this.resolveEngine();
      if (this.shouldAbortStart()) {
        this.releaseEngine();
        return;
      }
      this.setState("listening");
      this.options.onTranscript?.({ interimText: "" });
    } catch (error) {
      if (this.shouldAbortStart()) {
        return;
      }
      this.fail(getUserMediaErrorMessageJa(error));
    }
  }

  public async stop(): Promise<void> {
    if (this.disposed || this.requestedStop || !this.captureActive) {
      return;
    }
    this.requestedStop = true;
    this.captureActive = false;
    this.teardownPcmTap();
    this.setState("stopping");
    await this.flushRecording({ restart: false, requireSpeech: true });
  }

  public dispose(): void {
    this.disposed = true;
    this.requestedStop = true;
    this.captureActive = false;
    this.teardownPcmTap();
    this.discardRecorder();
    this.stopTracks();
    void this.closeAudioContext();
    this.releaseEngine();
    this.setState("idle");
  }

  /**
   * Test / injection seam: feed synthetic RMS frames without getUserMedia.
   * Production uses 16 kHz PCM → Silero (or energy fallback).
   */
  public async ingestVadFrame(rmsDb: number, durationMs: number): Promise<void> {
    if (this.disposed || this.requestedStop || this.flushing || this.state !== "listening") {
      return;
    }
    await this.applyVadEvents(this.vad.pushFrame({ rmsDb, durationMs }));
  }

  public async ingestSamples(samples: Float32Array): Promise<void> {
    if (this.disposed || this.requestedStop || this.flushing || this.state !== "listening") {
      return;
    }
    const result = await this.processWithFallback(samples);
    if (
      !result ||
      this.disposed ||
      this.requestedStop ||
      this.flushing ||
      this.state !== "listening"
    ) {
      return;
    }
    await this.applyVadEvents(this.vad.pushVadResult(result, samples));
  }

  private resolveEngine(): void {
    try {
      if (this.options.vadEngine) {
        this.engine = this.options.vadEngine;
        this.engineKind = "silero";
        return;
      }
      this.engine = new EnergyVadEngine();
      this.engineKind = "energy";
      if (this.options.disableSilero) {
        return;
      }
      void this.upgradeToSilero();
    } catch {
      this.engine = new EnergyVadEngine();
      this.engineKind = "energy";
      this.options.onVadNotice?.(SILERO_FALLBACK_NOTICE_JA);
    }
  }

  private async upgradeToSilero(): Promise<void> {
    try {
      const silero = this.options.sileroLoader
        ? await this.options.sileroLoader()
        : await this.createDefaultSilero();
      if (this.shouldAbortStart()) {
        try {
          silero.dispose?.();
        } catch {
          // Drop unused Silero after dispose/stop.
        }
        return;
      }
      const previous = this.engine;
      this.engine = silero;
      this.engineKind = "silero";
      if (previous && previous !== silero) {
        try {
          previous.dispose?.();
        } catch {
          // Energy dispose is best effort before Silero takes over.
        }
      }
    } catch {
      if (this.shouldAbortStart()) {
        return;
      }
      if (this.engineKind !== "energy" || !this.engine) {
        this.engine = new EnergyVadEngine();
        this.engineKind = "energy";
      }
      this.options.onVadNotice?.(SILERO_FALLBACK_NOTICE_JA);
    }
  }

  private fallbackToEnergy(): void {
    if (this.engineKind === "energy" && this.engine) {
      return;
    }
    try {
      this.engine?.dispose?.();
    } catch {
      // Drop Silero even if dispose throws.
    }
    this.engine = new EnergyVadEngine();
    this.engineKind = "energy";
    this.options.onVadNotice?.(SILERO_FALLBACK_NOTICE_JA);
  }

  private async processWithFallback(samples: Float32Array): Promise<VadResult | null> {
    const engine = this.engine ?? new EnergyVadEngine();
    if (!this.engine) {
      this.engine = engine;
      this.engineKind = "energy";
    }
    try {
      return await engine.process(samples);
    } catch {
      if (this.engineKind !== "silero") {
        return null;
      }
      this.fallbackToEnergy();
      try {
        return await this.engine.process(samples);
      } catch {
        return null;
      }
    }
  }

  private async createDefaultSilero(): Promise<VadEngine> {
    const silero = new SileroWasmVadEngine();
    await silero.init();
    return silero;
  }

  private releaseEngine(): void {
    try {
      this.engine?.dispose?.();
    } catch {
      // Leaving Workers AI ASR must drop ORT even if release throws.
    }
    this.engine = null;
    this.engineKind = "energy";
  }

  private async setupAudioGraph(stream: MediaStream): Promise<void> {
    const Context = audioContextConstructor();
    if (!Context) {
      if (hasMediaRecorderSupport()) {
        this.ensureTimesliceRecorder();
        return;
      }
      throw new Error(WORKERS_AI_ASR_GRAPH_UNAVAILABLE_JA);
    }
    try {
      const audioContext = new Context();
      this.audioContext = audioContext;
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      if (this.shouldAbortStart()) {
        return;
      }
      const source = audioContext.createMediaStreamSource(stream);
      this.pcmSource = source;

      if (typeof audioContext.createScriptProcessor === "function") {
        const tap = audioContext.createScriptProcessor(PCM_TAP_BUFFER_SIZE, 1, 1);
        tap.onaudioprocess = (event) => {
          void this.onPcmTap(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
        };
        source.connect(tap);
        if (typeof audioContext.createMediaStreamDestination === "function") {
          const destination = audioContext.createMediaStreamDestination();
          tap.connect(destination);
          this.tapDestination = destination;
        } else if (typeof audioContext.createGain === "function") {
          const gain = audioContext.createGain();
          gain.gain.value = 0;
          tap.connect(gain);
          this.tapGain = gain;
        }
        this.pcmTap = tap;
        return;
      }

      if (typeof audioContext.createAnalyser === "function") {
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = PCM_TAP_BUFFER_SIZE;
        source.connect(analyser);
        this.analyser = analyser;
        const buffer = new Float32Array(analyser.fftSize);
        const sampleRate = audioContext.sampleRate;
        this.analyserTimer = setInterval(() => {
          if (this.disposed || this.requestedStop || this.state !== "listening") {
            return;
          }
          analyser.getFloatTimeDomainData(buffer);
          void this.onPcmTap(Float32Array.from(buffer), sampleRate);
        }, WORKERS_AI_ASR_VAD_DEFAULTS.vadIntervalMs);
        return;
      }

      if (hasMediaRecorderSupport()) {
        this.ensureTimesliceRecorder();
        return;
      }
      throw new Error(WORKERS_AI_ASR_GRAPH_UNAVAILABLE_JA);
    } catch (error) {
      if (error instanceof Error && error.message === WORKERS_AI_ASR_GRAPH_UNAVAILABLE_JA) {
        throw error;
      }
      if (hasMediaRecorderSupport()) {
        this.ensureTimesliceRecorder();
        return;
      }
      throw new Error(WORKERS_AI_ASR_GRAPH_UNAVAILABLE_JA);
    }
  }

  private teardownPcmTap(): void {
    if (this.analyserTimer !== null) {
      clearInterval(this.analyserTimer);
      this.analyserTimer = null;
    }
    if (this.pcmTap) {
      try {
        this.pcmTap.disconnect();
      } catch {
        // Already disconnected.
      }
      this.pcmTap.onaudioprocess = null;
    }
    if (this.tapGain) {
      try {
        this.tapGain.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    if (this.tapDestination) {
      try {
        this.tapDestination.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    if (this.pcmSource) {
      try {
        this.pcmSource.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.pcmTap = null;
    this.tapGain = null;
    this.tapDestination = null;
    this.analyser = null;
    this.pcmSource = null;
    this.resampleRemainder = new Float32Array(0);
    this.sileroRemainder = new Float32Array(0);
    this.pcmFrames = [];
    this.capturingPcm = false;
  }

  private async onPcmTap(channel: Float32Array, sampleRate: number): Promise<void> {
    if (
      this.disposed ||
      this.requestedStop ||
      this.flushing ||
      this.state !== "listening" ||
      !this.engine
    ) {
      return;
    }
    try {
      const withRemainder = new Float32Array(this.resampleRemainder.length + channel.length);
      withRemainder.set(this.resampleRemainder, 0);
      withRemainder.set(channel, this.resampleRemainder.length);
      const resampled = resampleMono(withRemainder, sampleRate, SILERO_SAMPLE_RATE);
      const consumedNative = Math.min(
        withRemainder.length,
        Math.floor((resampled.length * sampleRate) / SILERO_SAMPLE_RATE),
      );
      this.resampleRemainder = withRemainder.subarray(consumedNative);

      const pending = new Float32Array(this.sileroRemainder.length + resampled.length);
      pending.set(this.sileroRemainder, 0);
      pending.set(resampled, this.sileroRemainder.length);
      let offset = 0;
      while (offset + SILERO_CHUNK_SAMPLES <= pending.length) {
        const chunk = pending.subarray(offset, offset + SILERO_CHUNK_SAMPLES);
        if (this.capturingPcm) {
          this.pcmFrames.push(Float32Array.from(chunk));
        }
        const result = await this.processWithFallback(chunk);
        if (
          !result ||
          this.disposed ||
          this.requestedStop ||
          this.flushing ||
          this.state !== "listening"
        ) {
          return;
        }
        await this.applyVadEvents(this.vad.pushVadResult(result, chunk));
        offset += SILERO_CHUNK_SAMPLES;
      }
      this.sileroRemainder = pending.subarray(offset);
    } catch {
      this.fallbackToEnergy();
    }
  }

  private async applyVadEvents(events: WorkersAiAsrVadEvent[]): Promise<void> {
    for (const event of events) {
      if (this.disposed || this.requestedStop) {
        return;
      }
      if (event.type === "pending-start") {
        this.ensureRecorder();
      } else if (event.type === "utterance-start") {
        this.hadCommittedSpeech = true;
        this.ensureRecorder();
        this.options.onTranscript?.({ interimText: RECORDING_INTERIM });
      } else if (event.type === "pending-cancel") {
        this.discardRecorder();
        this.options.onTranscript?.({ interimText: "" });
      } else if (event.type === "utterance-end") {
        this.hadCommittedSpeech = true;
        this.options.onTranscript?.({ interimText: TRANSCRIBING_INTERIM });
        await this.flushRecording({
          restart: !this.requestedStop,
          requireSpeech: false,
          pcm: event.fullAudio,
        });
      }
    }
  }

  private ensureRecorder(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      return;
    }
    this.beginRecorder();
  }

  private ensureTimesliceRecorder(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      return;
    }
    this.beginRecorder(RECORDING_TIMESLICE_MS);
  }

  private beginRecorder(timesliceMs?: number): void {
    this.capturingPcm = true;
    this.pcmFrames = [];
    if (!this.stream || !hasMediaRecorderSupport()) {
      return;
    }
    this.chunks = [];
    const recorder = new MediaRecorder(this.stream);
    this.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };
    recorder.onerror = () => {
      this.fail("録音に失敗しました");
    };
    if (typeof timesliceMs === "number" && timesliceMs > 0) {
      recorder.start(timesliceMs);
      return;
    }
    recorder.start();
  }

  private discardRecorder(): void {
    this.capturingPcm = false;
    this.pcmFrames = [];
    const recorder = this.recorder;
    this.recorder = null;
    this.chunks = [];
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    try {
      recorder.stop();
    } catch {
      // Already inactive; discard is best effort.
    }
  }

  private stopRecorder(): Promise<Blob> {
    return new Promise((resolve) => {
      const recorder = this.recorder;
      const finish = (): void => {
        const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || "audio/webm" });
        this.chunks = [];
        this.recorder = null;
        resolve(blob);
      };
      if (!recorder || recorder.state === "inactive") {
        finish();
        return;
      }
      recorder.onstop = finish;
      recorder.stop();
    });
  }

  private takeCapturedPcm(): Float32Array | undefined {
    this.capturingPcm = false;
    if (this.pcmFrames.length === 0) {
      return undefined;
    }
    let total = 0;
    for (const frame of this.pcmFrames) {
      total += frame.length;
    }
    const merged = new Float32Array(total);
    let offset = 0;
    for (const frame of this.pcmFrames) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    this.pcmFrames = [];
    return merged.length >= SILERO_CHUNK_SAMPLES ? merged : undefined;
  }

  private async flushRecording(options: {
    restart: boolean;
    requireSpeech: boolean;
    pcm?: Float32Array;
  }): Promise<void> {
    if (this.disposed || this.flushing) {
      return;
    }
    this.flushing = true;
    const hasSpeech = this.hadCommittedSpeech || this.vad.currentPhase === "speech";
    const usablePcm =
      options.pcm && options.pcm.length >= SILERO_CHUNK_SAMPLES
        ? options.pcm
        : this.takeCapturedPcm();
    const blob = usablePcm ? null : await this.stopRecorder();
    this.hadCommittedSpeech = false;
    this.vad.reset();
    this.capturingPcm = false;
    this.pcmFrames = [];

    if (this.disposed) {
      this.flushing = false;
      return;
    }

    if (options.requireSpeech && !hasSpeech) {
      this.options.onTranscript?.({ interimText: "" });
      this.completeSessionOrRestart(options.restart);
      return;
    }

    try {
      this.options.onTranscript?.({ interimText: TRANSCRIBING_INTERIM });
      let wav: File;
      let audioSeconds: number;
      if (usablePcm) {
        wav = wavFileFromPcmFloat32(usablePcm);
        audioSeconds = audioSecondsFromPcmLength(usablePcm.length);
      } else if (blob && blob.size > 0) {
        const pcm = await blobToPcm16Mono(blob);
        wav = new File([pcm16ToWavBytes(pcm)], "utterance.wav", { type: "audio/wav" });
        audioSeconds = audioSecondsFromPcmLength(pcm.length);
      } else {
        this.flushing = false;
        this.fail("録音データがありません");
        return;
      }
      if (this.disposed) {
        this.flushing = false;
        return;
      }
      const result = await transcribeWorkersAiAsr(wav, {
        endpointUrl: this.options.endpointUrl,
        language: this.options.language,
        auth: this.options.auth,
      });
      if (this.disposed) {
        this.flushing = false;
        return;
      }
      const text = result.text.trim();
      this.options.onTranscript?.({ interimText: "" });
      if (text) {
        this.options.onFinalText?.(text);
      }
      this.options.onUtteranceFinal?.({ text, audioSeconds });
      this.completeSessionOrRestart(options.restart);
    } catch (error) {
      this.flushing = false;
      this.fail(
        error instanceof Error && error.message.trim() ? error.message : "認識に失敗しました",
      );
    }
  }

  private completeSessionOrRestart(restart: boolean): void {
    this.flushing = false;
    if (this.disposed) {
      return;
    }
    if (!restart || this.requestedStop) {
      this.teardownPcmTap();
      this.stopTracks();
      void this.closeAudioContext();
      this.options.onTranscript?.({ interimText: "" });
      this.setState("idle");
      return;
    }
    this.setState("listening");
  }

  private stopTracks(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
  }

  private async closeAudioContext(): Promise<void> {
    this.teardownPcmTap();
    const audioContext = this.audioContext;
    this.audioContext = null;
    if (!audioContext || audioContext.state === "closed") {
      return;
    }
    try {
      await audioContext.close();
    } catch {
      // Closing is best effort during dispose/fail.
    }
  }

  private shouldAbortStart(): boolean {
    return this.disposed || this.requestedStop;
  }

  private fail(message: string): void {
    if (this.disposed) {
      return;
    }
    this.teardownPcmTap();
    this.discardRecorder();
    this.stopTracks();
    void this.closeAudioContext();
    this.captureActive = false;
    this.setState("error");
    this.options.onError?.(message);
  }

  private setState(next: WorkersAiAsrState): void {
    if (this.disposed && next !== "idle") {
      return;
    }
    this.state = next;
    this.options.onStateChange?.(next);
  }
}

export { WORKERS_AI_ASR_VAD_DEFAULTS };
