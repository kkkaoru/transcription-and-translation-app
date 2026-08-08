/**
 * Browser-side Vibrato WASM pre-pass for the comparison app.
 *
 * The generated wasm-bindgen module in `public/vibrato` exports
 * `initSync`/`VibratoTokenizer` rather than a string converter. This loader
 * initializes that module from a dictionary URL and uses its IPADIC reading
 * field (F[7]) to produce hiragana before the Worker AzooKey stage. A small
 * wrapper/global that already exposes `convert`, `transform`, or `tokenize`
 * remains supported for deployments that host their own dictionary.
 */

import { containsKanji } from "./azookey-reading";
import {
  DEFAULT_BROWSER_WASM_DICTIONARY_URL,
  DEFAULT_BROWSER_WASM_FEATURE_INDEX,
  DEFAULT_BROWSER_WASM_GLOBAL_NAME,
} from "./contract";

export interface BrowserVibratoConfig {
  /** JS wasm-bindgen glue module, or an empty string when using a global. */
  moduleUrl: string;
  globalName?: string;
  /** Compressed Vibrato system.dic bytes (IPADIC by default). */
  dictionaryUrl?: string;
  /** Dictionary feature index; IPADIC reading is F[7], UniDic CWJ kana is F[20]. */
  featureIndex?: number;
  /** Optional raw wasm URL for modules that only expose initSync. */
  wasmBinaryUrl?: string;
}

export interface BrowserVibratoResult {
  text: string;
  elapsedMs: number;
}

type VibratoConvertFunction = (text: string) => unknown;

interface UnknownRecord {
  [key: string]: unknown;
}

interface GeneratedTokenizer {
  toHiragana?: (text: string, featureIndex: number) => unknown;
  tokenize?: (text: string) => unknown;
  free?: () => void;
}

interface GeneratedVibratoModule extends UnknownRecord {
  default?: (input?: unknown) => unknown;
  initSync?: (input: unknown) => unknown;
  VibratoTokenizer?: new (dictionaryBytes: Uint8Array) => GeneratedTokenizer;
}

const loadedConverters = new Map<string, Promise<VibratoConvertFunction>>();
const MIN_ELAPSED_MS = 0;
const MAX_DICTIONARY_BYTES = 64 * 1024 * 1024;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

const featureIndex = (value: number | undefined): number => {
  if (value === undefined) {
    return DEFAULT_BROWSER_WASM_FEATURE_INDEX;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Vibrato feature index must be a non-negative integer");
  }
  return value;
};

const asConverter = (value: unknown): VibratoConvertFunction | null => {
  if (typeof value === "function") {
    return value as VibratoConvertFunction;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const key of ["convert", "transform", "tokenize"]) {
    const candidate = value[key];
    if (typeof candidate === "function") {
      return candidate as VibratoConvertFunction;
    }
  }
  const defaultExport = value.default;
  return defaultExport === value ? null : asConverter(defaultExport);
};

const rejectUnsafeUrl = (value: string, label: string): void => {
  if (/^javascript:/iu.test(value)) {
    throw new Error(`${label} に javascript: URL は指定できません`);
  }
};

const fetchBytes = async (
  url: string,
  label: string,
  maximumBytes?: number,
): Promise<Uint8Array> => {
  rejectUnsafeUrl(url, label);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `${label}を読み込めません: ${error instanceof Error ? error.message : "fetch failed"}`,
    );
  }
  if (!response.ok) {
    throw new Error(`${label}を読み込めません（HTTP ${response.status}）`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new Error(
      `${label}を読み込めません: ${error instanceof Error ? error.message : "invalid bytes"}`,
    );
  }
  if (bytes.byteLength === 0) {
    throw new Error(`${label}が空です`);
  }
  if (maximumBytes !== undefined && bytes.byteLength > maximumBytes) {
    throw new Error(`${label}が大きすぎます（${maximumBytes} bytes 以下）`);
  }
  return bytes;
};

const loadDictionary = (config: BrowserVibratoConfig): Promise<Uint8Array> => {
  const dictionaryUrl = config.dictionaryUrl?.trim() || DEFAULT_BROWSER_WASM_DICTIONARY_URL;
  return fetchBytes(dictionaryUrl, "Vibrato辞書", MAX_DICTIONARY_BYTES);
};

