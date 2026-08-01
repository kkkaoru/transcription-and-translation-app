/**
 * Lightweight display-path timing for progressive caption paints.
 * Writes to the console only when verbose pipeline logging is enabled.
 *
 * Metrics (when available):
 * - sincePipelineStart: wall ms from caption.startedAt → paint
 * - sinceReceived: wall ms from caption.receivedAt → paint
 * - sinceFirstPaint: wall ms from first source paint → translation paint
 */

import { isVerbosePipelineLogging } from "./pipelineStages";
import type { CaptionPayload } from "./types";

const nowMs = (): number => Date.now();

/** Wall-clock ms when the first progressive source for an utterance hit the UI. */
const firstPaintById = new Map<string, number>();
const MAX_TRACKED = 32;

const remember = (id: string, at: number): void => {
  firstPaintById.set(id, at);
  if (firstPaintById.size > MAX_TRACKED) {
    const oldest = firstPaintById.keys().next().value;
    if (oldest !== undefined) {
      firstPaintById.delete(oldest);
    }
  }
};

const lagPart = (label: string, origin: number | undefined | null, wall: number): string | null => {
  if (origin == null || !Number.isFinite(origin) || origin <= 0) {
    return null;
  }
  return `${label}=${Math.max(0, Math.round(wall - origin))}ms`;
};

/**
 * Record a caption paint for TTFS / translation lag diagnostics.
 * Safe to call from setState updaters; never throws.
 */
export const markCaptionDisplay = (caption: CaptionPayload): void => {
  const wall = nowMs();
  const isTranslation =
    caption.stage === "translation" || Boolean(caption.isFinal && caption.translationText.trim());
  const prior = firstPaintById.get(caption.id);

  if (!isVerbosePipelineLogging()) {
    // Still track first paint so a later verbose toggle mid-session is useful.
    if (!prior && caption.sourceText.trim()) {
      remember(caption.id, wall);
    }
    return;
  }

  if (!prior && caption.sourceText.trim() && !isTranslation) {
    remember(caption.id, wall);
    const parts = [
      `[display] first-paint id=${caption.id}`,
      `stage=${caption.stage ?? "source"}`,
      `chars=${caption.sourceText.length}`,
      lagPart("sincePipelineStart", caption.startedAt, wall),
      lagPart("sinceReceived", caption.receivedAt, wall),
    ].filter(Boolean);
    // biome-ignore lint/suspicious/noConsole: optional display-path latency diagnostics
    console.info(parts.join(" "));
    return;
  }

  if (isTranslation) {
    if (!prior && caption.sourceText.trim()) {
      remember(caption.id, wall);
    }
    const first = firstPaintById.get(caption.id);
    const parts = [
      `[display] translation-paint id=${caption.id}`,
      first != null ? `sinceFirstPaint=${Math.max(0, Math.round(wall - first))}ms` : null,
      lagPart("sincePipelineStart", caption.startedAt, wall),
      lagPart("sinceReceived", caption.receivedAt, wall),
      `chars=${caption.translationText.length}`,
    ].filter(Boolean);
    // biome-ignore lint/suspicious/noConsole: optional display-path latency diagnostics
    console.info(parts.join(" "));
  }
};

export const clearCaptionDisplayTiming = (): void => {
  firstPaintById.clear();
};
