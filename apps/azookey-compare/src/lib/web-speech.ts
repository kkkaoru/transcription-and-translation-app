/**
 * Small, dependency-free wrapper around the browser's Web Speech recognition API.
 *
 * The API is still prefixed in Safari and is not included in TypeScript's DOM
 * declarations. Keeping the narrow declarations here lets the comparison page
 * remain SSR-safe and makes unsupported browsers an explicit state in the UI.
 */

export type SpeechRecognitionState = "idle" | "starting" | "listening" | "stopping" | "error";

export interface SpeechTranscriptUpdate {
  /** All final segments returned by the current recognition session. */
  finalText: string;
  /** The currently changing, non-final segment, if one exists. */
  interimText: string;
}

export interface SpeechRecognitionCallbacks {
  onStateChange?: (state: SpeechRecognitionState) => void;
  onTranscript?: (update: SpeechTranscriptUpdate) => void;
  onFinalText?: (text: string) => void;
  onError?: (message: string) => void;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const MAX_SPEECH_ALTERNATIVES = 1;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export const getSpeechRecognitionConstructor = (): SpeechRecognitionConstructor | null => {
  if (typeof window === "undefined") {
    return null;
  }
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
};

const readTranscript = (result: SpeechRecognitionResultLike): string => {
  const first = result.length > 0 ? result[0] : undefined;
  return first?.transcript.trim() ?? "";
};

export class WebSpeechController {
  readonly supported: boolean;

  private readonly recognition: SpeechRecognitionLike | null;
  private readonly callbacks: SpeechRecognitionCallbacks;
  private readonly finalSegments = new Map<number, string>();
  private readonly emittedFinalSegments = new Map<number, string>();
  private state: SpeechRecognitionState = "idle";
  private requestedStop = false;

  constructor(language: string, callbacks: SpeechRecognitionCallbacks = {}) {
    this.callbacks = callbacks;
    const Constructor = getSpeechRecognitionConstructor();
    this.supported = Constructor !== null;
    this.recognition = Constructor ? new Constructor() : null;
    if (!this.recognition) {
      return;
    }

    this.recognition.lang = language;
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = MAX_SPEECH_ALTERNATIVES;
    this.recognition.onstart = () => {
      this.requestedStop = false;
      this.setState("listening");
    };
    this.recognition.onend = () => {
      this.setState(this.requestedStop ? "idle" : "idle");
    };
    this.recognition.onerror = (event) => {
      // `aborted` is emitted by some browsers during a deliberate stop.
      if (event.error === "aborted" && this.requestedStop) {
        return;
      }
      this.setState("error");
      this.callbacks.onError?.(event.message?.trim() || event.error || "Speech recognition failed");
    };
    this.recognition.onresult = (event) => {
      this.handleResult(event);
    };
  }

  setLanguage(language: string): void {
    if (this.recognition && language.trim()) {
      this.recognition.lang = language.trim();
    }
  }

  start(): void {
    if (!this.recognition || this.state === "starting" || this.state === "listening") {
      return;
    }
    this.requestedStop = false;
    this.finalSegments.clear();
    this.emittedFinalSegments.clear();
    this.setState("starting");
    try {
      this.recognition.start();
    } catch (error) {
      this.setState("error");
      this.callbacks.onError?.(
        error instanceof Error ? error.message : "Speech recognition could not start",
      );
    }
  }

  stop(): void {
    if (!this.recognition || this.state === "idle") {
      return;
    }
    this.requestedStop = true;
    this.setState("stopping");
    try {
      this.recognition.stop();
    } catch (error) {
      this.setState("error");
      this.callbacks.onError?.(
        error instanceof Error ? error.message : "Speech recognition could not stop",
      );
    }
  }

  dispose(): void {
    this.requestedStop = true;
    this.recognition?.abort();
    this.setState("idle");
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    const interimSegments: string[] = [];
    const newFinalTexts: string[] = [];
    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (!result) {
        continue;
      }
      const text = readTranscript(result);
      if (!text) {
        continue;
      }
      if (result.isFinal) {
        this.finalSegments.set(index, text);
        if (this.emittedFinalSegments.get(index) !== text) {
          this.emittedFinalSegments.set(index, text);
          // Only emit the segment after the last committed value. This avoids
          // submitting the same final transcript repeatedly on Chrome updates.
          if (index >= event.resultIndex) {
            newFinalTexts.push(text);
          }
        }
      } else {
        interimSegments.push(text);
      }
    }

    const finalText = [...this.finalSegments.values()].join(" ").trim();
    const interimText = interimSegments.join(" ").trim();
    this.callbacks.onTranscript?.({ finalText, interimText });
    for (const text of newFinalTexts) {
      this.callbacks.onFinalText?.(text);
    }
  }

  private setState(state: SpeechRecognitionState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }
}
