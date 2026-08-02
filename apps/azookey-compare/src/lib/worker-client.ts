import type { ComparisonAuth, ComparisonMode } from "./contract";

export type WorkerConnectionState = "idle" | "connecting" | "open" | "closed" | "error";
export type VibratoExecution = "worker" | "browser-wasm";

export interface WorkerClientOptions {
  endpoint: string;
  requestTimeoutMs?: number;
  /** Number of times a server-side `busy` refusal is retried before failing. */
  maxBusyRetries?: number;
  /** Delay between `busy` retries. Defaults to a short 50ms backoff. */
  busyRetryDelayMs?: number;
  onStateChange?: (state: WorkerConnectionState) => void;
}

/**
 * Versioned enough to be useful outside this demo: the first frame is a JSON
 * conversion request and the response carries the same requestId. A Worker
 * can add fields without breaking this client; see `parseWorkerMessage` below.
 */
export interface AzooKeyConvertRequest {
  type: "azookey.convert";
  requestId: string;
  source: "web-speech";
  language: string;
  sourceText: string;
  /** Input after the selected Vibrato stage (or the raw speech text). */
  vibratoInput: string;
  mode: ComparisonMode;
  /** The selected UI mode, retained for observability when the wire mode is normalized. */
  comparisonMode?: ComparisonMode;
  /** Where Vibrato ran before the Worker received this frame. */
  vibratoExecution?: VibratoExecution;
  auth?: ComparisonAuth;
}

export interface AzooKeyConvertResult {
  requestId: string;
  sourceText: string;
  convertedText: string;
  mode?: ComparisonMode;
  elapsedMs?: number;
  receivedAt: number;
}

interface PendingRequest {
  resolve: (result: AzooKeyConvertResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** The transport that carried this request.  A response from another
   * socket generation must never settle it, even if a legacy server omitted
   * its requestId. */
  readonly socket: WebSocket;
  readonly socketGeneration: number;
}

interface QueuedConversion {
  readonly requestId: string;
  readonly payload: string;
  readonly resolve: (result: AzooKeyConvertResult) => void;
  readonly reject: (error: Error) => void;
  busyRetries: number;
}

interface ConnectionAttempt {
  readonly socket: WebSocket;
  readonly generation: number;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface UnknownRecord {
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_BUSY_RETRIES = 3;
const DEFAULT_BUSY_RETRY_DELAY_MS = 50;
const MIN_BUSY_RETRY_DELAY_MS = 0;
const MIN_BUSY_RETRIES = 0;
const NORMAL_WEBSOCKET_CLOSE_CODE = 1_000;
const RANDOM_ID_SUFFIX_START = 2;
const RANDOM_ID_SUFFIX_END = 10;
const SINGLE_PENDING_REQUEST_COUNT = 1;

const clampNonNegativeInteger = (value: number | undefined, fallback: number): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

const readString = (record: UnknownRecord, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const readNumber = (record: UnknownRecord, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
};

const createRequestId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `azookey-${Date.now()}-${Math.random()
    .toString(36)
    .slice(RANDOM_ID_SUFFIX_START, RANDOM_ID_SUFFIX_END)}`;
};

const asError = (value: unknown, fallback: string): Error => {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return new Error(value.trim());
  }
  return new Error(fallback);
};

const parseJsonMessage = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const nestedRecord = (record: UnknownRecord, ...keys: string[]): UnknownRecord | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
};

/** A rejection the Worker reported, carrying the protocol code it sent. */
export class AzooKeyWorkerError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "AzooKeyWorkerError";
    this.code = code;
  }
}

/**
 * Codes the Worker answers with before it ever invokes the converter: contract
 * violations, auth, back-pressure, and an unusable converter.
 */
const PRE_CONVERTER_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_message",
  "invalid_json",
  "unsupported_message",
  "binary_message_not_supported",
  "message_too_large",
  "text_too_large",
  "empty_text",
  "invalid_request_id",
  "invalid_contract",
  "unsupported_mode",
  "vibrato_unavailable",
  "unauthorized",
  "busy",
  "converter_unavailable",
]);

export type WorkerErrorStage = "worker-request" | "worker-transport" | "worker";

/**
 * Classify a Worker rejection without claiming that an uncertain request ran.
 *
 * The Worker emits `conversion_*` only from the converter path. Known protocol
 * refusal codes are returned before conversion. A plain transport error or an
 * unknown protocol code cannot prove either outcome, so it gets its own stage.
 */
