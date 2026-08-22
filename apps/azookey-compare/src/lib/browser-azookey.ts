/**
 * Browser loader for the portable AzooKey WASM ABI (no wasm-bindgen).
 *
 * Same raw exports as Worker `createWasmConverter`: alloc / convert / owned
 * dictionary init. Browser-compact mode uses this instead of `/ws/azookey`.
 */

import {
  AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS,
  AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES,
  AZOOKEY_MAX_DICTIONARY_BYTES,
  isAllowedDictionaryLocator,
} from "@caption-bridge/dictionaries";

export const DEFAULT_BROWSER_AZOOKEY_WASM_URL = "/azookey/azookey.wasm";
export const DEFAULT_BROWSER_AZOOKEY_DICTIONARY_URL = "/azookey/system.azkdict.gz";
export const AZOOKEY_WASM_ABI_VERSION = 2;
export const AZOOKEY_WASM_POINTER_BITS = 32;
export const AZOOKEY_WASM_U32_MASK = BigInt(0xffffffff);

export type BrowserAzookeyFetcher = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Response | Promise<Response>;

export interface BrowserAzookeyOptions {
  wasmUrl?: string;
  dictionaryUrl?: string;
  fetcher?: BrowserAzookeyFetcher;
  wasmModule?: WebAssembly.Module;
  dictionaryBytes?: Uint8Array;
  timeoutMs?: number;
}

export interface BrowserAzookeyResult {
  text: string;
  elapsedMs: number;
}

interface AzookeyWasmExports {
  memory: WebAssembly.Memory;
  azookey_alloc: (length: number) => number;
  azookey_dealloc: (pointer: number, length: number) => void;
  azookey_convert: (pointer: number, length: number) => bigint | number;
  azookey_abi_version: () => number;
  azookey_dictionary_init_owned: (pointer: number, length: number) => number;
}

type AzookeyConverter = (text: string) => string;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

let cachedKey = "";
let cachedConverter: Promise<AzookeyConverter> | undefined;

export const resetBrowserAzookeyCache = (): void => {
  cachedKey = "";
  cachedConverter = undefined;
};

const rejectUnsafeUrl = (value: string, label: string): void => {
  if (/^javascript:/iu.test(value)) {
    throw new Error(`${label} に javascript: URL は指定できません`);
  }
};

const assertBrowserLocator = (value: string, label: string): void => {
  rejectUnsafeUrl(value, label);
  if (!isAllowedDictionaryLocator(value, "browser")) {
    throw new Error(`${label} の URL が不正です`);
  }
};

const cacheKey = (options: BrowserAzookeyOptions): string => {
  if (options.wasmModule && options.dictionaryBytes) {
    return `inline:${options.dictionaryBytes.byteLength}`;
  }
  return `${options.wasmUrl?.trim() || DEFAULT_BROWSER_AZOOKEY_WASM_URL}|${
    options.dictionaryUrl?.trim() || DEFAULT_BROWSER_AZOOKEY_DICTIONARY_URL
  }`;
};

const byteLimitTransform = (
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

const collectStream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
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

const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("AzooKey dictionary fetch timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const decompressPortableDictionary = async (response: Response): Promise<Uint8Array> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES) {
    throw new Error("AzooKey compressed dictionary exceeds the byte limit");
  }
  if (!response.body) {
    throw new Error("AzooKey dictionary response has no body");
  }
  if (typeof DecompressionStream !== "function") {
    throw new Error("AzooKey dictionary requires DecompressionStream");
  }
  const decompressed = response.body
    .pipeThrough(
      byteLimitTransform(
        AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES,
        "AzooKey compressed dictionary exceeds the byte limit",
      ),
    )
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(
      byteLimitTransform(AZOOKEY_MAX_DICTIONARY_BYTES, "AzooKey dictionary exceeds the byte limit"),
    );
  return await collectStream(decompressed);
};

