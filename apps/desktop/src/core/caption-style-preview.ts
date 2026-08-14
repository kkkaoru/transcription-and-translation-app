import type { CaptionPayload } from "./types";

export type CaptionStylePreviewLines = 1 | 2;

/** One-line style preview hides translation; two-line preview mirrors live JA+EN rows. */
export const captionForStylePreviewLines = (
  caption: CaptionPayload,
  lines: CaptionStylePreviewLines,
): CaptionPayload => (lines === 1 ? { ...caption, translationText: "" } : caption);