export const workerErrorStage = (error: unknown): WorkerErrorStage => {
  if (!(error instanceof AzooKeyWorkerError)) {
    return "worker-transport";
  }
  if (error.code?.startsWith("conversion_")) {
    return "worker";
  }
  if (error.code !== undefined && PRE_CONVERTER_ERROR_CODES.has(error.code)) {
    return "worker-request";
  }
  return "worker-transport";
};

/** Whether a rejection proves the AzooKey converter actually ran. */
export const workerErrorReachedConverter = (error: unknown): boolean =>
  workerErrorStage(error) === "worker";

interface ParsedWorkerMessage {
  requestId?: string;
  error?: Error;
  convertedText?: string;
  sourceText?: string;
  mode?: ComparisonMode;
  elapsedMs?: number;
}

const parseWorkerMessage = (payload: unknown): ParsedWorkerMessage | null => {
  if (!isRecord(payload)) {
    return null;
  }
  const nested = nestedRecord(payload, "result", "data", "output");
  const rootType = readString(payload, "type", "event");
  const nestedType = nested ? readString(nested, "type", "event") : undefined;
  const requestId =
    readString(payload, "requestId", "id", "correlationId") ??
    (nested ? readString(nested, "requestId", "id", "correlationId") : undefined);

  const errorValue = nestedRecord(payload, "error") ?? (nested && nestedRecord(nested, "error"));
  if (rootType === "error" || nestedType === "error" || errorValue) {
    const errorMessage = errorValue
      ? readString(errorValue, "message", "detail", "error")
      : readString(payload, "message", "detail", "error");
    const errorCode = errorValue ? readString(errorValue, "code") : readString(payload, "code");
    return {
      requestId,
      error: new AzooKeyWorkerError(
        errorMessage ?? "AzooKey Worker rejected the conversion",
        errorCode,
      ),
    };
  }

  const convertedText =
    readString(payload, "convertedText", "text", "output") ??
    (nested ? readString(nested, "convertedText", "text", "output") : undefined);
  if (convertedText === undefined) {
    return requestId ? { requestId } : null;
  }
  const sourceText =
    readString(payload, "sourceText", "input", "originalText") ??
    (nested ? readString(nested, "sourceText", "input", "originalText") : undefined);
  const modeValue =
    readString(payload, "mode") ?? (nested ? readString(nested, "mode") : undefined);
  const mode: ComparisonMode | undefined =
    modeValue === "worker-vibrato" || modeValue === "browser-vibrato" ? modeValue : undefined;
  const elapsedMs =
    readNumber(payload, "elapsedMs", "durationMs", "latencyMs") ??
    (nested ? readNumber(nested, "elapsedMs", "durationMs", "latencyMs") : undefined);
  return { requestId, convertedText, sourceText, mode, elapsedMs };
};

/** A reconnect-on-demand JSON WebSocket client for the comparison page. */
export class AzooKeyWorkerClient {
  private readonly endpoint: string;
  private readonly requestTimeoutMs: number;
  private readonly maxBusyRetries: number;
  private readonly busyRetryDelayMs: number;
  private readonly onStateChange?: (state: WorkerConnectionState) => void;
  private readonly pending = new Map<string, PendingRequest>();
  /** The Worker accepts one conversion per socket; retain every utterance FIFO. */
  private readonly conversionQueue: QueuedConversion[] = [];
  private socket: WebSocket | null = null;
  /** Monotonic transport generation used to fence stale asynchronous events. */
  private socketGeneration = 0;
  /**
   * A no-requestId response is only safe until the first conversion on this
   * generation has been abandoned/consumed.  Keep the socket usable for
   * correlated responses, but never let a late legacy frame claim a newer
   * FIFO item.
   */
  private legacyResponseBlockedGeneration: number | null = null;
  /** One owner for the active handshake; stale socket events cannot settle a new attempt. */
  private connectionAttempt: ConnectionAttempt | null = null;
  private activeConversion: QueuedConversion | null = null;
  private busyRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private state: WorkerConnectionState = "idle";

