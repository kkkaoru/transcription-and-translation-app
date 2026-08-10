import { readingForAzookeyAsync } from "@caption-bridge/azookey-reading";
import {
  AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS,
  AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES,
  AZOOKEY_MAX_DICTIONARY_BYTES,
  AZOOKEY_MAX_DICTIONARY_TIMEOUT_MS,
  AZOOKEY_MIN_DICTIONARY_TIMEOUT_MS,
  clampDictionaryTimeoutMs,
  isAllowedDictionaryLocator,
  VIBRATO_IPADIC_FEATURE_INDEX,
  VIBRATO_MAX_DICTIONARY_BYTES,
} from "@caption-bridge/dictionaries";
import { initSync as initVibratoSync, VibratoTokenizer } from "./vibrato_wasm.js";

export {
  AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS,
  AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES,
  AZOOKEY_MAX_DICTIONARY_BYTES,
  AZOOKEY_MAX_DICTIONARY_TIMEOUT_MS,
  AZOOKEY_MIN_DICTIONARY_TIMEOUT_MS,
  VIBRATO_IPADIC_FEATURE_INDEX,
  VIBRATO_MAX_DICTIONARY_BYTES,
};

export const AZOOKEY_WS_PATH = "/ws/azookey";
/** Public inference hostname. Disabled in production (`workers_dev: false`). */
export const INFERENCE_PUBLIC_HOST = "kotoba-beacon-inference.kaoru.workers.dev";
export const AZOOKEY_PROTOCOL = "azookey.text.v1";
export const AZOOKEY_MODEL = "azookey-rust-wasm";
export const AZOOKEY_ZENZ_XSMALL_MODEL = "zenz-v3.2-xsmall-gguf";
export const AZOOKEY_ZENZ_SMALL_MODEL = "zenz-v3.2-small-gguf";
export const AZOOKEY_CONVERT_MODELS = [
  AZOOKEY_MODEL,
  AZOOKEY_ZENZ_XSMALL_MODEL,
  AZOOKEY_ZENZ_SMALL_MODEL,
] as const;
export type AzookeyConvertModel = (typeof AZOOKEY_CONVERT_MODELS)[number];
/** Worker fell back to portable WASM because MODEL_ROUTES lacked the requested Zenzai id. */
export const AZOOKEY_MODEL_FALLBACK_UNCONFIGURED_ROUTE = "unconfigured-route";
/** Worker fell back to portable WASM after a configured Zenzai upstream failed. */
export const AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED = "upstream-failed";
export type AzookeyModelFallback =
  | typeof AZOOKEY_MODEL_FALLBACK_UNCONFIGURED_ROUTE
  | typeof AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED;
export const AZOOKEY_MODE = "worker-vibrato" as const;
export const BROWSER_VIBRATO_MODE = "browser-vibrato" as const;
/** Where the Vibrato pre-pass is executed for a comparison request. */
export const WORKER_VIBRATO_EXECUTION = "worker" as const;
export const BROWSER_VIBRATO_EXECUTION = "browser-wasm" as const;
/** Result marker for clients that supplied no explicit Vibrato execution. */
export const VIBRATO_NOT_REQUESTED = "not-requested" as const;
/** Effective Worker-side input stage advertised in ready/result metadata. */
export type WorkerInputStage = "configured" | "passthrough" | "unconfigured";
export type AzookeyResultVibratoStage =
  | WorkerInputStage
  | typeof BROWSER_VIBRATO_EXECUTION
  | typeof VIBRATO_NOT_REQUESTED;
export const AZOOKEY_MAX_TEXT_BYTES = 4_096;
export const AZOOKEY_MAX_MESSAGE_BYTES = 8_192;
/** Upper bound for the whole upstream Vibrato JSON body before it is parsed.
 * The text field itself is capped at AZOOKEY_MAX_TEXT_BYTES; this leaves room
 * for the JSON envelope while refusing a body that would otherwise allocate
 * unboundedly before the output check runs. */
export const VIBRATO_MAX_RESPONSE_BYTES = AZOOKEY_MAX_TEXT_BYTES * 4;
export const AZOOKEY_MAX_ID_BYTES = 128;
export const AZOOKEY_MAX_LANGUAGE_BYTES = 64;
export const AZOOKEY_AUTH_TOKEN_MAX_ID_MULTIPLIER = 4;
export const AZOOKEY_MAX_AUTH_TOKEN_BYTES =
  AZOOKEY_MAX_ID_BYTES * AZOOKEY_AUTH_TOKEN_MAX_ID_MULTIPLIER;
// Portable AzooKey conversion is synchronous Wasm. Measurements for the
// official dictionary put many Japanese captions around 300–600 ms, but
// longer weather-style clauses such as `あしたのてんきははれ` regularly need
// ~1.1 s even on native release builds. A 1000 ms default therefore produced
// false conversion_timeout errors for real caption text. Keep the bound
// finite while leaving room for those clauses and a cold isolate;
// deployments can still tune within the validated range.
export const AZOOKEY_DEFAULT_TIMEOUT_MS = 2_000;
export const AZOOKEY_MIN_TIMEOUT_MS = 25;
export const AZOOKEY_MAX_TIMEOUT_MS = 2_000;
export const AZOOKEY_WASM_POINTER_BITS = 32;
export const AZOOKEY_WASM_U32_MASK = 0xffff_ffffn;
export const AZOOKEY_WASM_ABI_VERSION = 2;
/**
 * Protocol timing for `azookey.result.elapsedMs`.
 * Field name stays `elapsedMs`. Value is a finite integer millisecond count:
 * `Math.round` of the measured duration, then floored at 1 so a successful
 * conversion never reports 0.
 */
