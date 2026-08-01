export const AZOOKEY_WS_PATH = "/ws/azookey";
export const AZOOKEY_PROTOCOL = "azookey.text.v1";
export const AZOOKEY_MODEL = "azookey-rust-wasm";
export const AZOOKEY_MODE = "worker-vibrato" as const;
export const BROWSER_VIBRATO_MODE = "browser-vibrato" as const;
export const AZOOKEY_MAX_TEXT_BYTES = 4_096;
export const AZOOKEY_MAX_MESSAGE_BYTES = 8_192;
export const AZOOKEY_MAX_ID_BYTES = 128;
export const AZOOKEY_MAX_LANGUAGE_BYTES = 64;
export const AZOOKEY_AUTH_TOKEN_MAX_ID_MULTIPLIER = 4;
export const AZOOKEY_MAX_AUTH_TOKEN_BYTES =
  AZOOKEY_MAX_ID_BYTES * AZOOKEY_AUTH_TOKEN_MAX_ID_MULTIPLIER;
export const AZOOKEY_DEFAULT_TIMEOUT_MS = 250;
export const AZOOKEY_MIN_TIMEOUT_MS = 25;
export const AZOOKEY_MAX_TIMEOUT_MS = 2_000;
export const AZOOKEY_WASM_POINTER_BITS = 32;
export const AZOOKEY_WASM_U32_MASK = 0xffff_ffffn;
export const AZOOKEY_MIN_ELAPSED_MS = 0;
export const HTTP_SWITCHING_PROTOCOLS = 101;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_METHOD_NOT_ALLOWED = 405;
export const HTTP_UPGRADE_REQUIRED = 426;
export const HTTP_SERVICE_UNAVAILABLE = 503;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface AzookeyEnv {
  AZOOKEY_API_TOKEN?: string;
  AZOOKEY_TIMEOUT_MS?: string;
}

export type AzookeyMode = typeof AZOOKEY_MODE | typeof BROWSER_VIBRATO_MODE;

export interface AzookeyAuth {
  scheme: "none" | "bearer";
  token?: string;
}

export interface AzookeyWasmExports {
  memory: WebAssembly.Memory;
  azookey_alloc: (length: number) => number;
  azookey_dealloc: (pointer: number, length: number) => void;
  azookey_convert: (pointer: number, length: number) => bigint | number;
}

export type AzookeyConverter = (text: string) => string | Promise<string>;

export interface AzookeyRuntime {
  converter: AzookeyConverter;
  timeoutMs: number;
  expectedToken?: string;
  handshakeAuthorized?: boolean;
}

export interface AzookeySocketPair {
  client: WebSocket;
  server: WebSocket;
}

export type AzookeySocketPairFactory = () => AzookeySocketPair;

export interface AzookeyRequestDependencies {
  /** Injected in tests; production uses the imported raw Wasm module. */
  wasmModule?: WebAssembly.Module;
  /** Injected in tests to avoid depending on the Workers WebSocket runtime. */
  socketPair?: AzookeySocketPairFactory;
  /** Injected in tests or for a controlled fallback implementation. */
  converter?: AzookeyConverter;
}

export interface AzookeyMessage {
  type: "azookey.convert";
  requestId: string;
  source: "web-speech";
  language: string;
  sourceText: string;
  vibratoInput: string;
  mode: AzookeyMode;
  auth?: AzookeyAuth;
}

export interface AzookeyResultMessage {
  type: "azookey.result";
  requestId: string;
  sourceText: string;
  convertedText: string;
  mode: typeof AZOOKEY_MODE;
  elapsedMs: number;
  model: typeof AZOOKEY_MODEL;
}

export interface AzookeyErrorMessage {
  type: "azookey.error";
  requestId?: string;
  error: {
    code: AzookeyErrorCode;
    message: string;
  };
}

