/**
 * Sentence-end detection for live caption paging.
 *
 * Tauri `caption-bridge-vibrato-core` is the source of truth for IPADIC POS
 * combinations. This heuristic matches that crate's copula/punctuation fallback
 * so overlay / browser / Worker can page when WASM offsets are not yet present.
 */

const SENTENCE_PUNCT = /[。．！？!?]/u;
const COPULA_END =
  /(?:ませんでした|でした|ました|ません|でしょう|だろう|だった|である|です|ます)(?:[よねなわぞさか])?[。．！？!?]?\s*$/u;
const PAST_WITH_PARTICLE = /(?:だ|た|ない)[よねなわぞさか][。．！？!?]?\s*$/u;
const CLAUSE_CONTINUATION =
  /^(?:が|を|に|へ|で|と|も|の|や|て|けど|けれど|けれども|から|ので|し|ば|たり|つつ|ながら|よ|ね|な|わ|ぞ|さ|か|、|，|,)/u;
const ENGLISH_SENTENCE_END = /[.!?]["')\]]?\s*$/u;
const ENGLISH_CONTINUATION = /^(?:[a-z]|[,;:])/u;

export type CaptionSentenceKey = "source" | "translation";

export interface CaptionSentenceHints {
  key?: CaptionSentenceKey;
  azookeyInputText?: string | null;
  /** Unicode scalar offsets (exclusive) from Vibrato/IPADIC when the pipeline supplies them. */
  sentenceEndOffsets?: number[];
  /** Mid-sentence POS wrap points for line breaks before maxChars. */
  softBreakOffsets?: number[];
}

const SOFT_PARTICLE_SUFFIX =
  /(?:から|まで|より|など|って|では|には|とは|のは|けど|けれど|けれども|ので|が|を|に|へ|で|と|も|の|や|か|は|ね|よ|な|て|、|，|,)$/u;

/**
 * Heuristic soft wrap offsets when Vibrato POS offsets are not yet present.
 * Matches `heuristic_soft_break_offsets` in caption-bridge-vibrato-core.
 */
export const detectCaptionSoftBreaks = (
  text: string,
  hints: CaptionSentenceHints = {},
): number[] => {
  const supplied = (hints.softBreakOffsets ?? []).filter(
    (offset) => Number.isFinite(offset) && offset > 0 && offset <= codePoints(text).length,
  );
  if (supplied.length > 0) {
    return [...new Set(supplied)].sort((left, right) => left - right);
  }
  const chars = codePoints(text);
  if (chars.length === 0) {
    return [];
  }
  const ends: number[] = [];
  for (let index = 1; index <= chars.length; index += 1) {
    const prefix = chars.slice(0, index).join("");
    const trimmed = prefix.trimEnd();
    if (!trimmed) {
      continue;
    }
    const last = trimmed.at(-1);
    if (last !== undefined && (SENTENCE_PUNCT.test(last) || last === "、")) {
      ends.push(index);
      continue;
    }
    if (!SOFT_PARTICLE_SUFFIX.test(trimmed)) {
      continue;
    }
    const remainder = chars.slice(index).join("");
    const next = remainder.trimStart();
    const first = next[0];
    if (
      next &&
      first !== undefined &&
      !SENTENCE_PUNCT.test(first) &&
      !/\p{M}/u.test(first)
    ) {
      ends.push(index);
    }
  }
  const sentenceEnds = detectCaptionSentenceEnds(text, hints);
  return [...new Set([...ends, ...sentenceEnds])].sort((left, right) => left - right);
};

const codePoints = (text: string): string[] => Array.from(text);

const startsTaraContinuation = (prefix: string, remainder: string): boolean => {
  const next = remainder.trimStart();
  if (!next.startsWith("ら")) {
    return false;
  }
  const base = prefix.trimEnd();
  return base.endsWith("か") || base.endsWith("た") || base.endsWith("です");
};

const STRONG_UTTERANCE_HEAD =
  /^(?:今日|明日|昨日|あした|あす|きょう|きのう|いま|今|あとで|あと|今度|次回|じゃあ|でも|そして|それで|だから)/u;

const japaneseCopulaAllowsRemainder = (prefix: string, remainder: string): boolean => {
  const next = remainder.trimStart();
  if (!next) {
    return true;
  }
  const last = prefix.trimEnd().at(-1);
  if (last !== undefined && SENTENCE_PUNCT.test(last)) {
    return true;
  }
  return STRONG_UTTERANCE_HEAD.test(next);
};

const startsClauseContinuation = (remainder: string, english: boolean): boolean => {
  const next = remainder.trimStart();
  if (!next) {
    return false;
  }
  const first = next[0];
  if (first !== undefined && (/\p{M}/u.test(first) || SENTENCE_PUNCT.test(first))) {
    return true;
  }
  return english ? ENGLISH_CONTINUATION.test(next) : CLAUSE_CONTINUATION.test(next);
};

const isJapaneseSentenceEnd = (prefix: string): boolean => {
  const trimmed = prefix.trimEnd();
  if (!trimmed) {
    return false;
  }
  const last = trimmed.at(-1);
  if (last !== undefined && SENTENCE_PUNCT.test(last)) {
    return true;
  }
  return COPULA_END.test(trimmed) || PAST_WITH_PARTICLE.test(trimmed);
};

const isEnglishSentenceEnd = (prefix: string): boolean =>
  ENGLISH_SENTENCE_END.test(prefix.trimEnd());

const detectHeuristicEnds = (text: string, english: boolean): number[] => {
  const chars = codePoints(text);
  if (chars.length === 0) {
    return [];
  }
  const ends: number[] = [];
  for (let index = 1; index <= chars.length; index += 1) {
    const prefix = chars.slice(0, index).join("");
    const isEnd = english ? isEnglishSentenceEnd(prefix) : isJapaneseSentenceEnd(prefix);
    if (!isEnd) {
      continue;
    }
    const remainder = chars.slice(index).join("");
    if (startsClauseContinuation(remainder, english)) {
      continue;
    }
    if (!english && startsTaraContinuation(prefix, remainder)) {
      continue;
    }
    if (!english && !japaneseCopulaAllowsRemainder(prefix, remainder)) {
      continue;
    }
    ends.push(index);
  }
  return ends;
};

/**
 * Exclusive Unicode-scalar offsets where a caption sentence completes.
 *
 * Prefers Vibrato offsets from the native pipeline. Falls back to AzooKey
 * copula/particle endings on the display surface and, for Japanese, the
 * phonetic `azookeyInputText` when the surface has no detectable end yet.
 */
export const detectCaptionSentenceEnds = (
  text: string,
  hints: CaptionSentenceHints = {},
): number[] => {
  const english = hints.key === "translation";
  const supplied = (hints.sentenceEndOffsets ?? []).filter(
    (offset) => Number.isFinite(offset) && offset > 0 && offset <= codePoints(text).length,
  );
  if (supplied.length > 0) {
    return [...new Set(supplied)].sort((left, right) => left - right);
  }
  const surfaceEnds = detectHeuristicEnds(text, english);
  if (surfaceEnds.length > 0 || english) {
    return surfaceEnds;
  }
  const reading = hints.azookeyInputText?.trim() ?? "";
  // Provisional ASR paints the AzooKey reading itself. Do not apply reading
  // offsets onto a different kanji surface — those indices would not line up.
  if (reading && reading === text) {
    return detectHeuristicEnds(reading, false);
  }
  return surfaceEnds;
};

/** Newest complete sentence, or the in-progress sentence after the last end. */
export const selectVisibleCaptionSentence = (
  text: string,
  hints: CaptionSentenceHints = {},
): string => {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) {
    return "";
  }
  const chars = codePoints(normalized);
  const ends = detectCaptionSentenceEnds(normalized, hints);
  if (ends.length === 0) {
    return normalized;
  }
  const lastEnd = ends[ends.length - 1] as number;
  if (lastEnd >= chars.length) {
    const previousEnd = ends.length >= 2 ? (ends[ends.length - 2] as number) : 0;
    return chars.slice(previousEnd, lastEnd).join("").trim();
  }
  return chars.slice(lastEnd).join("").trim() || normalized;
};