export const AZOOKEY_MIN_ELAPSED_MS = 1;

export const elapsedMsFromDuration = (elapsed: number): number => {
  const rounded = Number.isFinite(elapsed) ? Math.round(Math.max(0, elapsed)) : 0;
  return Math.max(AZOOKEY_MIN_ELAPSED_MS, rounded);
};
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
  /** Maximum time to wait for one lazy dictionary fetch during socket setup. */
  AZOOKEY_DICTIONARY_TIMEOUT_MS?: string;
  /** Optional HTTP adapter that performs the real Vibrato/UniDic pre-pass. */
  VIBRATO_UPSTREAM_URL?: string;
  VIBRATO_API_TOKEN?: string;
  /** URL of a zstd-compressed Vibrato system dictionary. */
  VIBRATO_DICTIONARY_URL?: string;
  /** URL of the gzip-compressed official portable AzooKey dictionary. */
  AZOOKEY_DICTIONARY_URL?: string;
  /** JSON map of model id → `{ baseUrl, servedModel? }` for Zenzai upstreams. */
  MODEL_ROUTES?: string;
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
  azookey_abi_version: () => number;
  azookey_dictionary_init_owned: (pointer: number, length: number) => number;
}

export type AzookeyConverter = ((
  text: string,
  signal?: AbortSignal,
) => string | Promise<string>) & {
  /** Optional cold-start hook used by the WebSocket upgrade path. */
  warmup?: () => Promise<void>;
};

export type AzookeyVibratoConverter = ((
  text: string,
  language: string,
  signal?: AbortSignal,
) => string | Promise<string>) & {
  /** Optional cold-start hook used by the WebSocket upgrade path. */
  warmup?: () => Promise<void>;
};

export type AzookeyFetcher = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Response | Promise<Response>;

// Keep one tokenizer per loaded WASM module, dictionary URL, and fetcher. A
// Worker isolate can handle several WebSocket upgrades, so rebuilding the 7.7
// MiB dictionary for every socket would add avoidable cold latency and memory
// pressure. The fetcher identity is part of the key so injected test or local
// adapters cannot accidentally reuse another adapter's bytes. Failed loads are
// removed below and may be retried safely.
const vibratoTokenizerCache = new WeakMap<
  WebAssembly.Module,
  WeakMap<AzookeyFetcher, Map<string, Promise<VibratoTokenizer>>>
>();
const azookeyConverterCache = new WeakMap<
  WebAssembly.Module,
  WeakMap<AzookeyFetcher, Map<string, Promise<AzookeyConverter>>>
>();

export interface AzookeyRuntime {
  converter: AzookeyConverter;
  /** Optional real Vibrato stage. Required when vibratoExecution is `worker`. */
  vibrato?: AzookeyVibratoConverter;
  /** The effective Worker-side stage; `passthrough` is an intentional identity adapter. */
  vibratoStage?: WorkerInputStage;
  timeoutMs: number;
  expectedToken?: string;
  handshakeAuthorized?: boolean;
  /** Optional Zenzai GGUF upstreams keyed by model id. */
  modelRoutes?: Record<string, { baseUrl: string; servedModel?: string }>;
  /** Fetcher used for Zenzai chat completions. */
  fetcher?: AzookeyFetcher;
}

export interface AzookeySocketPair {
  client: WebSocket;
  server: WebSocket;
}

export type AzookeySocketPairFactory = () => AzookeySocketPair;

export interface AzookeyRequestDependencies {
  /** Injected in tests; production uses the imported raw Wasm module. */
  wasmModule?: WebAssembly.Module;
  /** Injected in tests; production uses the compiled Vibrato WASM module. */
  vibratoWasmModule?: WebAssembly.Module;
  /** Injected in tests to avoid depending on the Workers WebSocket runtime. */
  socketPair?: AzookeySocketPairFactory;
  /** Injected in tests or for a controlled fallback implementation. */
  converter?: AzookeyConverter;
  /** Injected in tests; production builds this from VIBRATO_UPSTREAM_URL. */
  vibratoConverter?: AzookeyVibratoConverter;
  /** Injected in tests; production uses the platform fetch. */
  fetcher?: AzookeyFetcher;
  /** Optional asset-bound fetcher for a Worker-hosted system dictionary. */
  vibratoDictionaryFetcher?: AzookeyFetcher;
  /** Optional asset-bound fetcher for the official AzooKey dictionary. */
  azookeyDictionaryFetcher?: AzookeyFetcher;
  /** Test seam for the bounded lazy dictionary fetch. */
  dictionaryTimeoutMs?: number;
}

export interface AzookeyMessage {
  type: "azookey.convert";
  requestId: string;
  source: "web-speech";
  language: string;
  sourceText: string;
  vibratoInput: string;
  mode: AzookeyMode;
  /** Converter model; defaults to the portable WASM dictionary path. */
  model: AzookeyConvertModel;
  /** Explicitly records where the required Vibrato pre-pass ran. */
  vibratoExecution?: typeof WORKER_VIBRATO_EXECUTION | typeof BROWSER_VIBRATO_EXECUTION;
  auth?: AzookeyAuth;
}