export type AzookeyErrorCode =
  | "invalid_message"
  | "invalid_json"
  | "unsupported_message"
  | "binary_message_not_supported"
  | "message_too_large"
  | "text_too_large"
  | "empty_text"
  | "invalid_request_id"
  | "invalid_contract"
  | "unsupported_mode"
  | "unauthorized"
  | "busy"
  | "conversion_timeout"
  | "conversion_failed"
  | "converter_unavailable";

class AzookeyProtocolError extends Error {
  readonly code: AzookeyErrorCode;
  readonly requestId?: string;

  constructor(code: AzookeyErrorCode, message: string, requestId?: string) {
    super(message);
    this.name = "AzookeyProtocolError";
    this.code = code;
    if (requestId !== undefined) {
      this.requestId = requestId;
    }
  }
}

const clampTimeout = (value: string | undefined): number => {
  const normalized = value?.trim();
  if (!normalized) {
    return AZOOKEY_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return AZOOKEY_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(AZOOKEY_MAX_TIMEOUT_MS, Math.max(AZOOKEY_MIN_TIMEOUT_MS, Math.round(parsed)));
};

export const azookeyTimeoutMs = (env: AzookeyEnv): number => clampTimeout(env.AZOOKEY_TIMEOUT_MS);

const jsonMessage = (message: object): string => JSON.stringify(message);

const errorMessage = (
  code: AzookeyErrorCode,
  message: string,
  requestId?: string,
): AzookeyErrorMessage => ({
  type: "azookey.error",
  ...(requestId === undefined ? {} : { requestId }),
  error: { code, message },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (
  value: unknown,
  field: string,
  maximumBytes: number,
  code: AzookeyErrorCode = "invalid_contract",
): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AzookeyProtocolError(code, `${field} must be a non-empty string`);
  }
  if (encoder.encode(value).byteLength > maximumBytes) {
    throw new AzookeyProtocolError(code, `${field} exceeds its byte limit`);
  }
  return value;
};

const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AzookeyProtocolError("empty_text", `${field} must be a non-empty string`);
  }
  if (encoder.encode(value).byteLength > AZOOKEY_MAX_TEXT_BYTES) {
    throw new AzookeyProtocolError("text_too_large", `${field} exceeds its byte limit`);
  }
  return value;
};

const optionalAuth = (value: unknown): AzookeyAuth | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new AzookeyProtocolError("invalid_contract", "auth must be an object");
  }
  const scheme = value["scheme"] ?? value["type"];
  const token = value["token"];
  if (scheme !== "none" && scheme !== "bearer") {
    throw new AzookeyProtocolError("invalid_contract", "auth.scheme must be none or bearer");
  }
  if (scheme === "bearer") {
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new AzookeyProtocolError("invalid_contract", "auth.token is required for bearer auth");
    }
    const normalizedToken = token.trim();
    if (encoder.encode(normalizedToken).byteLength > AZOOKEY_MAX_AUTH_TOKEN_BYTES) {
      throw new AzookeyProtocolError("invalid_contract", "auth.token is too large");
    }
    return { scheme, token: normalizedToken };
  }
  if (token !== undefined) {
    throw new AzookeyProtocolError("invalid_contract", "auth.token is not allowed with none auth");
  }
  return { scheme };
};

