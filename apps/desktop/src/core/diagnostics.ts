/** Lightweight in-memory diagnostic event log for the Debug panel. */

import {
  appendCaptureCorrelationLog,
  appendStructuredLog,
  redactSensitiveText,
  type CaptureCorrelationPhase,
} from "./structuredLog";
import type { LogLevel } from "./types";

export type DiagnosticEventKind =
  | "runtime"
  | "audio"
  | "caption"
  | "download"
  | "overlay"
  | "config"
  | "error"
  | "info";

export type DiagnosticEvent = {
  id: string;
  at: string;
  kind: DiagnosticEventKind;
  message: string;
  detail?: string;
};

/**
 * Correlated prepare → session.ready → first PCM → first speech/caption timeline
 * for one capture generation. Used to diagnose cold-start speech loss without
 * scraping uncorrelated lifecycle noise.
 */
export type CaptureStartupCorrelation = {
  /** Native capture generation; null only for pre-generation / legacy probes. */
  captureGeneration: number | null;
  /** Recognition mode when known (for example continuous Parapper). */
  mode: string | null;
  prepareAtMs: number | null;
  sessionReadyAtMs: number | null;
  /** Optional preroll stats (wired by audio capture once the ring buffer lands). */
  prerollFrameCount: number | null;
  prerollSampleCount: number | null;
  prerollDurationMs: number | null;
  firstForwardedPcmAtMs: number | null;
  firstSpeechAtMs: number | null;
  firstCaptionAtMs: number | null;
  /** Why this generation's startup path was discarded, when applicable. */
  discardReason: string | null;
  prepareToReadyMs: number | null;
  readyToFirstPcmMs: number | null;
  prepareToFirstCaptionMs: number | null;
};

export type CaptureStartupPrerollStats = {
  prerollFrameCount?: number | null;
  prerollSampleCount?: number | null;
  prerollDurationMs?: number | null;
};

/** Bounded number of completed/active correlation records retained for export. */
export const MAX_CAPTURE_STARTUP_CORRELATIONS = 16;
/** Bound diagnostic event spam from correlation milestones (one stream of many gens). */
export const MAX_CAPTURE_STARTUP_CORRELATION_EVENTS = 32;

const MAX_EVENTS = 48;
const events: DiagnosticEvent[] = [];
const listeners = new Set<() => void>();
let sequence = 0;
let storeRevision = 0;

/** Active generation tracker (latest begin wins). */
let activeCorrelation: CaptureStartupCorrelation | null = null;
/** Newest last; trimmed to {@link MAX_CAPTURE_STARTUP_CORRELATIONS}. */
const correlationHistory: CaptureStartupCorrelation[] = [];
let correlationEventsEmitted = 0;

const notify = (): void => {
  storeRevision += 1;
  // A diagnostic subscriber is UI code, but one faulty listener must never
  // prevent the remaining listeners (or the producer) from making progress.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Ignore listener failures; diagnostics must remain best-effort.
    }
  }
};

const kindToLevel = (kind: DiagnosticEventKind): LogLevel => {
  switch (kind) {
    case "error":
      return "error";
    case "audio":
    case "runtime":
    case "download":
    case "overlay":
    case "config":
    case "caption":
      return "info";
    default:
      return "info";
  }
};

const nowMs = (epochMs?: number): number => {
  if (typeof epochMs === "number" && Number.isFinite(epochMs)) {
    return Math.max(0, Math.round(epochMs));
  }
  return Date.now();
};

const normalizeOptionalNonNegInt = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
};

