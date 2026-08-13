/**
 * Sentence-end detection for live caption paging.
 *
 * Tauri `caption-bridge-vibrato-core` is the source of truth for IPADIC POS
 * combinations. This heuristic matches that crate's copula/punctuation fallback
 * so overlay / browser / Worker can page when WASM offsets are not yet present.
 */

const SENTENCE_PUNCT = /[。．！？!?]/u;
const COPULA_END =
  /(?:ませんでした|でした|ました|ません|でしょう|だろう|だった|である|です)(?:[よねなわぞさか])?[。．！？!?]?\s*$/u;
/** Polite non-past auxiliary ます (しています / できます / ございます…). Not a completed copula. */
const POLITE_MASU_AUXILIARY = /ます(?:[よねなわぞさか])?$/u;
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
   * Skip heuristic copula paging so a first hypothesis like
   * 「です＋次節」 keeps the lead sentence. Explicit punctuation still pages.
   * Supplied Vibrato copula offsets follow the same remainder-dominance rule.
   * Polite ます stems are never sentence ends.
   */
  deferSentencePaging?: boolean;
  /** Previous utterance text for sticky sentence-end carryover (normalized). */
  previousText?: string | null;
  /** Previous utterance sentence ends for sticky carryover. */
  previousEnds?: number[] | null;
}

const SOFT_PARTICLE_SUFFIX =
  /(?:から|まで|より|など|って|では|には|とは|のは|けど|けれど|けれども|ので|が|を|に|へ|で|と|も|の|や|か|は|ね|よ|な|て|、|，|,)$/u;

/**
 * After a soft で, remainder may still be the copula です/でした/…. Breaking
 * there produced 「字幕で」+「す。」on the preview plate.
 */
const COPULA_AFTER_DE = /^(?:す|した|して|しょう)/u;

/**
 * Particle wraps before this many scalars isolate a short head on its own row
 * while the same-turn continuation is still arriving. Structural, not a
 * greeting/lexeme table: unknown short leads stay glued to what follows.
 */
const MIN_SOFT_WRAP_PREFIX = 8;

/**
 * True when a soft break would leave only a short already-recognized head on
 * the first wrap row. Applies to greetings and any other short prefix.
 */