export const parseAzookeyMessage = (raw: string): AzookeyMessage => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AzookeyProtocolError("invalid_json", "message must be valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new AzookeyProtocolError("invalid_message", "message must be a JSON object");
  }
  if (parsed["type"] !== "azookey.convert") {
    throw new AzookeyProtocolError("unsupported_message", 'type must be "azookey.convert"');
  }
  const requestId = requiredString(
    parsed["requestId"],
    "requestId",
    AZOOKEY_MAX_ID_BYTES,
    "invalid_request_id",
  );
  if (parsed["source"] !== "web-speech") {
    throw new AzookeyProtocolError("invalid_contract", 'source must be "web-speech"', requestId);
  }
  let language: string;
  let sourceText: string;
  let vibratoInput: string;
  let auth: AzookeyAuth | undefined;
  try {
    language = requiredString(parsed["language"], "language", AZOOKEY_MAX_LANGUAGE_BYTES);
    sourceText = requiredText(parsed["sourceText"], "sourceText");
    vibratoInput = requiredText(parsed["vibratoInput"], "vibratoInput");
  } catch (error) {
    if (error instanceof AzookeyProtocolError && error.requestId === undefined) {
      throw new AzookeyProtocolError(error.code, error.message, requestId);
    }
    throw error;
  }
  const mode = parsed["mode"];
  if (mode !== AZOOKEY_MODE && mode !== BROWSER_VIBRATO_MODE) {
    throw new AzookeyProtocolError(
      "unsupported_mode",
      "mode must be worker-vibrato or browser-vibrato",
      requestId,
    );
  }
  if (mode !== AZOOKEY_MODE) {
    throw new AzookeyProtocolError(
      "unsupported_mode",
      "browser-vibrato mode is client-only",
      requestId,
    );
  }
  try {
    auth = optionalAuth(parsed["auth"]);
  } catch (error) {
    if (error instanceof AzookeyProtocolError && error.requestId === undefined) {
      throw new AzookeyProtocolError(error.code, error.message, requestId);
    }
    throw error;
  }
  return {
    type: "azookey.convert",
    requestId,
    source: "web-speech",
    language,
    sourceText,
    vibratoInput,
    mode: AZOOKEY_MODE,
    ...(auth === undefined ? {} : { auth }),
  };
};

const unpackResult = (exports: AzookeyWasmExports, packed: bigint | number): string => {
  const value = typeof packed === "bigint" ? packed : BigInt(packed);
  const pointer = Number((value >> BigInt(AZOOKEY_WASM_POINTER_BITS)) & AZOOKEY_WASM_U32_MASK);
  const length = Number(value & AZOOKEY_WASM_U32_MASK);
  if (pointer === 0 && length !== 0) {
    throw new Error("AzooKey Wasm returned a null output pointer");
  }
  if (length > exports.memory.buffer.byteLength - pointer) {
    throw new Error("AzooKey Wasm returned an invalid output range");
  }
  try {
    return decoder.decode(new Uint8Array(exports.memory.buffer, pointer, length));
  } finally {
    exports.azookey_dealloc(pointer, length);
  }
};

export const createWasmConverter = (module: WebAssembly.Module): AzookeyConverter => {
  const instance = new WebAssembly.Instance(module, {});
  const exports = instance.exports as unknown as Partial<AzookeyWasmExports>;
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    typeof exports.azookey_alloc !== "function" ||
    typeof exports.azookey_dealloc !== "function" ||
    typeof exports.azookey_convert !== "function"
  ) {
    throw new Error("AzooKey Wasm module is missing the required raw ABI");
  }
  const checkedExports = exports as AzookeyWasmExports;

  return (text: string): string => {
    const bytes = encoder.encode(text);
    const pointer = checkedExports.azookey_alloc(bytes.byteLength);
    if (pointer === 0 && bytes.byteLength !== 0) {
      throw new Error("AzooKey Wasm input allocation failed");
    }
    try {
      new Uint8Array(checkedExports.memory.buffer, pointer, bytes.byteLength).set(bytes);
      const packed = checkedExports.azookey_convert(pointer, bytes.byteLength);
      if (packed === 0 || packed === 0n) {
        throw new Error("AzooKey Wasm conversion allocation failed");
      }
      return unpackResult(checkedExports, packed);
    } finally {
      checkedExports.azookey_dealloc(pointer, bytes.byteLength);
    }
  };
};

