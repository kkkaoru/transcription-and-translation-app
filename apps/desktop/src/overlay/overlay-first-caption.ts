import { mergeCaptionPayload } from "../core/caption-updates";
import type { CaptionPayload } from "../core/types";

/**
 * Overlay mounts with design-time preview copy. The first real caption must
 * not skip merge in a way that lets a short `getLatestCaption` paint before
 * a longer ASR/history surface that is still in flight.
 *
 * Provisional ASR may replace preview immediately so Syphon is not empty.
 * Non-provisional latest/normalize waits until ASR history has settled.
 */
export const shouldHoldCaptionOverPreview = (
  currentId: string,
  incoming: CaptionPayload,
  asrHistorySettled: boolean,
): boolean => currentId === "preview" && !asrHistorySettled && incoming.provisional !== true;

/** Keep the longer of two held first-real candidates while preview is still up. */
export const retainHeldOverlayCaption = (
  held: CaptionPayload | null,
  incoming: CaptionPayload,
): CaptionPayload => {
  if (!held) {
    return incoming;
  }
  return mergeCaptionPayload(held, incoming) ?? held;
};
