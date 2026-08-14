import {
  type CaptionSentenceHints,
  detectCaptionSoftBreaks,
  selectVisibleCaptionSentence,
} from "@caption-bridge/sentence-boundary";
import {
  CAPTION_MAX_CHARS_MAX,
  CAPTION_MAX_CHARS_MIN,
  CAPTION_MAX_VISIBLE_LINES,
  clampCaptionMaxChars,
  defaultCaptionMaxChars,
  SOURCE_CAPTION_MAX_CHARS,
  TRANSLATION_CAPTION_MAX_CHARS,
} from "../core/defaults";
import type { AppConfig, CaptionPayload, CaptionTextStyle } from "../core/types";

/**
 * The caption budgets live in `core/defaults` so the config defaults can use
 * them without the core layer importing the overlay. Re-exported here because
 * this module is the caption segmentation entry point.
 */
export {
  CAPTION_MAX_CHARS_MAX,
  CAPTION_MAX_CHARS_MIN,
  CAPTION_MAX_VISIBLE_LINES,
  SOURCE_CAPTION_MAX_CHARS,
  TRANSLATION_CAPTION_MAX_CHARS,
};

export interface CaptionItem {
  key: "source" | "translation";
  text: string;
  style: CaptionTextStyle;
  /** Resolved per-row character budget for one logical line. */
  maxChars: number;
  azookeyInputText?: string | null;
  sentenceEndOffsets?: number[];
  softBreakOffsets?: number[];
  /** Skip heuristic copula/ます paging; punctuation and Vibrato offsets still page. */
  deferSentencePaging?: boolean;
  /** Bounded OPEN-segment prediction that fits the source line budget. */
  partialWindowText?: string;
}

/**
 * Resolve the configured budget for one caption row.
 *
 * A legacy config has no `captionMaxChars` at all, and a hand-edited config
 * can carry a non-finite or out-of-range number. `clampCaptionMaxChars` folds
 * both cases back into the supported range so an unusable value never reaches
 * the segmenter.
 */
export const resolveCaptionMaxChars = (
  config: Pick<AppConfig, "overlay">,
  key: CaptionItem["key"],
): number => clampCaptionMaxChars(config.overlay.captionMaxChars?.[key], key);

const preferredBreak = /[。．！？!?、,，；;：:]/u;

/**
 * User-visible characters for caption budgets.
 *
 * `Array.from` / UTF-16 code points split ZWJ emoji and combining marks. The
 * overlay budget is a human character count, so wrap on grapheme clusters
 * whenever `Intl.Segmenter` is available and fall back to code points only in
 * runtimes that still lack it.
 */
export const captionGraphemes = (text: string): string[] => {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
      (part) => part.segment,
    );
  }
  return Array.from(text);
};

/**
 * Vibrato/UniDic typically ends a token on these particles and auxiliaries.
 * Prefer wrapping after them so captions switch on natural morph boundaries
 * instead of mid-word grapheme cuts.
 */
const vibratoMorphBreakAfter =
  /(?:から|まで|より|など|って|では|には|とは|のは|が|を|に|へ|で|と|も|の|や|か|は|ね|よ|な|て|た|だ|です|ます|でした|ました)$/u;

/** True when the prefix ending at `endExclusive` is a Vibrato-like morph break. */
const isVibratoMorphBreak = (graphemes: string[], endExclusive: number): boolean => {
  if (endExclusive <= 0 || endExclusive > graphemes.length) {
    return false;
  }
  const prefix = graphemes.slice(0, endExclusive).join("");
  return vibratoMorphBreakAfter.test(prefix);
};

/**
 * Parapper marks continuing turns with a trailing `...`. Captions should never
 * paint that display marker; strip ASCII/fullwidth ellipsis suffixes only.
 */
export const stripCaptionContinuationMarker = (text: string): string =>
  text.replace(/(?:\.{3}|…|⋯)+$/u, "").trimEnd();

const ELONGATION_LED = /^[ー〜～]+/u;
const ELONGATION_ONLY = /^[ー〜～]+$/u;

const stripElongationAndTrailingClausePunct = (text: string): string =>
  text.replace(/[ー〜～]/gu, "").replace(/[。．.、！？!?]+$/u, "");