export interface AzookeyResultMessage {
  type: "azookey.result";
  requestId: string;
  sourceText: string;
  /** The exact text passed to the AzooKey converter after any pre-pass. */
  vibratoInput: string;
  /** Requested/executed pre-pass location, or `not-requested` for legacy frames. */
  vibratoExecution:
    | typeof WORKER_VIBRATO_EXECUTION
    | typeof BROWSER_VIBRATO_EXECUTION
    | typeof VIBRATO_NOT_REQUESTED;
  /** Effective stage, including explicit identity passthrough. */
  vibratoStage: AzookeyResultVibratoStage;
  /** True only when Worker Vibrato intentionally returned source text unchanged. */
  vibratoPassthrough: boolean;
  convertedText: string;
  mode: typeof AZOOKEY_MODE;
  elapsedMs: number;
  /** Effective converter model after any Zenzai fallback. */
  model: AzookeyConvertModel;
  /** Original Zenzai model id when the Worker used a dictionary fallback. */
  requestedModel?: AzookeyConvertModel;
  modelFallback?: AzookeyModelFallback;
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
  | "vibrato_unavailable"
  | "vibrato_timeout"
  | "vibrato_failed"
  | "unauthorized"
  | "busy"
  | "conversion_timeout"
  | "conversion_failed"
  | "converter_unavailable"
  | "unsupported_model";

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

export const azookeyDictionaryTimeoutMs = (env: AzookeyEnv): number =>
  clampDictionaryTimeoutMs(env.AZOOKEY_DICTIONARY_TIMEOUT_MS);

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
  const vibratoExecution = parsed["vibratoExecution"];
  if (
    vibratoExecution !== undefined &&
    vibratoExecution !== WORKER_VIBRATO_EXECUTION &&
    vibratoExecution !== BROWSER_VIBRATO_EXECUTION
  ) {
    throw new AzookeyProtocolError(
      "invalid_contract",
      "vibratoExecution must be worker or browser-wasm",
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
  const modelValue = parsed["model"];
  let model: AzookeyConvertModel = AZOOKEY_MODEL;
  if (modelValue !== undefined) {
    if (
      typeof modelValue !== "string" ||
      !(AZOOKEY_CONVERT_MODELS as readonly string[]).includes(modelValue)
    ) {
      throw new AzookeyProtocolError(
        "unsupported_model",
        "model must be azookey-rust-wasm, zenz-v3.2-xsmall-gguf, or zenz-v3.2-small-gguf",
        requestId,
      );
    }
    model = modelValue as AzookeyConvertModel;
  }
  return {
    type: "azookey.convert",
    requestId,
    source: "web-speech",
    language,
    sourceText,
    vibratoInput,
    mode: AZOOKEY_MODE,
    model,
    ...(vibratoExecution === undefined ? {} : { vibratoExecution }),
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

const instantiateWasmConverter = (
  module: WebAssembly.Module,
  dictionary?: Uint8Array,
): AzookeyConverter => {
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
  if (
    typeof exports.azookey_abi_version !== "function" ||
    exports.azookey_abi_version() !== AZOOKEY_WASM_ABI_VERSION
  ) {
    throw new Error(
      `AzooKey Wasm module ABI version mismatch: expected ${AZOOKEY_WASM_ABI_VERSION}`,
    );
  }
  if (dictionary) {
    if (typeof exports.azookey_dictionary_init_owned !== "function") {
      throw new Error("AzooKey Wasm module does not support portable dictionaries");
    }
    initializeWasmDictionary(checkedExports, dictionary);
  }

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

const initializeWasmDictionary = (exports: AzookeyWasmExports, dictionary: Uint8Array): void => {
  const pointer = exports.azookey_alloc(dictionary.byteLength);
  if (pointer === 0) {
    throw new Error("AzooKey Wasm dictionary allocation failed");
  }
  let transferred = false;
  try {
    new Uint8Array(exports.memory.buffer, pointer, dictionary.byteLength).set(dictionary);
    // The owned ABI consumes the allocation at the call boundary, including
    // malformed-input and trap paths. Never deallocate it from JavaScript
    // after invoking the function.
    transferred = true;
    const status = exports.azookey_dictionary_init_owned(pointer, dictionary.byteLength);
    if (status !== 0) {
      throw new Error(`AzooKey Wasm dictionary initialization failed (${status})`);
    }
  } finally {
    if (!transferred) {
      exports.azookey_dealloc(pointer, dictionary.byteLength);
    }
  }
};

export const byteLimitTransform = (
  limit: number,
  message: string,
): TransformStream<Uint8Array, Uint8Array> => {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller): void {
      total += chunk.byteLength;
      if (total > limit) {
        controller.error(new Error(message));
        return;
      }
      controller.enqueue(chunk);
    },
  });
};

export const collectStream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
};

const decompressPortableDictionary = (response: Response): Promise<Uint8Array> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES) {
    throw new Error("AzooKey compressed dictionary exceeds the byte limit");
  }
  if (!response.body) {
    throw new Error("AzooKey dictionary response has no body");
  }
  const compressed = response.body.pipeThrough(
    byteLimitTransform(
      AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES,
      "AzooKey compressed dictionary exceeds the byte limit",
    ),
  );
  const decompressed = compressed
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(
      byteLimitTransform(AZOOKEY_MAX_DICTIONARY_BYTES, "AzooKey dictionary exceeds the byte limit"),
    );
  return collectStream(decompressed);
};

const fetchPortableDictionary = (
  dictionaryUrl: string,
  fetcher: AzookeyFetcher,
  timeoutMs: number,
): Promise<Uint8Array> => {
  return withDictionaryFetchTimeout(async (signal) => {
    const response = await fetcher(dictionaryUrl, { signal });
    if (!response.ok) {
      throw new Error(`AzooKey dictionary returned ${response.status}`);
    }
    const dictionary = await decompressPortableDictionary(response);
    if (dictionary.byteLength === 0) {
      throw new Error("AzooKey dictionary is empty");
    }
    return dictionary;
  }, timeoutMs);
};

