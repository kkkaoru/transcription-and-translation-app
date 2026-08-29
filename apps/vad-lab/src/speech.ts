// Runs in the browser; built and tested with Bun.
export interface AudioTranscriptionRequest {
  audioBlob: Blob;
  language: string;
}

export interface AudioTranscription {
  transcript: string;
  supported: boolean;
  status: "completed" | "unsupported" | "failed";
  error: string | null;
  processingMs: number;
  confidence: number | null;
}

interface RecognitionAccumulator {
  transcripts: string[];
  confidences: number[];
  settled: boolean;
}

interface CapturableAudioElement extends HTMLAudioElement {
  captureStream(): MediaStream;
}

const MINIMUM_TIMEOUT_MS: number = 15_000;
const TIMEOUT_PADDING_MS: number = 10_000;
const MAXIMUM_TIMEOUT_MS: number = 120_000;
const HAVE_FUTURE_DATA: number = 3;
const normalizeTranscript = (value: string): string => value.replaceAll(/\s+/gu, " ").trim();
const recognitionConstructor = (): SpeechRecognitionConstructorLike | null =>
  window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
const isCapturableAudio = (audio: HTMLAudioElement): audio is CapturableAudioElement =>
  "captureStream" in audio && typeof audio.captureStream === "function";
const recognitionTimeout = (durationSeconds: number): number =>
  Number.isFinite(durationSeconds)
    ? Math.min(
        MAXIMUM_TIMEOUT_MS,
        Math.max(MINIMUM_TIMEOUT_MS, durationSeconds * 1_000 + TIMEOUT_PADDING_MS),
      )
    : MINIMUM_TIMEOUT_MS;
const average = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Audio track speech recognition failed";

const waitUntilPlayable = (audio: HTMLAudioElement): Promise<void> => {
  if (audio.readyState >= HAVE_FUTURE_DATA) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    audio.oncanplay = () => resolve();
    audio.onerror = () => reject(new Error("The recorded audio could not be loaded for STT"));
    audio.load();
  });
};

const collectResults = (
  accumulator: RecognitionAccumulator,
  event: SpeechRecognitionResultEventLike,
): void => {
  const resultCount: number = Math.max(0, event.results.length - event.resultIndex);
  Array.from({ length: resultCount }, (_, index) => event.results.item(event.resultIndex + index))
    .filter((result) => result.isFinal)
    .map((result) => result.item(0))
    .map((alternative) => {
      accumulator.transcripts.push(alternative.transcript);
      accumulator.confidences.push(alternative.confidence);
      return alternative;
    });
};

const recognizeAudioTrack = (
  audio: CapturableAudioElement,
  language: string,
): Promise<AudioTranscription> => {
  const Constructor: SpeechRecognitionConstructorLike | null = recognitionConstructor();
  if (Constructor === null) {
    return Promise.resolve({
      transcript: "",
      supported: false,
      status: "unsupported",
      error: "Web Speech API is unavailable",
      processingMs: 0,
      confidence: null,
    });
  }
  const stream: MediaStream = audio.captureStream();
  const track: MediaStreamTrack | undefined = stream.getAudioTracks()[0];
  if (track === undefined || track.kind !== "audio" || track.readyState !== "live") {
    stream.getTracks().map((streamTrack) => streamTrack.stop());
    return Promise.resolve({
      transcript: "",
      supported: true,
      status: "failed",
      error: "Recorded audio did not provide a live audio track",
      processingMs: 0,
      confidence: null,
    });
  }
  const startedMs: number = performance.now();
  const recognition: SpeechRecognitionLike = new Constructor();
  const accumulator: RecognitionAccumulator = {
    transcripts: [],
    confidences: [],
    settled: false,
  };
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = language;
  recognition.maxAlternatives = 1;

  return new Promise((resolve) => {
    const finish = (status: "completed" | "failed", error: string | null): void => {
      if (accumulator.settled) {
        return;
      }
      accumulator.settled = true;
      window.clearTimeout(timeoutId);
      stream.getTracks().map((streamTrack) => streamTrack.stop());
      resolve({
        transcript: normalizeTranscript(accumulator.transcripts.join(" ")),
        supported: true,
        status,
        error,
        processingMs: performance.now() - startedMs,
        confidence: average(accumulator.confidences),
      });
    };
    const timeoutId: number = window.setTimeout(() => {
      recognition.abort();
      finish("failed", "Audio track speech recognition timed out");
    }, recognitionTimeout(audio.duration));
    recognition.onresult = (event) => collectResults(accumulator, event);
    recognition.onerror = (event) => finish("failed", event.message || event.error);
    recognition.onend = () => finish("completed", null);
    audio.onended = () => recognition.stop();
    void audio
      .play()
      .then(() => recognition.start(track))
      .catch((error: unknown) => finish("failed", errorMessage(error)));
  });
};

export class AudioSpeechRecognizer {
  public readonly supported: boolean;
  private queue: Promise<void> = Promise.resolve();

  public constructor() {
    this.supported = recognitionConstructor() !== null;
  }

  public transcribe(request: AudioTranscriptionRequest): Promise<AudioTranscription> {
    const job: Promise<AudioTranscription> = this.queue.then(() => this.run(request));
    this.queue = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private async run({
    audioBlob,
    language,
  }: AudioTranscriptionRequest): Promise<AudioTranscription> {
    if (!this.supported) {
      return {
        transcript: "",
        supported: false,
        status: "unsupported",
        error: "Web Speech API is unavailable",
        processingMs: 0,
        confidence: null,
      };
    }
    const url: string = URL.createObjectURL(audioBlob);
    const audio: HTMLAudioElement = new Audio(url);
    audio.muted = true;
    audio.preload = "auto";
    try {
      await waitUntilPlayable(audio);
      return isCapturableAudio(audio)
        ? await recognizeAudioTrack(audio, language)
        : {
            transcript: "",
            supported: true,
            status: "failed",
            error: "This browser cannot transcribe recorded audio tracks",
            processingMs: 0,
            confidence: null,
          };
    } catch (error: unknown) {
      return {
        transcript: "",
        supported: true,
        status: "failed",
        error: errorMessage(error),
        processingMs: 0,
        confidence: null,
      };
    } finally {
      audio.pause();
      URL.revokeObjectURL(url);
    }
  }
}
