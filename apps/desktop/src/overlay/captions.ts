import type { AppConfig, CaptionPayload, CaptionTextStyle } from "../core/types";

export interface CaptionItem {
  key: "source" | "translation";
  text: string;
  style: CaptionTextStyle;
}

/**
 * Keep one logical subtitle line readable before the browser/canvas performs
 * width-based wrapping.  These are character budgets rather than hard
 * truncation limits: `segmentCaptionText` preserves every character and only
 * inserts line breaks.  The source budget is tuned for the default 36px
 * Japanese style; the wider translation budget accounts for smaller Latin
 * glyphs at the default 29px style.
 */
export const SOURCE_CAPTION_MAX_CHARS = 28;
export const TRANSLATION_CAPTION_MAX_CHARS = 48;

const preferredBreak = /[。．！？!?、,，；;：:]/u;

const splitLongLine = (line: string, maxChars: number): string[] => {
  const characters = Array.from(line);
  if (characters.length <= maxChars) {
    return [line];
  }

  const segments: string[] = [];
  let remaining = line;
  while (Array.from(remaining).length > maxChars) {
    const charactersLeft = Array.from(remaining);
    let breakAt = maxChars;
    // Prefer punctuation/whitespace near the limit so Japanese clauses and
    // Latin words stay together where possible. Never scan below half a line;
    // a very long clause should still make forward progress.
    for (let index = maxChars; index >= Math.floor(maxChars / 2); index -= 1) {
      const character = charactersLeft[index - 1];
      if (character && (preferredBreak.test(character) || /\s/u.test(character))) {
        breakAt = index;
        break;
      }
    }
    const segment = charactersLeft.slice(0, breakAt).join("").trim();
    if (segment) {
      segments.push(segment);
    }
    remaining = charactersLeft.slice(breakAt).join("").trimStart();
  }
  if (remaining) {
    segments.push(remaining.trim());
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

/** Logical lines used by both the DOM overlay and the native canvas output. */
export const captionTextLines = (item: Pick<CaptionItem, "key" | "text">): string[] =>
  segmentCaptionText(
    item.text,
    item.key === "source" ? SOURCE_CAPTION_MAX_CHARS : TRANSLATION_CAPTION_MAX_CHARS,
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
  };
  const translation: CaptionItem = {
    key: "translation",
    text: placeholder ? "English translation will appear here" : caption.translationText,
    style: config.overlay.translation,
  };
  return config.overlay.order === "source-first" ? [source, translation] : [translation, source];
};
