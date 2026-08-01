/**
 * Browser-side Vibrato integration shared by the comparison app.
 *
 * The WASM package is intentionally injected instead of imported here.  The
 * current maintained build is published on JSR (`@ryo-morimoto/vibrato-wasm`)
 * rather than npm, and Next.js/Turbopack should own how that package (and the
 * dictionary asset) is bundled.  This module owns the stable application
 * contract: browser and Worker execution, fallback state, and ordering of
 * Web Speech partial/final results.
 */

import type { ComparisonMode } from "./contract";

/** Alias the adapter mode to the app-wide configuration contract. */
export type VibratoComparisonMode = ComparisonMode;

export type VibratoAdapterState =
  | "idle"
  | "loading"
  | "ready"
  | "unsupported"
  | "error"
  | "disposed";

export type VibratoErrorCode =
  | "unsupported"
  | "invalid-request"
  | "missing-dictionary"
  | "dictionary-fetch"
  | "worker-init"
  | "worker-error"
  | "worker-timeout"
  | "tokenize"
  | "disposed";

export interface VibratoToken {
  /** Surface form returned by Vibrato. */
  readonly surface: string;
  /** Dictionary-dependent comma-separated feature string. */
  readonly feature: string;
}

/** Metadata carried through a browser/Worker tokenization request. */
export interface VibratoInput {
  readonly sessionId: string;
  /** Stable caption/turn identifier inside one recognition session. */
  readonly turnId: string;
  /** Monotonically increasing revision for this session/turn. */
  readonly revision: number;
  readonly text: string;
  /** True when the Web Speech result that produced this revision is final. */
  readonly isFinal: boolean;
}

export interface VibratoOutput extends VibratoInput {
  readonly tokens: readonly VibratoToken[];
  readonly mode: VibratoComparisonMode;
}

export interface VibratoTokenizerLike {
  tokenize(
    text: string,
  ): VibratoToken[] | readonly VibratoToken[] | Promise<VibratoToken[] | readonly VibratoToken[]>;
  free?: () => void;
}

export type VibratoTokenizerFactory = (
  dictionaryBytes: Uint8Array,
) => VibratoTokenizerLike | Promise<VibratoTokenizerLike>;

/** Small structural Worker type used by both browser code and unit tests. */
export interface VibratoWorkerLike {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate?: () => void;
}

export interface VibratoWorkerInitRequest {
  readonly type: "init";
  readonly requestId: string;
  /** The Worker may fetch this URL, keeping the dictionary off the main thread. */
  readonly dictionaryUrl?: string;
  /** Optional transferable dictionary bytes for local/test deployments. */
  readonly dictionaryBytes?: ArrayBuffer;
}

export interface VibratoWorkerTokenizeRequest {
  readonly type: "tokenize";
  readonly requestId: string;
  readonly vibratoInput: VibratoInput;
}

export interface VibratoWorkerDisposeRequest {
  readonly type: "dispose";
  readonly requestId: string;
}

export type VibratoWorkerRequest =
  | VibratoWorkerInitRequest
  | VibratoWorkerTokenizeRequest
  | VibratoWorkerDisposeRequest;

export interface VibratoWorkerReadyResponse {
  readonly type: "ready";
  readonly requestId: string;
}

export interface VibratoWorkerTokenizedResponse {
  readonly type: "tokenized";
  readonly requestId: string;
  readonly vibratoOutput: VibratoOutput;
}

export interface VibratoWorkerErrorResponse {
  readonly type: "error";
  readonly requestId?: string;
  readonly code: VibratoErrorCode | string;
  readonly message: string;
}

export interface VibratoWorkerDisposedResponse {
  readonly type: "disposed";
  readonly requestId: string;
}

export type VibratoWorkerResponse =
  | VibratoWorkerReadyResponse
  | VibratoWorkerTokenizedResponse
  | VibratoWorkerErrorResponse
  | VibratoWorkerDisposedResponse;

