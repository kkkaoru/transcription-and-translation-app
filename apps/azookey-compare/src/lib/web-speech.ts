/**
 * Small, dependency-free wrapper around the browser's Web Speech recognition API.
 *
 * The API is still prefixed in Safari and is not included in TypeScript's DOM
 * declarations. Keeping the narrow declarations here lets the comparison page
 * remain SSR-safe and makes unsupported browsers an explicit state in the UI.
 */

export type SpeechRecognitionState = "idle" | "starting" | "listening" | "stopping" | "error";

export type SpeechUtteranceFinalCause = "browser-final" | "stop-flush" | "end-flush";

export type SpeechRecognitionEndReason = "user-stop" | "service-end" | "error" | "timeout";

export interface SpeechTranscriptUpdate {
  /** All final segments returned by the current recognition session. */
  finalText: string;
  /** The currently changing, non-final segment, if one exists. */
  interimText: string;
}

export interface SpeechUtteranceFinal {
  /** Newly committed utterance text (one final segment or a promoted interim). */
  text: string;
  /** All committed finals in the current recognition generation. */
  finalText: string;
  cause: SpeechUtteranceFinalCause;
  /** Result-list index for this committed segment, when known. */
  resultIndex: number;
}

export interface SpeechRecognitionEnded {
  reason: SpeechRecognitionEndReason;
  finalText: string;
  /** Leftover interim at end, if any (usually empty after a flush). */
  interimText: string;
}

