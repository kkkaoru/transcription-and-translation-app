/**
 * Desktop-equivalent AzooKey reading pre-pass.
 *
 * Tauri only runs Vibrato IPADIC when the ASR surface still contains kanji.
 * Pure kana must pass through unchanged: tokenizing hiragana rewrites particles
 * such as `は` → `わ` and `へ` → `え`, which then poisons kana-kanji conversion.
 */

import type { ComparisonMode } from "./contract";

const CJK_EXTENSION_A_START = 0x3400;
const CJK_EXTENSION_A_END = 0x4dbf;
const CJK_UNIFIED_START = 0x4e00;
const CJK_UNIFIED_END = 0x9fff;
const CJK_COMPATIBILITY_START = 0xf900;
const CJK_COMPATIBILITY_END = 0xfaff;

export const containsKanji = (text: string): boolean => {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code >= CJK_EXTENSION_A_START && code <= CJK_EXTENSION_A_END) ||
      (code >= CJK_UNIFIED_START && code <= CJK_UNIFIED_END) ||
      (code >= CJK_COMPATIBILITY_START && code <= CJK_COMPATIBILITY_END)
    ) {
      return true;
    }
  }
  return false;
};

export const readingForAzookey = (text: string, toHiragana: (input: string) => string): string =>
  containsKanji(text) ? toHiragana(text) : text;

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
