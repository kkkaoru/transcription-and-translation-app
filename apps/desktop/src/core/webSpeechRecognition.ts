/**
 * A small, browser-independent adapter for the Web Speech API.
 *
 * Chrome-based browsers expose the API as `SpeechRecognition`, and a few
 * browser WebKit builds historically exposed `webkitSpeechRecognition`.
 * macOS WKWebView (including the Tauri desktop shell) does not expose either
 * constructor, so feature detection must treat that mode as unavailable there.
 * Even when a browser exposes a constructor, the recognition service can still
 * reject `start()`; the first `start()` and its error event remain
 * authoritative. Keeping detection and event handling here lets the rest of the
 * app use one stream contract in browsers and tests.
 *
 * The native API is a session API rather than a truly long-lived stream: even
 * with `continuous = true` it eventually fires `onend`.  A stream requested by
 * the caller therefore restarts itself after `onend` until `stop()` or
 * `cancel()` is called explicitly.
 */

export const DEFAULT_WEB_SPEECH_LANGUAGE = "ja-JP";
/** Chrome can still be unwinding its previous session when `onend` fires. */
export const DEFAULT_WEB_SPEECH_RESTART_DELAY_MS = 50;
/**
 * Some WebKit builds resolve `start()` without ever dispatching `onstart` (or
 * an `onend` for the failed session). Keep a bounded watchdog so a stream
 * cannot remain in `starting` forever and block subsequent retries.
 */
export const DEFAULT_WEB_SPEECH_START_TIMEOUT_MS = 2_000;
/**
 * WebKit can dispatch `onend` just before its last final `onresult`. Keep the
 * result slots alive for this short, finite drain window before restarting or
 * discarding a session.
 */
export const DEFAULT_WEB_SPEECH_FINAL_GRACE_MS = 50;
const MAX_TRACKED_RESULTS = 256;
const MAX_RESTART_BACKOFF_MS = 2_000;
const MIN_RESTART_DELAY_MS = 0;
const MIN_ALTERNATIVES = 1;
const INITIAL_RESTART_ATTEMPT = 0;
const FIRST_RETRY_ATTEMPT = 1;
const RESTART_BACKOFF_BASE_MS = 50;
const MAX_RESTART_EXPONENT = 5;
const MIN_RESULT_LENGTH = 0;
const DEFAULT_RESULT_INDEX = 0;
const RESULT_INDEX_STEP = 1;

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

export type WebSpeechRecognitionPermissionState = "granted" | "denied" | "prompt" | "unknown";

interface WebSpeechRecognitionPermissionStatusLike {
  readonly state?: string;
}

interface WebSpeechRecognitionPermissionsLike {
  query?: (descriptor: {
    readonly name: string;
  }) => Promise<WebSpeechRecognitionPermissionStatusLike>;
}

interface WebSpeechRecognitionNavigatorLike {
  readonly permissions?: WebSpeechRecognitionPermissionsLike;
  readonly userAgent?: string;
}

export type WebSpeechRecognitionScope = {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
  /** Kept opaque so a real DOM `Window` remains assignable in consumers. */
  navigator?: unknown;
  isSecureContext?: boolean;
  /** Tauri 2 exposes this marker in the renderer without enabling global APIs. */
  __TAURI_INTERNALS__?: unknown;
};

export type WebSpeechRecognitionConstructorName =
  | "SpeechRecognition"
  | "webkitSpeechRecognition"
  | null;

export interface WebSpeechRecognitionDiagnostics {
  readonly supported: boolean;
  readonly constructorName: WebSpeechRecognitionConstructorName;
  readonly reason: "constructor-missing" | "insecure-context" | "constructor-present";
  /** `null` means that the host did not expose an `isSecureContext` signal. */
  readonly secureContext: boolean | null;
  readonly runtime: "browser" | "tauri" | "unknown";
  readonly userAgent: string | null;
}

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
  /**
   * Maximum time to wait for `onstart` after `start()`. Defaults to
   * `DEFAULT_WEB_SPEECH_START_TIMEOUT_MS`; zero schedules the watchdog on the
   * next task and is useful for deterministic tests.
   */
  startTimeoutMs?: number;
  /**
   * Grace period after `onend` for a delayed final `onresult`. Defaults to
   * `DEFAULT_WEB_SPEECH_FINAL_GRACE_MS` and is always finite and non-negative.
   */
  finalResultGraceMs?: number;
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

