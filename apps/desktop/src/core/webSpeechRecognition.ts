/**
 * A small, browser-independent adapter for the Web Speech API.
 *
 * Chrome exposes the API as `SpeechRecognition`, while the WebKit builds used
 * by the desktop shell still expose it as `webkitSpeechRecognition`.  Keeping
 * the feature detection and event handling here means the rest of the app can
 * use the same stream contract in a browser, a Tauri webview, and unit tests.
 *
 * The native API is a session API rather than a truly long-lived stream: even
 * with `continuous = true` it eventually fires `onend`.  A stream requested by
 * the caller therefore restarts itself after `onend` until `stop()` or
 * `cancel()` is called explicitly.
 */

export const DEFAULT_WEB_SPEECH_LANGUAGE = "ja-JP";
/** Chrome can still be unwinding its previous session when `onend` fires. */
export const DEFAULT_WEB_SPEECH_RESTART_DELAY_MS = 50;
const MAX_TRACKED_RESULTS = 256;
const MAX_RESTART_BACKOFF_MS = 2_000;

/** The small subset of SpeechRecognition used by this adapter. */
export interface WebSpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: WebSpeechRecognitionEventLike) => void) | null;
  onerror: ((event: WebSpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
}

/**
 * The browser's `SpeechRecognition` and `SpeechRecognitionEvent` types are not
 * present in every TypeScript DOM lib.  These structural types also make fake
 * recognizers straightforward to provide in tests.
 */
export interface WebSpeechRecognitionEventLike {
  readonly resultIndex?: number;
  readonly results: WebSpeechRecognitionResultListLike;
}

export interface WebSpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: WebSpeechRecognitionResultLike | undefined;
}

export interface WebSpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length?: number;
  readonly [index: number]: WebSpeechRecognitionAlternativeLike | undefined;
}

export interface WebSpeechRecognitionAlternativeLike {
  readonly transcript?: string;
  readonly confidence?: number;
}

export interface WebSpeechRecognitionErrorEventLike {
  readonly error?: string;
  readonly message?: string;
}

export type WebSpeechRecognitionConstructor = new () => WebSpeechRecognitionLike;

export type WebSpeechRecognitionScope = {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
};

/** A normalized partial/final result emitted by this adapter. */
export interface WebSpeechRecognitionResult {
  readonly type: "partial" | "final";
  readonly transcript: string;
  /** Alias useful to consumers that call the field `text`. */
  readonly text: string;
  /** Recognition confidence when supplied by the engine. */
  readonly confidence?: number;
  readonly resultIndex: number;
  readonly isFinal: boolean;
}

export interface WebSpeechRecognitionErrorDetails {
  readonly code: string;
  readonly message: string;
  readonly fatal: boolean;
  readonly originalEvent: unknown;
}

/**
 * Error delivered through `onError`/`onEvent`.
 *
 * It extends Error so callers can use normal error handling while retaining
 * Web Speech's machine-readable `code` and whether restarting is useful.
 */
export class WebSpeechRecognitionError extends Error {
  public readonly code: string;
  /** Alias matching SpeechRecognitionErrorEvent.error. */
  public readonly error: string;
  public readonly fatal: boolean;
  public readonly originalEvent: unknown;
  /** Alias useful when forwarding diagnostics to event-oriented code. */
  public readonly event: unknown;

  public constructor(details: WebSpeechRecognitionErrorDetails) {
    super(details.message);
    this.name = "WebSpeechRecognitionError";
    this.code = details.code;
    this.error = details.code;
    this.fatal = details.fatal;
    this.originalEvent = details.originalEvent;
    this.event = details.originalEvent;
  }
}

export type WebSpeechRecognitionStreamEvent =
  | ({ readonly type: "partial" | "final" } & WebSpeechRecognitionResult)
  | { readonly type: "start" }
  | { readonly type: "end"; readonly willRestart: boolean }
  | { readonly type: "error"; readonly error: WebSpeechRecognitionError };

export type WebSpeechRecognitionStreamState = "idle" | "starting" | "running" | "stopping";

