/**
 * Comparison-app helpers around the shared AzooKey reading gate.
 *
 * `containsKanji` / `readingForAzookey` live in `@caption-bridge/azookey-reading`
 * so Worker and browser match Tauri.
 */

import { containsKanji } from "@caption-bridge/azookey-reading";
import type { ComparisonMode } from "./contract";

export { containsKanji, readingForAzookey } from "@caption-bridge/azookey-reading";

/**
 * Whether the comparison UI should run browser Vibrato before Worker AzooKey.
 *
 * Phonetic fixtures already supply a reading. Browser mode always enters the
 * pre-pass (pure kana no-ops inside the tokenizer). Worker mode only needs it
 * for kanji-bearing Web Speech, matching Tauri when Worker Vibrato is passthrough.
 */
export const shouldRunBrowserVibratoPrePass = (
  mode: ComparisonMode,
  sourceText: string,
  phoneticInput?: string,
): boolean => {
  if (phoneticInput?.trim()) {
    return false;
  }
  return mode === "browser-vibrato" || containsKanji(sourceText);
};

/**
 * Warm browser IPADIC at Tauri capture-start equivalent moments.
 *
 * Browser mode always needs the dictionary. Worker mode still needs it when
 * Worker Vibrato is passthrough/unconfigured, because kanji Web Speech falls
 * back to the browser tokenizer.
 */
export const shouldWarmBrowserVibratoDictionary = (
  mode: ComparisonMode,
  workerVibratoConfigured?: boolean,
): boolean => mode === "browser-vibrato" || workerVibratoConfigured !== true;
