/**
 * Normalize ASR `sourceText` for Japanese conversion (Vibrato / AzooKey).
 *
 * Web Speech and Cloudflare Workers AI ASR often insert half-width or
 * full-width spaces between Japanese tokens. Those spaces must be removed
 * before kana-kanji conversion; Latin word spaces are preserved.
 */

/** Hiragana, katakana, kanji, iteration/prolonged marks, and common JP punct. */
const JA_ATOM =
  "(?:\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Han}|[々〆ヵヶー、。．，！？!?「」『』（）・…〜～])";

/** Spaces ASR may place between Japanese tokens (after full-width → half-width unify). */
const JA_TOKEN_GAP = new RegExp(`(?<=${JA_ATOM})[ \\t]+(?=${JA_ATOM})`, "gu");

/**
 * Strip leading/trailing whitespace and Japanese inter-token spaces.
 * Ideographic space / NBSP are treated like half-width spaces.
 */
export const normalizeAsrSourceText = (rawSource: string): string => {
  const unified = rawSource.replace(/[\u00A0\u3000]/gu, " ");
  const withoutJaGaps = unified.replace(JA_TOKEN_GAP, "");
  return withoutJaGaps.replace(/[ \t]+/gu, " ").trim();
};
