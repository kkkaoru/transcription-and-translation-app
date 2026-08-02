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
/**
 * WebKit can dispatch `end` before the final `result` already queued for the
 * same recognition service. Keep that service's result buffers alive for a
 * bounded window before clearing/restarting it.
 */
const FINAL_RESULT_GRACE_MS = 100;
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
  private readonly finalSegmentsByGeneration = new Map<number, Map<number, string>>();
  private readonly emittedFinalSegmentsByGeneration = new Map<number, Map<number, string>>();
  private state: SpeechRecognitionState = "idle";
  private recognitionGeneration = 0;
  private endingGeneration: number | null = null;
  private requestedStop = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly resultFlushTimers = new Map<number, ReturnType<typeof setTimeout>>();
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
      this.restartAttempt = 0;
      this.ensureResultBuffers(this.recognitionGeneration);
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
      const generation = this.recognitionGeneration;
      this.endingGeneration = generation;
      this.setState("idle");
      // Do not clear this generation's final buffers yet. A queued final
      // result may be delivered after `end`, especially in WebKit. The flush
      // callback restarts only after the bounded grace window has elapsed.
      this.scheduleResultFlush(generation, !this.requestedStop);
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
    const preserveResultBuffers = this.state === "stopping" || this.resultFlushTimers.size > 0;
    if (this.state === "stopping" || this.state === "error") {
      let aborted = false;
      try {
        this.recognition.abort();
        aborted = true;
      } catch {
        // The state transition below is the fallback for a service already
        // unwinding after a network/permission failure.
      }
      // Only a successful abort guarantees that the next end event belongs
      // to the superseded service. If abort throws, the real end event must
      // still drive the normal restart/state transition.
      if (aborted) {
        this.ignoredEndEvents += 1;
      }
      this.setState("idle");
    }
    // A prior service may still have a queued final result. Advance the
    // generation without clearing older buffers; its flush timer owns the
    // eventual cleanup. This keeps a rapid stop/start from dropping that
    // result or attributing its de-duplication state to the new service.
    if (!preserveResultBuffers) {
      this.finalSegmentsByGeneration.clear();
      this.emittedFinalSegmentsByGeneration.clear();
    }
    this.recognitionGeneration += 1;
    this.ensureResultBuffers(this.recognitionGeneration);
    this.setState("starting");
    try {
      this.recognition.start();
    } catch (error) {
      this.setState("error");
      this.reportError(
        error instanceof Error ? error.message : "Speech recognition could not start",
      );
      // WebKit may throw while the previous recognition service is still
      // unwinding. Treat that the same as its recoverable asynchronous error:
      // keep the continuous session requested and retry on the normal bounded
      // backoff rather than leaving the controller permanently errored.
      if (!this.requestedStop) {
        this.scheduleRestart();
      }
    }
  }

  stop(): void {
    if (!this.recognition || this.disposed) {
      return;
    }
    this.clearRestartTimer();
    this.requestedStop = true;
    // `end` can move the controller to idle while its bounded result-flush
    // timer is still waiting. Marking the stop request even in idle prevents
    // that timer from scheduling a restart after the user cancelled capture.
    if (this.state === "idle" || this.state === "stopping") {
      return;
    }
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
    this.clearResultFlushTimers();
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
    this.finalSegmentsByGeneration.clear();
    this.emittedFinalSegmentsByGeneration.clear();
    this.setState("idle");
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private clearResultFlushTimers(): void {
    for (const timer of this.resultFlushTimers.values()) {
      clearTimeout(timer);
    }
    this.resultFlushTimers.clear();
  }

  private ensureResultBuffers(generation: number): void {
    if (!this.finalSegmentsByGeneration.has(generation)) {
      this.finalSegmentsByGeneration.set(generation, new Map());
    }
    if (!this.emittedFinalSegmentsByGeneration.has(generation)) {
      this.emittedFinalSegmentsByGeneration.set(generation, new Map());
    }
  }

  private scheduleResultFlush(generation: number, restart: boolean): void {
    if (this.disposed || !this.recognition || this.resultFlushTimers.has(generation)) {
      return;
    }
    const timer = setTimeout(() => {
      this.resultFlushTimers.delete(generation);
      this.finalSegmentsByGeneration.delete(generation);
      this.emittedFinalSegmentsByGeneration.delete(generation);
      if (this.endingGeneration !== generation) {
        return;
      }
      this.endingGeneration = null;
      if (restart && !this.requestedStop && this.recognitionGeneration === generation) {
        this.scheduleRestart(generation);
      }
    }, FINAL_RESULT_GRACE_MS);
    this.resultFlushTimers.set(generation, timer);
  }

  private scheduleRestart(generation = this.recognitionGeneration): void {
    if (
      this.disposed ||
      !this.recognition ||
      this.requestedStop ||
      this.restartTimer !== null ||
      this.resultFlushTimers.has(generation)
    ) {
      return;
    }
    const delay = Math.min(
      MAX_RESTART_DELAY_MS,
      DEFAULT_RESTART_DELAY_MS * 2 ** Math.min(this.restartAttempt, MAX_RESTART_EXPONENT),
    );
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed || this.requestedStop || this.recognitionGeneration !== generation) {
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
    const generation = this.recognitionGeneration;
    this.ensureResultBuffers(generation);
    const finalSegments = this.finalSegmentsByGeneration.get(generation);
    const emittedFinalSegments = this.emittedFinalSegmentsByGeneration.get(generation);
    if (!finalSegments || !emittedFinalSegments) {
      return;
    }
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
        finalSegments.set(index, text);
        if (emittedFinalSegments.get(index) !== text) {
          emittedFinalSegments.set(index, text);
          // Browsers can revise a previously committed final segment while
          // reporting a later resultIndex. The segment map de-duplicates the
          // same text, so every changed final (including one before
          // resultIndex) must reach the consumer.
          newFinalTexts.push(text);
        }
      } else {
        interimSegments.push(text);
      }
    }

    const finalText = [...finalSegments.values()].join(" ").trim();
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