const fetchVibratoDictionary = (
  dictionaryUrl: string,
  fetcher: AzookeyFetcher,
  timeoutMs: number,
): Promise<Uint8Array> =>
  withDictionaryFetchTimeout(async (signal) => {
    const response = await fetcher(dictionaryUrl, { signal });
    if (!response.ok) {
      throw new Error(`Vibrato dictionary returned ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > VIBRATO_MAX_DICTIONARY_BYTES) {
      throw new Error("Vibrato dictionary exceeds the byte limit");
    }
    if (!response.body) {
      throw new Error("Vibrato dictionary response has no body");
    }
    return collectStream(
      response.body.pipeThrough(
        byteLimitTransform(
          VIBRATO_MAX_DICTIONARY_BYTES,
          "Vibrato dictionary exceeds the byte limit",
        ),
      ),
    );
  }, timeoutMs);

const withDictionaryFetchTimeout = async <T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new Error("dictionary fetch timed out"));
        },
        Math.max(1, timeoutMs),
      );
      void Promise.resolve()
        .then(() => operation(controller.signal))
        .then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const moduleConverterCache = (
  module: WebAssembly.Module,
  fetcher: AzookeyFetcher,
): Map<string, Promise<AzookeyConverter>> => {
  let fetcherCache = azookeyConverterCache.get(module);
  if (!fetcherCache) {
    fetcherCache = new WeakMap<AzookeyFetcher, Map<string, Promise<AzookeyConverter>>>();
    azookeyConverterCache.set(module, fetcherCache);
  }
  let converterCache = fetcherCache.get(fetcher);
  if (!converterCache) {
    converterCache = new Map<string, Promise<AzookeyConverter>>();
    fetcherCache.set(fetcher, converterCache);
  }
  return converterCache;
};

export const createWasmConverter = (
  module: WebAssembly.Module,
  dictionaryUrl?: string,
  fetcher: AzookeyFetcher = fetch,
  dictionaryTimeoutMs: number = AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS,
): AzookeyConverter => {
  const normalizedUrl = dictionaryUrl?.trim();
  if (!normalizedUrl) {
    return instantiateWasmConverter(module);
  }
  if (!isDictionaryUrl(normalizedUrl)) {
    throw new Error(
      "AZOOKEY_DICTIONARY_URL must be an http:// or https:// URL or an absolute Worker asset path",
    );
  }
  const cache = moduleConverterCache(module, fetcher);
  const loadConverter = (): Promise<AzookeyConverter> => {
    const cached = cache.get(normalizedUrl);
    if (cached) {
      return cached;
    }
    let pending!: Promise<AzookeyConverter>;
    pending = fetchPortableDictionary(normalizedUrl, fetcher, dictionaryTimeoutMs)
      .then((dictionary) => instantiateWasmConverter(module, dictionary))
      .catch((error: unknown) => {
        // A late rejection must not evict a newer retry for the same URL.
        if (cache.get(normalizedUrl) === pending) {
          cache.delete(normalizedUrl);
        }
        throw error instanceof Error
          ? error
          : new Error("AzooKey dictionary initialization failed");
      });
    cache.set(normalizedUrl, pending);
    return pending;
  };
  const converter = (async (text: string): Promise<string> => {
    const loaded = await loadConverter();
    return loaded(text);
  }) as AzookeyConverter;
  converter.warmup = async (): Promise<void> => {
    await loadConverter();
  };
  return converter;
};

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const isDictionaryUrl = (value: string): boolean => isAllowedDictionaryLocator(value, "worker");

const createPortableDictionaryInputAdapter =
  (): AzookeyVibratoConverter =>
  (text: string): string =>
    text;

/**
 * Build the Worker-side Vibrato adapter without bundling a 684 MB UniDic
 * dictionary into a Cloudflare isolate.  The upstream contract is deliberately
 * tiny and explicit: POST `{text, language}` and return `{text}` (a hiragana
 * string).  `hiragana` and `reading` are accepted aliases for interoperating
 * with existing adapters, but no heuristic/fixed phrase fallback is used.
 */
export const createVibratoHttpConverter = (
  env: Pick<AzookeyEnv, "VIBRATO_UPSTREAM_URL" | "VIBRATO_API_TOKEN">,
  fetcher: AzookeyFetcher = fetch,
): AzookeyVibratoConverter | undefined => {
  const upstreamUrl = env.VIBRATO_UPSTREAM_URL?.trim();
  if (!upstreamUrl) {
    return undefined;
  }
  if (!isHttpUrl(upstreamUrl)) {
    throw new Error("VIBRATO_UPSTREAM_URL must be an http:// or https:// URL");
  }
  const token = env.VIBRATO_API_TOKEN?.trim();
  return async (text: string, language: string, signal?: AbortSignal): Promise<string> =>
    readingForAzookeyAsync(text, async (input) => {
      let response: Response;
      try {
        response = await fetcher(upstreamUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ text: input, language }),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "connection failed";
        throw new Error(`Vibrato upstream connection failed: ${detail}`);
      }
      if (!response.ok) {
        throw new Error(`Vibrato upstream returned ${response.status}`);
      }
      if (!response.body) {
        throw new Error("Vibrato upstream response has no body");
      }
      let payload: unknown;
      try {
        const bounded = response.body.pipeThrough(
          byteLimitTransform(
            VIBRATO_MAX_RESPONSE_BYTES,
            "Vibrato upstream response exceeds the byte limit",
          ),
        );
        payload = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(await collectStream(bounded)),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Vibrato upstream response exceeds the byte limit"
        ) {
          throw error;
        }
        throw new Error("Vibrato upstream returned invalid JSON");
      }
      if (!isRecord(payload)) {
        throw new Error("Vibrato upstream response must be an object");
      }
      const output = payload["text"] ?? payload["hiragana"] ?? payload["reading"];
      if (typeof output !== "string" || output.trim().length === 0) {
        throw new Error("Vibrato upstream response has no non-empty text field");
      }
      if (encoder.encode(output).byteLength > AZOOKEY_MAX_TEXT_BYTES) {
        throw new Error("Vibrato upstream output exceeds the text byte limit");
      }
      return output;
    });
};

/**
 * Build the real Worker-side Vibrato adapter from the checked-in WASM module
 * and a standard Vibrato system dictionary.  The dictionary is fetched lazily
 * once per Worker isolate so a cold start pays the cost only when a request
 * selects `vibratoExecution: "worker"`; no phrase-specific fallback exists.
 */
export const createVibratoWasmConverter = (
  wasmModule: WebAssembly.Module | undefined,
  dictionaryUrl: string | undefined,
  fetcher: AzookeyFetcher = fetch,
  dictionaryTimeoutMs: number = AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS,
): AzookeyVibratoConverter | undefined => {
  const normalizedUrl = dictionaryUrl?.trim();
  if (!wasmModule || !normalizedUrl) {
    return undefined;
  }
  if (!isDictionaryUrl(normalizedUrl)) {
    throw new Error(
      "VIBRATO_DICTIONARY_URL must be an http:// or https:// URL or an absolute Worker asset path",
    );
  }

  let fetcherCache = vibratoTokenizerCache.get(wasmModule);
  if (!fetcherCache) {
    fetcherCache = new WeakMap<AzookeyFetcher, Map<string, Promise<VibratoTokenizer>>>();
    vibratoTokenizerCache.set(wasmModule, fetcherCache);
  }
  let moduleCache = fetcherCache.get(fetcher);
  if (!moduleCache) {
    moduleCache = new Map<string, Promise<VibratoTokenizer>>();
    fetcherCache.set(fetcher, moduleCache);
  }

  const loadTokenizer = (): Promise<VibratoTokenizer> => {
    const cached = moduleCache.get(normalizedUrl);
    if (cached) {
      return cached;
    }
    let tokenizerPromise!: Promise<VibratoTokenizer>;
    tokenizerPromise = fetchVibratoDictionary(normalizedUrl, fetcher, dictionaryTimeoutMs)
      .then((bytes) => {
        if (bytes.byteLength === 0) {
          throw new Error("Vibrato dictionary is empty");
        }
        initVibratoSync({ module: wasmModule });
        return new VibratoTokenizer(bytes);
      })
      .catch((error: unknown) => {
        // A late rejection must not evict a newer retry for the same URL.
        if (moduleCache.get(normalizedUrl) === tokenizerPromise) {
          moduleCache.delete(normalizedUrl);
        }
        throw error instanceof Error
          ? error
          : new Error("Vibrato dictionary initialization failed");
      });
    moduleCache.set(normalizedUrl, tokenizerPromise);
    return tokenizerPromise;
  };

  const converter = (async (text: string): Promise<string> =>
    readingForAzookeyAsync(text, async (input) => {
      const tokenizer = await loadTokenizer();
      return tokenizer.toHiragana(input, VIBRATO_IPADIC_FEATURE_INDEX);
    })) as AzookeyVibratoConverter;
  converter.warmup = async (): Promise<void> => {
    await loadTokenizer();
  };
  return converter;
};

const withTimeout = async <T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AzookeyProtocolError("conversion_timeout", "conversion timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const toKatakana = (input: string): string =>
  input.replace(/[\u3041-\u3096]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));

export const zenzPrompt = (input: string): string => `\u{EE00}${toKatakana(input)}\u{EE01}`;

export const parseModelRoutes = (
  raw: string | undefined,
): Record<string, { baseUrl: string; servedModel?: string }> => {
  if (!raw?.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const routes: Record<string, { baseUrl: string; servedModel?: string }> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const baseUrl = (value as { baseUrl?: unknown }).baseUrl;
      if (typeof baseUrl !== "string" || !baseUrl.trim()) {
        continue;
      }
      const servedModel = (value as { servedModel?: unknown }).servedModel;
      routes[id] = {
        baseUrl: baseUrl.trim().replace(/\/$/, ""),
        ...(typeof servedModel === "string" && servedModel.trim()
          ? { servedModel: servedModel.trim() }
          : {}),
      };
    }
    return routes;
  } catch {
    return {};
  }
};

export const isZenzConvertModel = (model: AzookeyConvertModel): boolean =>
  model === AZOOKEY_ZENZ_XSMALL_MODEL || model === AZOOKEY_ZENZ_SMALL_MODEL;

const convertWithZenzModel = async (
  model: AzookeyConvertModel,
  text: string,
  runtime: AzookeyRuntime,
  signal?: AbortSignal,
): Promise<string> => {
  const route = runtime.modelRoutes?.[model];
  if (!route) {
    throw new AzookeyProtocolError(
      "unsupported_model",
      `${model} is not configured in MODEL_ROUTES`,
    );
  }
  const fetcher = runtime.fetcher ?? fetch;
  // Zenz llama.cpp servers speak `/completion`, not OpenAI chat completions.
  const response = await fetcher(`${route.baseUrl}/completion`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      prompt: zenzPrompt(text),
      n_predict: 256,
      temperature: 0,
      stream: false,
    }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new AzookeyProtocolError(
      "conversion_failed",
      `Zenzai upstream returned HTTP ${response.status}`,
    );
  }
  const payload: unknown = await response.json();
  const content =
    payload && typeof payload === "object" ? (payload as { content?: unknown }).content : undefined;
  if (typeof content !== "string" || !content.trim()) {
    throw new AzookeyProtocolError("conversion_failed", "Zenzai upstream returned no text");
  }
  return content.trim();
};

export const convertAzookeyMessage = async (
  message: AzookeyMessage,
  runtime: AzookeyRuntime,
): Promise<AzookeyResultMessage> => {
  const deadlineMs = runtime.timeoutMs;
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const remainingMs = (): number => Math.max(0, deadlineMs - (nowMs() - startedAt));
  const deadlineExpired = (): boolean => remainingMs() <= 0;
  const vibratoExecution = message.vibratoExecution ?? VIBRATO_NOT_REQUESTED;
  const vibratoStage: AzookeyResultVibratoStage =
    message.vibratoExecution === WORKER_VIBRATO_EXECUTION
      ? (runtime.vibratoStage ?? (runtime.vibrato ? "configured" : "unconfigured"))
      : message.vibratoExecution === BROWSER_VIBRATO_EXECUTION
        ? BROWSER_VIBRATO_EXECUTION
        : VIBRATO_NOT_REQUESTED;
  let conversionInput = message.vibratoInput;
  if (message.vibratoExecution === WORKER_VIBRATO_EXECUTION) {
    if (!runtime.vibrato) {
      throw new AzookeyProtocolError(
        "vibrato_unavailable",
        "Worker Vibrato adapter is not configured",
        message.requestId,
      );
    }
    try {
      if (remainingMs() <= 0) {
        throw new AzookeyProtocolError(
          "vibrato_timeout",
          "Worker Vibrato conversion timed out",
          message.requestId,
        );
      }
      const vibratoOutput = await withTimeout(
        (signal) => runtime.vibrato?.(message.sourceText, message.language, signal),
        remainingMs(),
      );
      if (deadlineExpired()) {
        throw new AzookeyProtocolError(
          "vibrato_timeout",
          "Worker Vibrato conversion timed out",
          message.requestId,
        );
      }
      if (typeof vibratoOutput !== "string" || vibratoOutput.trim().length === 0) {
        throw new Error("Worker Vibrato adapter returned no text");
      }
      if (encoder.encode(vibratoOutput).byteLength > AZOOKEY_MAX_TEXT_BYTES) {
        throw new Error("Worker Vibrato output exceeds the text byte limit");
      }
      conversionInput = vibratoOutput;
    } catch (error) {
      if (
        error instanceof AzookeyProtocolError &&
        (error.code === "conversion_timeout" || error.code === "vibrato_timeout")
      ) {
        throw new AzookeyProtocolError(
          "vibrato_timeout",
          "Worker Vibrato conversion timed out",
          message.requestId,
        );
      }
      throw new AzookeyProtocolError(
        "vibrato_failed",
        error instanceof Error ? error.message : "Worker Vibrato conversion failed",
        message.requestId,
      );
    }
  } else if (deadlineExpired()) {
    throw new AzookeyProtocolError("conversion_timeout", "conversion timed out", message.requestId);
  }
  const runDictionaryConversion = async (): Promise<string> => {
    if (remainingMs() <= 0) {
      throw new AzookeyProtocolError(
        "conversion_timeout",
        "conversion timed out",
        message.requestId,
      );
    }
    const candidate = await withTimeout(
      (signal) => runtime.converter(conversionInput, signal),
      remainingMs(),
    );
    if (deadlineExpired()) {
      throw new AzookeyProtocolError(
        "conversion_timeout",
        "conversion timed out",
        message.requestId,
      );
    }
    if (typeof candidate !== "string") {
      throw new AzookeyProtocolError("conversion_failed", "AzooKey conversion returned no text");
    }
    if (encoder.encode(candidate).byteLength > AZOOKEY_MAX_TEXT_BYTES) {
      throw new AzookeyProtocolError(
        "conversion_failed",
        "AzooKey conversion output exceeds the text byte limit",
        message.requestId,
      );
    }
    return candidate;
  };

  let converted: string;
  let resultModel: AzookeyConvertModel = message.model;
  let requestedModel: AzookeyConvertModel | undefined;
  let modelFallback: AzookeyModelFallback | undefined;
  try {
    if (message.model === AZOOKEY_MODEL) {
      converted = await runDictionaryConversion();
    } else if (!runtime.modelRoutes?.[message.model]) {
      requestedModel = message.model;
      modelFallback = AZOOKEY_MODEL_FALLBACK_UNCONFIGURED_ROUTE;
      resultModel = AZOOKEY_MODEL;
      converted = await runDictionaryConversion();
    } else {
      try {
        if (remainingMs() <= 0) {
          throw new AzookeyProtocolError(
            "conversion_timeout",
            "conversion timed out",
            message.requestId,
          );
        }
        const candidate = await withTimeout(
          (signal) => convertWithZenzModel(message.model, conversionInput, runtime, signal),
          remainingMs(),
        );
        if (deadlineExpired()) {
          throw new AzookeyProtocolError(
            "conversion_timeout",
            "conversion timed out",
            message.requestId,
          );
        }
        if (typeof candidate !== "string") {
          throw new AzookeyProtocolError(
            "conversion_failed",
            "AzooKey conversion returned no text",
          );
        }
        if (encoder.encode(candidate).byteLength > AZOOKEY_MAX_TEXT_BYTES) {
          throw new AzookeyProtocolError(
            "conversion_failed",
            "AzooKey conversion output exceeds the text byte limit",
            message.requestId,
          );
        }
        converted = candidate;
      } catch (error) {
        if (
          error instanceof AzookeyProtocolError &&
          (error.code === "conversion_failed" || error.code === "conversion_timeout")
        ) {
          requestedModel = message.model;
          modelFallback = AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED;
          resultModel = AZOOKEY_MODEL;
          converted = await runDictionaryConversion();
        } else if (error instanceof AzookeyProtocolError) {
          if (error.requestId === undefined) {
            throw new AzookeyProtocolError(error.code, error.message, message.requestId);
          }
          throw error;
        } else {
          throw new AzookeyProtocolError(
            "conversion_failed",
            "AzooKey conversion failed",
            message.requestId,
          );
        }
      }
    }
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
  const elapsed = nowMs() - startedAt;
  return {
    type: "azookey.result",
    requestId: message.requestId,
    sourceText: message.sourceText,
    vibratoInput: conversionInput,
    vibratoExecution,
    vibratoStage,
    vibratoPassthrough: vibratoStage === "passthrough",
    convertedText: converted,
    mode: AZOOKEY_MODE,
    elapsedMs: elapsedMsFromDuration(elapsed),
    model: resultModel,
    ...(requestedModel ? { requestedModel } : {}),
    ...(modelFallback ? { modelFallback } : {}),
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

export type AzookeyDictionaryTransport = "portable-wasm" | "builtin";

export const readyAzookeyMessage = (
  timeoutMs: number,
  workerInputStage: WorkerInputStage | boolean = "unconfigured",
  modelRoutes: Record<string, { baseUrl: string; servedModel?: string }> = {},
  dictionaryTransport: AzookeyDictionaryTransport = "builtin",
): string => {
  const normalizedStage =
    typeof workerInputStage === "boolean"
      ? workerInputStage
        ? "configured"
        : "unconfigured"
      : workerInputStage;
  const zenzDictionaryFallbackAvailable = dictionaryTransport === "portable-wasm";
  const availableModels = [
    AZOOKEY_MODEL,
    ...AZOOKEY_CONVERT_MODELS.filter(
      (model) =>
        model !== AZOOKEY_MODEL &&
        (Boolean(modelRoutes[model]) || zenzDictionaryFallbackAvailable),
    ),
  ];
  return jsonMessage({
    type: "azookey.ready",
    protocol: AZOOKEY_PROTOCOL,
    model: AZOOKEY_MODEL,
    models: availableModels,
    mode: AZOOKEY_MODE,
    browserMode: BROWSER_VIBRATO_MODE,
    vibrato: {
      workerStage: normalizedStage,
      workerInput: normalizedStage === "passthrough" ? "sourceText" : "vibrato-output",
      workerPassthrough: normalizedStage === "passthrough",
      browserStage: "client",
    },
    dictionary: {
      transport: dictionaryTransport,
      configured: dictionaryTransport === "portable-wasm",
    },
    maxTextBytes: AZOOKEY_MAX_TEXT_BYTES,
    timeoutMs,
  });
};

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

export const isPublicInferenceRequest = (request: Request): boolean => {
  try {
    return new URL(request.url).hostname === INFERENCE_PUBLIC_HOST;
  } catch {
    return false;
  }
};

export type AzookeyHandshakeAuthorization = {
  handshakeAuthorized: boolean;
  unauthorized: boolean;
};

/**
 * Public inference still requires a matching Bearer or first-frame token.
 * Service-binding / local hosts (no public hostname) may upgrade without
 * Authorization; a wrong Bearer is still 401.
 */
export const resolveAzookeyHandshakeAuthorization = ({
  expectedToken,
  hasAuthorizationHeader,
  tokenMatches,
  publicInferenceHost,
}: {
  expectedToken?: string | undefined;
  hasAuthorizationHeader: boolean;
  tokenMatches: boolean;
  publicInferenceHost: boolean;
}): AzookeyHandshakeAuthorization => {
  if (!expectedToken) {
    return { handshakeAuthorized: false, unauthorized: false };
  }
  if (hasAuthorizationHeader && !tokenMatches) {
    return { handshakeAuthorized: false, unauthorized: true };
  }
  if (tokenMatches) {
    return { handshakeAuthorized: true, unauthorized: false };
  }
  if (!publicInferenceHost) {
    return { handshakeAuthorized: true, unauthorized: false };
  }
  return { handshakeAuthorized: false, unauthorized: false };
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
  const expectedToken = env.AZOOKEY_API_TOKEN?.trim() || undefined;
  const hasAuthorizationHeader = request.headers.has("authorization");
  const tokenMatches = expectedToken ? await bearerTokenMatches(request, expectedToken) : false;
  const handshake = resolveAzookeyHandshakeAuthorization({
    expectedToken,
    hasAuthorizationHeader,
    tokenMatches,
    publicInferenceHost: isPublicInferenceRequest(request),
  });
  // A wrong Authorization header fails before upgrade. Binding requests with
  // no Authorization are trusted (`workers_dev` stays false). Public inference
  // still requires first-frame bearer when the handshake did not match.
  if (handshake.unauthorized) {
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
  const handshakeAuthorized = handshake.handshakeAuthorized;
  // A WebSocketPair is an allocated resource even while the lazy dictionary
  // warmup is in flight.  Create an injected/Workers pair before warmup so a
  // failed 503 path can close both ends explicitly.  Node/Vitest does not
  // expose WebSocketPair, so defer the native pair there until the upgrade is
  // known to be successful.
  let pair = createWarmupSocketPair(dependencies);
  const closePair = (): void => {
    closeAzookeySocketPair(pair);
  };
  let converter: AzookeyConverter;
  const portableDictionaryConfigured = Boolean(env.AZOOKEY_DICTIONARY_URL?.trim());
  const dictionaryTimeoutMs = dependencies.dictionaryTimeoutMs ?? azookeyDictionaryTimeoutMs(env);
  try {
    converter =
      dependencies.converter ??
      createWasmConverter(
        dependencies.wasmModule as WebAssembly.Module,
        env.AZOOKEY_DICTIONARY_URL,
        dependencies.azookeyDictionaryFetcher ?? dependencies.fetcher ?? fetch,
        dictionaryTimeoutMs,
      );
    await converter.warmup?.();
  } catch {
    closePair();
    return new Response(
      JSON.stringify({
        error: {
          code: "converter_unavailable",
          message: "AzooKey converter or dictionary is unavailable",
        },
      }),
      {
        status: HTTP_SERVICE_UNAVAILABLE,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  let vibratoConverter: AzookeyVibratoConverter | undefined;
  const vibratoDictionaryConfigured = Boolean(env.VIBRATO_DICTIONARY_URL?.trim());
  let httpVibrato: AzookeyVibratoConverter | undefined;
  try {
    httpVibrato = createVibratoHttpConverter(env, dependencies.fetcher ?? fetch);
    const dictionaryVibrato =
      vibratoDictionaryConfigured && !httpVibrato && !dependencies.vibratoConverter
        ? createVibratoWasmConverter(
            dependencies.vibratoWasmModule,
            env.VIBRATO_DICTIONARY_URL,
            dependencies.vibratoDictionaryFetcher ?? dependencies.fetcher ?? fetch,
            dictionaryTimeoutMs,
          )
        : undefined;
    if (
      vibratoDictionaryConfigured &&
      !httpVibrato &&
      !dictionaryVibrato &&
      !dependencies.vibratoConverter
    ) {
      throw new Error("Vibrato dictionary is configured but the WASM adapter is unavailable");
    }
    vibratoConverter =
      dependencies.vibratoConverter ??
      httpVibrato ??
      dictionaryVibrato ??
      (portableDictionaryConfigured ? createPortableDictionaryInputAdapter() : undefined);
  } catch {
    closePair();
    return new Response(
      JSON.stringify({
        error: { code: "vibrato_unavailable", message: "Vibrato adapter is unavailable" },
      }),
      {
        status: HTTP_SERVICE_UNAVAILABLE,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  const timeoutMs = azookeyTimeoutMs(env);
  if (vibratoConverter?.warmup && (vibratoConverter as unknown) !== converter) {
    try {
      await vibratoConverter.warmup();
    } catch {
      closePair();
      return new Response(
        JSON.stringify({
          error: { code: "vibrato_unavailable", message: "Vibrato dictionary is unavailable" },
        }),
        {
          status: HTTP_SERVICE_UNAVAILABLE,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
  }
  // In Node/Vitest there is no native WebSocketPair.  Only allocate the
  // deferred pair after all warmups have succeeded; Workers always took the
  // pre-warmup branch above and therefore still get explicit cleanup on 503.
  pair ??= createWorkersSocketPair();
  const workerPassthrough =
    portableDictionaryConfigured &&
    !vibratoDictionaryConfigured &&
    !httpVibrato &&
    !dependencies.vibratoConverter;
  const workerInputStage: WorkerInputStage = workerPassthrough
    ? "passthrough"
    : vibratoConverter
      ? "configured"
      : "unconfigured";
  try {
    pair.server.accept();
    attachAzookeySocket(pair.server, {
      converter,
      ...(vibratoConverter ? { vibrato: vibratoConverter } : {}),
      vibratoStage: workerInputStage,
      timeoutMs,
      handshakeAuthorized,
      modelRoutes: parseModelRoutes(env.MODEL_ROUTES),
      fetcher: dependencies.fetcher ?? fetch,
      ...(expectedToken ? { expectedToken } : {}),
    });
    pair.server.send(
      readyAzookeyMessage(
        timeoutMs,
        workerInputStage,
        parseModelRoutes(env.MODEL_ROUTES),
        portableDictionaryConfigured ? "portable-wasm" : "builtin",
      ),
    );
    return websocketUpgradeResponse(pair.client);
  } catch (error) {
    // A runtime throw after pair creation (accept/send/upgrade response) must
    // not strand either endpoint.  Re-throw so the Worker entrypoint can
    // preserve its existing 500 error envelope.
    closePair();
    throw error;
  }
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

const closeAzookeySocket = (socket: WebSocket | undefined): void => {
  if (!socket || typeof socket.close !== "function") {
    return;
  }
  try {
    socket.close();
  } catch {
    // Closing one endpoint must not prevent the other endpoint from being
    // closed when a Worker runtime rejects a close on an unaccepted socket.
  }
};

const closeAzookeySocketPair = (pair: AzookeySocketPair | undefined): void => {
  if (!pair) {
    return;
  }
  closeAzookeySocket(pair.server);
  closeAzookeySocket(pair.client);
};

const createWarmupSocketPair = (
  dependencies: AzookeyRequestDependencies,
): AzookeySocketPair | undefined => {
  if (dependencies.socketPair) {
    return dependencies.socketPair();
  }
  if (typeof WebSocketPair === "undefined") {
    return undefined;
  }
  return createWorkersSocketPair();
};
