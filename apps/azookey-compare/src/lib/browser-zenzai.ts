/**
 * Browser Zenzai dictionary path (LOUDS only, no GGUF inference).
 *
 * Serves the official portable AzooKey dictionary (`system.azkdict.gz`) from
 * same-origin static assets (`public/azookey/`). Neural Zenzai GGUF in the
 * browser is deferred; Cloudflare Worker 依存モード still uses llama-server.
 */

import {
  DEFAULT_BROWSER_AZOOKEY_DICTIONARY_URL,
  runBrowserAzookey,
  warmupBrowserAzookey,
  type BrowserAzookeyOptions,
  type BrowserAzookeyResult,
} from "./browser-azookey";
import type { ConverterModel } from "./converter-models";
import { isZenzConverterModel } from "./converter-models";

export const BROWSER_ZENZAI_DICT_EXECUTION = "browser-dict" as const;

export type BrowserZenzaiDictExecution = typeof BROWSER_ZENZAI_DICT_EXECUTION;

/** User-visible label: dictionary conversion, not neural GGUF. */
export const BROWSER_ZENZAI_DICT_LABEL = "Zenzai 辞書（LOUDS / system.azkdict.gz）";

export const BROWSER_ZENZAI_DICT_NOTICE =
  "ブラウザ完結では Zenzai 辞書（LOUDS）のみ利用します。GGUF ニューラル推論は Cloudflare Worker 依存モードで選択してください。";

export const BROWSER_ZENZAI_DICT_MISSING_MESSAGE =
  "Zenzai 辞書が見つかりません。build 前に copy:azookey-assets で public/azookey/system.azkdict.gz を配置してください。";

export interface BrowserZenzaiDictOptions extends BrowserAzookeyOptions {
  model: ConverterModel;
}

export interface BrowserZenzaiDictResult extends BrowserAzookeyResult {
  execution: BrowserZenzaiDictExecution;
  model: ConverterModel;
  dictionaryUrl: string;
  label: typeof BROWSER_ZENZAI_DICT_LABEL;
}

export const browserZenzaiDictionaryUrl = (): string => DEFAULT_BROWSER_AZOOKEY_DICTIONARY_URL;

export const isBrowserZenzaiDictModel = (model: ConverterModel): boolean =>
  isZenzConverterModel(model);

export const assertBrowserZenzaiDictModel = (model: ConverterModel): void => {
  if (!isBrowserZenzaiDictModel(model)) {
    throw new Error("browser Zenzai dictionary path requires a Zenzai model id");
  }
};

export const runBrowserZenzaiDict = async (
  text: string,
  options: BrowserZenzaiDictOptions,
): Promise<BrowserZenzaiDictResult> => {
  assertBrowserZenzaiDictModel(options.model);
  const dictionaryUrl = options.dictionaryUrl?.trim() || browserZenzaiDictionaryUrl();
  const result = await runBrowserAzookey(text, { ...options, dictionaryUrl });
  return {
    ...result,
    execution: BROWSER_ZENZAI_DICT_EXECUTION,
    model: options.model,
    dictionaryUrl,
    label: BROWSER_ZENZAI_DICT_LABEL,
  };
};

export const warmupBrowserZenzaiDict = async (options: BrowserZenzaiDictOptions): Promise<void> => {
  assertBrowserZenzaiDictModel(options.model);
  await warmupBrowserAzookey({
    ...options,
    dictionaryUrl: options.dictionaryUrl?.trim() || browserZenzaiDictionaryUrl(),
  });
};

export { resetBrowserAzookeyCache as resetBrowserZenzaiDictCache } from "./browser-azookey";
