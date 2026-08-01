import type { ComparisonAuth, ComparisonMode } from "./contract";

export type WorkerConnectionState = "idle" | "connecting" | "open" | "closed" | "error";
export type VibratoExecution = "worker" | "browser-wasm";

export interface WorkerClientOptions {
  endpoint: string;
  requestTimeoutMs?: number;
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
}

interface UnknownRecord {
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const NORMAL_WEBSOCKET_CLOSE_CODE = 1_000;
const RANDOM_ID_SUFFIX_START = 2;
const RANDOM_ID_SUFFIX_END = 10;
const SINGLE_PENDING_REQUEST_COUNT = 1;

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
    return {
      requestId,
      error: new Error(errorMessage ?? "AzooKey Worker rejected the conversion"),
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
  private readonly onStateChange?: (state: WorkerConnectionState) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private state: WorkerConnectionState = "idle";

  constructor(options: WorkerClientOptions) {
    this.endpoint = options.endpoint.trim();
    this.requestTimeoutMs = Math.max(
      MIN_REQUEST_TIMEOUT_MS,
      options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    this.onStateChange = options.onStateChange;
  }

  get connectionState(): WorkerConnectionState {
    return this.state;
  }

  connect(): Promise<void> {
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
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.setState("connecting");
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.endpoint);
      } catch (error) {
        this.connectPromise = null;
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.setState("error");
        reject(asError(error, "Worker WebSocket を作成できません"));
        return;
      }
      this.socket = socket;
      socket.onopen = () => {
        this.setState("open");
        this.resolveConnect?.();
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.connectPromise = null;
      };
      socket.onmessage = (event) => {
        void this.handleMessage(event.data);
      };
      socket.onerror = () => {
        const error = new Error("Worker WebSocket で接続エラーが発生しました");
        this.setState("error");
        this.rejectConnect?.(error);
        this.resolveConnect = null;
        this.rejectConnect = null;
      };
      socket.onclose = (event) => {
        this.socket = null;
        this.setState("closed");
        const error = new Error(
          event.reason?.trim() || `Worker WebSocket が切断されました (${event.code})`,
        );
        this.rejectConnect?.(error);
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.connectPromise = null;
        this.rejectPending(error);
      };
    });
    return this.connectPromise;
  }

  convert(
    request: Omit<AzooKeyConvertRequest, "type" | "requestId">,
  ): Promise<AzooKeyConvertResult> {
    const openSocket = this.socket;
    if (openSocket?.readyState === WebSocket.OPEN) {
      return this.enqueueConversion(openSocket, request);
    }
    return this.connect().then(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Worker WebSocket が接続されていません");
      }
      return this.enqueueConversion(socket, request);
    });
  }

  private enqueueConversion(
    socket: WebSocket,
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
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("AzooKey Worker の応答がタイムアウトしました"));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(asError(error, "Worker WebSocket に送信できません"));
      }
    });
  }

  close(): void {
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
    if (this.socket) {
      this.socket.close(NORMAL_WEBSOCKET_CLOSE_CODE, "comparison page closed");
      this.socket = null;
    }
    this.setState("closed");
    this.rejectPending(new Error("Worker WebSocket を閉じました"));
  }

  private async handleMessage(data: unknown): Promise<void> {
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
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
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
