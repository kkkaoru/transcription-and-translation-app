/**
 * Optional browser-side convert/transform/tokenize pre-pass for the comparison app.
 *
 * This is not Vibrato and does not load UniDic. A WASM build normally ships
 * with a small JavaScript glue module (wasm-bindgen, wasm-pack, or an
 * equivalent wrapper). Point `moduleUrl` at that glue module, or expose the
 * same object as `globalThis.__AZOOKEY_VIBRATO_WASM__`. The module must export a
 * `convert(text)`, `transform(text)`, or `tokenize(text)` function (or expose
 * one as its default export) returning a string (sync or async). Without a
 * module URL or injected global, the pre-pass fails instead of silently falling
 * back to Worker-only conversion.
 */

import { DEFAULT_BROWSER_WASM_GLOBAL_NAME } from "./contract";

export interface BrowserVibratoConfig {
  moduleUrl: string;
  globalName?: string;
}

export interface BrowserVibratoResult {
  text: string;
  elapsedMs: number;
}

type VibratoConvertFunction = (text: string) => unknown;

interface UnknownRecord {
  [key: string]: unknown;
}

const loadedConverters = new Map<string, Promise<VibratoConvertFunction>>();
const MIN_ELAPSED_MS = 0;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

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

const loadConverter = (config: BrowserVibratoConfig): Promise<VibratoConvertFunction> => {
  const globalName = config.globalName?.trim() || DEFAULT_BROWSER_WASM_GLOBAL_NAME;
  const root = globalThis as unknown as UnknownRecord;
  const globalConverter = asConverter(root[globalName]);
  if (globalConverter) {
    return Promise.resolve(globalConverter);
  }

  const moduleUrl = config.moduleUrl.trim();
  if (!moduleUrl) {
    throw new Error(
      `ブラウザWASMが未設定です。${globalName} または WASMモジュールURLを設定してください`,
    );
  }
  if (/^javascript:/iu.test(moduleUrl)) {
    throw new Error("ブラウザWASMモジュールに javascript: URL は指定できません");
  }
  const cached = loadedConverters.get(moduleUrl);
  if (cached) {
    return cached;
  }

  const loading = import(/* webpackIgnore: true */ moduleUrl)
    .then((module: unknown) => {
      const converter = asConverter(module);
      if (!converter) {
        throw new Error("WASMモジュールに convert/transform/tokenize 関数がありません");
      }
      return converter;
    })
    .catch((error: unknown) => {
      loadedConverters.delete(moduleUrl);
      throw error instanceof Error ? error : new Error("ブラウザWASMを読み込めません");
    });
  loadedConverters.set(moduleUrl, loading);
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
  const converter = await loadConverter(config);
  const value = await converter(input);
  if (typeof value !== "string") {
    throw new Error("ブラウザWASMの変換結果が文字列ではありません");
  }
  const endedAt = typeof performance === "undefined" ? Date.now() : performance.now();
  return { text: value, elapsedMs: Math.max(MIN_ELAPSED_MS, endedAt - startedAt) };
};