const withTimeout = async <T>(operation: () => T | Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new AzookeyProtocolError("conversion_timeout", "conversion timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

export const convertAzookeyMessage = async (
  message: AzookeyMessage,
  runtime: AzookeyRuntime,
): Promise<AzookeyResultMessage> => {
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  let converted: string;
  try {
    const candidate = await withTimeout(
      () => runtime.converter(message.vibratoInput),
      runtime.timeoutMs,
    );
    if (typeof candidate !== "string") {
      throw new AzookeyProtocolError("conversion_failed", "AzooKey conversion returned no text");
    }
    converted = candidate;
  } catch (error) {
    if (error instanceof AzookeyProtocolError) {
      if (error.requestId === undefined) {
        throw new AzookeyProtocolError(error.code, error.message, message.requestId);
      }
      throw error;
    }
    throw new AzookeyProtocolError(
      "conversion_failed",
      "AzooKey conversion failed",
      message.requestId,
    );
  }
  const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
  if (elapsed > runtime.timeoutMs) {
    throw new AzookeyProtocolError("conversion_timeout", "conversion timed out", message.requestId);
  }
  return {
    type: "azookey.result",
    requestId: message.requestId,
    sourceText: message.sourceText,
    convertedText: converted,
    mode: AZOOKEY_MODE,
    elapsedMs: Math.max(AZOOKEY_MIN_ELAPSED_MS, Math.round(elapsed)),
    model: AZOOKEY_MODEL,
  };
};

const requestAuthorized = (message: AzookeyMessage, runtime: AzookeyRuntime): boolean => {
  if (!runtime.expectedToken || runtime.handshakeAuthorized) {
    return true;
  }
  const authorized =
    message.auth?.scheme === "bearer" && message.auth.token === runtime.expectedToken;
  if (authorized) {
    // Browser clients cannot authenticate the upgrade itself. Treat a valid
    // first-frame token as connection-level authorization for later frames.
    runtime.handshakeAuthorized = true;
  }
  return authorized;
};

export const attachAzookeySocket = (socket: WebSocket, runtime: AzookeyRuntime): void => {
  let processing = false;
  socket.addEventListener("message", (event) => {
    const raw = event.data;
    if (typeof raw !== "string") {
      socket.send(
        jsonMessage(errorMessage("binary_message_not_supported", "message must be text")),
      );
      return;
    }
    if (encoder.encode(raw).byteLength > AZOOKEY_MAX_MESSAGE_BYTES) {
      socket.send(
        jsonMessage(
          errorMessage(
            "message_too_large",
            `message exceeds the ${AZOOKEY_MAX_MESSAGE_BYTES}-byte limit`,
          ),
        ),
      );
      return;
    }
    let message: AzookeyMessage;
    try {
      message = parseAzookeyMessage(raw);
    } catch (error) {
      const protocolError =
        error instanceof AzookeyProtocolError
          ? error
          : new AzookeyProtocolError("invalid_message", "invalid message");
      socket.send(
        jsonMessage(
          errorMessage(protocolError.code, protocolError.message, protocolError.requestId),
        ),
      );
      return;
    }
    if (processing) {
      socket.send(
        jsonMessage(errorMessage("busy", "another conversion is in progress", message.requestId)),
      );
      return;
    }
    if (!requestAuthorized(message, runtime)) {
      socket.send(
        jsonMessage(errorMessage("unauthorized", "Bearer token is invalid", message.requestId)),
      );
      return;
    }
    processing = true;
    void convertAzookeyMessage(message, runtime)
      .then((result) => socket.send(jsonMessage(result)))
      .catch((error: unknown) => {
        const protocolError =
          error instanceof AzookeyProtocolError
            ? error
            : new AzookeyProtocolError(
                "conversion_failed",
                "AzooKey conversion failed",
                message.requestId,
              );
        socket.send(
          jsonMessage(
            errorMessage(protocolError.code, protocolError.message, protocolError.requestId),
          ),
        );
      })
      .finally(() => {
        processing = false;
      });
  });
};

export const readyAzookeyMessage = (timeoutMs: number): string =>
  jsonMessage({
    type: "azookey.ready",
    protocol: AZOOKEY_PROTOCOL,
    model: AZOOKEY_MODEL,
    mode: AZOOKEY_MODE,
    browserMode: BROWSER_VIBRATO_MODE,
    maxTextBytes: AZOOKEY_MAX_TEXT_BYTES,
    timeoutMs,
  });

export const isWebSocketUpgrade = (request: Request): boolean =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket";

const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

export const bearerTokenMatches = async (request: Request, expected: string): Promise<boolean> => {
  const authorization = request.headers.get("authorization") ?? "";
  const separator = authorization.indexOf(" ");
  if (separator <= 0 || authorization.slice(0, separator).toLowerCase() !== "bearer") {
    return false;
  }
  const providedToken = authorization.slice(separator + 1).trim();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(providedToken)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return constantTimeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash));
};

