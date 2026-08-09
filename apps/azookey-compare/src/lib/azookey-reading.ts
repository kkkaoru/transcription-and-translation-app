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