export interface VibratoAdapterErrorInfo {
  readonly code: VibratoErrorCode | string;
  readonly message: string;
}

export interface VibratoAdapterSnapshot {
  readonly state: VibratoAdapterState;
  readonly requestedMode: VibratoComparisonMode;
  readonly activeMode: VibratoComparisonMode | null;
  /** Set when worker-vibrato fell back to browser-vibrato. */
  readonly fallbackFrom?: VibratoComparisonMode;
  readonly error?: VibratoAdapterErrorInfo;
}

export interface VibratoBrowserAdapterOptions {
  readonly mode: VibratoComparisonMode;
  readonly worker?: VibratoWorkerLike;
  readonly workerFactory?: () => VibratoWorkerLike;
  /** Required for browser-vibrato and optional as worker fallback. */
  readonly tokenizerFactory?: VibratoTokenizerFactory;
  /** URL is preferred for Worker mode so the 8 MB dictionary is not copied. */
  readonly dictionaryUrl?: string;
  readonly dictionaryBytes?: Uint8Array;
  readonly requestTimeoutMs?: number;
  readonly allowFallback?: boolean;
  readonly onStateChange?: (snapshot: VibratoAdapterSnapshot) => void;
}

export interface VibratoBrowserAdapter {
  readonly snapshot: VibratoAdapterSnapshot;
  initialize(): Promise<VibratoAdapterSnapshot>;
  tokenize(input: VibratoInput): Promise<VibratoOutput>;
  dispose(): void;
}

export interface VibratoWasmModuleLike {
  initTokenizer(dictionaryBytes: Uint8Array): Promise<VibratoTokenizerLike>;
}

/** Adapt the maintained WASM package's `initTokenizer` export to this module. */
export const createVibratoTokenizerFactory =
  (wasmModule: VibratoWasmModuleLike): VibratoTokenizerFactory =>
  (dictionaryBytes) =>
    wasmModule.initTokenizer(dictionaryBytes);

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_TIMEOUT_MS = 1;
const MIN_REVISION = 0;
const MIN_RESULT_INDEX = 0;
let requestSequence = 0;