/**
 * Head that paging dropped when `shown` is a suffix of `source`.
 * Elongation / trailing clause punct are ignored so `ー続きがあります`
 * still maps onto `会議を始めますー続きがあります`.
 */
const prefixBeforeShown = (source: string, shown: string): string | null => {
  if (shown && source.endsWith(shown) && shown.length < source.length) {
    return source.slice(0, source.length - shown.length);
  }
  const sourceBare = stripElongationAndTrailingClausePunct(source);
  const shownBare = stripElongationAndTrailingClausePunct(shown);
  if (shownBare && sourceBare.endsWith(shownBare) && shownBare.length < sourceBare.length) {
    return sourceBare.slice(0, sourceBare.length - shownBare.length);
  }
  return null;
};

/**
 * True when `shown` is the clause after `。` / `．` / `.` in `original`.
 * Overlay must not glue that remainder back onto the previous sentence.
 * Bang/question (`！` `?`) are not period paging and may still restore.
 */
const isSentencePagedRemainder = (original: string, shown: string): boolean => {
  const prefix = prefixBeforeShown(original, shown);
  if (prefix === null) {
    return false;
  }
  return /[。．.]\s*$/u.test(prefix);
};

/**
 * True when `shown` follows bang/question punct. Sentence-boundary pages that
 * remainder, but overlay still restores the recognized head.
 */
const isBangOrQuestionRemainder = (original: string, shown: string): boolean => {
  const prefix = prefixBeforeShown(original, shown);
  if (prefix === null) {
    return false;
  }
  return /[！？!?]\s*$/u.test(prefix);
};

/**
 * True when paging/reveal dropped the already-recognized head and left a
 * continuation fragment (`ー`, an elongation-led tail, or a proper suffix).
 */
const isCollapsedContinuationSurface = (source: string, shown: string): boolean => {
  if (!shown || shown === source || source.length <= shown.length) {
    return false;
  }
  if (ELONGATION_ONLY.test(shown) && source.includes(shown)) {
    return true;
  }
  const sourceBare = stripElongationAndTrailingClausePunct(source);
  const shownBare = stripElongationAndTrailingClausePunct(shown);
  if (!shownBare || [...shownBare].length < 2) {
    return false;
  }
  if (ELONGATION_LED.test(shown) && (source.endsWith(shown) || sourceBare.endsWith(shownBare))) {
    return true;
  }
  return source.endsWith(shown) || sourceBare.endsWith(shownBare);
};

/**
 * After the first overlay frame commits, paging can drop the recognized head
 * and leave only `ー`, an elongation-led tail, or a suffix of the same turn.
 * Keep the longer surface already in `original`. Do not concatenate a different
 * turn, and do not undo intentional sentence paging: `。` remainder, or a
 * copula 2× tail that `selectVisibleCaptionSentence` already chose. Glue,
 * elongation-led, and bang/question suffixes restore the recognized head even
 * when the tail is twice the lead (`おはようよろしくお願いします`).
 */
export const restoreCollapsedContinuation = (original: string, visible: string): string => {
  const source = original.trim();
  const shown = visible.trim();
  if (!source) {
    return visible;
  }
  if (!shown) {
    return sanitizeCaptionDisplayText(source);
  }
  if (shown === source) {
    return visible;
  }
  if (ELONGATION_ONLY.test(shown) && source.includes(shown) && source.length > shown.length) {
    return sanitizeCaptionDisplayText(source);
  }
  if (isSentencePagedRemainder(source, shown)) {
    return visible;
  }
  if (!isCollapsedContinuationSurface(source, shown)) {
    return visible;
  }
  // Sentence paging already selected this suffix (copula 2×). Glue that
  // `selectVisibleCaptionSentence` still treats as one line must restore.
  // Bang/question remainders are paged by the segmenter but overlay restores.
  if (selectVisibleCaptionSentence(source) === shown) {
    if (isBangOrQuestionRemainder(source, shown)) {
      return sanitizeCaptionDisplayText(source);
    }
    return visible;
  }
  return sanitizeCaptionDisplayText(source);
};

/** @deprecated Use {@link restoreCollapsedContinuation}. */
export const restoreCollapsedGreetingContinuation = restoreCollapsedContinuation;

