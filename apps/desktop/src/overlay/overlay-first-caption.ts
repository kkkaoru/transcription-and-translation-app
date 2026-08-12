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

/**
 * Successful idle restores design-time preview. Drop any held latest and wait
 * for ASR history again so the next session cannot first-paint a short caption.
 * Without pipeline stages there is nothing to wait for, so stay settled.
 */
export const rearmPreviewHold = (
  restoredCaptionId: string,
  pipelineStagesAvailable: boolean,
): { asrHistorySettled: boolean; heldOverPreview: null } => ({
  asrHistorySettled: restoredCaptionId !== "preview" || !pipelineStagesAvailable,
  heldOverPreview: null,
});

/** Last ASR row the overlay painted, used to fence previous-session history. */
export type OverlayAsrStageRef = {
  utteranceId: string;
  at: number;
  startedAt?: number;
  captureGeneration?: number;
};

export const overlayAsrStageFence = (stage: OverlayAsrStageRef): OverlayAsrStageRef => ({
  utteranceId: stage.utteranceId,
  at: stage.at,
  ...(typeof stage.startedAt === "number" ? { startedAt: stage.startedAt } : {}),
  ...(typeof stage.captureGeneration === "number"
    ? { captureGeneration: stage.captureGeneration }
    : {}),
});

export const overlayAsrFenceFromCaption = (caption: CaptionPayload): OverlayAsrStageRef | null => {
  if (caption.id === "preview" || caption.id === "empty") {
    return null;
  }
  return overlayAsrStageFence({
    utteranceId: caption.id,
    at: caption.receivedAt,
    startedAt: caption.startedAt,
    captureGeneration: caption.captureGeneration,
  });
};

/**
 * Previous-session ASR must not repaint after idle. Prefer captureGeneration
 * when both sides have it; otherwise treat a history snapshot that is not
 * newer than the idle fence as stale. Live events after capturing still
 * paint unless they belong to an older generation or the same fenced row.
 */
export const isStaleOverlayAsrStage = (
  stage: OverlayAsrStageRef,
  fence: OverlayAsrStageRef | null,
  historyInvalidated: boolean,
  source: "history" | "live",
): boolean => {
  if (typeof stage.captureGeneration === "number" && typeof fence?.captureGeneration === "number") {
    if (stage.captureGeneration < fence.captureGeneration) {
      return true;
    }
    return historyInvalidated && stage.captureGeneration <= fence.captureGeneration;
  }
  if (source === "history" && historyInvalidated) {
    if (!fence) {
      return true;
    }
    return stage.at <= fence.at;
  }
  if (!fence) {
    return false;
  }
  return stage.utteranceId === fence.utteranceId && stage.at <= fence.at;
};

/** Stale-only history after idle must not settle the short-latest hold. */
export const shouldSettleAsrHistoryReplay = (
  appliedNonStaleHistory: boolean,
  historyInvalidated: boolean,
): boolean => appliedNonStaleHistory || !historyInvalidated;