const deriveWasmBinaryUrl = (moduleUrl: string): string | undefined => {
  const derived = moduleUrl.replace(/\.js([?#].*)?$/iu, "_bg.wasm$1");
  return derived === moduleUrl || /^data:/iu.test(moduleUrl) ? undefined : derived;
};

const initializeGeneratedModule = async (
  module: GeneratedVibratoModule,
  config: BrowserVibratoConfig,
  moduleUrl: string,
): Promise<void> => {
  // wasm-bindgen's web target emits a default async initializer that resolves
  // the sibling *_bg.wasm asset relative to the imported JS module.
  if (typeof module.default === "function") {
    await module.default();
    return;
  }
  if (typeof module.initSync !== "function") {
    // An injected global may already have initialized its generated module.
    return;
  }
  const binaryUrl = config.wasmBinaryUrl?.trim() || deriveWasmBinaryUrl(moduleUrl);
  if (!binaryUrl) {
    throw new Error("Vibrato WASM の initSync 用バイナリ URL が未設定です");
  }
  const binary = await fetchBytes(binaryUrl, "Vibrato WASM");
  module.initSync(binary);
};

const katakanaToHiragana = (input: string): string =>
  [...input]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x30a1 && code <= 0x30f6
        ? String.fromCodePoint(code - (0x30a1 - 0x3041))
        : character;
    })
    .join("");

const readingFromTokens = (value: unknown, index: number): string => {
  if (!Array.isArray(value)) {
    throw new Error("Vibrato tokenize の結果が配列ではありません");
  }
  return value
    .map((token, tokenIndex) => {
      if (
        !isRecord(token) ||
        typeof token.surface !== "string" ||
        typeof token.feature !== "string"
      ) {
        throw new Error(`Vibrato token ${tokenIndex} の形式が不正です`);
      }
      const reading = token.feature.split(",")[index];
      return reading && reading !== "*" ? katakanaToHiragana(reading) : token.surface;
    })
    .join("");
};

const generatedConverter = async (
  value: unknown,
  config: BrowserVibratoConfig,
  moduleUrl: string,
): Promise<VibratoConvertFunction | null> => {
  if (!isRecord(value)) {
    return null;
  }
  const module = value as GeneratedVibratoModule;
  const Tokenizer = module.VibratoTokenizer;
  if (typeof Tokenizer !== "function") {
    return null;
  }
  const index = featureIndex(config.featureIndex);
  const dictionary = await loadDictionary(config);
  await initializeGeneratedModule(module, config, moduleUrl);
  const tokenizer = new Tokenizer(dictionary);
  return (text: string): unknown => {
    if (typeof tokenizer.toHiragana === "function") {
      return tokenizer.toHiragana(text, index);
    }
    if (typeof tokenizer.tokenize === "function") {
      return readingFromTokens(tokenizer.tokenize(text), index);
    }
    tokenizer.free?.();
    throw new Error("VibratoTokenizer に toHiragana/tokenize がありません");
  };
};

const cacheKey = (config: BrowserVibratoConfig, moduleUrl: string): string =>
  [
    moduleUrl,
    config.dictionaryUrl?.trim() || DEFAULT_BROWSER_WASM_DICTIONARY_URL,
    String(featureIndex(config.featureIndex)),
    config.wasmBinaryUrl?.trim() ?? "",
  ].join("\u0000");

const loadConverter = async (config: BrowserVibratoConfig): Promise<VibratoConvertFunction> => {
  const globalName = config.globalName?.trim() || DEFAULT_BROWSER_WASM_GLOBAL_NAME;
  const root = globalThis as unknown as UnknownRecord;
  // Only an injected global counts. Reading through the prototype chain would
  // let an inherited name such as `toString` pose as a converter.
  const globalValue = Object.hasOwn(root, globalName) ? root[globalName] : undefined;
  if (globalValue !== undefined) {
    const generated = await generatedConverter(globalValue, config, "");
    if (generated) {
      return generated;
    }
    const globalConverter = asConverter(globalValue);
    if (globalConverter) {
      return globalConverter;
    }
  }

  const moduleUrl = config.moduleUrl.trim();
  if (!moduleUrl) {
    throw new Error(
      `ブラウザVibrato WASMが未設定です。${globalName} または WASMモジュールURLを設定してください`,
    );
  }
  rejectUnsafeUrl(moduleUrl, "ブラウザWASMモジュール");
  const key = cacheKey(config, moduleUrl);
  const cached = loadedConverters.get(key);
  if (cached) {
    return cached;
  }

  const loading = import(/* webpackIgnore: true */ moduleUrl)
    .then(async (module: unknown) => {
      const generated = await generatedConverter(module, config, moduleUrl);
      if (generated) {
        return generated;
      }
      const converter = asConverter(module);
      if (!converter) {
        throw new Error("WASMモジュールに convert/transform/tokenize 関数がありません");
      }
      return converter;
    })
    .catch((error: unknown) => {
      loadedConverters.delete(key);
      throw error instanceof Error ? error : new Error("ブラウザWASMを読み込めません");
    });
  loadedConverters.set(key, loading);
  return loading;
};

export const runBrowserVibrato = async (
  text: string,
  config: BrowserVibratoConfig,
): Promise<BrowserVibratoResult> => {
  const input = text.trim();
  if (!input) {
    throw new Error("変換するテキストがありません");
  }
  const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
  // Match Tauri: pure kana is already the reading AzooKey expects. Tokenizing
  // it through IPADIC rewrites particles (`は`→`わ`) and hurts conversion.
  if (!containsKanji(input)) {
    const endedAt = typeof performance === "undefined" ? Date.now() : performance.now();
    return { text: input, elapsedMs: Math.max(MIN_ELAPSED_MS, endedAt - startedAt) };
  }
  const converter = await loadConverter(config);
  const value = await converter(input);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("ブラウザVibrato WASMの変換結果が文字列ではありません");
  }
  const endedAt = typeof performance === "undefined" ? Date.now() : performance.now();
  return { text: value, elapsedMs: Math.max(MIN_ELAPSED_MS, endedAt - startedAt) };
};