/**
 * Collapse pathological single-Kanji runs (e.g. 為為為為…) that can appear
 * when a one-character revision is appended repeatedly across rolling
 * windows. Hiragana/katakana repetition is normal speech and is left alone.
 *
 * Keep at most two identical Kanji in a row — three or more indicate a
 * merge/ASR stutter and are collapsed.
 */
export const MAX_IDENTICAL_KANJI_RUN = 2;

export const collapseRunawayGraphemeRuns = (
  text: string,
  maxRun = MAX_IDENTICAL_KANJI_RUN,
): string => {
  const graphemes = captionGraphemes(text);
  if (graphemes.length === 0) {
    return "";
  }
  const safeMax = Math.max(1, Math.floor(maxRun));
  const isKanji = (grapheme: string): boolean => /\p{Script=Han}/u.test(grapheme);
  const out: string[] = [];
  let previous = "";
  let run = 0;
  for (const grapheme of graphemes) {
    if (grapheme === previous && isKanji(grapheme)) {
      run += 1;
      if (run <= safeMax) {
        out.push(grapheme);
      }
      continue;
    }
    previous = grapheme;
    run = 1;
    out.push(grapheme);
  }
  return out.join("");
};

/** ReazonSpeech き-drop of 聞こえる, before or after kana→kanji conversion. */
const DROPPED_KIKOERU_KANA = /あえますか|おえますか/gu;
const DROPPED_KIKOERU_KANJI = /会えますか|終えますか/gu;

/**
 * ReazonSpeech often drops the initial き of 聞こえる, yielding あえますか /
 * おえますか (ZenZ/AzooKey may then pick 会えますか / 終えますか). Repair that
 * slip as a phrase, with no lead-word list. Leave `。` / `．` / `.` in place so
 * remainder paging can still show the newest clause.
 */
export const repairHearingPhraseConfusion = (text: string): string => {
  if (!text) {
    return text;
  }
  return text
    .replace(DROPPED_KIKOERU_KANA, "きこえますか")
    .replace(DROPPED_KIKOERU_KANJI, "聞こえますか");
};

/** Sanitize caption text before segmentation / display. */
export const sanitizeCaptionDisplayText = (text: string): string =>
  collapseRunawayGraphemeRuns(
    repairHearingPhraseConfusion(stripCaptionContinuationMarker(text.replace(/\r\n?/gu, "\n"))),
  );

/**
 * A translation containing no Unicode letter or number is not useful caption
 * content. Keep this display-side guard even though the pipeline rejects the
 * same degenerate model output, so stale or external payloads cannot paint `.`.
 */
export const hasDisplayableTranslationText = (text: string): boolean =>
  /[\p{L}\p{N}]/u.test(text.trim());

/** Pick the best wrap index in `[floor, limit]` preferring soft POS then morph/punct. */
const preferNaturalBreakIndex = (
  graphemes: string[],
  limit: number,
  floor: number,
  softBreakOffsets: number[] = [],
): number => {
  const softSet = new Set(softBreakOffsets.filter((offset) => offset > floor && offset <= limit));
  let punctuationBreak = 0;
  for (let index = limit; index >= floor; index -= 1) {
    if (softSet.has(index)) {
      return index;
    }
    if (isVibratoMorphBreak(graphemes, index)) {
      return index;
    }
    const character = graphemes[index - 1];
    if (
      !punctuationBreak &&
      character &&
      (preferredBreak.test(character) || /\s/u.test(character))
    ) {
      punctuationBreak = index;
    }
  }
  return punctuationBreak || limit;
};

/**
 * Convert exclusive Unicode-scalar soft-break offsets into grapheme indices
 * for the same `text`. Soft breaks from Vibrato are scalar offsets.
 */
const softBreakGraphemeOffsets = (text: string, scalarOffsets: number[]): number[] => {
  if (scalarOffsets.length === 0) {
    return [];
  }
  const scalars = Array.from(text);
  const graphemes = captionGraphemes(text);
  if (scalars.length === graphemes.length) {
    return scalarOffsets.filter((offset) => offset > 0 && offset <= graphemes.length);
  }
  // When grapheme clusters span multiple scalars, map each scalar offset to
  // the grapheme boundary that covers it.
  const mapped: number[] = [];
  let scalarIndex = 0;
  let graphemeIndex = 0;
  const wanted = [...new Set(scalarOffsets)].sort((a, b) => a - b);
  let wantAt = 0;
  while (graphemeIndex < graphemes.length && wantAt < wanted.length) {
    const cluster = graphemes[graphemeIndex] ?? "";
    const clusterScalars = Array.from(cluster).length;
    scalarIndex += clusterScalars;
    graphemeIndex += 1;
    while (wantAt < wanted.length && (wanted[wantAt] as number) <= scalarIndex) {
      mapped.push(graphemeIndex);
      wantAt += 1;
    }
  }
  return mapped;
};