const nextRequestId = (): string => {
  requestSequence += 1;
  return `vibrato-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
};

const adapterError = (code: VibratoErrorCode | string, message: string): VibratoAdapterError =>
  new VibratoAdapterError({ code, message });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isVibratoInput = (value: unknown): value is VibratoInput =>
  isRecord(value) &&
  isNonEmptyString(value.sessionId) &&
  isNonEmptyString(value.turnId) &&
  typeof value.revision === "number" &&
  Number.isSafeInteger(value.revision) &&
  value.revision >= MIN_REVISION &&
  typeof value.text === "string" &&
  typeof value.isFinal === "boolean";

const isWorkerRequest = (value: unknown): value is VibratoWorkerRequest => {
  if (!isRecord(value) || !isNonEmptyString(value.type) || !isNonEmptyString(value.requestId)) {
    return false;
  }
  if (value.type === "init") {
    return value.dictionaryUrl === undefined || typeof value.dictionaryUrl === "string";
  }
  if (value.type === "tokenize") {
    return isVibratoInput(value.vibratoInput);
  }
  return value.type === "dispose";
};

const normalizeTokens = (value: unknown): VibratoToken[] => {
  if (!Array.isArray(value)) {
    throw adapterError("tokenize", "Vibrato returned an invalid token list");
  }
  return value.map((token, index) => {
    if (
      !isRecord(token) ||
      typeof token.surface !== "string" ||
      typeof token.feature !== "string"
    ) {
      throw adapterError("tokenize", `Vibrato returned an invalid token at index ${index}`);
    }
    return { surface: token.surface, feature: token.feature };
  });
};

const toTransferableArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const snapshotError = (error: unknown, fallbackCode: VibratoErrorCode): VibratoAdapterErrorInfo => {
  if (error instanceof VibratoAdapterError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
};

export class VibratoAdapterError extends Error {
  readonly code: VibratoErrorCode | string;

  constructor(info: VibratoAdapterErrorInfo) {
    super(info.message);
    this.name = "VibratoAdapterError";
    this.code = info.code;
  }
}

type PendingWorkerRequest = {
  readonly resolve: (response: VibratoWorkerResponse) => void;
  readonly reject: (error: VibratoAdapterError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

class VibratoWorkerClient {
  private readonly worker: VibratoWorkerLike;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingWorkerRequest>();
  private closed = false;

  constructor(worker: VibratoWorkerLike, timeoutMs: number) {
    this.worker = worker;
    this.timeoutMs = timeoutMs;
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = (event) => this.handleWorkerError(event);
  }

  async initialize(request: Omit<VibratoWorkerInitRequest, "type" | "requestId">): Promise<void> {
    const response = await this.request({
      type: "init",
      requestId: nextRequestId(),
      ...request,
    });
    if (response.type !== "ready") {
      if (response.type === "error") {
        throw adapterError(response.code, response.message);
      }
      throw adapterError("worker-init", `Unexpected Vibrato Worker response: ${response.type}`);
    }
  }

  async tokenize(input: VibratoInput): Promise<VibratoOutput> {
    const response = await this.request({
      type: "tokenize",
      requestId: nextRequestId(),
      vibratoInput: input,
    });
    if (response.type !== "tokenized") {
      if (response.type === "error") {
        throw adapterError(response.code, response.message);
      }
      throw adapterError("worker-error", `Unexpected Vibrato Worker response: ${response.type}`);
    }
    if (!isVibratoInput(response.vibratoOutput) || !Array.isArray(response.vibratoOutput.tokens)) {
      throw adapterError("worker-error", "Vibrato Worker returned an invalid tokenization result");
    }
    return {
      ...response.vibratoOutput,
      tokens: normalizeTokens(response.vibratoOutput.tokens),
    };
  }

  dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(adapterError("disposed", "Vibrato Worker was disposed"));
    }
    this.pending.clear();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate?.();
  }

  private request(request: VibratoWorkerRequest): Promise<VibratoWorkerResponse> {
    if (this.closed) {
      return Promise.reject(adapterError("disposed", "Vibrato Worker was disposed"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(adapterError("worker-timeout", `Vibrato Worker timed out for ${request.type}`));
      }, this.timeoutMs);
      this.pending.set(request.requestId, { resolve, reject, timer });
      try {
        if (request.type === "init" && request.dictionaryBytes) {
          this.worker.postMessage(request, [request.dictionaryBytes]);
        } else {
          this.worker.postMessage(request);
        }
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(
          adapterError("worker-error", error instanceof Error ? error.message : String(error)),
        );
      }
    });
  }

  private handleMessage(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") {
      return;
    }
    const requestId = typeof value.requestId === "string" ? value.requestId : undefined;
    if (!requestId) {
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (value.type === "error") {
      pending.reject(
        adapterError(
          typeof value.code === "string" ? value.code : "worker-error",
          typeof value.message === "string" ? value.message : "Vibrato Worker failed",
        ),
      );
      return;
    }
    if (value.type === "ready" || value.type === "tokenized" || value.type === "disposed") {
      pending.resolve(value as unknown as VibratoWorkerResponse);
      return;
    }
    pending.reject(adapterError("worker-error", `Unknown Vibrato Worker response: ${value.type}`));
  }

  private handleWorkerError(event: unknown): void {
    const message = event instanceof Error ? event.message : "Vibrato Worker failed";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(adapterError("worker-error", message));
    }
    this.pending.clear();
  }
}

const getDictionaryBytes = async (
  options: Pick<VibratoBrowserAdapterOptions, "dictionaryBytes" | "dictionaryUrl">,
): Promise<Uint8Array> => {
  if (options.dictionaryBytes) {
    return new Uint8Array(options.dictionaryBytes);
  }
  if (!options.dictionaryUrl) {
    throw adapterError("missing-dictionary", "A Vibrato dictionary URL or byte array is required");
  }
  let response: Response;
  try {
    response = await fetch(options.dictionaryUrl);
  } catch (error) {
    throw adapterError(
      "dictionary-fetch",
      error instanceof Error ? error.message : "Could not fetch the Vibrato dictionary",
    );
  }
  if (!response.ok) {
    throw adapterError(
      "dictionary-fetch",
      `Could not fetch the Vibrato dictionary (HTTP ${response.status})`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
};

class VibratoBrowserAdapterImpl implements VibratoBrowserAdapter {
  private readonly options: VibratoBrowserAdapterOptions;
  private readonly timeoutMs: number;
  private readonly allowFallback: boolean;
  private currentSnapshot: VibratoAdapterSnapshot;
  private initializePromise: Promise<VibratoAdapterSnapshot> | null = null;
  private workerClient: VibratoWorkerClient | null = null;
  private tokenizer: VibratoTokenizerLike | null = null;
  private disposed = false;

  constructor(options: VibratoBrowserAdapterOptions) {
    this.options = options;
    this.timeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? Math.max(
          MIN_REQUEST_TIMEOUT_MS,
          Math.floor(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
        )
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.allowFallback = options.allowFallback !== false;
    this.currentSnapshot = {
      state: "idle",
      requestedMode: options.mode,
      activeMode: null,
    };
  }

  get snapshot(): VibratoAdapterSnapshot {
    return this.currentSnapshot;
  }

  initialize(): Promise<VibratoAdapterSnapshot> {
    if (this.disposed) {
      return Promise.reject(adapterError("disposed", "Vibrato adapter was disposed"));
    }
    if (this.currentSnapshot.state === "ready") {
      return Promise.resolve(this.currentSnapshot);
    }
    if (this.initializePromise) {
      return this.initializePromise;
    }
    this.setSnapshot({ state: "loading", activeMode: null, error: undefined });
    this.initializePromise = this.initializeInternal().finally(() => {
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  async tokenize(input: VibratoInput): Promise<VibratoOutput> {
    if (!isVibratoInput(input)) {
      throw adapterError("invalid-request", "Invalid Vibrato input metadata");
    }
    await this.initialize();
    if (this.disposed) {
      throw adapterError("disposed", "Vibrato adapter was disposed");
    }
    try {
      if (this.workerClient && this.currentSnapshot.activeMode === "worker-vibrato") {
        const output = await this.workerClient.tokenize(input);
        return { ...output, mode: "worker-vibrato", tokens: normalizeTokens(output.tokens) };
      }
      if (this.tokenizer && this.currentSnapshot.activeMode === "browser-vibrato") {
        const tokens = normalizeTokens(await this.tokenizer.tokenize(input.text));
        return { ...input, tokens, mode: "browser-vibrato" };
      }
    } catch (error) {
      const info = snapshotError(error, "tokenize");
      this.setSnapshot({ state: "error", error: info });
      throw error instanceof VibratoAdapterError ? error : adapterError(info.code, info.message);
    }
    throw adapterError("unsupported", "Vibrato tokenizer is not ready");
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.workerClient?.dispose();
    this.workerClient = null;
    this.tokenizer?.free?.();
    this.tokenizer = null;
    this.setSnapshot({ state: "disposed", activeMode: null });
  }

  private async initializeInternal(): Promise<VibratoAdapterSnapshot> {
    if (this.options.mode === "worker-vibrato") {
      const worker = this.options.worker ?? this.options.workerFactory?.();
      if (worker) {
        const client = new VibratoWorkerClient(worker, this.timeoutMs);
        try {
          await client.initialize({
            dictionaryUrl: this.options.dictionaryUrl,
            dictionaryBytes: this.options.dictionaryBytes
              ? toTransferableArrayBuffer(this.options.dictionaryBytes)
              : undefined,
          });
          this.workerClient = client;
          return this.setSnapshot({
            state: "ready",
            activeMode: "worker-vibrato",
            error: undefined,
          });
        } catch (error) {
          client.dispose();
          this.workerClient?.dispose();
          this.workerClient = null;
          if (!this.allowFallback || !this.options.tokenizerFactory) {
            return this.setFailure(error, "worker-init");
          }
          return this.initializeBrowserFallback(error);
        }
      }
      if (this.allowFallback && this.options.tokenizerFactory) {
        return this.initializeBrowserFallback(
          adapterError("unsupported", "Vibrato Worker is unavailable"),
        );
      }
      return this.setSnapshot({
        state: "unsupported",
        activeMode: null,
        error: { code: "unsupported", message: "Vibrato Worker is unavailable" },
      });
    }
    if (!this.options.tokenizerFactory) {
      return this.setSnapshot({
        state: "unsupported",
        activeMode: null,
        error: { code: "unsupported", message: "Browser Vibrato WASM loader is unavailable" },
      });
    }
    try {
      const dictionaryBytes = await getDictionaryBytes(this.options);
      this.tokenizer = await this.options.tokenizerFactory(dictionaryBytes);
      return this.setSnapshot({ state: "ready", activeMode: "browser-vibrato", error: undefined });
    } catch (error) {
      return this.setFailure(error, "tokenize");
    }
  }

  private async initializeBrowserFallback(originalError: unknown): Promise<VibratoAdapterSnapshot> {
    const fallbackInfo = snapshotError(originalError, "worker-init");
    try {
      const dictionaryBytes = await getDictionaryBytes(this.options);
      const tokenizer = await this.options.tokenizerFactory?.(dictionaryBytes);
      this.tokenizer = tokenizer ?? null;
      if (!tokenizer) {
        return this.setFailure(originalError, "unsupported");
      }
      return this.setSnapshot({
        state: "ready",
        activeMode: "browser-vibrato",
        fallbackFrom: "worker-vibrato",
        error: {
          code: fallbackInfo.code,
          message: `Worker unavailable; using browser Vibrato fallback: ${fallbackInfo.message}`,
        },
      });
    } catch (error) {
      return this.setFailure(error, "tokenize", "worker-vibrato");
    }
  }

  private setFailure(
    error: unknown,
    fallbackCode: VibratoErrorCode,
    fallbackFrom?: VibratoComparisonMode,
  ): VibratoAdapterSnapshot {
    const info = snapshotError(error, fallbackCode);
    return this.setSnapshot({ state: "error", activeMode: null, fallbackFrom, error: info });
  }

  private setSnapshot(
    patch: Omit<Partial<VibratoAdapterSnapshot>, "requestedMode"> & {
      readonly state: VibratoAdapterState;
    },
  ): VibratoAdapterSnapshot {
    const next: VibratoAdapterSnapshot = {
      requestedMode: this.options.mode,
      state: patch.state,
      activeMode:
        patch.activeMode === undefined ? this.currentSnapshot.activeMode : patch.activeMode,
      ...(patch.fallbackFrom ? { fallbackFrom: patch.fallbackFrom } : {}),
      ...(patch.error ? { error: patch.error } : {}),
    };
    this.currentSnapshot = next;
    this.options.onStateChange?.(next);
    return next;
  }
}

export const createVibratoBrowserAdapter = (
  options: VibratoBrowserAdapterOptions,
): VibratoBrowserAdapter => new VibratoBrowserAdapterImpl(options);

/** Alias used by callers that do not need the browser-specific name. */
export const createVibratoAdapter = createVibratoBrowserAdapter;

export interface VibratoWorkerScopeLike {
  postMessage(message: VibratoWorkerResponse): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener?(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
}

export interface VibratoWorkerHandlerOptions {
  readonly scope: VibratoWorkerScopeLike;
  readonly loadTokenizer: (
    request: VibratoWorkerInitRequest,
  ) => VibratoTokenizerLike | Promise<VibratoTokenizerLike>;
}

/**
 * Install the protocol handler inside a DedicatedWorker.
 *
 * The caller supplies `loadTokenizer`, which can import the JSR WASM package,
 * fetch a dictionary URL, or return a deterministic fake in tests.  Keeping
 * that loader outside the handler avoids bundler-specific WASM imports here.
 */
export const createVibratoWorkerHandler = (options: VibratoWorkerHandlerOptions): (() => void) => {
  let tokenizer: VibratoTokenizerLike | null = null;
  let disposed = false;
  let generation = 0;

  const sendError = (
    requestId: string | undefined,
    code: VibratoErrorCode | string,
    message: string,
  ): void => {
    options.scope.postMessage({ type: "error", requestId, code, message });
  };

  const onMessage = (event: { readonly data: unknown }): void => {
    const request = event.data;
    if (!isWorkerRequest(request)) {
      sendError(undefined, "invalid-request", "Invalid Vibrato Worker request");
      return;
    }
    if (disposed && request.type !== "dispose") {
      sendError(request.requestId, "disposed", "Vibrato Worker is disposed");
      return;
    }
    const requestGeneration = generation;
    void (async () => {
      try {
        if (request.type === "init") {
          tokenizer?.free?.();
          tokenizer = await options.loadTokenizer(request);
          if (disposed || requestGeneration !== generation) {
            tokenizer?.free?.();
            tokenizer = null;
            sendError(
              request.requestId,
              "disposed",
              "Vibrato Worker initialization was superseded",
            );
            return;
          }
          options.scope.postMessage({ type: "ready", requestId: request.requestId });
          return;
        }
        if (request.type === "tokenize") {
          if (!tokenizer) {
            sendError(request.requestId, "worker-init", "Vibrato Worker is not initialized");
            return;
          }
          const tokens = normalizeTokens(await tokenizer.tokenize(request.vibratoInput.text));
          options.scope.postMessage({
            type: "tokenized",
            requestId: request.requestId,
            vibratoOutput: {
              ...request.vibratoInput,
              mode: "worker-vibrato",
              tokens,
            },
          });
          return;
        }
        tokenizer?.free?.();
        tokenizer = null;
        disposed = true;
        generation += 1;
        options.scope.postMessage({ type: "disposed", requestId: request.requestId });
      } catch (error) {
        sendError(
          request.requestId,
          error instanceof VibratoAdapterError ? error.code : "tokenize",
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  };

  options.scope.addEventListener("message", onMessage);
  return () => {
    if (disposed) {
      options.scope.removeEventListener?.("message", onMessage);
      return;
    }
    disposed = true;
    generation += 1;
    tokenizer?.free?.();
    tokenizer = null;
    options.scope.removeEventListener?.("message", onMessage);
  };
};

export interface WebSpeechVibratoResult {
  readonly resultIndex: number;
  readonly transcript: string;
  readonly confidence?: number;
  readonly isFinal: boolean;
}

export interface WebSpeechVibratoSynchronizerOptions {
  readonly adapter: VibratoBrowserAdapter;
  readonly sessionId?: string;
  readonly onOutput?: (output: VibratoOutput) => void;
  readonly onError?: (error: VibratoAdapterError, input: VibratoInput) => void;
}

export interface WebSpeechVibratoSynchronizer {
  startSession(sessionId?: string): string;
  endSession(): void;
  accept(result: WebSpeechVibratoResult): Promise<VibratoOutput | null>;
  readonly sessionId: string | null;
  readonly revision: number;
}

type SpeechSlot = {
  transcript: string;
  isFinal: boolean;
  confidence?: number;
};

let speechSessionSequence = 0;

const nextSpeechSessionId = (): string => {
  speechSessionSequence += 1;
  return `webspeech-${Date.now().toString(36)}-${speechSessionSequence.toString(36)}`;
};

/**
 * Coalesce Web Speech result slots and protect the caption stream from stale
 * Worker replies.  Web Speech can resend every previous final slot in one
 * event, while a Worker may finish an older partial after a newer final.  The
 * synchronizer gives all revisions one stable session/turn identity and only
 * publishes the latest revision.
 */
export const createWebSpeechVibratoSynchronizer = (
  options: WebSpeechVibratoSynchronizerOptions,
): WebSpeechVibratoSynchronizer => {
  let currentSessionId = options.sessionId?.trim() || null;
  let sessionGeneration = 0;
  let currentRevision = 0;
  let active = false;
  const slots = new Map<number, SpeechSlot>();

  const startSession = (sessionId?: string): string => {
    sessionGeneration += 1;
    currentSessionId = sessionId?.trim() || nextSpeechSessionId();
    currentRevision = 0;
    slots.clear();
    active = true;
    return currentSessionId;
  };

  const endSession = (): void => {
    active = false;
    sessionGeneration += 1;
    currentSessionId = null;
    currentRevision = 0;
    slots.clear();
  };

  const accept = async (result: WebSpeechVibratoResult): Promise<VibratoOutput | null> => {
    if (!active) {
      startSession();
    }
    if (!Number.isSafeInteger(result.resultIndex) || result.resultIndex < MIN_RESULT_INDEX) {
      return null;
    }
    const transcript = result.transcript;
    if (typeof transcript !== "string" || transcript.trim().length === 0) {
      return null;
    }
    const previous = slots.get(result.resultIndex);
    if (
      previous &&
      previous.transcript === transcript &&
      previous.isFinal === result.isFinal &&
      previous.confidence === result.confidence
    ) {
      return null;
    }
    slots.set(result.resultIndex, {
      transcript,
      isFinal: result.isFinal,
      confidence: result.confidence,
    });
    currentRevision += 1;
    const revision = currentRevision;
    const generation = sessionGeneration;
    const sessionId = currentSessionId ?? startSession();
    const text = [...slots.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, slot]) => slot.transcript)
      .join("")
      .trim();
    if (!text) {
      return null;
    }
    const input: VibratoInput = {
      sessionId,
      turnId: "speech",
      revision,
      text,
      isFinal: result.isFinal,
    };
    try {
      const output = await options.adapter.tokenize(input);
      if (!active || generation !== sessionGeneration || revision !== currentRevision) {
        return null;
      }
      options.onOutput?.(output);
      return output;
    } catch (error) {
      if (error instanceof VibratoAdapterError) {
        options.onError?.(error, input);
      }
      throw error;
    }
  };

  if (currentSessionId) {
    active = true;
  }

  return {
    startSession,
    endSession,
    accept,
    get sessionId() {
      return currentSessionId;
    },
    get revision() {
      return currentRevision;
    },
  };
};

/** Fetch a dictionary for Worker loaders without coupling them to a framework. */
export const fetchVibratoDictionary = async (
  request: Pick<VibratoWorkerInitRequest, "dictionaryUrl" | "dictionaryBytes">,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> => {
  if (request.dictionaryBytes) {
    return new Uint8Array(request.dictionaryBytes);
  }
  if (!request.dictionaryUrl) {
    throw adapterError("missing-dictionary", "A Vibrato dictionary URL is required");
  }
  let response: Response;
  try {
    response = await fetchImpl(request.dictionaryUrl);
  } catch (error) {
    throw adapterError(
      "dictionary-fetch",
      error instanceof Error ? error.message : "Could not fetch the Vibrato dictionary",
    );
  }
  if (!response.ok) {
    throw adapterError(
      "dictionary-fetch",
      `Could not fetch the Vibrato dictionary (HTTP ${response.status})`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
};