const readScopeValue = <K extends keyof WebSpeechRecognitionScope>(
  scope: WebSpeechRecognitionScope,
  key: K,
): WebSpeechRecognitionScope[K] | undefined => {
  try {
    return scope[key];
  } catch {
    // A host object can expose a throwing getter while its web runtime is
    // shutting down. Treat that the same as a missing optional API.
    return undefined;
  }
};

const readNavigator = (scope: WebSpeechRecognitionScope): WebSpeechRecognitionNavigatorLike => {
  const value = readScopeValue(scope, "navigator");
  return value && typeof value === "object" ? (value as WebSpeechRecognitionNavigatorLike) : {};
};

const readNavigatorValue = <K extends keyof WebSpeechRecognitionNavigatorLike>(
  navigator: WebSpeechRecognitionNavigatorLike,
  key: K,
): WebSpeechRecognitionNavigatorLike[K] | undefined => {
  try {
    return navigator[key];
  } catch {
    return undefined;
  }
};

const readNavigatorPermissionValue = <K extends keyof WebSpeechRecognitionPermissionsLike>(
  permissions: WebSpeechRecognitionPermissionsLike,
  key: K,
): WebSpeechRecognitionPermissionsLike[K] | undefined => {
  try {
    return permissions[key];
  } catch {
    return undefined;
  }
};

/** Resolve the standard or WebKit-prefixed constructor without instantiating it. */
export const getWebSpeechRecognitionConstructor = (
  scope: WebSpeechRecognitionScope = getGlobalScope(),
): WebSpeechRecognitionConstructor | null => {
  const standard = readScopeValue(scope, "SpeechRecognition");
  if (isConstructor(standard)) {
    return standard;
  }
  const webkit = readScopeValue(scope, "webkitSpeechRecognition");
  if (isConstructor(webkit)) {
    return webkit;
  }
  return null;
};

/** Return which vendor API is actually exposed without constructing it. */
export const getWebSpeechRecognitionConstructorName = (
  scope: WebSpeechRecognitionScope = getGlobalScope(),
): WebSpeechRecognitionConstructorName => {
  const standard = readScopeValue(scope, "SpeechRecognition");
  if (isConstructor(standard)) {
    return "SpeechRecognition";
  }
  const webkit = readScopeValue(scope, "webkitSpeechRecognition");
  return isConstructor(webkit) ? "webkitSpeechRecognition" : null;
};

/**
 * Collect host facts for diagnostics. This deliberately does not call
 * `start()` or request permission, so it is safe to run while rendering the
 * settings page and cannot consume the user's transient gesture.
 */
export const getWebSpeechRecognitionDiagnostics = (
  scope: WebSpeechRecognitionScope = getGlobalScope(),
): WebSpeechRecognitionDiagnostics => {
  const constructorName = getWebSpeechRecognitionConstructorName(scope);
  const isSecureContext = readScopeValue(scope, "isSecureContext");
  const navigatorValue = readScopeValue(scope, "navigator");
  const navigator = readNavigator(scope);
  const userAgent = readNavigatorValue(navigator, "userAgent");
  return {
    supported: constructorName !== null,
    constructorName,
    reason:
      isSecureContext === false
        ? "insecure-context"
        : constructorName === null
          ? "constructor-missing"
          : "constructor-present",
    secureContext: typeof isSecureContext === "boolean" ? isSecureContext : null,
    runtime: readScopeValue(scope, "__TAURI_INTERNALS__")
      ? "tauri"
      : navigatorValue
        ? "browser"
        : "unknown",
    userAgent: typeof userAgent === "string" && userAgent.trim() ? userAgent : null,
  };
};

/**
 * Read the microphone permission without prompting. Speech recognition has no
 * interoperable `PermissionName`, so `microphone` is the only portable signal.
 * A `prompt`/`unknown` result must not block `start()`: the browser may need the
 * user's click to show its own speech-service permission sheet.
 */
