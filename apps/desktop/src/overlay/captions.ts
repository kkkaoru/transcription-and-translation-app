import {
  CAPTION_MAX_CHARS_MAX,
  CAPTION_MAX_CHARS_MIN,
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
    let breakAt = maxChars;
    // Prefer punctuation/whitespace near the limit so Japanese clauses and
    // Latin words stay together where possible. Never scan below half a line;
    // a very long clause should still make forward progress.
    for (let index = maxChars; index >= Math.floor(maxChars / 2); index -= 1) {
      const character = remaining[index - 1];
      if (character && (preferredBreak.test(character) || /\s/u.test(character))) {
        breakAt = index;
        break;
      }
    }
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

/** Split caption text into readable logical lines without dropping content. */
export const segmentCaptionText = (text: string, maxChars: number): string[] => {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
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
): string[] =>
  segmentCaptionText(
    item.text,
    typeof item.maxChars === "number" ? item.maxChars : defaultCaptionMaxChars(item.key),
  );

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
    text: placeholder ? "日本語の音声認識結果がここに表示されます" : caption.sourceText,
    style: config.overlay.source,
    maxChars: resolveCaptionMaxChars(config, "source"),
  };
  const translation: CaptionItem = {
    key: "translation",
    text: placeholder ? "English translation will appear here" : caption.translationText,
    style: config.overlay.translation,
    maxChars: resolveCaptionMaxChars(config, "translation"),
  };
  return config.overlay.order === "source-first" ? [source, translation] : [translation, source];
};
