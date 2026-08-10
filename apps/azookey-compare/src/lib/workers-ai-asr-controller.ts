import type { ComparisonAuth } from "./contract";
import { blobToPcm16Mono, pcm16ToWavBytes } from "./pcm-wav";
import { transcribeWorkersAiAsr } from "./workers-ai-asr-client";
import { audioSecondsFromPcmLength } from "./workers-ai-asr-cost";
import { SileroWasmVadEngine } from "./workers-ai-asr-silero";
import { SILERO_FALLBACK_NOTICE_JA } from "./workers-ai-asr-silero-paths";
import {
  EnergyVadEngine,
  resampleMono,
  SILERO_CHUNK_SAMPLES,
  SILERO_SAMPLE_RATE,
  type VadEngine,
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

type AudioContextCtor = new () => AudioContext;

const PCM_TAP_BUFFER_SIZE = 4096;
const RECORDING_INTERIM = "録音中…";
const TRANSCRIBING_INTERIM = "認識中…";

const audioContextConstructor = (): AudioContextCtor | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }
  const standard = window.AudioContext;
  if (typeof standard === "function") {
    return standard;
  }
  const webkit = (window as unknown as { webkitAudioContext?: AudioContextCtor })
    .webkitAudioContext;
  return typeof webkit === "function" ? webkit : undefined;
};

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
  private resampleRemainder = new Float32Array(0);
  private sileroRemainder = new Float32Array(0);
  private requestedStop = false;
  private captureActive = false;
  private flushing = false;
  private hadCommittedSpeech = false;
  private disposed = false;

  public constructor(language: string, options: WorkersAiAsrControllerOptions) {
    this.options = { ...options, language };
    const nav = typeof navigator !== "undefined" ? (navigator as NavigatorWithMedia) : undefined;
    this.supported = Boolean(
      typeof window !== "undefined" &&
        nav?.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== "undefined",
    );
  }

  public get currentState(): WorkersAiAsrState {
    return this.state;
  }

  public get vadBackend(): WorkersAiAsrVadBackend {
    return this.engineKind;
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
      await this.setupAudioGraph(this.stream);
      await this.resolveEngine();
      this.setState("listening");
      this.options.onTranscript?.({ interimText: "" });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "マイクを開始できません");
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
    const engine = this.engine ?? new EnergyVadEngine();
    const result = await engine.process(samples);
    await this.applyVadEvents(this.vad.pushVadResult(result, samples));
  }

  private async resolveEngine(): Promise<void> {
    if (this.options.vadEngine) {
      this.engine = this.options.vadEngine;
      this.engineKind = "silero";
      return;
    }
    if (this.options.disableSilero) {
      this.engine = new EnergyVadEngine();
      this.engineKind = "energy";
      return;
    }
    try {
      this.engine = this.options.sileroLoader
        ? await this.options.sileroLoader()
        : await this.createDefaultSilero();
      this.engineKind = "silero";
    } catch {
      this.engine = new EnergyVadEngine();
      this.engineKind = "energy";
      this.options.onVadNotice?.(SILERO_FALLBACK_NOTICE_JA);
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
      return;
    }
    const audioContext = new Context();
    this.audioContext = audioContext;
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    if (typeof audioContext.createScriptProcessor !== "function") {
      return;
    }
    const source = audioContext.createMediaStreamSource(stream);
    const tap = audioContext.createScriptProcessor(PCM_TAP_BUFFER_SIZE, 1, 1);
    tap.onaudioprocess = (event) => {
      void this.onPcmTap(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
    };
    source.connect(tap);
    tap.connect(audioContext.destination);
    this.pcmSource = source;
    this.pcmTap = tap;
  }

  private teardownPcmTap(): void {
    if (this.pcmTap) {
      try {
        this.pcmTap.disconnect();
      } catch {
        // Already disconnected.
      }
      this.pcmTap.onaudioprocess = null;
    }
    if (this.pcmSource) {
      try {
        this.pcmSource.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.pcmTap = null;
    this.pcmSource = null;
    this.resampleRemainder = new Float32Array(0);
    this.sileroRemainder = new Float32Array(0);
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
      const result = await this.engine.process(chunk);
      if (this.disposed || this.requestedStop || this.flushing || this.state !== "listening") {
        return;
      }
      await this.applyVadEvents(this.vad.pushVadResult(result, chunk));
      offset += SILERO_CHUNK_SAMPLES;
    }
    this.sileroRemainder = pending.subarray(offset);
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
        await this.flushRecording({ restart: !this.requestedStop, requireSpeech: false });
      }
    }
  }

  private ensureRecorder(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      return;
    }
    this.beginRecorder();
  }

  private beginRecorder(): void {
    if (!this.stream) {
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
    recorder.onerror = (event) => {
      this.fail(event.error?.message ?? "MediaRecorder failed");
    };
    recorder.start();
  }

  private discardRecorder(): void {
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

  private async flushRecording(options: {
    restart: boolean;
    requireSpeech: boolean;
  }): Promise<void> {
    if (this.disposed || this.flushing) {
      return;
    }
    this.flushing = true;
    const hasSpeech = this.hadCommittedSpeech || this.vad.currentPhase === "speech";
    const blob = await this.stopRecorder();
    this.hadCommittedSpeech = false;
    this.vad.reset();

    if (this.disposed) {
      this.flushing = false;
      return;
    }

    if (options.requireSpeech && !hasSpeech) {
      this.options.onTranscript?.({ interimText: "" });
      this.completeSessionOrRestart(options.restart);
      return;
    }

    if (blob.size === 0) {
      this.flushing = false;
      this.fail("録音データがありません");
      return;
    }

    try {
      this.options.onTranscript?.({ interimText: TRANSCRIBING_INTERIM });
      const pcm = await blobToPcm16Mono(blob);
      const wav = new File([pcm16ToWavBytes(pcm)], "utterance.wav", { type: "audio/wav" });
      const audioSeconds = audioSecondsFromPcmLength(pcm.length);
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
      this.fail(error instanceof Error ? error.message : "Workers AI ASR failed");
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

  private fail(message: string): void {
    this.teardownPcmTap();
    this.discardRecorder();
    this.stopTracks();
    void this.closeAudioContext();
    this.captureActive = false;
    this.setState("error");
    this.options.onError?.(message);
  }

  private setState(next: WorkersAiAsrState): void {
    this.state = next;
    this.options.onStateChange?.(next);
  }
}

export { WORKERS_AI_ASR_VAD_DEFAULTS };