/**
 * A grapheme cluster is whitespace-only when it trims to an empty string.
 * A cluster like U+0020 + U+0301 (space + combining acute) is one grapheme
 * that is NOT whitespace-only, so it must never be stripped by a boundary trim.
 */
const isWhitespaceGrapheme = (grapheme: string): boolean => grapheme.trim() === "";

/** Remove leading and trailing whitespace grapheme clusters from an array. */
const trimGraphemes = (graphemes: string[]): string[] => {
  let start = 0;
  let end = graphemes.length;
  while (start < end && isWhitespaceGrapheme(graphemes[start] as string)) {
    start += 1;
  }
  while (end > start && isWhitespaceGrapheme(graphemes[end - 1] as string)) {
    end -= 1;
  }
  return graphemes.slice(start, end);
};

/** Remove leading whitespace grapheme clusters from an array. */
const trimStartGraphemes = (graphemes: string[]): string[] => {
  let start = 0;
  while (start < graphemes.length && isWhitespaceGrapheme(graphemes[start] as string)) {
    start += 1;
  }
  return graphemes.slice(start);
};

const splitLongLine = (
  line: string,
  maxChars: number,
  softBreakOffsets: number[] = [],
): string[] => {
  const characters = captionGraphemes(line);
  const softGraphemes = softBreakGraphemeOffsets(line, softBreakOffsets);

  // Stay on one plate row while the grapheme budget holds. Earlier POS
  // "pre-wrap" under maxChars produced arbitrary mid-phrase breaks
  // (今日の天気は / 晴れ。) that users read as unwanted line breaks.
  if (characters.length <= maxChars) {
    return characters.length > 0 ? [characters.join("")] : [line];
  }

  const segments: string[] = [];
  let remaining = characters;
  let consumed = 0;
  while (remaining.length > maxChars) {
    // Prefer a POS soft break near the hard budget (not mid-line) so wrapping
    // stays natural without producing many short lines that overflow the
    // CAPTION_MAX_VISIBLE_LINES plate after a second CSS/canvas wrap.
    const earlyFloor = Math.max(1, Math.floor(maxChars * 0.7));
    const relativeSoft = softGraphemes
      .map((offset) => offset - consumed)
      .filter((offset) => offset > 0);
    const breakAt = preferNaturalBreakIndex(remaining, maxChars, earlyFloor, relativeSoft);
    // Trim at the grapheme-cluster level, not on the joined string: a cluster
    // like U+0020 + U+0301 is one grapheme, and String.prototype.trimStart
    // would strip the space and leave a bare combining mark at the start of
    // the next line.
    const segment = trimGraphemes(remaining.slice(0, breakAt)).join("");
    if (segment) {
      segments.push(segment);
    }
    remaining = trimStartGraphemes(remaining.slice(breakAt));
    consumed += breakAt;
  }
  const tail = trimGraphemes(remaining).join("");
  if (tail) {
    segments.push(tail);
  }
  return segments.length > 0 ? segments : [line.trim()];
};

/**
 * Keep only the newest sentence, then the newest grapheme window when that
 * sentence still exceeds `maxChars * maxLines`.
 *
 * Soft POS breaks are for *wrapping* lines inside the window (see
 * {@link segmentCaptionText}), not for discarding mid-utterance text before
 * the hard budget fills. Early soft-paging hid characters the speaker was
 * still producing. Prefer a soft/morph/punctuation boundary only when aligning
 * the hard-window cut so the first visible line does not start mid-phrase.
 * Always keep the newest graphemes — never drop the utterance tail.
 */