export const queryWebSpeechRecognitionPermission = async (
  scope: WebSpeechRecognitionScope = getGlobalScope(),
): Promise<WebSpeechRecognitionPermissionState> => {
  const navigator = readNavigator(scope);
  const permissions = readNavigatorValue(navigator, "permissions");
  const query = permissions && readNavigatorPermissionValue(permissions, "query");
  if (typeof query !== "function") {
    return "unknown";
  }
  try {
    const status = await query.call(permissions, { name: "microphone" });
    const state = status?.state;
    return state === "granted" || state === "denied" || state === "prompt" ? state : "unknown";
  } catch {
    // Safari/WKWebView commonly throws for unsupported permission names or
    // disabled embedding APIs. This is diagnostic-only and never fatal.
    return "unknown";
  }
};

/** Feature detection that is safe in a DOM-less runtime. */
export const isWebSpeechRecognitionSupported = (
  scope: WebSpeechRecognitionScope = getGlobalScope(),
): boolean => getWebSpeechRecognitionConstructor(scope) !== null;

const clampRestartDelay = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_WEB_SPEECH_RESTART_DELAY_MS;
  }
  return Math.max(MIN_RESTART_DELAY_MS, Math.floor(value));
};

const clampStartTimeout = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_WEB_SPEECH_START_TIMEOUT_MS;
  }
  return Math.max(MIN_RESTART_DELAY_MS, Math.floor(value));
};

const clampFinalResultGrace = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_WEB_SPEECH_FINAL_GRACE_MS;
  }
  return Math.max(MIN_RESTART_DELAY_MS, Math.floor(value));
};

const normalizeLanguage = (value: string | undefined): string => {
  const language = value?.trim();
  return language || DEFAULT_WEB_SPEECH_LANGUAGE;
};

const normalizeMaxAlternatives = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return MIN_ALTERNATIVES;
  }
  return Math.max(MIN_ALTERNATIVES, Math.floor(value));
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

const isPermissionErrorCode = (code: string): boolean =>
  code === "not-allowed" ||
  code === "service-not-allowed" ||
  code === "security-error" ||
  code === "securityerror" ||
  code === "notallowederror";