const shouldIgnoreShortPrefixSoftBreak = (prefix: string, remainder: string): boolean => {
  const next = remainder.trimStart();
  if (!next) {
    return false;
  }
  const trimmed = prefix.trimEnd().replace(/[ー〜～]+$/u, "");
  const last = trimmed.at(-1);
  // Punctuation wraps stay valid even on a short head; particle wraps do not.
  if (
    last !== undefined &&
    (SENTENCE_PUNCT.test(last) || last === "、" || last === "，" || last === ",")
  ) {
    return false;
  }
  return codePoints(trimmed).length < MIN_SOFT_WRAP_PREFIX;
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
    return !shouldIgnoreShortPrefixSoftBreak(prefix, remainder);
  };
  const rawSupplied = hints.softBreakOffsets;
  if (rawSupplied != null && rawSupplied.length > 0) {
    // Drop particle wraps that would isolate a short head, including stale
    // Vibrato offsets inside an still-open lead clause.
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
      if (shouldIgnoreShortPrefixSoftBreak(prefix, remainder)) {
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

const prefixEndsWithPunct = (prefix: string): boolean => {
  const last = prefix.trimEnd().at(-1);
  return last !== undefined && SENTENCE_PUNCT.test(last);
};

const endsWithPoliteMasuAuxiliary = (prefix: string): boolean =>
  POLITE_MASU_AUXILIARY.test(prefix.trimEnd());

/**
 * Copula paging may replace the lead only when the next span is at least twice
 * as long — two-thirds of the utterance. Mid-vs-mid splits (8 vs 12) and ます
 * stems with a merely-longer tail are ambiguous, so the full longer surface
 * stays. Punctuation still pages.
 */
const remainderDominatesPrefix = (prefix: string, remainder: string): boolean =>
  codePoints(remainder.trimStart()).length >= 2 * codePoints(prefix.trimEnd()).length;

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

const isJapaneseSentenceEnd = (prefix: string, allowCopula = true): boolean => {
  const trimmed = prefix.trimEnd();
  if (!trimmed) {
    return false;
  }
  const last = trimmed.at(-1);
  if (last !== undefined && SENTENCE_PUNCT.test(last)) {
    return true;
  }
  if (!allowCopula) {
    return false;
  }
  return COPULA_END.test(trimmed) || PAST_WITH_PARTICLE.test(trimmed);
};

const isEnglishSentenceEnd = (prefix: string): boolean =>
  ENGLISH_SENTENCE_END.test(prefix.trimEnd());

const ELONGATION_MARK = /^[ー〜～]/u;

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
  const trimmedPrefix = prefix.trimEnd();
  if (startsClauseContinuation(remainder, false) || startsTaraContinuation(prefix, remainder)) {
    return true;
  }
  // ます is a polite auxiliary on a verb stem, not a completed copula.
  // Offsets after しています / できます / ございます must not page.
  if (endsWithPoliteMasuAuxiliary(trimmedPrefix) && !prefixEndsWithPunct(trimmedPrefix)) {
    return true;
  }
  // Completed copula offsets must not replace the lead unless the next span is
  // at least twice as long. Punctuation still pages.
  if (!prefixEndsWithPunct(trimmedPrefix) && !remainderDominatesPrefix(trimmedPrefix, next)) {
    return true;
  }
  // Bare topic/binding は・も mid-utterance must not page; those offsets hide
  // the already-recognized head on the plate. Structural, not a word list.
  if (/[はも]$/u.test(trimmedPrefix) && !isJapaneseSentenceEnd(trimmedPrefix)) {
    return true;
  }
  return false;
};

const detectHeuristicEnds = (text: string, english: boolean, allowCopula = true): number[] => {
  const chars = codePoints(text);
  if (chars.length === 0) {
    return [];
  }
  const ends: number[] = [];
  for (let index = 1; index <= chars.length; index += 1) {
    const prefix = chars.slice(0, index).join("");
    const isEnd = english
      ? isEnglishSentenceEnd(prefix)
      : isJapaneseSentenceEnd(prefix, allowCopula);
    if (!isEnd) {
      continue;
    }
    const remainder = chars.slice(index).join("");
    // Do not page after は when ー continues the same spoken phrase.
    if (shouldIgnoreSentenceEndBeforeContinuation(prefix, remainder, english)) {
      continue;
    }
    if (english && startsClauseContinuation(remainder, true)) {
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
const resolveStickySuppliedEnds = (
  text: string,
  hints: CaptionSentenceHints,
): number[] | null => {
  const previousText = hints.previousText?.trim() ?? "";
  const previousEnds = hints.previousEnds ?? [];
  if (!previousText || previousEnds.length === 0) {
    return null;
  }
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  const previous = previousText.replace(/\r\n?/gu, "\n").trim();
  if (!previous || !normalized.startsWith(previous)) {
    return null;
  }
  const textLen = codePoints(normalized).length;
  const previousLen = codePoints(previous).length;
  const expected = previousEnds.filter(
    (offset) => Number.isFinite(offset) && offset > 0 && offset <= previousLen && offset <= textLen,
  );
  if (expected.length === 0) {
    return null;
  }
  const current = detectHeuristicEnds(normalized, hints.key === "translation", hints.deferSentencePaging !== true);
  if (current.length > 0) {
    return null;
  }
  const supplied = hints.sentenceEndOffsets ?? [];
  if (supplied.length > 0) {
    return null;
  }
  return expected;
};

export const detectCaptionSentenceEnds = (
  text: string,
  hints: CaptionSentenceHints = {},
): number[] => {
  const english = hints.key === "translation";
  const allowCopula = hints.deferSentencePaging !== true;
  const chars = codePoints(text);
  const stickyEnds = resolveStickySuppliedEnds(text, hints);
  if (stickyEnds != null) {
    return stickyEnds;
  }
  const supplied = (hints.sentenceEndOffsets ?? []).filter((offset) => {
    if (!Number.isFinite(offset) || offset <= 0 || offset > chars.length) {
      return false;
    }
    const prefix = chars.slice(0, offset).join("");
    const remainder = chars.slice(offset).join("");
    // Drop pipeline offsets that would split before ー/〜, replace a longer
    // lead with a shorter copula tail, or page after a bare topic は・も.
    if (shouldIgnoreSentenceEndBeforeContinuation(prefix, remainder, english)) {
      return false;
    }
    return true;
  });
  if (supplied.length > 0) {
    return [...new Set(supplied)].sort((left, right) => left - right);
  }
  const surfaceEnds = detectHeuristicEnds(text, english, allowCopula);
  if (surfaceEnds.length > 0 || english) {
    return surfaceEnds;
  }
  const reading = hints.azookeyInputText?.trim() ?? "";
  // Provisional ASR paints the AzooKey reading itself. Do not apply reading
  // offsets onto a different kanji surface — those indices would not line up.
  if (reading && reading === text) {
    return detectHeuristicEnds(reading, false, allowCopula);
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

const normalizeForStickyCompare = (text: string): string =>
  text.replace(/\r\n?/gu, "\n").trim();

export interface CaptionSentenceStickyState {
  previousText: string;
  previousEnds: number[];
}

export const mergeCaptionSentenceEndsForStickyPrefix = (
  text: string,
  hints: CaptionSentenceHints,
  sticky: CaptionSentenceStickyState | null | undefined,
): number[] | null => {
  if (!sticky || !sticky.previousText || sticky.previousEnds.length === 0) {
    return null;
  }
  const normalized = normalizeForStickyCompare(text);
  const previous = normalizeForStickyCompare(sticky.previousText);
  if (!previous || !normalized.startsWith(previous)) {
    return null;
  }
  const textScalars = codePoints(normalized).length;
  const previousScalars = codePoints(previous).length;
  const expected = sticky.previousEnds
    .map((offset) => {
      if (!Number.isFinite(offset) || offset <= 0) {
        return null;
      }
      if (offset > previousScalars) {
        return null;
      }
      const prefix = codePoints(previous).slice(0, offset).join("");
      if (!normalizeForStickyCompare(previous).startsWith(normalizeForStickyCompare(prefix))) {
        return null;
      }
      return offset;
    })
    .filter(
      (value): value is number => value != null && value > 0 && value <= textScalars,
    );
  if (expected.length === 0) {
    return null;
  }
  const current = detectCaptionSentenceEnds(normalized, hints);
  const merged = [...new Set([...current, ...expected])].sort((left, right) => left - right);
  const visibleWithMerged = sliceNewestSentence(normalized, merged);
  if (visibleWithMerged === normalized) {
    return null;
  }
  return merged;
};

export const selectVisibleCaptionSentenceWithSticky = (
  text: string,
  hints: CaptionSentenceHints = {},
  sticky: CaptionSentenceStickyState | null | undefined = null,
): string => {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) {
    return "";
  }
  const merged = mergeCaptionSentenceEndsForStickyPrefix(normalized, hints, sticky);
  if (merged != null) {
    return sliceNewestSentence(normalized, merged);
  }
  return sliceNewestSentence(normalized, detectCaptionSentenceEnds(normalized, hints));
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
  // Punctuation still pages. Completed copulas (です/ました) page only when
  // the next span is at least twice the lead. Polite ます stems never page.
  // `deferSentencePaging` skips heuristic copula detection so a first
  // hypothesis like 「です＋次節」 keeps the head when offsets are absent.
  return sliceNewestSentence(normalized, detectCaptionSentenceEnds(normalized, hints));
};