export const trimCaptionToDisplayWindow = (
  text: string,
  maxChars: number,
  maxLines: number = CAPTION_MAX_VISIBLE_LINES,
  hints: CaptionSentenceHints = {},
): string => {
  const sanitized = sanitizeCaptionDisplayText(text);
  const normalized = restoreCollapsedContinuation(
    sanitized,
    selectVisibleCaptionSentence(sanitized, hints),
  );
  if (!normalized) {
    return "";
  }
  const safeMaxChars = Math.max(1, Math.floor(maxChars));
  const safeMaxLines = Math.max(1, Math.floor(maxLines));
  const budget = safeMaxChars * safeMaxLines;
  const graphemes = captionGraphemes(normalized);
  if (graphemes.length <= budget) {
    return normalized;
  }
  const softScalar = detectCaptionSoftBreaks(normalized, hints);
  const softGraphemes = softBreakGraphemeOffsets(normalized, softScalar);
  let start = graphemes.length - budget;
  // Prefer a soft / Vibrato morph / punctuation boundary near the cut so the
  // first visible line does not begin mid-phrase when a nearby break exists.
  // Never advance start past the newest budget — the utterance tail stays.
  const searchEnd = Math.min(graphemes.length, start + Math.floor(safeMaxChars / 2));
  const softNearCut = new Set(
    softGraphemes.filter((offset) => offset >= start && offset < searchEnd),
  );
  for (let index = start; index < searchEnd; index += 1) {
    if (softNearCut.has(index) || isVibratoMorphBreak(graphemes, index)) {
      start = index;
      break;
    }
    const character = graphemes[index];
    if (character && preferredBreak.test(character)) {
      start = index + 1;
      break;
    }
  }
  return trimStartGraphemes(graphemes.slice(start)).join("");
};

/** Split caption text into readable logical lines without dropping content. */
export const segmentCaptionText = (
  text: string,
  maxChars: number,
  softBreakOffsets: number[] = [],
): string[] => {
  const normalized = sanitizeCaptionDisplayText(text).trim();
  if (!normalized) {
    return [];
  }
  const safeMaxChars = Math.max(1, Math.floor(maxChars));
  if (!normalized.includes("\n")) {
    const soft =
      softBreakOffsets.length > 0 ? softBreakOffsets : detectCaptionSoftBreaks(normalized);
    return splitLongLine(normalized, safeMaxChars, soft);
  }
  // Multi-line payloads are rare; re-detect soft breaks per line so offsets
  // stay local to each segment.
  return normalized
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return [];
      }
      return splitLongLine(trimmed, safeMaxChars, detectCaptionSoftBreaks(trimmed));
    })
    .filter(Boolean);
};

/** Keep only the newest logical lines so the plate never exceeds the visible budget. */
export const keepNewestCaptionLines = (
  lines: string[],
  maxLines: number = CAPTION_MAX_VISIBLE_LINES,
): string[] => {
  const safeMaxLines = Math.max(1, Math.floor(maxLines));
  if (lines.length <= safeMaxLines) {
    return lines;
  }
  return lines.slice(lines.length - safeMaxLines);
};

/**
 * Logical lines used by both the DOM overlay and the native canvas output.
 *
 * The budget rides on the item so every consumer honours the configured
 * value without threading the config through its own call sites. Items built
 * outside {@link captionItems} (older fixtures) keep the per-row default.
 *
 * Soft breaks wrap inside the grapheme window; after segmentation the result
 * is clamped to {@link CAPTION_MAX_VISIBLE_LINES} so CSS/canvas cannot paint
 * three or four visual rows from one source/translation plate.
 */
export const captionTextLines = (
  item: Pick<CaptionItem, "key" | "text"> &
    Partial<
      Pick<
        CaptionItem,
        | "maxChars"
        | "azookeyInputText"
        | "sentenceEndOffsets"
        | "softBreakOffsets"
        | "deferSentencePaging"
      >
    >,
): string[] => {
  const maxChars =
    typeof item.maxChars === "number" ? item.maxChars : defaultCaptionMaxChars(item.key);
  const hints: CaptionSentenceHints = {
    key: item.key,
    azookeyInputText: item.azookeyInputText,
    sentenceEndOffsets: item.sentenceEndOffsets,
    softBreakOffsets: item.softBreakOffsets,
    deferSentencePaging: item.deferSentencePaging,
  };
  const windowed = trimCaptionToDisplayWindow(
    item.text,
    maxChars,
    CAPTION_MAX_VISIBLE_LINES,
    hints,
  );
  return keepNewestCaptionLines(
    segmentCaptionText(windowed, maxChars, detectCaptionSoftBreaks(windowed, hints)),
    CAPTION_MAX_VISIBLE_LINES,
  );
};

