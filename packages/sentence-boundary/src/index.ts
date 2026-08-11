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
  /**
   * Retained for callers. Finished-clause paging is always active; this flag
   * no longer suppresses です/ます pages when a new clause follows.
   */
  deferSentencePaging?: boolean;
}

const SOFT_PARTICLE_SUFFIX =
  /(?:から|まで|より|など|って|では|には|とは|のは|けど|けれど|けれども|ので|が|を|に|へ|で|と|も|の|や|か|は|ね|よ|な|て|、|，|,)$/u;

/**
 * After a soft で, remainder may still be the copula です/でした/…. Breaking
 * there produced 「字幕で」+「す。」on the preview plate.
 */
const COPULA_AFTER_DE = /^(?:す|した|して|しょう)/u;

/** Greetings whose interior に/は must not become soft wrap points. */
const FIXED_GREETINGS = [
  "こんにちは",
  "こんばんは",
  "おはようございます",
  "おはよう",
  "さようなら",
] as const;

/**
 * True when a soft break would split inside/after a fixed greeting while more
 * speech follows — that left only 「こんにちは」 on the first plate row.
 */
const shouldIgnoreSoftBreakInGreeting = (prefix: string, remainder: string): boolean => {
  const next = remainder.trimStart();
  if (!next) {
    return false;
  }
  const trimmed = prefix.trimEnd().replace(/[ー〜～]+$/u, "");
  return FIXED_GREETINGS.some(
    (greeting) => greeting.startsWith(trimmed) || trimmed === greeting,
  );
};

/**
 * Heuristic soft wrap offsets when Vibrato POS offsets are not yet present.
 * Matches `heuristic_soft_break_offsets` in caption-bridge-vibrato-core.
 */
export const detectCaptionSoftBreaks = (
  text: string,
  hints: CaptionSentenceHints = {},
): number[] => {
  const chars = codePoints(text);
  const allowSoftBreak = (offset: number): boolean => {
    if (!Number.isFinite(offset) || offset <= 0 || offset > chars.length) {
      return false;
    }
    const prefix = chars.slice(0, offset).join("");
    const remainder = chars.slice(offset).join("");
    return !shouldIgnoreSoftBreakInGreeting(prefix, remainder);
  };
  const rawSupplied = hints.softBreakOffsets;
  if (rawSupplied != null && rawSupplied.length > 0) {
    // Respect an explicit Vibrato list even when greeting filters clear it —
    // do not reintroduce heuristic particle wraps inside こんにちは….
    return [...new Set(rawSupplied.filter(allowSoftBreak))].sort((left, right) => left - right);
  }
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
      // Keep です/でした/でしょう intact — soft で is not a wrap point there.
      if (trimmed.endsWith("で") && COPULA_AFTER_DE.test(next)) {
        continue;
      }
      if (shouldIgnoreSoftBreakInGreeting(prefix, remainder)) {
        continue;
      }
      ends.push(index);
    }
  }
  const sentenceEnds = detectCaptionSentenceEnds(text, hints);
  return [...new Set([...ends, ...sentenceEnds].filter(allowSoftBreak))].sort(
    (left, right) => left - right,
  );
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

/**
 * After a copula/punctuation end, page whenever the next span is a new clause
 * rather than a grammatical continuation. Restricting to a small "strong head"
 * list (今日/じゃあ…) left finished clauses on the plate through long speech,
 * so the newest ending phrase (e.g. 「質問をお受けしますね」) never owned the
 * visible window until the whole utterance finished.
 */
const japaneseCopulaAllowsRemainder = (prefix: string, remainder: string): boolean => {
  const next = remainder.trimStart();
  if (!next) {
    return true;
  }
  const last = prefix.trimEnd().at(-1);
  if (last !== undefined && SENTENCE_PUNCT.test(last)) {
    return true;
  }
  // Clause continuations (が/ので/て/よ…) are rejected earlier; any other
  // remainder is treated as a new caption page so mid-speech POS paging can
  // show the current clause before the speaker finishes.
  return !startsClauseContinuation(remainder, false);
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

const ELONGATION_MARK = /^[ー〜～]/u;
/** Fixed greetings that must not page away from a same-turn continuation. */
const FIXED_GREETING_END =
  /(?:こんにちは|こんばんは|おはようございます|おはよう|さようなら)$/u;

/** True when a sentence end would split immediately before a prolonged sound. */
const remainderStartsWithElongation = (remainder: string): boolean =>
  ELONGATION_MARK.test(remainder.trimStart());

const shouldIgnoreSentenceEndBeforeContinuation = (
  prefix: string,
  remainder: string,
  english: boolean,
): boolean => {
  if (english) {
    return false;
  }
  const next = remainder.trimStart();
  if (!next) {
    return false;
  }
  if (remainderStartsWithElongation(next)) {
    return true;
  }
  // 「こんにちはきこえますか」— Vibrato may mark は as a sentence end; keep the
  // greeting with the continuation so the first recognized words stay visible.
  const trimmedPrefix = prefix.trimEnd();
  if (FIXED_GREETING_END.test(trimmedPrefix)) {
    return true;
  }
  // Bare topic/binding は・も mid-utterance (明日の天気は晴れ…) must not page;
  // those offsets hide the already-recognized head on the plate.
  if (/[はも]$/u.test(trimmedPrefix) && !isJapaneseSentenceEnd(trimmedPrefix)) {
    return true;
  }
  return false;
};

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
    // 「こんにちはーきこえますか」— do not page after は when ー continues the
    // same spoken phrase; that left only the greeting on the plate.
    if (shouldIgnoreSentenceEndBeforeContinuation(prefix, remainder, english)) {
      continue;
    }
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
  const chars = codePoints(text);
  const supplied = (hints.sentenceEndOffsets ?? []).filter((offset) => {
    if (!Number.isFinite(offset) || offset <= 0 || offset > chars.length) {
      return false;
    }
    const prefix = chars.slice(0, offset).join("");
    const remainder = chars.slice(offset).join("");
    // Drop pipeline offsets that would strip a fixed greeting or split before
    // ー/〜 so the first recognized span stays on the plate with its continuation.
    if (shouldIgnoreSentenceEndBeforeContinuation(prefix, remainder, english)) {
      return false;
    }
    return true;
  });
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

const sliceNewestSentence = (normalized: string, ends: number[]): string => {
  const chars = codePoints(normalized);
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

/** Newest complete sentence, or the in-progress sentence after the last end. */
export const selectVisibleCaptionSentence = (
  text: string,
  hints: CaptionSentenceHints = {},
): string => {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) {
    return "";
  }
  // Always page finished clauses (punctuation, Vibrato/IPADIC offsets, and
  // copula/ます ends when the next span is not a grammatical continuation).
  // Soft mid-clause continuations (が/ので/て/よ…) stay open. `deferSentencePaging`
  // is retained for callers but does not suppress finished-clause paging — long
  // speech must advance the plate before the speaker finishes.
  void hints.deferSentencePaging;
  return sliceNewestSentence(normalized, detectCaptionSentenceEnds(normalized, hints));
};
