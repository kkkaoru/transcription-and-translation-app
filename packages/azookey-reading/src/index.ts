/**
 * This file runs with bun.
 *
 * Desktop-equivalent AzooKey reading pre-pass.
 *
 * Tauri only runs Vibrato IPADIC when the ASR surface still contains kanji.
 * Pure kana must pass through unchanged: tokenizing hiragana rewrites particles
 * such as `は` → `わ` and `へ` → `え`, which then poisons kana-kanji conversion.
 *
 * Japanese ASR (Web Speech / Nova-3) also inserts token-gap spaces. Those
 * spaces must be stripped before Vibrato / AzooKey; Latin word spaces stay.
 */

/** Hiragana, katakana, kanji, iteration/prolonged marks, and common JP punct. */
const JA_ATOM: string =
  "(?:\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Han}|[々〆ヵヶー、。．，！？!?「」『』（）・…〜～])";

/** Spaces ASR may place between Japanese tokens (after full-width → half-width unify). */
const JA_TOKEN_GAP: RegExp = new RegExp(`(?<=${JA_ATOM})[ \\t]+(?=${JA_ATOM})`, "gu");

const CJK_EXTENSION_A_START = 0x3400;
const CJK_EXTENSION_A_END = 0x4dbf;
const CJK_UNIFIED_START = 0x4e00;
const CJK_UNIFIED_END = 0x9fff;
const CJK_COMPATIBILITY_START = 0xf900;
const CJK_COMPATIBILITY_END = 0xfaff;

export const isKanji = (character: string): boolean => {
  const code = character.codePointAt(0);
  if (code === undefined) {
    return false;
  }
  return (
    (code >= CJK_EXTENSION_A_START && code <= CJK_EXTENSION_A_END) ||
    (code >= CJK_UNIFIED_START && code <= CJK_UNIFIED_END) ||
    (code >= CJK_COMPATIBILITY_START && code <= CJK_COMPATIBILITY_END)
  );
};

export const containsKanji = (text: string): boolean => {
  for (const character of text) {
    if (isKanji(character)) {
      return true;
    }
  }
  return false;
};

export const readingForAzookey = (text: string, toHiragana: (input: string) => string): string =>
  containsKanji(text) ? toHiragana(text) : text;

export const readingForAzookeyAsync = async (
  text: string,
  toHiragana: (input: string) => Promise<string>,
): Promise<string> => (containsKanji(text) ? toHiragana(text) : text);

/**
 * Strip leading/trailing whitespace and Japanese inter-token spaces.
 * Ideographic space / NBSP are treated like half-width spaces.
 */
export const normalizeAsrSourceText = (rawSource: string): string => {
  const unified = rawSource.replace(/[\u00A0\u3000]/gu, " ");
  const withoutJaGaps = unified.replace(JA_TOKEN_GAP, "");
  return withoutJaGaps.replace(/[ \t]+/gu, " ").trim();
};

/**
 * Same order as Tauri after Parapper: strip Japanese token-gap spaces, then
 * extract a Vibrato reading only when the surface still contains kanji.
 */
export const readingForAzookeyFromAsr = (
  rawSource: string,
  toHiragana: (input: string) => string,
): string => readingForAzookey(normalizeAsrSourceText(rawSource), toHiragana);

export const readingForAzookeyFromAsrAsync = async (
  rawSource: string,
  toHiragana: (input: string) => Promise<string>,
): Promise<string> => readingForAzookeyAsync(normalizeAsrSourceText(rawSource), toHiragana);