export const createPreviewCaption = (): CaptionPayload => {
  const now = Date.now();
  return {
    id: "preview",
    sourceText: "これはプレビュー用の字幕です。",
    translationText: "This is a preview caption.",
    sourceLanguage: "ja",
    targetLanguage: "en",
    startedAt: now,
    receivedAt: now,
  };
};

/** Empty live state used after capture stops; unlike the preview it paints no sample text. */
export const createEmptyCaption = (): CaptionPayload => {
  return {
    id: "empty",
    sourceText: "",
    translationText: "",
    sourceLanguage: "ja",
    targetLanguage: "en",
    startedAt: 0,
    receivedAt: 0,
    stage: "source",
    sequence: 0,
    isFinal: false,
  };
};

/**
 * Empty plate after hold-clear while capture is still running.
 *
 * `receivedAt` is a receipt barrier so merge drops late events whose original
 * timestamps predate the clear. `startedAt` stays 0 so a new utterance whose
 * audio started just before the timer is not rejected by the startedAt guard.
 * Initial mount and idle reset keep {@link createEmptyCaption} (`receivedAt: 0`)
 * so the first live caption after OBS opens or capture restarts can still land.
 */
export const createHoldClearedCaption = (clearedAt = Date.now()): CaptionPayload => ({
  ...createEmptyCaption(),
  receivedAt: Math.max(1, clearedAt),
});

export const boundPartialWindowText = (source: CaptionItem, partialWindowText: string): string => {
  const suffix = partialWindowText.trim();
  if (!suffix) {
    return "";
  }
  const lastLine = captionTextLines(source).at(-1) ?? "";
  const available = Math.max(0, source.maxChars - captionGraphemes(lastLine).length - 1);
  return captionGraphemes(suffix).slice(0, available).join("");
};

export const captionItems = (
  config: AppConfig,
  caption: CaptionPayload,
  placeholder = false,
  partialWindowText = "",
): CaptionItem[] => {
  const prediction = sanitizeCaptionDisplayText(partialWindowText).trim();
  // A partial-window event belongs to the next OPEN segment. Replace the
  // completed previous plate immediately instead of appending beyond its width
  // and hiding the new speech until the old five-second hold expires.
  const predictionOnly =
    !placeholder &&
    Boolean(prediction) &&
    (caption.isFinal === true || hasDisplayableTranslationText(caption.translationText));
  // Provisional first hypotheses keep the lead sentence (defer copula paging)
  // so 「です＋次節」 does not drop the already-recognized head. Copula paging
  // on live interims/finals still requires punctuation or a 2× remainder.
  const deferSentencePaging = caption.provisional === true;
  const source: CaptionItem = {
    key: "source",
    text: placeholder
      ? "日本語の音声認識結果がここに表示されます"
      : predictionOnly
        ? prediction
        : sanitizeCaptionDisplayText(caption.sourceText),
    style: predictionOnly
      ? { ...config.overlay.source, opacity: config.overlay.source.opacity * 0.42 }
      : config.overlay.source,
    maxChars: resolveCaptionMaxChars(config, "source"),
    azookeyInputText: predictionOnly ? undefined : caption.azookeyInputText,
    sentenceEndOffsets: predictionOnly ? undefined : caption.sentenceEndOffsets,
    softBreakOffsets: predictionOnly ? undefined : caption.softBreakOffsets,
    deferSentencePaging,
  };
  source.partialWindowText = predictionOnly
    ? ""
    : boundPartialWindowText(source, partialWindowText);
  const sanitizedTranslation = sanitizeCaptionDisplayText(caption.translationText);
  const translation: CaptionItem = {
    key: "translation",
    text: placeholder
      ? "English translation will appear here"
      : !predictionOnly && hasDisplayableTranslationText(sanitizedTranslation)
        ? sanitizedTranslation
        : "",
    style: config.overlay.translation,
    maxChars: resolveCaptionMaxChars(config, "translation"),
    deferSentencePaging,
  };
  return config.overlay.order === "source-first" ? [source, translation] : [translation, source];
};
