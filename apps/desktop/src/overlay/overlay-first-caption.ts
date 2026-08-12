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
 * `parapper:session:turnSession:turnId` → `session:turnSession`.
 * Delayed untagged ASR from the idle recognition session shares this key;
 * a new capture uses a new session or turnSession id.
 */
export const parapperSessionKey = (utteranceId: string): string | null => {
  if (!utteranceId.startsWith("parapper:")) {
    return null;
  }
  const rest = utteranceId.slice("parapper:".length);
  const turnColon = rest.lastIndexOf(":");
  if (turnColon <= 0) {
    return null;
  }
  const beforeTurn = rest.slice(0, turnColon);
  if (!beforeTurn.includes(":")) {
    return null;
  }
  return beforeTurn;
};

/**
 * Session identity for idle fencing. Parapper and web-speech ids group by
 * capture attempt; other ids stay exact so a delayed same-row replay is
 * still dropped.
 */
export const overlayAsrSessionKey = (utteranceId: string): string | null => {
  const parapper = parapperSessionKey(utteranceId);
  if (parapper) {
    return `parapper:${parapper}`;
  }
  if (utteranceId.startsWith("web-speech:")) {
    const rest = utteranceId.slice("web-speech:".length);
    const colon = rest.indexOf(":");
    return colon <= 0 ? utteranceId : `web-speech:${rest.slice(0, colon)}`;
  }
  const trimmed = utteranceId.trim();
  return trimmed ? trimmed : null;
};

const isParseableOverlayAsrSession = (utteranceId: string): boolean =>
  parapperSessionKey(utteranceId) != null || utteranceId.startsWith("web-speech:");

/**
 * Previous-session ASR must not repaint after idle. Prefer captureGeneration
 * when both sides have it. Untagged live *or history* rows from the idle
 * session (Parapper, web-speech, or a non-parapper rolling id) are delayed
 * previous-session stages even when `at` is later; a different parseable
 * session key is the new capture and must still paint the longer ASR.
 */
export const isStaleOverlayAsrStage = (
  stage: OverlayAsrStageRef,
  fence: OverlayAsrStageRef | null,
  historyInvalidated: boolean,
  source: "history" | "live",
  idleAsrSessionKey: string | null = null,
): boolean => {
  if (typeof stage.captureGeneration === "number" && typeof fence?.captureGeneration === "number") {
    if (stage.captureGeneration < fence.captureGeneration) {
      return true;
    }
    return historyInvalidated && stage.captureGeneration <= fence.captureGeneration;
  }
  if (typeof stage.captureGeneration !== "number" && idleAsrSessionKey) {
    const stageSession = overlayAsrSessionKey(stage.utteranceId);
    if (stageSession === idleAsrSessionKey) {
      return true;
    }
    if (isParseableOverlayAsrSession(stage.utteranceId) && stageSession) {
      return false;
    }
    return true;
  }
  if (source === "live" && typeof stage.captureGeneration !== "number") {
    if (
      isParseableOverlayAsrSession(stage.utteranceId) &&
      overlayAsrSessionKey(stage.utteranceId)
    ) {
      return false;
    }
    if (historyInvalidated) {
      return true;
    }
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