  constructor(options: WorkerClientOptions) {
    this.endpoint = options.endpoint.trim();
    this.requestTimeoutMs = Math.max(
      MIN_REQUEST_TIMEOUT_MS,
      options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    this.maxBusyRetries = Math.max(
      MIN_BUSY_RETRIES,
      clampNonNegativeInteger(options.maxBusyRetries, DEFAULT_MAX_BUSY_RETRIES),
    );
    this.busyRetryDelayMs = Math.max(
      MIN_BUSY_RETRY_DELAY_MS,
      clampNonNegativeInteger(options.busyRetryDelayMs, DEFAULT_BUSY_RETRY_DELAY_MS),
    );
    this.onStateChange = options.onStateChange;
  }

  get connectionState(): WorkerConnectionState {
    return this.state;
  }

  connect(): Promise<void> {
    // `close()` is recoverable: a caller may explicitly reconnect the same
    // client after a page-level transport reset.
    this.closed = false;
    if (typeof WebSocket === "undefined") {
      this.setState("error");
      return Promise.reject(new Error("このブラウザでは WebSocket が利用できません"));
    }
    if (!this.endpoint) {
      this.setState("error");
      return Promise.reject(new Error("Worker WebSocket URL を入力してください"));
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectionAttempt) {
      return this.connectionAttempt.promise;
    }

    this.setState("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.endpoint);
    } catch (error) {
      this.setState("error");
      return Promise.reject(asError(error, "Worker WebSocket を作成できません"));
    }

    let resolveAttempt: () => void = () => undefined;
    let rejectAttempt: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const generation = this.socketGeneration + 1;
    this.socketGeneration = generation;
    this.legacyResponseBlockedGeneration = null;
    const attempt: ConnectionAttempt = {
      socket,
      generation,
      promise,
      resolve: resolveAttempt,
      reject: rejectAttempt,
    };
    this.socket = socket;
    this.connectionAttempt = attempt;

    socket.onopen = () => {
      if (
        this.socket !== socket ||
        this.socketGeneration !== generation ||
        this.connectionAttempt !== attempt
      ) {
        return;
      }
      this.connectionAttempt = null;
      this.setState("open");
      attempt.resolve();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.socketGeneration !== generation) {
        return;
      }
      void this.handleMessage(event.data, socket, generation);
    };
    socket.onerror = () => {
      if (this.socket !== socket || this.socketGeneration !== generation) {
        return;
      }
      const error = new Error("Worker WebSocket で接続エラーが発生しました");
      this.socket = null;
      this.socketGeneration += 1;
      if (this.connectionAttempt === attempt) {
        this.connectionAttempt = null;
      }
      this.setState("error");
      attempt.reject(error);
      this.rejectPending(error);
      // Keep FIFO requests submitted behind the failed frame moving. The
      // active request is already settled above; pumpConversions() reconnects
      // on demand for the next queued utterance or rejects it if reconnecting
      // fails, so no caller Promise is left hanging after a socket drop.
      this.pumpConversions();
      try {
        socket.close(NORMAL_WEBSOCKET_CLOSE_CODE, "connection error");
      } catch {
        // The socket is already closing or closed.
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket || this.socketGeneration !== generation) {
        return;
      }
      const error = new Error(
        event.reason?.trim() || `Worker WebSocket が切断されました (${event.code})`,
      );
      this.socket = null;
      this.socketGeneration += 1;
      if (this.connectionAttempt === attempt) {
        this.connectionAttempt = null;
      }
      this.setState("closed");
      attempt.reject(error);
      this.rejectPending(error);
      this.pumpConversions();
    };

    return promise;
  }