export interface SpeechRecognitionCallbacks {
  onStateChange?: (state: SpeechRecognitionState) => void;
  onTranscript?: (update: SpeechTranscriptUpdate) => void;
  onFinalText?: (text: string) => void;
  /** Fired when an utterance is committed: browser `isFinal` or a stop/end flush. */
  onUtteranceFinal?: (update: SpeechUtteranceFinal) => void;
  /**
   * Fired when the user-facing capture session ends. Continuous `end` +
   * auto-restart does not count; the caller should keep listening.
   */
  onRecognitionEnded?: (update: SpeechRecognitionEnded) => void;
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
 * A permission prompt or an unavailable browser speech service can leave
 * `start()` pending without dispatching either `start` or `error`. Bound that
 * state so the UI never remains on "starting" forever.
 */
const START_TIMEOUT_MS = 10_000;
/**
 * WebKit can dispatch `end` before the final `result` already queued for the
 * same recognition service. Keep that service's result buffers alive for a
 * bounded window before clearing/restarting it.
 */
const FINAL_RESULT_GRACE_MS = 100;
/**
 * WebKit can accept `stop()` without ever dispatching `end`. Bound that
 * `stopping` state so the UI can return to idle and still flush leftover text.
 */
const STOP_TIMEOUT_MS = 2_000;
const MAX_RESTART_DELAY_MS = 2_000;
const MAX_RESTART_EXPONENT = 5;

type ResultFlushPlan = {
  restart: boolean;
  reason: SpeechRecognitionEndReason;
};

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
  private readonly interimTextByGeneration = new Map<number, string>();
  private state: SpeechRecognitionState = "idle";
  private recognitionGeneration = 0;
  private endingGeneration: number | null = null;
  private requestedStop = false;
  /**
   * True from an explicit `start()` until `onRecognitionEnded`. Continuous
   * browser `end` + restart keeps this set so the caller can treat one
   * capture session as still open.
   */
  private captureActive = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly resultFlushTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private restartAttempt = 0;
  private ignoredEndEvents = 0;
  private lastFlushCommittedText = "";
  private flushCommittedGeneration: number | null = null;
  private flushCommittedAt = 0;
  /**
   * A fatal recognition error (most notably `not-allowed`) must stop the
   * continuous-session loop. Browsers normally dispatch `end` after `error`,
   * so keeping this separate from `state` prevents that `end` from scheduling
   * a restart and repeatedly re-triggering a denied permission prompt.
   */
  private restartBlocked = false;
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
      this.restartBlocked = false;
      this.clearStartTimer();
      this.restartAttempt = 0;
      // Bind this browser service to the generation that called `start()`.
      // A later `onend` must not read a replacement generation incremented
      // while the prior service was still unwinding.
      this.endingGeneration = this.recognitionGeneration;
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
      this.clearStartTimer();
      this.clearStopWatchdog();
      const generation = this.endingGeneration ?? this.recognitionGeneration;
      this.endingGeneration = generation;
      const fenceStaleEnd = !this.requestedStop && this.state === "stopping";
      if (fenceStaleEnd) {
        this.ignoredEndEvents += 1;
      }
      if (this.requestedStop) {
        // Stay in `stopping` until the grace flush commits leftover text.
        // A start-timeout error must remain `error` rather than looking idle.
        if (this.state !== "error") {
          this.setState("stopping");
        }
      } else {
        this.setState("idle");
      }
      // Do not clear this generation's final buffers yet. A queued final
      // result may be delivered after `end`, especially in WebKit. The flush
      // callback restarts only after the bounded grace window has elapsed.
      this.scheduleResultFlush(generation, {
        restart: !this.requestedStop && !this.restartBlocked,
        reason: this.requestedStop ? "user-stop" : this.restartBlocked ? "error" : "service-end",
      });
    };
    this.recognition.onerror = (event) => {
      if (this.disposed) {
        return;
      }
      // `aborted` is emitted by some browsers during a deliberate stop.
      if (event.error === "aborted" && this.requestedStop) {
        return;
      }
      this.clearStartTimer();
      this.setState("error");
      if (this.isFatalError(event.error)) {
        this.restartBlocked = true;
        // A transient error may already have queued a backoff restart before
        // the fatal error arrives. Cancel that timer as well as suppressing
        // the `end`-driven restart below.
        this.clearRestartTimer();
      }
      try {
        this.callbacks.onError?.(
          event.message?.trim() || event.error || "Speech recognition failed",
        );
      } catch {
        // Callback exceptions must not break the browser's recognition loop.
      }
      if (!this.requestedStop && !this.restartBlocked && !this.isFatalError(event.error)) {
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
    this.captureActive = true;
    // An explicit start is the user's acknowledgement/retry after a fatal
    // permission or policy error. Allow a fresh browser session to run.
    this.restartBlocked = false;
    // Chrome rejects `start()` until the previous service has delivered `end`.
    // Record the latest intent and wait for the in-flight stop/flush to finish.
    if (this.state === "stopping" || this.resultFlushTimers.size > 0) {
      return;
    }
    this.beginRecognitionStart();
  }

  private beginRecognitionStart(): void {
    if (this.disposed || !this.recognition || this.requestedStop) {
      return;
    }
    this.clearStartTimer();
    this.clearStopWatchdog();
    const preserveResultBuffers = this.resultFlushTimers.size > 0;
    if (this.state === "error") {
      let aborted = false;
      try {
        this.recognition.abort();
        aborted = true;
      } catch {
        // The state transition below is the fallback for a service already
        // unwinding after a network/permission failure.
      }
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
      this.interimTextByGeneration.clear();
    }
    this.recognitionGeneration += 1;
    this.ensureResultBuffers(this.recognitionGeneration);
    this.setState("starting");
    try {
      this.recognition.start();
      if (this.isStarting() && !this.disposed && !this.requestedStop) {
        this.startTimer = setTimeout(() => {
          this.startTimer = null;
          if (this.disposed || this.requestedStop || this.state !== "starting") {
            return;
          }
          // Fence a late `start` callback from the service we are aborting;
          // only an explicit user retry clears this stop request.
          this.requestedStop = true;
          this.restartBlocked = true;
          this.setState("error");
          this.reportError(
            "Speech recognition did not start; check microphone permission and site security settings",
          );
          try {
            this.recognition?.abort();
          } catch {
            // A service that never started may reject abort; the controller is
            // already in a recoverable, user-retryable error state.
          }
          this.emitRecognitionEnded("timeout");
        }, START_TIMEOUT_MS);
      }
    } catch (error) {
      this.clearStartTimer();
      this.setState("error");
      this.reportError(
        error instanceof Error ? error.message : "Speech recognition could not start",
      );
      // WebKit may throw while the previous recognition service is still
      // unwinding. Treat that the same as its recoverable asynchronous error:
      // keep the continuous session requested and retry on the normal bounded
      // backoff rather than leaving the controller permanently errored.
      if (!this.requestedStop && !this.restartBlocked) {
        this.scheduleRestart();
      }
    }
  }

  stop(): void {
    if (!this.recognition || this.disposed) {
      return;
    }
    this.clearRestartTimer();
    this.clearStartTimer();
    this.requestedStop = true;
    // `end` can move the controller to idle while its bounded result-flush
    // timer is still waiting. Marking the stop request even in idle prevents
    // that timer from scheduling a restart after the user cancelled capture.
    if (this.state === "stopping") {
      this.ensureStopWatchdog();
      return;
    }
    if (this.state === "idle") {
      if (this.resultFlushTimers.size > 0) {
        return;
      }
      if (this.captureActive) {
        this.flushPendingTranscript(this.recognitionGeneration, "stop-flush");
        this.setState("idle");
        this.emitRecognitionEnded("user-stop");
      }
      return;
    }
    this.setState("stopping");
    this.ensureStopWatchdog();
    try {
      this.recognition.stop();
    } catch (error) {
      this.clearStopWatchdog();
      this.setState("error");
      this.reportError(
        error instanceof Error ? error.message : "Speech recognition could not stop",
      );
      this.flushPendingTranscript(this.recognitionGeneration, "stop-flush");
      this.emitRecognitionEnded("error");
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.requestedStop = true;
    this.captureActive = false;
    this.clearStartTimer();
    this.clearRestartTimer();
    this.clearStopWatchdog();
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
    this.interimTextByGeneration.clear();
    this.setState("idle");
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  private clearStopWatchdog(): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  private ensureStopWatchdog(): void {
    if (this.disposed || this.stopTimer !== null) {
      return;
    }
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (this.disposed || this.state !== "stopping") {
        return;
      }
      try {
        this.recognition?.abort();
      } catch {
        // Abort is best effort; the watchdog still has to leave `stopping`.
      }
      this.flushPendingTranscript(this.recognitionGeneration, "stop-flush");
      this.setState("idle");
      this.emitRecognitionEnded("timeout");
    }, STOP_TIMEOUT_MS);
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

  private scheduleResultFlush(generation: number, plan: ResultFlushPlan): void {
    if (this.disposed || !this.recognition || this.resultFlushTimers.has(generation)) {
      return;
    }
    const timer = setTimeout(() => {
      this.resultFlushTimers.delete(generation);
      const reason: SpeechRecognitionEndReason = this.requestedStop ? "user-stop" : plan.reason;
      const cause: SpeechUtteranceFinalCause = reason === "user-stop" ? "stop-flush" : "end-flush";
      const superseded = this.recognitionGeneration !== generation;
      this.flushPendingTranscript(generation, cause);
      const endedSnapshot = this.snapshotTranscript(generation);
      this.interimTextByGeneration.delete(generation);
      this.finalSegmentsByGeneration.delete(generation);
      this.emittedFinalSegmentsByGeneration.delete(generation);
      if (this.endingGeneration === generation) {
        this.endingGeneration = null;
      }
      if (this.disposed) {
        return;
      }
      if (superseded) {
        return;
      }
      if (reason === "user-stop" || reason === "error" || reason === "timeout") {
        this.clearStopWatchdog();
        if (this.state === "stopping") {
          this.setState("idle");
        }
        this.emitRecognitionEnded(reason, endedSnapshot);
        if (!this.requestedStop && !this.restartBlocked) {
          this.beginRecognitionStart();
        }
        return;
      }
      if (plan.restart && !this.requestedStop && !this.restartBlocked) {
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
      this.restartBlocked ||
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
      this.beginRecognitionStart();
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
    const newFinals: Array<{ index: number; text: string }> = [];
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
          if (this.shouldSkipDuplicateFlush(generation, text)) {
            continue;
          }
          // Browsers can revise a previously committed final segment while
          // reporting a later resultIndex. The segment map de-duplicates the
          // same text, so every changed final (including one before
          // resultIndex) must reach the consumer.
          newFinals.push({ index, text });
        }
      } else {
        interimSegments.push(text);
      }
    }

    const finalText = [...finalSegments.values()].join(" ").trim();
    const interimText = interimSegments.join(" ").trim();
    this.interimTextByGeneration.set(generation, interimText);
    this.emitTranscript({ finalText, interimText });
    for (const { index, text } of newFinals) {
      this.emitFinalText(text);
      this.emitUtteranceFinal({
        text,
        finalText,
        cause: "browser-final",
        resultIndex: index,
      });
    }
  }

  private flushPendingTranscript(
    generation: number,
    cause: Exclude<SpeechUtteranceFinalCause, "browser-final">,
  ): SpeechTranscriptUpdate {
    this.ensureResultBuffers(generation);
    const finalSegments = this.finalSegmentsByGeneration.get(generation);
    const emittedFinalSegments = this.emittedFinalSegmentsByGeneration.get(generation);
    const update: SpeechTranscriptUpdate = {
      finalText: finalSegments ? [...finalSegments.values()].join(" ").trim() : "",
      interimText: "",
    };
    if (!finalSegments || !emittedFinalSegments) {
      this.interimTextByGeneration.set(generation, "");
      this.emitTranscript(update);
      return update;
    }
    const interim = (this.interimTextByGeneration.get(generation) ?? "").trim();
    if (interim) {
      const lastFinal = [...finalSegments.values()].at(-1);
      if (lastFinal !== interim) {
        const nextIndex = finalSegments.size === 0 ? 0 : Math.max(...finalSegments.keys()) + 1;
        finalSegments.set(nextIndex, interim);
        if (emittedFinalSegments.get(nextIndex) !== interim) {
          emittedFinalSegments.set(nextIndex, interim);
          this.lastFlushCommittedText = interim;
          this.flushCommittedGeneration = generation;
          this.flushCommittedAt = Date.now();
          update.finalText = [...finalSegments.values()].join(" ").trim();
          this.interimTextByGeneration.set(generation, "");
          this.emitTranscript(update);
          this.emitFinalText(interim);
          this.emitUtteranceFinal({
            text: interim,
            finalText: update.finalText,
            cause,
            resultIndex: nextIndex,
          });
          return update;
        }
      }
    }
    this.interimTextByGeneration.set(generation, "");
    this.emitTranscript(update);
    return update;
  }

  private snapshotTranscript(generation: number): SpeechTranscriptUpdate {
    const finalSegments = this.finalSegmentsByGeneration.get(generation);
    return {
      finalText: finalSegments ? [...finalSegments.values()].join(" ").trim() : "",
      interimText: (this.interimTextByGeneration.get(generation) ?? "").trim(),
    };
  }

  private shouldSkipDuplicateFlush(generation: number, text: string): boolean {
    if (
      !this.lastFlushCommittedText ||
      this.flushCommittedGeneration === null ||
      text !== this.lastFlushCommittedText ||
      generation === this.flushCommittedGeneration
    ) {
      return false;
    }
    return Date.now() - this.flushCommittedAt <= FINAL_RESULT_GRACE_MS;
  }

  private emitTranscript(update: SpeechTranscriptUpdate): void {
    try {
      this.callbacks.onTranscript?.(update);
    } catch {
      // Keep processing later results even if a UI observer fails.
    }
  }

  private emitFinalText(text: string): void {
    try {
      this.callbacks.onFinalText?.(text);
    } catch {
      // Keep the browser event loop independent from application callbacks.
    }
  }

  private emitUtteranceFinal(update: SpeechUtteranceFinal): void {
    try {
      this.callbacks.onUtteranceFinal?.(update);
    } catch {
      // Keep the browser event loop independent from application callbacks.
    }
  }

  private emitRecognitionEnded(
    reason: SpeechRecognitionEndReason,
    snapshot?: SpeechTranscriptUpdate,
  ): void {
    if (!this.captureActive || this.disposed) {
      return;
    }
    this.captureActive = false;
    const update = snapshot ?? this.snapshotTranscript(this.recognitionGeneration);
    try {
      this.callbacks.onRecognitionEnded?.({
        reason,
        finalText: update.finalText,
        interimText: update.interimText,
      });
    } catch {
      // Ending observers must not break disposal or stop recovery.
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

  private isStarting(): boolean {
    return this.state === "starting";
  }
}
