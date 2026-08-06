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

/**
 * Collapse pathological single-Kanji runs (e.g. 為為為為…) that can appear
 * when a one-character revision is appended repeatedly across rolling
 * windows. Hiragana/katakana repetition is normal speech and is left alone.
 *
 * Keep at most two identical Kanji in a row — three or more indicate a
 * merge/ASR stutter and are collapsed.
 */
export const MAX_IDENTICAL_KANJI_RUN = 2;

export const collapseRunawayGraphemeRuns = (text: string, maxRun = MAX_IDENTICAL_KANJI_RUN): string => {
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

/** Sanitize caption text before segmentation / display. */
export const sanitizeCaptionDisplayText = (text: string): string =>
  collapseRunawayGraphemeRuns(stripCaptionContinuationMarker(text.replace(/\r\n?/gu, "\n")));

/** Pick the best wrap index in `[floor, limit]` preferring morph then punctuation. */
const preferNaturalBreakIndex = (graphemes: string[], limit: number, floor: number): number => {
  let punctuationBreak = 0;
  for (let index = limit; index >= floor; index -= 1) {
    if (isVibratoMorphBreak(graphemes, index)) {
      return index;
    }
    const character = graphemes[index - 1];
    if (!punctuationBreak && character && (preferredBreak.test(character) || /\s/u.test(character))) {
      punctuationBreak = index;
    }
  }
  return punctuationBreak || limit;
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

const splitLongLine = (line: string, maxChars: number): string[] => {
  const characters = captionGraphemes(line);
  if (characters.length <= maxChars) {
    return [line];
  }

  const segments: string[] = [];
  let remaining = characters;
  while (remaining.length > maxChars) {
    const breakAt = preferNaturalBreakIndex(
      remaining,
      maxChars,
      Math.floor(maxChars / 2),
    );
    // Trim at the grapheme-cluster level, not on the joined string: a cluster
    // like U+0020 + U+0301 is one grapheme, and String.prototype.trimStart
    // would strip the space and leave a bare combining mark at the start of
    // the next line.
    const segment = trimGraphemes(remaining.slice(0, breakAt)).join("");
    if (segment) {
      segments.push(segment);
    }
    remaining = trimStartGraphemes(remaining.slice(breakAt));
  }
  const tail = trimGraphemes(remaining).join("");
  if (tail) {
    segments.push(tail);
  }
  return segments.length > 0 ? segments : [line.trim()];
};

/**
 * Keep only the newest grapheme window when recognition has grown past the
 * on-screen budget (`maxChars * maxLines`).
 *
 * Older text is discarded entirely so the overlay / Syphon plate does not
 * stack dozens of wrapped lines and collapse the layout. Prefer starting the
 * window after punctuation when a nearby break exists, so a mid-clause cut is
 * rare.
 */
export const trimCaptionToDisplayWindow = (
  text: string,
  maxChars: number,
  maxLines: number = CAPTION_MAX_VISIBLE_LINES,
): string => {
  const normalized = sanitizeCaptionDisplayText(text).trim();
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
  let start = graphemes.length - budget;
  // Prefer a Vibrato morph / punctuation boundary near the cut so the first
  // visible line does not begin mid-phrase when a nearby break exists.
  const searchEnd = Math.min(graphemes.length, start + Math.floor(safeMaxChars / 2));
  for (let index = start; index < searchEnd; index += 1) {
    if (isVibratoMorphBreak(graphemes, index)) {
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
export const segmentCaptionText = (text: string, maxChars: number): string[] => {
  const normalized = sanitizeCaptionDisplayText(text).trim();
  if (!normalized) {
    return [];
  }
  const safeMaxChars = Math.max(1, Math.floor(maxChars));
  return normalized
    .split("\n")
    .flatMap((line) => splitLongLine(line.trim(), safeMaxChars))
    .filter(Boolean);
};

/**
 * Logical lines used by both the DOM overlay and the native canvas output.
 *
 * The budget rides on the item so every consumer honours the configured
 * value without threading the config through its own call sites. Items built
 * outside {@link captionItems} (older fixtures) keep the per-row default.
 */
export const captionTextLines = (
  item: Pick<CaptionItem, "key" | "text"> & Partial<Pick<CaptionItem, "maxChars">>,
): string[] => {
  const maxChars =
    typeof item.maxChars === "number" ? item.maxChars : defaultCaptionMaxChars(item.key);
  return segmentCaptionText(trimCaptionToDisplayWindow(item.text, maxChars), maxChars);
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

export const captionItems = (
  config: AppConfig,
  caption: CaptionPayload,
  placeholder = false,
): CaptionItem[] => {
  const source: CaptionItem = {
    key: "source",
    text: placeholder
      ? "日本語の音声認識結果がここに表示されます"
      : sanitizeCaptionDisplayText(caption.sourceText),
    style: config.overlay.source,
    maxChars: resolveCaptionMaxChars(config, "source"),
  };
  const translation: CaptionItem = {
    key: "translation",
    text: placeholder
      ? "English translation will appear here"
      : sanitizeCaptionDisplayText(caption.translationText),
    style: config.overlay.translation,
    maxChars: resolveCaptionMaxChars(config, "translation"),
  };
  return config.overlay.order === "source-first" ? [source, translation] : [translation, source];
};
