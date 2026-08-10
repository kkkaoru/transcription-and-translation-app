import type { ComparisonAuth } from "./contract";
import { blobToPcm16Mono, pcm16ToWavBytes, pcmDurationSeconds } from "./pcm-wav";
import { transcribeWorkersAiAsr } from "./workers-ai-asr-client";
import {
  rmsDbFromTimeDomainBytes,
  WorkersAiAsrVad,
  type WorkersAiAsrVadEvent,
} from "./workers-ai-asr-vad";

export type WorkersAiAsrState = "idle" | "starting" | "listening" | "stopping" | "error";

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
  onStateChange?: (state: WorkersAiAsrState) => void;
  onTranscript?: (update: WorkersAiAsrTranscriptUpdate) => void;
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

const VAD_POLL_MS = 50;
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
  private state: WorkersAiAsrState = "idle";
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timeDomain = new Uint8Array(0);
  private vadTimer: ReturnType<typeof setInterval> | null = null;
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
      await this.setupAnalyser(this.stream);
      this.startVadPolling();
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
    this.stopVadPolling();
    this.setState("stopping");
    await this.flushRecording({ restart: false, requireSpeech: true });
  }

  public dispose(): void {
    this.disposed = true;
    this.requestedStop = true;
    this.captureActive = false;
    this.stopVadPolling();
    this.discardRecorder();
    this.stopTracks();
    void this.closeAnalyser();
    this.setState("idle");
  }

  /**
   * Test / injection seam: feed synthetic RMS frames without getUserMedia.
   * Production uses AnalyserNode polling on the same path.
   */
  public async ingestVadFrame(rmsDb: number, durationMs: number): Promise<void> {
    if (this.disposed || this.requestedStop || this.flushing || this.state !== "listening") {
      return;
    }
    await this.applyVadEvents(this.vad.pushFrame({ rmsDb, durationMs }));
  }

  private async setupAnalyser(stream: MediaStream): Promise<void> {
    const Context = audioContextConstructor();
    if (!Context) {
      return;
    }
    const audioContext = new Context();
    this.audioContext = audioContext;
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    this.analyser = analyser;
    this.timeDomain = new Uint8Array(analyser.fftSize);
  }

  private startVadPolling(): void {
    if (this.vadTimer !== null || !this.analyser) {
      return;
    }
    this.vadTimer = setInterval(() => {
      void this.pollVad();
    }, VAD_POLL_MS);
  }

  private stopVadPolling(): void {
    if (this.vadTimer === null) {
      return;
    }
    clearInterval(this.vadTimer);
    this.vadTimer = null;
  }

  private async pollVad(): Promise<void> {
    if (
      !this.analyser ||
      this.disposed ||
      this.requestedStop ||
      this.flushing ||
      this.state !== "listening"
    ) {
      return;
    }
    this.analyser.getByteTimeDomainData(this.timeDomain);
    await this.applyVadEvents(
      this.vad.pushFrame({
        rmsDb: rmsDbFromTimeDomainBytes(this.timeDomain),
        durationMs: VAD_POLL_MS,
      }),
    );
  }

  private async applyVadEvents(events: WorkersAiAsrVadEvent[]): Promise<void> {
    for (const event of events) {
      if (this.disposed || this.requestedStop) {
        return;
      }
      if (event.type === "candidate-start" || event.type === "utterance-start") {
        if (event.type === "utterance-start") {
          this.hadCommittedSpeech = true;
        }
        this.ensureRecorder();
        this.options.onTranscript?.({ interimText: RECORDING_INTERIM });
      } else if (event.type === "candidate-cancel") {
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
      const audioSeconds = pcmDurationSeconds(pcm);
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
      this.stopVadPolling();
      this.stopTracks();
      void this.closeAnalyser();
      this.options.onTranscript?.({ interimText: "" });
      this.setState("idle");
      return;
    }
    this.startVadPolling();
    this.setState("listening");
  }

  private stopTracks(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
  }

  private async closeAnalyser(): Promise<void> {
    this.analyser = null;
    this.timeDomain = new Uint8Array(0);
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
    this.stopVadPolling();
    this.discardRecorder();
    this.stopTracks();
    void this.closeAnalyser();
    this.captureActive = false;
    this.setState("error");
    this.options.onError?.(message);
  }

  private setState(next: WorkersAiAsrState): void {
    this.state = next;
    this.options.onStateChange?.(next);
  }
}
