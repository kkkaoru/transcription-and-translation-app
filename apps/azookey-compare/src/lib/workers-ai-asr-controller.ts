import type { ComparisonAuth } from "./contract";
import { blobToPcm16Mono, blobToWavFile, pcm16ToWavBytes, pcmDurationSeconds } from "./pcm-wav";
import { transcribeWorkersAiAsr } from "./workers-ai-asr-client";

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

type MediaRecorderLike = {
  state: string;
  start: () => void;
  stop: () => void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: { error?: DOMException }) => void) | null;
};

type NavigatorWithMedia = Navigator & {
  mediaDevices?: {
    getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  };
};

export class WorkersAiAsrController {
  readonly supported: boolean;

  private readonly options: WorkersAiAsrControllerOptions;
  private state: WorkersAiAsrState = "idle";
  private stream: MediaStream | null = null;
  private recorder: MediaRecorderLike | null = null;
  private chunks: Blob[] = [];
  private requestedStop = false;
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
    if (this.disposed || !this.supported || this.state === "listening" || this.state === "starting") {
      return;
    }
    this.requestedStop = false;
    this.setState("starting");
    try {
      const nav = navigator as NavigatorWithMedia;
      this.stream = await nav.mediaDevices!.getUserMedia({ audio: true });
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
      recorder.onstop = () => {
        void this.flushRecording();
      };
      recorder.start();
      this.setState("listening");
      this.options.onTranscript?.({ interimText: "録音中…" });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "マイクを開始できません");
    }
  }

  public stop(): void {
    if (this.disposed || !this.recorder || this.requestedStop) {
      return;
    }
    this.requestedStop = true;
    this.setState("stopping");
    if (this.recorder.state !== "inactive") {
      this.recorder.stop();
    } else {
      void this.flushRecording();
    }
    this.stopTracks();
  }

  public dispose(): void {
    this.disposed = true;
    this.requestedStop = true;
    this.stopTracks();
    this.recorder = null;
    this.setState("idle");
  }

  private async flushRecording(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || "audio/webm" });
    this.chunks = [];
    if (blob.size === 0) {
      this.fail("録音データがありません");
      return;
    }
    try {
      const pcm = await blobToPcm16Mono(blob);
      const wav = new File([pcm16ToWavBytes(pcm)], "utterance.wav", { type: "audio/wav" });
      const audioSeconds = pcmDurationSeconds(pcm);
      const result = await transcribeWorkersAiAsr(wav, {
        endpointUrl: this.options.endpointUrl,
        language: this.options.language,
        auth: this.options.auth,
      });
      const text = result.text.trim();
      this.options.onTranscript?.({ interimText: "" });
      if (text) {
        this.options.onFinalText?.(text);
      }
      this.options.onUtteranceFinal?.({ text, audioSeconds });
      this.setState("idle");
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Workers AI ASR failed");
    }
  }

  private stopTracks(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
  }

  private fail(message: string): void {
    this.setState("error");
    this.options.onError?.(message);
    this.stopTracks();
  }

  private setState(next: WorkersAiAsrState): void {
    this.state = next;
    this.options.onStateChange?.(next);
  }
}