export interface WebSpeechRecognitionStreamOptions {
  /** BCP-47 language tag. Defaults to Japanese (`ja-JP`). */
  language?: string;
  /** Alias for `language`, matching the Web Speech API property name. */
  lang?: string;
  /** Defaults to true so a session keeps listening between browser `onend`s. */
  continuous?: boolean;
  /** Defaults to true so partial text can be painted with low latency. */
  interimResults?: boolean;
  /** Number of alternatives requested from the browser. Defaults to one. */
  maxAlternatives?: number;
  /** Delay before an automatic restart. Zero still schedules a separate tick. */
  restartDelayMs?: number;
  /** Inject a constructor when running without a browser (or in tests). */
  recognitionConstructor?: WebSpeechRecognitionConstructor;
  /** Factory alternative for fakes that are not constructable classes. */
  recognitionFactory?: () => WebSpeechRecognitionLike;
  /** Inject an already-created recognizer. Useful for deterministic tests. */
  recognition?: WebSpeechRecognitionLike;
  /** Called for each changed partial/final result. */
  onResult?: (result: WebSpeechRecognitionResult) => void;
  /** Called with the transcript of each changed interim result. */
  onPartial?: (transcript: string, result: WebSpeechRecognitionResult) => void;
  /** Called with the transcript of each newly final result. */
  onFinal?: (transcript: string, result: WebSpeechRecognitionResult) => void;
  /** Called for lifecycle and result events. */
  onEvent?: (event: WebSpeechRecognitionStreamEvent) => void;
  /** Called when the browser reports an error. */
  onError?: (error: WebSpeechRecognitionError) => void;
}

type ResultSlot = {
  transcript: string;
  confidence: number | undefined;
  isFinal: boolean;
};

const isConstructor = (value: unknown): value is WebSpeechRecognitionConstructor =>
  typeof value === "function";

const getGlobalScope = (): WebSpeechRecognitionScope => {
  // Do not mention `window` here.  The module is intentionally importable from
  // a worker, a Node/Vitest test, or a Tauri process with no DOM globals.
  return globalThis as unknown as WebSpeechRecognitionScope;
};

/** Resolve the standard or WebKit-prefixed constructor without instantiating it. */
export const getWebSpeechRecognitionConstructor = (
  scope: WebSpeechRecognitionScope = getGlobalScope(),
): WebSpeechRecognitionConstructor | null => {
  if (isConstructor(scope.SpeechRecognition)) {
    return scope.SpeechRecognition;
  }
  if (isConstructor(scope.webkitSpeechRecognition)) {
    return scope.webkitSpeechRecognition;
  }
  return null;
};

/** Feature detection that is safe in a DOM-less runtime. */
export const isWebSpeechRecognitionSupported = (
  scope: WebSpeechRecognitionScope = getGlobalScope(),
): boolean => getWebSpeechRecognitionConstructor(scope) !== null;

const clampRestartDelay = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_WEB_SPEECH_RESTART_DELAY_MS;
  }
  return Math.max(0, Math.floor(value));
};

const normalizeLanguage = (value: string | undefined): string => {
  const language = value?.trim();
  return language || DEFAULT_WEB_SPEECH_LANGUAGE;
};

const normalizeMaxAlternatives = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value));
};

const normalizeTranscript = (value: unknown): string => (typeof value === "string" ? value : "");

const normalizeConfidence = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const normalizeErrorCode = (value: unknown): string => {
  const code = typeof value === "string" ? value.trim() : "";
  return code || "unknown";
};

const isFatalErrorCode = (code: string): boolean =>
  code === "not-allowed" ||
  code === "service-not-allowed" ||
  code === "language-not-supported" ||
  code === "phrases-not-supported" ||
  code === "bad-grammar";

/**
 * A resilient Web Speech API stream.
 *
 * A single recognizer instance is deliberately used.  It avoids overlapping
 * browser microphone sessions (which can race for the same input device),
 * while `onend` restart provides the same continuous-caption behaviour as the
 * double-buffered implementation used by jimakuChan.
 */
export class WebSpeechRecognitionStream {
  private readonly recognition: WebSpeechRecognitionLike;
  private readonly restartDelayMs: number;
  private readonly onResult: (result: WebSpeechRecognitionResult) => void;
  private readonly onPartial: (transcript: string, result: WebSpeechRecognitionResult) => void;
  private readonly onFinal: (transcript: string, result: WebSpeechRecognitionResult) => void;
  private readonly onEvent: (event: WebSpeechRecognitionStreamEvent) => void;
  private readonly onError: (error: WebSpeechRecognitionError) => void;
  private readonly resultSlots = new Map<number, ResultSlot>();
  private stateValue: WebSpeechRecognitionStreamState = "idle";
  private shouldRun = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  private disposed = false;

  public constructor(options: WebSpeechRecognitionStreamOptions = {}) {
    const recognition = options.recognition ?? this.createRecognition(options);
    this.recognition = recognition;
    this.restartDelayMs = clampRestartDelay(options.restartDelayMs);
    this.onResult = options.onResult ?? (() => undefined);
    this.onPartial = options.onPartial ?? (() => undefined);
    this.onFinal = options.onFinal ?? (() => undefined);
    this.onEvent = options.onEvent ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);

    const language = normalizeLanguage(options.language ?? options.lang);
    this.recognition.lang = language;
    this.recognition.continuous = options.continuous ?? true;
    this.recognition.interimResults = options.interimResults ?? true;
    this.recognition.maxAlternatives = normalizeMaxAlternatives(options.maxAlternatives);

