/**
 * Lightweight display-path timing for normalized source / translation paints.
 * Metrics are always retained for DebugPanel; console + structured samples are
 * emitted only when verbose pipeline logging is enabled.
 *
 * Metrics (when available):
 * - sincePipelineStart: wall ms from caption.startedAt → paint
 * - sinceReceived: wall ms from caption.receivedAt → paint
 * - sinceFirstPaint: wall ms from first source paint → translation paint
 */

import { isVerbosePipelineLogging } from "./pipelineStages";
import { appendStructuredLog } from "./structuredLog";
import type { CaptionPayload } from "./types";

const nowMs = (): number => Date.now();

/** Wall-clock ms when the first progressive source for an utterance hit the UI. */
const firstPaintById = new Map<string, number>();
const MAX_TRACKED = 32;

export type CaptionDisplayTimingStats = {
  /** Most recent normalized source paint latency from pipeline start. */
  sourceSincePipelineStartMs: number | null;
  /** Most recent normalized source event → browser paint latency. */
  sourceEventToPaintMs: number | null;
  /** Most recent translation paint latency from pipeline start. */
  translationSincePipelineStartMs: number | null;
  /** Most recent translation event → browser paint latency. */
  translationEventToPaintMs: number | null;
  /** Most recent source paint → translation paint latency. */
  translationSinceSourcePaintMs: number | null;
  utteranceId: string | null;
  updatedAt: string | null;
};

const emptyStats = (): CaptionDisplayTimingStats => ({
  sourceSincePipelineStartMs: null,
  sourceEventToPaintMs: null,
  translationSincePipelineStartMs: null,
  translationEventToPaintMs: null,
  translationSinceSourcePaintMs: null,
  utteranceId: null,
  updatedAt: null,
});

let displayStats = emptyStats();
let displayRevision = 0;
const displayListeners = new Set<() => void>();

const publishStats = (patch: Partial<CaptionDisplayTimingStats>): void => {
  displayStats = {
    ...displayStats,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  displayRevision += 1;
  for (const listener of [...displayListeners]) {
    try {
      listener();
    } catch {
      // A stale UI subscriber must not interrupt caption rendering.
    }
  }
};

export const getCaptionDisplayTimingStats = (): CaptionDisplayTimingStats => ({
  ...displayStats,
});

export const getCaptionDisplayTimingRevision = (): number => displayRevision;

export const subscribeCaptionDisplayTiming = (listener: () => void): (() => void) => {
  displayListeners.add(listener);
  return () => {
    displayListeners.delete(listener);
  };
};

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

  if (!prior && caption.sourceText.trim() && !isTranslation) {
    remember(caption.id, wall);
    const sincePipelineStart = lagValue(caption.startedAt, wall);
    const sourceEventToPaint = lagValue(caption.receivedAt, wall);
    publishStats({
      sourceSincePipelineStartMs: sincePipelineStart,
      sourceEventToPaintMs: sourceEventToPaint,
      utteranceId: caption.id,
    });
    if (!isVerbosePipelineLogging()) {
      return;
    }
    const parts = [
      `[display] first-paint id=${caption.id}`,
      `stage=${caption.stage ?? "source"}`,
      `chars=${caption.sourceText.length}`,
      lagPart("sincePipelineStart", caption.startedAt, wall),
      lagPart("sinceReceived", caption.receivedAt, wall),
    ].filter(Boolean);
    appendStructuredLog({
      level: "info",
      source: "frontend",
      stage: "display",
      chunkId: caption.id,
      message: "normalized source painted",
      durationMs: sincePipelineStart,
      fields: {
        phase: "source",
        stageName: caption.stage ?? "source",
        sincePipelineStartMs: sincePipelineStart,
        eventToPaintMs: sourceEventToPaint,
        sourceChars: caption.sourceText.length,
      },
      epochMs: wall,
    });
    // biome-ignore lint/suspicious/noConsole: optional display-path latency diagnostics
    console.info(parts.join(" "));
    return;
  }

  if (isTranslation) {
    if (!prior && caption.sourceText.trim()) {
      remember(caption.id, wall);
    }
    const first = firstPaintById.get(caption.id);
    const translationSincePipelineStart = lagValue(caption.startedAt, wall);
    const translationEventToPaint = lagValue(caption.receivedAt, wall);
    const translationSinceSourcePaint =
      first != null ? Math.max(0, Math.round(wall - first)) : null;
    publishStats({
      translationSincePipelineStartMs: translationSincePipelineStart,
      translationEventToPaintMs: translationEventToPaint,
      translationSinceSourcePaintMs: translationSinceSourcePaint,
      utteranceId: caption.id,
    });
    if (!isVerbosePipelineLogging()) {
      return;
    }
    const parts = [
      `[display] translation-paint id=${caption.id}`,
      first != null ? `sinceFirstPaint=${Math.max(0, Math.round(wall - first))}ms` : null,
      lagPart("sincePipelineStart", caption.startedAt, wall),
      lagPart("sinceReceived", caption.receivedAt, wall),
      `chars=${caption.translationText.length}`,
    ].filter(Boolean);
    appendStructuredLog({
      level: "info",
      source: "frontend",
      stage: "display",
      chunkId: caption.id,
      message: "translation painted",
      durationMs: translationSincePipelineStart,
      fields: {
        phase: "translation",
        stageName: caption.stage ?? "translation",
        sincePipelineStartMs: translationSincePipelineStart,
        eventToPaintMs: translationEventToPaint,
        sinceSourcePaintMs: translationSinceSourcePaint,
        translationChars: caption.translationText.length,
      },
      epochMs: wall,
    });
    // biome-ignore lint/suspicious/noConsole: optional display-path latency diagnostics
    console.info(parts.join(" "));
  }
};

const lagValue = (origin: number | undefined | null, wall: number): number | null => {
  if (origin == null || !Number.isFinite(origin) || origin <= 0) {
    return null;
  }
  return Math.max(0, Math.round(wall - origin));
};

export const clearCaptionDisplayTiming = (): void => {
  firstPaintById.clear();
  displayStats = emptyStats();
  displayRevision += 1;
  for (const listener of [...displayListeners]) {
    try {
      listener();
    } catch {
      // Ignore subscriber failures; timing reset is best-effort.
    }
  }
};
