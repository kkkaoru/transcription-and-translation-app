import type { CaptionPayload } from "./types";

/**
 * How long a finalized (or translated) caption stays visible for stream
 * viewers after updates stop. Short holds make captions unreadable on air.
 */
export const CAPTION_HOLD_CLEAR_MS = 5_000;

/**
 * Non-final captions must not auto-clear on a short idle: long utterances can
 * pause between ASR revisions for several seconds, and blanking the plate then
 * hides the only readable text. Only finalized/translated captions hold-clear.
 */
export const captionHoldClearDelayMs = (caption: CaptionPayload): number | null => {
  const hasText = Boolean(caption.sourceText.trim() || caption.translationText.trim());
  if (!hasText) {
    return null;
  }
  if (caption.id === "preview" || caption.id === "empty") {
    return null;
  }
  if (caption.isFinal === true || caption.translationText.trim()) {
    return CAPTION_HOLD_CLEAR_MS;
  }
  return null;
};