    this.recognition.onstart = () => {
      if (this.disposed) {
        return;
      }
      this.stateValue = "running";
      this.restartAttempt = 0;
      this.emitEvent({ type: "start" });
    };
    this.recognition.onresult = (event) => {
      if (!this.disposed) {
        this.handleResult(event);
      }
    };
    this.recognition.onerror = (event) => {
      if (!this.disposed) {
        this.handleError(event);
      }
    };
    this.recognition.onend = () => {
      if (this.disposed) {
        return;
      }
      this.stateValue = "idle";
      const willRestart = this.shouldRun;
      this.emitEvent({ type: "end", willRestart });
      if (willRestart) {
        this.scheduleRestart();
      }
    };
  }

  private createRecognition(options: WebSpeechRecognitionStreamOptions): WebSpeechRecognitionLike {
    if (options.recognitionFactory) {
      return options.recognitionFactory();
    }
    const recognitionCtor =
      options.recognitionConstructor ?? getWebSpeechRecognitionConstructor(getGlobalScope());
    if (!recognitionCtor) {
      throw new Error("Web Speech Recognition is unavailable in this runtime");
    }
    return new recognitionCtor();
  }

  /** The exact language tag configured on the recognizer. */
  public get language(): string {
    return this.recognition.lang;
  }

  /** Alias matching the Web Speech API's property spelling. */
  public get lang(): string {
    return this.language;
  }

  public setLanguage(language: string): void {
    this.recognition.lang = normalizeLanguage(language);
  }

  public get state(): WebSpeechRecognitionStreamState {
    return this.stateValue;
  }

  public get isRunning(): boolean {
    return this.shouldRun;
  }

  /** The underlying recognizer is exposed for diagnostics, not for lifecycle control. */
  public get recognizer(): WebSpeechRecognitionLike {
    return this.recognition;
  }

  /** Start listening. Repeated calls while active are idempotent. */
  public start(): void {
    if (this.disposed) {
      throw new Error("Web Speech Recognition stream has been disposed");
    }
    this.shouldRun = true;
    this.restartAttempt = 0;
    this.clearRestartTimer();
    if (this.stateValue === "starting" || this.stateValue === "running") {
      return;
    }
    this.startRecognizer();
  }

  /**
   * Gracefully stop listening. `onend` is still delivered by the browser, but
   * its restart guard is disabled before calling `stop()`.
   */
  public stop(): void {
    this.shouldRun = false;
    this.clearRestartTimer();
    if (this.stateValue === "idle") {
      return;
    }
    this.stateValue = "stopping";
    try {
      this.recognition.stop();
    } catch (error) {
      this.reportLifecycleError("stop", error);
      this.stateValue = "idle";
    }
  }

  /** Stop immediately and discard in-flight browser recognition. */
  public cancel(): void {
    this.shouldRun = false;
    this.clearRestartTimer();
    if (this.stateValue === "idle") {
      return;
    }
    this.stateValue = "stopping";
    try {
      this.recognition.abort();
    } catch (error) {
      this.reportLifecycleError("cancel", error);
      this.stateValue = "idle";
    }
  }

  /** Alias useful to owners that treat streams as disposable resources. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.cancel();
    this.disposed = true;
    this.resultSlots.clear();
    this.recognition.onstart = null;
    this.recognition.onresult = null;
    this.recognition.onerror = null;
    this.recognition.onend = null;
  }

  private startRecognizer(): void {
    this.clearRestartTimer();
    this.resultSlots.clear();
    this.stateValue = "starting";
    try {
      this.recognition.start();
    } catch (error) {
      // Browsers can throw InvalidStateError when an `onend`/`onstart` race
      // occurs. Treat it as recoverable while the caller still wants a stream.
      this.stateValue = "idle";
      this.reportLifecycleError("start", error);
      if (this.shouldRun) {
        this.scheduleRestart();
      }
    }
  }

  private scheduleRestart(): void {
    if (!this.shouldRun || this.disposed || this.restartTimer !== null) {
      return;
    }
    const backoff = Math.min(
      MAX_RESTART_BACKOFF_MS,
      this.restartAttempt === 0 ? 0 : 50 * 2 ** Math.min(this.restartAttempt - 1, 5),
    );
    const delay = Math.max(this.restartDelayMs, backoff);
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shouldRun && !this.disposed) {
        this.startRecognizer();
      }
    }, delay);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private handleResult(event: WebSpeechRecognitionEventLike): void {
    const results = event.results;
    if (!results || !Number.isFinite(results.length) || results.length <= 0) {
      return;
    }
    const rawStart = event.resultIndex ?? 0;
    const start = Number.isFinite(rawStart) ? Math.max(0, Math.floor(rawStart)) : 0;
    const end = Math.max(start, Math.floor(results.length));
    this.pruneResultSlots(start);
    for (let index = start; index < end; index += 1) {
      const result = results[index];
      const alternative = result?.[0];
      if (!result || !alternative) {
        continue;
      }
      const transcript = normalizeTranscript(alternative.transcript);
      // Empty alternatives are emitted by some engines for no-speech windows;
      // they carry no useful caption and should not replace a visible partial.
      if (!transcript.trim()) {
        continue;
      }
      const confidence = normalizeConfidence(alternative.confidence);
      const isFinal = result.isFinal === true;
      const previous = this.resultSlots.get(index);
      if (
        previous &&
        previous.transcript === transcript &&
        previous.confidence === confidence &&
        previous.isFinal === isFinal
      ) {
        continue;
      }
      this.resultSlots.set(index, { transcript, confidence, isFinal });
      const normalized: WebSpeechRecognitionResult = {
        type: isFinal ? "final" : "partial",
        transcript,
        text: transcript,
        confidence,
        resultIndex: index,
        isFinal,
      };
      this.emitResult(normalized);
    }
  }

  private pruneResultSlots(resultIndex: number): void {
    // `resultIndex` points at the first slot changed by this event. Final
    // slots below it can no longer be revised by the browser and need not stay
    // resident. This is the common continuous=true path.
    for (const [index, slot] of this.resultSlots) {
      if (slot.isFinal && index < resultIndex) {
        this.resultSlots.delete(index);
      }
    }
    // A few engines resend the entire cumulative result list with
    // resultIndex=0. Keep de-duplication bounded in that less common case.
    if (this.resultSlots.size <= MAX_TRACKED_RESULTS) {
      return;
    }
    const finalIndices = [...this.resultSlots]
      .filter(([, slot]) => slot.isFinal)
      .map(([index]) => index)
      .sort((left, right) => left - right);
    while (this.resultSlots.size > MAX_TRACKED_RESULTS && finalIndices.length > 0) {
      const index = finalIndices.shift();
      if (index !== undefined) {
        this.resultSlots.delete(index);
      }
    }
  }

  private emitResult(result: WebSpeechRecognitionResult): void {
    try {
      this.onResult(result);
    } catch {
      // Consumer callbacks must not break recognition's browser event loop.
    }
    try {
      if (result.isFinal) {
        this.onFinal(result.transcript, result);
      } else {
        this.onPartial(result.transcript, result);
      }
    } catch {
      // See the callback isolation note above.
    }
    this.emitEvent(result);
  }

  private emitEvent(event: WebSpeechRecognitionStreamEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // A diagnostic listener should never stop audio capture.
    }
  }

  private handleError(event: WebSpeechRecognitionErrorEventLike): void {
    const code = normalizeErrorCode(event.error);
    const message =
      typeof event.message === "string" && event.message.trim()
        ? event.message
        : `Web Speech Recognition failed (${code})`;
    const error = new WebSpeechRecognitionError({
      code,
      message,
      fatal: isFatalErrorCode(code),
      originalEvent: event,
    });
    if (error.fatal) {
      this.shouldRun = false;
      this.clearRestartTimer();
      this.stateValue = "idle";
    }
    try {
      this.onError(error);
    } catch {
      // Error observers are application code; do not leak exceptions into the
      // browser's SpeechRecognition event dispatcher.
    }
    this.emitEvent({ type: "error", error });
    // Some engines report recoverable `no-speech`/network errors without
    // emitting an `onend` event. Keep the continuous stream alive; the timer
    // is deduplicated against the normal onend restart path.
    if (!error.fatal && this.shouldRun) {
      this.scheduleRestart();
    }
  }

  private reportLifecycleError(operation: string, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : `${cause}`;
    const error = new WebSpeechRecognitionError({
      code: `lifecycle-${operation}`,
      message: `Web Speech Recognition ${operation} failed: ${message}`,
      fatal: false,
      originalEvent: cause,
    });
    try {
      this.onError(error);
    } catch {
      // Keep lifecycle recovery independent of observers.
    }
    this.emitEvent({ type: "error", error });
  }
}

/** Factory form for callers that prefer composition over `new`. */
export const createWebSpeechRecognitionStream = (
  options: WebSpeechRecognitionStreamOptions = {},
): WebSpeechRecognitionStream => new WebSpeechRecognitionStream(options);

/** Short alias matching the Web Speech API's class name. */
export const SpeechRecognitionStream = WebSpeechRecognitionStream;
/** Compatibility alias for integrations that name the adapter by its API. */
export const WebSpeechRecognition = WebSpeechRecognitionStream;
export const createSpeechRecognitionStream = createWebSpeechRecognitionStream;
export const supportsWebSpeechRecognition = isWebSpeechRecognitionSupported;