const errorCodeFromCause = (cause: unknown): string | null => {
  if (!cause || typeof cause !== "object") {
    return null;
  }
  const record = cause as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"].trim().toLowerCase() : "";
  const code = typeof record["code"] === "string" ? record["code"].trim().toLowerCase() : "";
  if (isPermissionErrorCode(name) || isPermissionErrorCode(code)) {
    return "not-allowed";
  }
  return null;
};

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
  private readonly startTimeoutMs: number;
  private readonly finalResultGraceMs: number;
  private readonly onResult: (result: WebSpeechRecognitionResult) => void;
  private readonly onPartial: (transcript: string, result: WebSpeechRecognitionResult) => void;
  private readonly onFinal: (transcript: string, result: WebSpeechRecognitionResult) => void;
  private readonly onEvent: (event: WebSpeechRecognitionStreamEvent) => void;
  private readonly onError: (error: WebSpeechRecognitionError) => void;
  private readonly resultSlots = new Map<number, ResultSlot>();
  private stateValue: WebSpeechRecognitionStreamState = "idle";
  private shouldRun = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private finalResultGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  /** True while an error recovery abort is waiting for the browser's `onend`. */
  private recoveryAbortPending = false;
  /** Number of late `onend` callbacks consumed after a forced recovery reset. */
  private ignoredEndEvents = 0;
  private disposed = false;

  public constructor(options: WebSpeechRecognitionStreamOptions = {}) {
    const recognition = options.recognition ?? this.createRecognition(options);
    this.recognition = recognition;
    this.restartDelayMs = clampRestartDelay(options.restartDelayMs);
    this.startTimeoutMs = clampStartTimeout(options.startTimeoutMs);
    this.finalResultGraceMs = clampFinalResultGrace(options.finalResultGraceMs);
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
      this.clearStartWatchdog();
      // A forced recovery may have reserved one stale onend callback. If the
      // replacement reaches onstart first, that callback either never arrives
      // or belongs to the new session; never consume the new session's end as
      // stale. Late old ends are still harmless because onend schedules the
      // next replacement.
      this.ignoredEndEvents = 0;
      this.recoveryAbortPending = false;
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
      if (this.ignoredEndEvents > 0) {
        this.ignoredEndEvents -= 1;
        this.recoveryAbortPending = false;
        return;
      }
      this.clearStartWatchdog();
      this.recoveryAbortPending = false;
      this.stateValue = "idle";
      const willRestart = this.shouldRun;
      this.emitEvent({ type: "end", willRestart });
      // Do not restart or clear de-duplication state synchronously. WebKit can
      // deliver the final result on the next task after `onend`; the grace
      // timer keeps that result observable before the next session begins.
      this.armFinalResultGrace(true);
    };
  }

  private createRecognition(options: WebSpeechRecognitionStreamOptions): WebSpeechRecognitionLike {
    if (options.recognitionFactory) {
      return options.recognitionFactory();
    }
    if (options.recognitionConstructor) {
      return new options.recognitionConstructor();
    }
    const scope = getGlobalScope();
    const constructors = [
      readScopeValue(scope, "SpeechRecognition"),
      readScopeValue(scope, "webkitSpeechRecognition"),
    ].filter(isConstructor);
    const uniqueConstructors = constructors.filter(
      (candidate, index) => constructors.indexOf(candidate) === index,
    );
    if (uniqueConstructors.length === 0) {
      throw new Error("Web Speech Recognition is unavailable in this runtime");
    }
    let lastError: unknown = null;
    for (const recognitionCtor of uniqueConstructors) {
      try {
        return new recognitionCtor();
      } catch (error) {
        // A stale standard constructor can remain exposed while only the
        // WebKit implementation is usable (and vice versa). Try the other
        // vendor before surfacing an initialization failure.
        lastError = error;
      }
    }
    throw lastError ?? new Error("Web Speech Recognition could not be initialized");
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
    if (this.stateValue === "stopping") {
      // `stop()` is graceful and normally resolves through onend. WebKit can
      // omit that callback, though, leaving a same-instance restart stuck in
      // the stopping state. Abort the old session and force an idle boundary;
      // any delayed end is consumed so it cannot tear down the replacement.
      this.recoveryAbortPending = true;
      try {
        this.recognition.abort();
      } catch {
        // The forced state transition below is the fallback for hosts that
        // reject abort() while their speech service is already unwinding.
      }
      if (this.stateValue === "stopping") {
        this.stateValue = "idle";
        this.ignoredEndEvents += 1;
      }
      this.recoveryAbortPending = false;
    }
    // If `onend` already fired, let its finite drain window finish before
    // starting a replacement. Starting now would clear resultSlots and could
    // lose WebKit's delayed final result.
    if (this.finalResultGraceTimer !== null && this.finalResultGraceAwaitingEnd) {
      return;
    }
    this.clearFinalResultGraceTimer();
    this.startRecognizer();
  }

  /**
   * Gracefully stop listening. `onend` is still delivered by the browser, but
   * its restart guard is disabled before calling `stop()`.
   */
  public stop(): void {
    this.shouldRun = false;
    this.clearRestartTimer();
    this.clearStartWatchdog();
    this.recoveryAbortPending = false;
    this.ignoredEndEvents = 0;
    if (this.stateValue === "idle" || this.stateValue === "stopping") {
      if (this.stateValue === "stopping" && this.finalResultGraceTimer === null) {
        this.armFinalResultGrace();
      }
      return;
    }
    this.stateValue = "stopping";
    try {
      this.recognition.stop();
    } catch (error) {
      this.reportLifecycleError("stop", error);
      this.stateValue = "idle";
      // If stop() failed before the browser could emit onend, still provide
      // the same bounded drain for a late final result.
    }
    // Some WebKit builds omit onend after stop(). Arm the drain proactively;
    // a synchronous/late onend simply resets the same finite timer.
    this.armFinalResultGrace();
  }

  /** Stop immediately and discard in-flight browser recognition. */
  public cancel(): void {
    this.shouldRun = false;
    this.clearRestartTimer();
    this.clearStartWatchdog();
    this.recoveryAbortPending = false;
    this.ignoredEndEvents = 0;
    if (this.stateValue === "idle" || this.stateValue === "stopping") {
      if (this.stateValue === "stopping" && this.finalResultGraceTimer === null) {
        this.armFinalResultGrace();
      }
      return;
    }
    this.stateValue = "stopping";
    try {
      this.recognition.abort();
    } catch (error) {
      this.reportLifecycleError("cancel", error);
      this.stateValue = "idle";
    }
    // abort() is not required to dispatch onend. Keep a bounded drain even
    // in that case so an already-queued final result is not dropped.
    this.armFinalResultGrace();
  }

  /** Alias useful to owners that treat streams as disposable resources. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.cancel();
    this.disposed = true;
    this.clearFinalResultGraceTimer();
    this.clearStartWatchdog();
    this.resultSlots.clear();
    this.recognition.onstart = null;
    this.recognition.onresult = null;
    this.recognition.onerror = null;
    this.recognition.onend = null;
  }

  private startRecognizer(): void {
    if (this.disposed || !this.shouldRun) {
      return;
    }
    // Never call start() while the previous WebKit session is still active.
    // Safari reports InvalidStateError here and some WKWebView builds then
    // stop dispatching events altogether. Error recovery aborts the old
    // session first and reaches this method only after the guard is idle.
    if (this.stateValue !== "idle") {
      return;
    }
    this.clearRestartTimer();
    this.resultSlots.clear();
    this.stateValue = "starting";
    this.armStartWatchdog();
    try {
      this.recognition.start();
    } catch (error) {
      // Browsers can throw InvalidStateError when an `onend`/`onstart` race
      // occurs. Treat it as recoverable while the caller still wants a stream.
      this.clearStartWatchdog();
      this.stateValue = "idle";
      const fatal = isFatalErrorCode(errorCodeFromCause(error) ?? "");
      if (fatal) {
        this.shouldRun = false;
        this.clearRestartTimer();
      }
      this.reportLifecycleError("start", error);
      if (this.shouldRun && !fatal) {
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
      this.restartAttempt === INITIAL_RESTART_ATTEMPT
        ? MIN_RESTART_DELAY_MS
        : RESTART_BACKOFF_BASE_MS *
            2 ** Math.min(this.restartAttempt - FIRST_RETRY_ATTEMPT, MAX_RESTART_EXPONENT),
    );
    const delay = Math.max(this.restartDelayMs, backoff);
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.shouldRun || this.disposed) {
        return;
      }
      if (this.stateValue !== "idle") {
        // Recoverable errors can arrive before `onend`, and some WebKit
        // versions never deliver that event. Force the old session to release
        // its microphone before starting a replacement; a late `onend` is
        // consumed by the guard in the event handler.
        if (this.stateValue === "starting" || this.stateValue === "running") {
          this.recoveryAbortPending = true;
          try {
            this.recognition.abort();
          } catch {
            // startRecognizer below still reports a useful lifecycle error if
            // the browser refused to abort the stale session.
          }
          const stateAfterAbort = this.stateValue as WebSpeechRecognitionStreamState;
          if (stateAfterAbort !== "idle") {
            this.stateValue = "idle";
            this.ignoredEndEvents += 1;
          }
        }
        if (this.stateValue === "stopping") {
          if (this.recoveryAbortPending) {
            this.ignoredEndEvents += 1;
          }
          this.recoveryAbortPending = false;
          this.stateValue = "idle";
        }
      }
      this.startRecognizer();
    }, delay);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private armStartWatchdog(): void {
    this.clearStartWatchdog();
    this.startWatchdogTimer = setTimeout(() => {
      this.startWatchdogTimer = null;
      this.handleStartTimeout();
    }, this.startTimeoutMs);
  }

  private clearStartWatchdog(): void {
    if (this.startWatchdogTimer !== null) {
      clearTimeout(this.startWatchdogTimer);
      this.startWatchdogTimer = null;
    }
  }

  private handleStartTimeout(): void {
    if (this.disposed || !this.shouldRun || this.stateValue !== "starting") {
      return;
    }

    // There is no reliable way to distinguish a late `onend` from the timed
    // out session once a single recognizer instance is reused. Abort first,
    // then reserve one stale end slot only when the abort did not synchronously
    // deliver an end boundary. This mirrors the existing recoverable-error
    // path and prevents the replacement session from being torn down by an
    // old callback.
    this.recoveryAbortPending = true;
    try {
      this.recognition.abort();
    } catch {
      // The explicit idle transition below is the fallback for hosts that
      // reject abort() while their speech service is already unwinding.
    }
    const stateAfterAbort = this.stateValue as WebSpeechRecognitionStreamState;
    const endedSynchronously = stateAfterAbort === "idle";
    if (!endedSynchronously) {
      this.stateValue = "idle";
      this.ignoredEndEvents += 1;
      this.emitEvent({ type: "end", willRestart: this.shouldRun });
      // Keep a late final result observable even when the host omitted onend.
      this.armFinalResultGrace(true);
    }
    this.recoveryAbortPending = false;

    // A synchronous abort can have armed the same grace timer through onend;
    // its expiry owns the retry in that case. Otherwise schedule the bounded
    // replacement now.
    if (this.shouldRun && !this.disposed && this.finalResultGraceTimer === null) {
      this.scheduleRestart();
    }
  }

  private finalResultGraceAwaitingEnd = false;

  private armFinalResultGrace(awaitingEnd = false): void {
    const hadEndBoundary = this.finalResultGraceTimer !== null && this.finalResultGraceAwaitingEnd;
    this.clearFinalResultGraceTimer();
    this.finalResultGraceAwaitingEnd = awaitingEnd || hadEndBoundary;
    this.finalResultGraceTimer = setTimeout(() => {
      this.finalResultGraceTimer = null;
      this.finalResultGraceAwaitingEnd = false;
      this.resultSlots.clear();
      if (this.shouldRun && !this.disposed && this.stateValue === "idle") {
        this.scheduleRestart();
      }
    }, this.finalResultGraceMs);
  }

  private clearFinalResultGraceTimer(): void {
    if (this.finalResultGraceTimer !== null) {
      clearTimeout(this.finalResultGraceTimer);
      this.finalResultGraceTimer = null;
    }
    this.finalResultGraceAwaitingEnd = false;
  }

  private handleResult(event: WebSpeechRecognitionEventLike): void {
    const results = event.results;
    if (!results || !Number.isFinite(results.length) || results.length <= MIN_RESULT_LENGTH) {
      return;
    }
    const rawStart = event.resultIndex ?? DEFAULT_RESULT_INDEX;
    const start = Number.isFinite(rawStart)
      ? Math.max(MIN_RESULT_LENGTH, Math.floor(rawStart))
      : DEFAULT_RESULT_INDEX;
    const end = Math.max(start, Math.floor(results.length));
    this.pruneResultSlots(start);
    for (let index = start; index < end; index += RESULT_INDEX_STEP) {
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
      this.recoveryAbortPending = false;
      this.stateValue = "stopping";
    }
    try {
      this.onError(error);
    } catch {
      // Error observers are application code; do not leak exceptions into the
      // browser's SpeechRecognition event dispatcher.
    }
    this.emitEvent({ type: "error", error });
    if (error.fatal) {
      // A fatal error (most commonly permission denied) can leave a WebKit
      // recognizer holding the input device unless it is explicitly aborted.
      // Do not report a second lifecycle error if an older engine rejects the
      // abort call; the original error is the actionable one.
      try {
        this.recognition.abort();
      } catch {
        this.stateValue = "idle";
      }
    }
    // Some engines report recoverable `no-speech`/network errors before
    // `onend`, and some omit `onend` entirely. Abort the current session first;
    // scheduleRestart() then waits for a normal end or force-releases the
    // stale session at the timer boundary before starting a replacement.
    if (!error.fatal && this.shouldRun) {
      this.recoveryAbortPending = true;
      this.stateValue = "stopping";
      try {
        this.recognition.abort();
      } catch {
        // The restart timer contains the fallback for engines that reject or
        // silently ignore abort().
      }
      this.scheduleRestart();
    }
  }

  private reportLifecycleError(operation: string, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : `${cause}`;
    const code = errorCodeFromCause(cause) ?? `lifecycle-${operation}`;
    const error = new WebSpeechRecognitionError({
      code,
      message: `Web Speech Recognition ${operation} failed: ${message}`,
      fatal: isFatalErrorCode(code),
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