const fetchWasmModule = async (
  wasmUrl: string,
  fetcher: BrowserAzookeyFetcher,
  signal: AbortSignal,
): Promise<WebAssembly.Module> => {
  assertBrowserLocator(wasmUrl, "AzooKey WASM");
  const response = await fetcher(wasmUrl, { signal });
  if (!response.ok) {
    throw new Error(`AzooKey WASM returned ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error("AzooKey WASM is empty");
  }
  return WebAssembly.compile(bytes);
};

const fetchDictionary = async (
  dictionaryUrl: string,
  fetcher: BrowserAzookeyFetcher,
  timeoutMs: number,
): Promise<Uint8Array> => {
  assertBrowserLocator(dictionaryUrl, "AzooKey dictionary");
  return await withTimeout(async (signal) => {
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

const initializeWasmDictionary = (exports: AzookeyWasmExports, dictionary: Uint8Array): void => {
  const pointer = exports.azookey_alloc(dictionary.byteLength);
  if (pointer === 0) {
    throw new Error("AzooKey Wasm dictionary allocation failed");
  }
  let transferred = false;
  try {
    new Uint8Array(exports.memory.buffer, pointer, dictionary.byteLength).set(dictionary);
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

export const instantiateBrowserAzookeyConverter = (
  module: WebAssembly.Module,
  dictionary: Uint8Array,
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
  if (typeof exports.azookey_dictionary_init_owned !== "function") {
    throw new Error("AzooKey Wasm module does not support portable dictionaries");
  }
  initializeWasmDictionary(checkedExports, dictionary);

  const convert = (text: string): string => {
    const bytes = encoder.encode(text);
    const pointer = checkedExports.azookey_alloc(bytes.byteLength);
    if (pointer === 0 && bytes.byteLength !== 0) {
      throw new Error("AzooKey Wasm input allocation failed");
    }
    try {
      new Uint8Array(checkedExports.memory.buffer, pointer, bytes.byteLength).set(bytes);
      const packed = checkedExports.azookey_convert(pointer, bytes.byteLength);
      if (packed === 0 || packed === BigInt(0)) {
        throw new Error("AzooKey Wasm conversion allocation failed");
      }
      return unpackResult(checkedExports, packed);
    } finally {
      checkedExports.azookey_dealloc(pointer, bytes.byteLength);
    }
  };
  return convert;
};

const loadConverter = (options: BrowserAzookeyOptions = {}): Promise<AzookeyConverter> => {
  const key = cacheKey(options);
  if (cachedConverter && cachedKey === key) {
    return cachedConverter;
  }
  const timeoutMs = options.timeoutMs ?? AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;
  const promise = (async () => {
    const wasmModule =
      options.wasmModule ??
      (await withTimeout(
        (signal) =>
          fetchWasmModule(
            options.wasmUrl?.trim() || DEFAULT_BROWSER_AZOOKEY_WASM_URL,
            fetcher,
            signal,
          ),
        timeoutMs,
      ));
    const dictionary =
      options.dictionaryBytes ??
      (await fetchDictionary(
        options.dictionaryUrl?.trim() || DEFAULT_BROWSER_AZOOKEY_DICTIONARY_URL,
        fetcher,
        timeoutMs,
      ));
    return instantiateBrowserAzookeyConverter(wasmModule, dictionary);
  })();
  cachedKey = key;
  cachedConverter = promise;
  return promise.catch((error) => {
    if (cachedKey === key) {
      cachedConverter = undefined;
      cachedKey = "";
    }
    throw error;
  });
};

export const warmupBrowserAzookey = async (options: BrowserAzookeyOptions = {}): Promise<void> => {
  await loadConverter(options);
};

export const runBrowserAzookey = async (
  text: string,
  options: BrowserAzookeyOptions = {},
): Promise<BrowserAzookeyResult> => {
  const converter = await loadConverter(options);
  const started = performance.now();
  const converted = converter(text);
  return {
    text: converted,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
  };
};