  convert(
    request: Omit<AzooKeyConvertRequest, "type" | "requestId">,
  ): Promise<AzooKeyConvertResult> {
    const openSocket = this.socket;
    if (typeof WebSocket !== "undefined" && openSocket?.readyState === WebSocket.OPEN) {
      return this.enqueueConversion(request);
    }
    return this.connect().then(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Worker WebSocket が接続されていません");
      }
      return this.enqueueConversion(request);
    });
  }

  private enqueueConversion(
    request: Omit<AzooKeyConvertRequest, "type" | "requestId">,
  ): Promise<AzooKeyConvertResult> {
    const requestId = createRequestId();
    const payload = {
      type: "azookey.convert" as const,
      requestId,
      ...request,
      // The Worker accepts only wire mode `worker-vibrato` (AzooKey WASM only).
      // Browser pre-pass selection stays a comparison concern and is carried as
      // metadata while `vibratoInput` holds the prepared text (historical name).
      mode: "worker-vibrato" as const,
      ...(request.mode === "browser-vibrato"
        ? { comparisonMode: "browser-vibrato" as const, vibratoExecution: "browser-wasm" as const }
        : { vibratoExecution: request.vibratoExecution ?? ("worker" as const) }),
    };
    return new Promise<AzooKeyConvertResult>((resolve, reject) => {
      this.conversionQueue.push({
        requestId,
        payload: JSON.stringify(payload),
        resolve,
        reject,
        busyRetries: 0,
      });
      this.pumpConversions();
    });
  }

  /**
   * Send at most one conversion at a time. The Worker deliberately responds
   * with `busy` for overlapping conversions, so a client-side FIFO is the
   * reliable way to preserve rapid Web Speech finals.
   */
  private pumpConversions(): void {
    if (this.closed || this.activeConversion || this.busyRetryTimer !== null) {
      return;
    }
    const next = this.conversionQueue.shift();
    if (!next) {
      return;
    }
    this.activeConversion = next;

    const socket = this.socket;
    if (typeof WebSocket !== "undefined" && socket?.readyState === WebSocket.OPEN) {
      this.sendQueuedConversion(socket, next);
      return;
    }
    // A socket can close after `convert()` checks it but before this queued
    // request is sent. Reconnect on demand instead of dropping the utterance.
    void this.connect()
      .then(() => {
        const connected = this.socket;
        if (!connected || connected.readyState !== WebSocket.OPEN) {
          throw new Error("Worker WebSocket が接続されていません");
        }
        this.sendQueuedConversion(connected, next);
      })
      .catch((error: unknown) => {
        this.finishQueuedConversion(next, asError(error, "Worker WebSocket に接続できません"));
      });
  }

  private sendQueuedConversion(socket: WebSocket, queued: QueuedConversion): void {
    const socketGeneration = this.socketGeneration;
    const timeout = setTimeout(() => {
      const pending = this.pending.get(queued.requestId);
      if (!pending || pending.socket !== socket || pending.socketGeneration !== socketGeneration) {
        return;
      }
      this.pending.delete(queued.requestId);
      // A legacy Worker may omit requestId.  Once this request timed out, an
      // eventual response is indistinguishable from the next FIFO request on
      // the same socket. Keep correlated responses available, but fence all
      // no-id frames on this generation until a fresh socket is established.
      if (this.conversionQueue.length > 0) {
        // If there is already FIFO work waiting, rotate immediately so the
        // next item can still use a legacy no-id response safely.
        this.retireSocket(socket, socketGeneration, "conversion timeout");
      } else {
        this.legacyResponseBlockedGeneration = socketGeneration;
      }
      this.finishQueuedConversion(queued, new Error("AzooKey Worker の応答がタイムアウトしました"));
    }, this.requestTimeoutMs);
    this.pending.set(queued.requestId, {
      resolve: (result) => this.finishQueuedConversion(queued, null, result),
      reject: (error) => this.finishQueuedConversion(queued, error),
      timeout,
      socket,
      socketGeneration,
    });
    try {
      socket.send(queued.payload);
    } catch (error) {
      clearTimeout(timeout);
      this.pending.delete(queued.requestId);
      this.finishQueuedConversion(queued, asError(error, "Worker WebSocket に送信できません"));
    }
  }

  private finishQueuedConversion(
    queued: QueuedConversion,
    error: Error | null,
    result?: AzooKeyConvertResult,
  ): void {
    // A timeout, socket error, or malformed duplicate response can only settle
    // one active attempt. Ignore a late callback after the job was already
    // moved to the busy-retry queue.
    if (this.activeConversion !== queued) {
      return;
    }
    if (error instanceof AzooKeyWorkerError && error.code === "busy") {
      if (queued.busyRetries < this.maxBusyRetries && !this.closed) {
        queued.busyRetries += 1;
        this.activeConversion = null;
        this.conversionQueue.unshift(queued);
        this.busyRetryTimer = setTimeout(() => {
          this.busyRetryTimer = null;
          this.pumpConversions();
        }, this.busyRetryDelayMs);
        return;
      }
    }
    this.activeConversion = null;
    if (error) {
      queued.reject(error);
    } else if (result) {
      queued.resolve(result);
    } else {
      queued.reject(new Error("Worker 応答が空です"));
    }
    this.pumpConversions();
  }

  close(): void {
    const error = new Error("Worker WebSocket を閉じました");
    this.closed = true;
    const socket = this.socket;
    const attempt = this.connectionAttempt;
    this.socket = null;
    this.socketGeneration += 1;
    this.connectionAttempt = null;
    if (socket) {
      try {
        socket.close(NORMAL_WEBSOCKET_CLOSE_CODE, "comparison page closed");
      } catch {
        // The socket is already closing or closed.
      }
    }
    this.setState("closed");
    attempt?.reject(error);
    this.rejectPending(error);
    if (this.busyRetryTimer !== null) {
      clearTimeout(this.busyRetryTimer);
      this.busyRetryTimer = null;
    }
    for (const queued of this.conversionQueue.splice(0)) {
      queued.reject(error);
    }
  }

  private async handleMessage(
    data: unknown,
    socket: WebSocket,
    socketGeneration: number,
  ): Promise<void> {
    let text: string;
    try {
      if (typeof data === "string") {
        text = data;
      } else if (data instanceof Blob) {
        text = await data.text();
      } else if (data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(data);
      } else {
        return;
      }
    } catch {
      return;
    }
    const parsed = parseWorkerMessage(parseJsonMessage(text));
    if (!parsed) {
      return;
    }
    // Responses without requestId are supported only as a strict FIFO
    // compatibility contract: one in-flight conversion, on the same socket
    // generation that carried it. This intentionally rejects a late legacy
    // response instead of guessing which newer utterance it belongs to.
    const fallback = parsed.requestId
      ? undefined
      : this.pending.size === SINGLE_PENDING_REQUEST_COUNT
        ? this.pending.keys().next().value
        : undefined;
    const requestId = parsed.requestId ?? fallback;
    if (!requestId) {
      return;
    }
    const pending = this.pending.get(requestId);
    if (
      !pending ||
      pending.socket !== socket ||
      pending.socketGeneration !== socketGeneration ||
      this.socket !== socket ||
      this.socketGeneration !== socketGeneration
    ) {
      return;
    }
    const legacyResponse = parsed.requestId === undefined;
    if (legacyResponse && this.legacyResponseBlockedGeneration === socketGeneration) {
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    if (legacyResponse) {
      // A duplicate no-id frame after this response would otherwise be
      // indistinguishable from the next FIFO item. Correlated responses remain
      // valid on this socket; only legacy frames are fenced.
      const legacyBusy = parsed.error instanceof AzooKeyWorkerError && parsed.error.code === "busy";
      if (this.conversionQueue.length > 0 || legacyBusy) {
        this.retireSocket(socket, socketGeneration, "legacy response without requestId");
      } else {
        this.legacyResponseBlockedGeneration = socketGeneration;
      }
    }
    if (parsed.error) {
      pending.reject(parsed.error);
      return;
    }
    if (parsed.convertedText === undefined) {
      pending.reject(new Error("Worker 応答に convertedText がありません"));
      return;
    }
    pending.resolve({
      requestId,
      sourceText: parsed.sourceText ?? "",
      convertedText: parsed.convertedText,
      ...(parsed.mode ? { mode: parsed.mode } : {}),
      ...(parsed.elapsedMs !== undefined ? { elapsedMs: parsed.elapsedMs } : {}),
      receivedAt: Date.now(),
    });
  }

  /** Invalidate a transport before a response can be mistaken for a newer FIFO item. */
  private retireSocket(socket: WebSocket, socketGeneration: number, reason: string): void {
    if (this.socket !== socket || this.socketGeneration !== socketGeneration) {
      return;
    }
    this.socket = null;
    this.socketGeneration += 1;
    this.legacyResponseBlockedGeneration = null;
    if (this.connectionAttempt?.socket === socket) {
      const error = new Error("Worker WebSocket が切断されました");
      this.connectionAttempt.reject(error);
      this.connectionAttempt = null;
    }
    this.setState("closed");
    try {
      socket.close(NORMAL_WEBSOCKET_CLOSE_CODE, reason);
    } catch {
      // The socket is already closing or closed.
    }
  }

  private rejectPending(error: Error): void {
    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timeout);
      request.reject(error);
      this.pending.delete(requestId);
    }
  }

  private setState(state: WorkerConnectionState): void {
    this.state = state;
    this.onStateChange?.(state);
  }
}
