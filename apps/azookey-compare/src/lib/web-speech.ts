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
const DEFAULT_RESTART_DELAY_MS = 50;
const MAX_RESTART_DELAY_MS = 2_000;
const MAX_RESTART_EXPONENT = 5;

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
  const standard = window.SpeechRecognition;
  if (typeof standard === "function") {
    return standard;
  }
  const webkit = window.webkitSpeechRecognition;
  return typeof webkit === "function" ? webkit : null;
};

const getSpeechRecognitionConstructors = (): SpeechRecognitionConstructor[] => {
  if (typeof window === "undefined") {
    return [];
  }
  const constructors = [window.SpeechRecognition, window.webkitSpeechRecognition].filter(
    (candidate): candidate is SpeechRecognitionConstructor => typeof candidate === "function",
  );
  return constructors.filter((candidate, index) => constructors.indexOf(candidate) === index);
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
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  private ignoredEndEvents = 0;
  private disposed = false;

  constructor(language: string, callbacks: SpeechRecognitionCallbacks = {}) {
    this.callbacks = callbacks;
    const constructors = getSpeechRecognitionConstructors();
    this.supported = constructors.length > 0;
    let recognition: SpeechRecognitionLike | null = null;
    let lastError: unknown = null;
    for (const Constructor of constructors) {
      try {
        recognition = new Constructor();
        break;
      } catch (error) {
        // A stale standard constructor can remain exposed while WebKit is the
        // usable implementation (and vice versa). Try every vendor before
        // surfacing an initialization failure.
        lastError = error;
      }
    }
    if (!recognition && lastError) {
      throw lastError;
    }
    this.recognition = recognition;
    if (!this.recognition) {
      return;
    }

    this.recognition.lang = language;
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = MAX_SPEECH_ALTERNATIVES;
    this.recognition.onstart = () => {
      if (this.disposed || this.requestedStop) {
        return;
      }
      this.requestedStop = false;
      this.ignoredEndEvents = 0;
      this.restartAttempt = 0;
      this.setState("listening");
    };
    this.recognition.onend = () => {
      if (this.disposed) {
        return;
      }
      if (this.ignoredEndEvents > 0) {
        this.ignoredEndEvents -= 1;
        return;
      }
      this.setState("idle");
      if (!this.requestedStop) {
        this.scheduleRestart();
      }
    };
    this.recognition.onerror = (event) => {
      if (this.disposed) {
        return;
      }
      // `aborted` is emitted by some browsers during a deliberate stop.
      if (event.error === "aborted" && this.requestedStop) {
        return;
      }
      this.setState("error");
      try {
        this.callbacks.onError?.(
          event.message?.trim() || event.error || "Speech recognition failed",
        );
      } catch {
        // Callback exceptions must not break the browser's recognition loop.
      }
      if (!this.requestedStop && !this.isFatalError(event.error)) {
        this.scheduleRestart();
      }
    };
    this.recognition.onresult = (event) => {
      if (!this.disposed) {
        this.handleResult(event);
      }
    };
  }

  setLanguage(language: string): void {
    if (this.recognition && language.trim()) {
      this.recognition.lang = language.trim();
    }
  }

  start(): void {
    if (
      this.disposed ||
      !this.recognition ||
      this.state === "starting" ||
      this.state === "listening"
    ) {
      return;
    }
    this.clearRestartTimer();
    this.requestedStop = false;
    if (this.state === "stopping" || this.state === "error") {
      try {
        this.recognition.abort();
      } catch {
        // The state transition below is the fallback for a service already
        // unwinding after a network/permission failure.
      }
      this.ignoredEndEvents += 1;
      this.setState("idle");
    }
    this.finalSegments.clear();
    this.emittedFinalSegments.clear();
    this.setState("starting");
    try {
      this.recognition.start();
    } catch (error) {
      this.setState("error");
      this.reportError(
        error instanceof Error ? error.message : "Speech recognition could not start",
      );
    }
  }

  stop(): void {
    if (!this.recognition || this.disposed || this.state === "idle" || this.state === "stopping") {
      return;
    }
    this.clearRestartTimer();
    this.requestedStop = true;
    this.setState("stopping");
    try {
      this.recognition.stop();
    } catch (error) {
      this.setState("error");
      this.reportError(
        error instanceof Error ? error.message : "Speech recognition could not stop",
      );
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.requestedStop = true;
    this.clearRestartTimer();
    this.disposed = true;
    try {
      this.recognition?.abort();
    } catch {
      // Disposal is best effort; a browser that already released the service
      // should not make React effect cleanup throw.
    }
    if (this.recognition) {
      this.recognition.onstart = null;
      this.recognition.onend = null;
      this.recognition.onerror = null;
      this.recognition.onresult = null;
    }
    this.setState("idle");
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private scheduleRestart(): void {
    if (this.disposed || !this.recognition || this.requestedStop || this.restartTimer !== null) {
      return;
    }
    const delay = Math.min(
      MAX_RESTART_DELAY_MS,
      DEFAULT_RESTART_DELAY_MS * 2 ** Math.min(this.restartAttempt, MAX_RESTART_EXPONENT),
    );
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed || this.requestedStop) {
        return;
      }
      this.start();
    }, delay);
  }

  private isFatalError(value: string): boolean {
    const code = value.trim().toLowerCase();
    return [
      "not-allowed",
      "service-not-allowed",
      "security-error",
      "securityerror",
      "notallowederror",
      "language-not-supported",
      "bad-grammar",
      "phrases-not-supported",
    ].includes(code);
  }

  private reportError(message: string): void {
    try {
      this.callbacks.onError?.(message);
    } catch {
      // Callback exceptions must not escape browser lifecycle handlers.
    }
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
    try {
      this.callbacks.onTranscript?.({ finalText, interimText });
    } catch {
      // Keep processing later results even if a UI observer fails.
    }
    for (const text of newFinalTexts) {
      try {
        this.callbacks.onFinalText?.(text);
      } catch {
        // Keep the browser event loop independent from application callbacks.
      }
    }
  }

  private setState(state: SpeechRecognitionState): void {
    this.state = state;
    try {
      this.callbacks.onStateChange?.(state);
    } catch {
      // A state observer must not break recognition lifecycle recovery.
    }
  }
}
