import { appendStructuredLog } from "./structuredLog";
import type { CaptionPayload } from "./types";

/**
 * How long a finalized (or translated) caption stays visible for stream
 * viewers after updates stop. Short holds make captions unreadable on air.
 */
export const CAPTION_HOLD_CLEAR_MS = 5_000;

export type CaptionDisplayLifecycle = "visible" | "hold" | "clear";

export const logCaptionDisplayLifecycle = (
  lifecycle: CaptionDisplayLifecycle,
  caption: CaptionPayload,
  nowMs: number = Date.now(),
): void => {
  const publishedAt = Math.max(0, Math.trunc(caption.receivedAt || caption.startedAt || 0));
  const ageMs = publishedAt > 0 ? Math.max(0, nowMs - publishedAt) : 0;
  const generation =
    typeof caption.captureGeneration === "number" && Number.isFinite(caption.captureGeneration)
      ? Math.trunc(caption.captureGeneration)
      : null;
  appendStructuredLog({
    level: "info",
    source: "frontend",
    stage: "display",
    chunkId: caption.id || null,
    message: `caption display lifecycle=${lifecycle} age_ms=${ageMs} generation=${generation ?? "none"} has_translation=${caption.translationText.trim().length > 0}`,
    durationMs: ageMs,
    epochMs: nowMs,
    fields: {
      lifecycle,
      ageMs,
      generation,
      isFinal: caption.isFinal === true,
      hasTranslation: caption.translationText.trim().length > 0,
    },
  });
};

/**
 * Identity of the held caption used to ignore stale hold-clear timers.
 *
 * A newer utterance can update `captionRef` / queue `setState` before React
 * runs the previous effect cleanup. Comparing this epoch at fire time keeps
 * that late timer from blanking the replacement caption.
 */
export const captionHoldClearEpoch = (caption: CaptionPayload): string =>
  [
    caption.id,
    caption.sourceText,
    caption.translationText,
    String(caption.isFinal),
    String(caption.provisional),
    String(caption.receivedAt),
  ].join("\u0000");

/** True when a scheduled hold-clear still refers to the visible caption. */
export const shouldApplyCaptionHoldClear = (
  expectedEpoch: string,
  current: CaptionPayload,
): boolean => expectedEpoch === captionHoldClearEpoch(current);

/**
 * Decide whether a hold-clear timer may blank the visible caption.
 *
 * Epoch mismatch rejects a stale timer after a newer utterance landed.
 * Preview / already-empty plates stay put even if a timer somehow fires.
 */
export const shouldBlankCaptionForHoldClear = (
  expectedEpoch: string,
  current: CaptionPayload,
): boolean => {
  if (!shouldApplyCaptionHoldClear(expectedEpoch, current)) {
    return false;
  }
  if (current.id === "preview") {
    return false;
  }
  return Boolean(current.sourceText.trim() || current.translationText.trim());
};

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