export const openAzookeySocket = async (
  request: Request,
  env: AzookeyEnv,
  dependencies: AzookeyRequestDependencies = {},
): Promise<Response> => {
  if (request.method !== "GET") {
    return new Response(
      JSON.stringify({
        error: { code: "method_not_allowed", message: "GET is required for WebSocket upgrade" },
      }),
      {
        status: HTTP_METHOD_NOT_ALLOWED,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  if (!isWebSocketUpgrade(request)) {
    return new Response(
      JSON.stringify({
        error: { code: "upgrade_required", message: "WebSocket upgrade required" },
      }),
      {
        status: HTTP_UPGRADE_REQUIRED,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  const expectedToken = env.AZOOKEY_API_TOKEN?.trim();
  const hasAuthorizationHeader = request.headers.has("authorization");
  // Authentication is optional for local/demo deployments. Once a secret is
  // configured, both native handshake headers and browser first-frame auth
  // are enforced; an invalid header must fail before the socket upgrade.
  const handshakeAuthorized = expectedToken
    ? await bearerTokenMatches(request, expectedToken)
    : false;
  if (expectedToken && hasAuthorizationHeader && !handshakeAuthorized) {
    return new Response(
      JSON.stringify({ error: { code: "unauthorized", message: "Bearer token is invalid" } }),
      {
        status: HTTP_UNAUTHORIZED,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "www-authenticate": "Bearer",
        },
      },
    );
  }
  let converter: AzookeyConverter;
  try {
    converter =
      dependencies.converter ?? createWasmConverter(dependencies.wasmModule as WebAssembly.Module);
  } catch {
    return new Response(
      JSON.stringify({
        error: { code: "converter_unavailable", message: "AzooKey converter is unavailable" },
      }),
      {
        status: HTTP_SERVICE_UNAVAILABLE,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  const pair = dependencies.socketPair?.() ?? createWorkersSocketPair();
  pair.server.accept();
  const timeoutMs = azookeyTimeoutMs(env);
  attachAzookeySocket(pair.server, {
    converter,
    timeoutMs,
    handshakeAuthorized,
    ...(expectedToken ? { expectedToken } : {}),
  });
  pair.server.send(readyAzookeyMessage(timeoutMs));
  return websocketUpgradeResponse(pair.client);
};

/**
 * Cloudflare's Response constructor supports the 101/webSocket upgrade shape,
 * while the standard Node Response used by Vitest rejects status 101. Keep the
 * production path native and provide a test/runtime shim only when needed.
 */
const websocketUpgradeResponse = (client: WebSocket): Response => {
  try {
    return new Response(null, { status: HTTP_SWITCHING_PROTOCOLS, webSocket: client });
  } catch {
    const response = new Response(null);
    Object.defineProperty(response, "status", { value: HTTP_SWITCHING_PROTOCOLS });
    Object.defineProperty(response, "webSocket", { value: client });
    return response;
  }
};

const createWorkersSocketPair = (): AzookeySocketPair => {
  const pair = new WebSocketPair();
  return { client: pair[0], server: pair[1] };
};