const normalizeOptionalGeneration = (value: unknown): number | null => {
  if (value == null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
};

const emptyCorrelation = (
  captureGeneration: number | null,
  mode: string | null,
): CaptureStartupCorrelation => ({
  captureGeneration,
  mode,
  prepareAtMs: null,
  sessionReadyAtMs: null,
  prerollFrameCount: null,
  prerollSampleCount: null,
  prerollDurationMs: null,
  firstForwardedPcmAtMs: null,
  firstSpeechAtMs: null,
  firstCaptionAtMs: null,
  discardReason: null,
  prepareToReadyMs: null,
  readyToFirstPcmMs: null,
  prepareToFirstCaptionMs: null,
});

const recomputeDeltas = (record: CaptureStartupCorrelation): void => {
  record.prepareToReadyMs =
    record.prepareAtMs != null && record.sessionReadyAtMs != null
      ? Math.max(0, record.sessionReadyAtMs - record.prepareAtMs)
      : null;
  record.readyToFirstPcmMs =
    record.sessionReadyAtMs != null && record.firstForwardedPcmAtMs != null
      ? Math.max(0, record.firstForwardedPcmAtMs - record.sessionReadyAtMs)
      : null;
  record.prepareToFirstCaptionMs =
    record.prepareAtMs != null && record.firstCaptionAtMs != null
      ? Math.max(0, record.firstCaptionAtMs - record.prepareAtMs)
      : null;
};

const cloneCorrelation = (record: CaptureStartupCorrelation): CaptureStartupCorrelation => ({
  ...record,
});

const retainCorrelation = (record: CaptureStartupCorrelation): void => {
  const generation = record.captureGeneration;
  const existingIndex =
    generation == null
      ? correlationHistory.findIndex((entry) => entry === record)
      : correlationHistory.findIndex((entry) => entry.captureGeneration === generation);
  if (existingIndex >= 0) {
    correlationHistory[existingIndex] = record;
  } else {
    correlationHistory.push(record);
  }
  if (correlationHistory.length > MAX_CAPTURE_STARTUP_CORRELATIONS) {
    correlationHistory.splice(0, correlationHistory.length - MAX_CAPTURE_STARTUP_CORRELATIONS);
  }
};

const resolveCorrelation = (
  captureGeneration?: number | null,
): CaptureStartupCorrelation | null => {
  if (captureGeneration != null) {
    const generation = normalizeOptionalGeneration(captureGeneration);
    if (generation == null) {
      return activeCorrelation;
    }
    if (activeCorrelation?.captureGeneration === generation) {
      return activeCorrelation;
    }
    const existing = correlationHistory.find((entry) => entry.captureGeneration === generation);
    if (existing) {
      activeCorrelation = existing;
      return existing;
    }
    const created = emptyCorrelation(generation, activeCorrelation?.mode ?? null);
    activeCorrelation = created;
    retainCorrelation(created);
    return created;
  }
  return activeCorrelation;
};

const formatCorrelationDetail = (record: CaptureStartupCorrelation): string => {
  const parts = [
    `generation=${record.captureGeneration ?? "none"}`,
    record.mode ? `mode=${record.mode}` : null,
    record.prepareAtMs != null ? `prepareAtMs=${record.prepareAtMs}` : null,
    record.sessionReadyAtMs != null ? `sessionReadyAtMs=${record.sessionReadyAtMs}` : null,
    record.prepareToReadyMs != null ? `prepareToReadyMs=${record.prepareToReadyMs}` : null,
    record.prerollFrameCount != null ? `prerollFrameCount=${record.prerollFrameCount}` : null,
    record.prerollSampleCount != null ? `prerollSampleCount=${record.prerollSampleCount}` : null,
    record.prerollDurationMs != null ? `prerollDurationMs=${record.prerollDurationMs}` : null,
    record.firstForwardedPcmAtMs != null
      ? `firstForwardedPcmAtMs=${record.firstForwardedPcmAtMs}`
      : null,
    record.readyToFirstPcmMs != null ? `readyToFirstPcmMs=${record.readyToFirstPcmMs}` : null,
    record.firstSpeechAtMs != null ? `firstSpeechAtMs=${record.firstSpeechAtMs}` : null,
    record.firstCaptionAtMs != null ? `firstCaptionAtMs=${record.firstCaptionAtMs}` : null,
    record.prepareToFirstCaptionMs != null
      ? `prepareToFirstCaptionMs=${record.prepareToFirstCaptionMs}`
      : null,
    record.discardReason ? `discardReason=${record.discardReason}` : null,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
};

const correlationFields = (
  record: CaptureStartupCorrelation,
): Record<string, string | number | boolean | null> => ({
  captureGeneration: record.captureGeneration,
  mode: record.mode,
  prepareAtMs: record.prepareAtMs,
  sessionReadyAtMs: record.sessionReadyAtMs,
  prepareToReadyMs: record.prepareToReadyMs,
  prerollFrameCount: record.prerollFrameCount,
  prerollSampleCount: record.prerollSampleCount,
  prerollDurationMs: record.prerollDurationMs,
  firstForwardedPcmAtMs: record.firstForwardedPcmAtMs,
  readyToFirstPcmMs: record.readyToFirstPcmMs,
  firstSpeechAtMs: record.firstSpeechAtMs,
  firstCaptionAtMs: record.firstCaptionAtMs,
  prepareToFirstCaptionMs: record.prepareToFirstCaptionMs,
  discardReason: record.discardReason,
});

const emitCorrelationMilestone = (
  phase: CaptureCorrelationPhase,
  record: CaptureStartupCorrelation,
  kind: "runtime" | "audio" | "caption" | "error" | "info",
  message: string,
): void => {
  const detail = formatCorrelationDetail(record);
  // Structured log is the durable DebugPanel/export path (own ring bound).
  // Diagnostic events are a smaller UI ring — stop adding after the cap.
  if (correlationEventsEmitted < MAX_CAPTURE_STARTUP_CORRELATION_EVENTS) {
    correlationEventsEmitted += 1;
    try {
      pushDiagnosticEvent(kind, message, detail, { mirrorStructured: false });
    } catch {
      // Best-effort UI signal; structured log below remains authoritative.
    }
  }
  try {
    appendCaptureCorrelationLog({
      phase,
      message,
      kind,
      fields: correlationFields(record),
      captureGeneration: record.captureGeneration,
      epochMs: Date.now(),
    });
  } catch {
    // Correlation logging must never break capture producers.
  }
};

export type PushDiagnosticOptions = {
  /** When false, skip the structured-log mirror (caller already logged). Default true. */
  mirrorStructured?: boolean;
};

export const pushDiagnosticEvent = (
  kind: DiagnosticEventKind,
  message: string,
  detail?: string,
  options?: PushDiagnosticOptions,
): DiagnosticEvent => {
  const toSafeText = (value: unknown): string | null => {
    try {
      return redactSensitiveText(value == null ? null : String(value));
    } catch {
      return null;
    }
  };
  const safeMessage = toSafeText(message) ?? "(empty)";
  const safeDetail = toSafeText(detail) ?? undefined;
  const entry: DiagnosticEvent = {
    id: `evt-${Date.now()}-${sequence++}`,
    at: new Date().toISOString(),
    kind,
    message: safeMessage,
    detail: safeDetail,
  };
  events.push(entry);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  if (options?.mirrorStructured !== false) {
    // Mirror into the structured log foundation (frontend source).
    appendStructuredLog({
      level: kindToLevel(kind),
      source: "frontend",
      message: `[${kind}] ${safeMessage}`,
      error: kind === "error" ? (safeDetail ?? safeMessage) : null,
      fields: {
        diagnosticKind: kind,
        detail: safeDetail ?? null,
      },
    });
  }
  notify();
  return entry;
};

/** Newest first. */
export const getDiagnosticEvents = (): DiagnosticEvent[] => [...events].reverse();

export const clearDiagnosticEvents = (): void => {
  events.length = 0;
  notify();
};

/** Stable external-store snapshot for DebugPanel subscriptions. */
export const getDiagnosticStoreRevision = (): number => storeRevision;

/** Subscribe to diagnostic additions/clears without coupling producers to React. */
export const subscribeDiagnosticEvents = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Begin (or re-bind) a capture-startup correlation for the given generation.
 * Marks prepare time on first call for that generation; subsequent calls with
 * the same generation are idempotent for prepareAtMs.
 */
export const beginCaptureStartupCorrelation = (input?: {
  captureGeneration?: number | null;
  mode?: string | null;
  epochMs?: number;
}): CaptureStartupCorrelation => {
  const generation = normalizeOptionalGeneration(input?.captureGeneration);
  const mode =
    typeof input?.mode === "string" && input.mode.trim() ? input.mode.trim() : (activeCorrelation?.mode ?? null);
  const at = nowMs(input?.epochMs);
  let record =
    generation != null
      ? correlationHistory.find((entry) => entry.captureGeneration === generation) ?? null
      : activeCorrelation;
  if (!record) {
    record = emptyCorrelation(generation, mode);
  } else if (mode && !record.mode) {
    record.mode = mode;
  }
  if (record.prepareAtMs == null) {
    record.prepareAtMs = at;
    recomputeDeltas(record);
    retainCorrelation(record);
    activeCorrelation = record;
    emitCorrelationMilestone("prepare", record, "runtime", "Capture startup: prepare");
  } else {
    retainCorrelation(record);
    activeCorrelation = record;
  }
  return cloneCorrelation(record);
};

/** Mark Parapper / recognition `session.ready` for the active or named generation. */
export const markCaptureSessionReady = (input?: {
  captureGeneration?: number | null;
  epochMs?: number;
}): CaptureStartupCorrelation | null => {
  const record = resolveCorrelation(input?.captureGeneration);
  if (!record) {
    return null;
  }
  if (record.sessionReadyAtMs == null) {
    record.sessionReadyAtMs = nowMs(input?.epochMs);
    recomputeDeltas(record);
    retainCorrelation(record);
    emitCorrelationMilestone("session-ready", record, "runtime", "Capture startup: session.ready");
  }
  return cloneCorrelation(record);
};

/**
 * Attach optional preroll buffer stats. Field names are stable so audio.ts can
 * wire them later without changing the diagnostic schema.
 */
export const markCapturePrerollStats = (
  stats: CaptureStartupPrerollStats,
  input?: { captureGeneration?: number | null },
): CaptureStartupCorrelation | null => {
  const record = resolveCorrelation(input?.captureGeneration);
  if (!record) {
    return null;
  }
  const frameCount = normalizeOptionalNonNegInt(stats.prerollFrameCount);
  const sampleCount = normalizeOptionalNonNegInt(stats.prerollSampleCount);
  const durationMs = normalizeOptionalNonNegInt(stats.prerollDurationMs);
  let changed = false;
  if (frameCount != null && record.prerollFrameCount !== frameCount) {
    record.prerollFrameCount = frameCount;
    changed = true;
  }
  if (sampleCount != null && record.prerollSampleCount !== sampleCount) {
    record.prerollSampleCount = sampleCount;
    changed = true;
  }
  if (durationMs != null && record.prerollDurationMs !== durationMs) {
    record.prerollDurationMs = durationMs;
    changed = true;
  }
  if (changed) {
    retainCorrelation(record);
    emitCorrelationMilestone("preroll", record, "audio", "Capture startup: preroll stats");
  }
  return cloneCorrelation(record);
};

/** First PCM frame actually forwarded to recognition (including after preroll drain). */
export const markCaptureFirstForwardedPcm = (input?: {
  captureGeneration?: number | null;
  epochMs?: number;
}): CaptureStartupCorrelation | null => {
  const record = resolveCorrelation(input?.captureGeneration);
  if (!record) {
    return null;
  }
  if (record.firstForwardedPcmAtMs == null) {
    record.firstForwardedPcmAtMs = nowMs(input?.epochMs);
    recomputeDeltas(record);
    retainCorrelation(record);
    emitCorrelationMilestone("first-pcm", record, "audio", "Capture startup: first forwarded PCM");
  }
  return cloneCorrelation(record);
};

/** First speech / VAD detection observed for this generation. */
export const markCaptureFirstSpeech = (input?: {
  captureGeneration?: number | null;
  epochMs?: number;
}): CaptureStartupCorrelation | null => {
  const record = resolveCorrelation(input?.captureGeneration);
  if (!record) {
    return null;
  }
  if (record.firstSpeechAtMs == null) {
    record.firstSpeechAtMs = nowMs(input?.epochMs);
    recomputeDeltas(record);
    retainCorrelation(record);
    emitCorrelationMilestone("first-speech", record, "audio", "Capture startup: first speech");
  }
  return cloneCorrelation(record);
};

/** First caption displayed / accepted for this generation. */
export const markCaptureFirstCaption = (input?: {
  captureGeneration?: number | null;
  epochMs?: number;
  captionId?: string | null;
}): CaptureStartupCorrelation | null => {
  const record = resolveCorrelation(input?.captureGeneration);
  if (!record) {
    return null;
  }
  if (record.firstCaptionAtMs == null) {
    record.firstCaptionAtMs = nowMs(input?.epochMs);
    recomputeDeltas(record);
    retainCorrelation(record);
    const captionNote =
      typeof input?.captionId === "string" && input.captionId.trim()
        ? ` (${input.captionId.trim().slice(0, 64)})`
        : "";
    emitCorrelationMilestone(
      "first-caption",
      record,
      "caption",
      `Capture startup: first caption${captionNote}`,
    );
  }
  return cloneCorrelation(record);
};

/** Record why a generation's startup path was discarded (cancel, supersede, failure). */
export const markCaptureStartupDiscard = (input: {
  reason: string;
  captureGeneration?: number | null;
  epochMs?: number;
}): CaptureStartupCorrelation | null => {
  const record = resolveCorrelation(input.captureGeneration);
  if (!record) {
    return null;
  }
  const reason =
    typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "unspecified";
  if (record.discardReason == null) {
    record.discardReason = reason;
    // epoch is reserved for future timeline extension; discard is reason-scoped.
    void input.epochMs;
    retainCorrelation(record);
    emitCorrelationMilestone("discard", record, "runtime", "Capture startup: discarded");
  }
  return cloneCorrelation(record);
};

/** Newest-first detached snapshots for DebugPanel/export consumers. */
export const snapshotCaptureStartupCorrelations = (): CaptureStartupCorrelation[] =>
  [...correlationHistory].reverse().map(cloneCorrelation);

export const getActiveCaptureStartupCorrelation = (): CaptureStartupCorrelation | null =>
  activeCorrelation ? cloneCorrelation(activeCorrelation) : null;

/** Clear correlation history at test boundaries or full diagnostic resets. */
export const clearCaptureStartupCorrelations = (): void => {
  activeCorrelation = null;
  correlationHistory.length = 0;
  correlationEventsEmitted = 0;
};
