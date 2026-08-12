/**
 * Bounded, cross-pipeline accounting for work that was intentionally dropped.
 *
 * Audio capture and the output queues are allowed to discard stale work to
 * keep latency bounded.  That is a useful back-pressure policy, but a silent
 * discard is indistinguishable from a recognition failure when debugging a
 * session.  This store provides one small, shared signal for every drop path;
 * the diagnostic event is visible in the existing Debug panel while the
 * aggregate remains queryable without coupling producers to React.
 */

import {
  type DiagnosticEventKind,
  markCaptureStartupDiscard,
  pushDiagnosticEvent,
} from "./diagnostics";

/** Maximum number of source/reason buckets retained in memory. */
export const MAX_PIPELINE_DROP_BUCKETS = 32;
/** Maximum number of source names retained in the bounded source aggregate. */
export const MAX_PIPELINE_DROP_SOURCES = 8;
const OVERFLOW_BUCKET = "other";

export type PipelineDropSource = string;

export type PipelineDropSignal = {
  source: string;
  reason: string;
  count: number;
};

export type PipelineDropSnapshot = {
  /** Total number of dropped items recorded since the last clear. */
  total: number;
  /** Bounded aggregate by producer (for example `audio` or `chunk-queue`). */
  bySource: Record<string, number>;
  /** Bounded aggregate by reason (for example `stale-final-cursor`). */
  byReason: Record<string, number>;
  /** Current bounded source/reason buckets, in insertion order. */
  signals: PipelineDropSignal[];
};

const sourceTotals = new Map<string, number>();
const reasonTotals = new Map<string, number>();
const buckets = new Map<string, PipelineDropSignal>();
let total = 0;

const normalizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized || fallback;
};

const normalizeCount = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(1, Math.floor(value));
};

const addBoundedTotal = (
  totals: Map<string, number>,
  key: string,
  count: number,
  maxKeys: number,
): void => {
  if (totals.has(key) || totals.size < maxKeys) {
    totals.set(key, (totals.get(key) ?? 0) + count);
    return;
  }
  totals.set(OVERFLOW_BUCKET, (totals.get(OVERFLOW_BUCKET) ?? 0) + count);
};

const addBucket = (source: string, reason: string, count: number): void => {
  const key = `${source}\u0000${reason}`;
  const previous = buckets.get(key);
  if (previous) {
    previous.count += count;
    return;
  }
  if (buckets.size >= MAX_PIPELINE_DROP_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (typeof oldest === "string") {
      buckets.delete(oldest);
    }
  }
  buckets.set(key, { source, reason, count });
};

const diagnosticKindForSource = (source: string): DiagnosticEventKind =>
  source === "audio" ? "audio" : "caption";

/**
 * Record one or more dropped pipeline items and emit a stable diagnostic.
 * Invalid/non-positive counts are ignored so defensive callers cannot inflate
 * telemetry with NaN or negative values.
 */
export const recordPipelineDrop = (
  source: PipelineDropSource,
  count = 1,
  reason = "unspecified",
): void => {
  const normalizedCount = normalizeCount(count);
  if (normalizedCount === 0) {
    return;
  }
  const normalizedSource = normalizeLabel(source, "unknown");
  const normalizedReason = normalizeLabel(reason, "unspecified");
  total += normalizedCount;
  addBoundedTotal(sourceTotals, normalizedSource, normalizedCount, MAX_PIPELINE_DROP_SOURCES);
  addBoundedTotal(reasonTotals, normalizedReason, normalizedCount, MAX_PIPELINE_DROP_BUCKETS);
  addBucket(normalizedSource, normalizedReason, normalizedCount);

  try {
    pushDiagnosticEvent(
      diagnosticKindForSource(normalizedSource),
      "Pipeline drop signal",
      `source=${normalizedSource} · reason=${normalizedReason} · count=${normalizedCount} · total=${total}`,
    );
  } catch {
    // Diagnostics are best-effort; a failing subscriber must not break an
    // audio callback or queue producer after the aggregate was recorded.
  }
};

/** Return a detached bounded snapshot for DebugPanel/tests. */
export const snapshotPipelineDrops = (): PipelineDropSnapshot => ({
  total,
  bySource: Object.fromEntries(sourceTotals.entries()),
  byReason: Object.fromEntries(reasonTotals.entries()),
  signals: [...buckets.values()].map((signal) => ({ ...signal })),
});

/** Clear drop accounting at a capture/session boundary. */
export const clearPipelineDrops = (): void => {
  total = 0;
  sourceTotals.clear();
  reasonTotals.clear();
  buckets.clear();
};

/**
 * Record a capture-startup discard that should appear both in pipeline drop
 * accounting and on the generation-correlated prepare→ready timeline.
 *
 * Safe to call before {@link markCaptureStartupDiscard}'s active correlation
 * exists: the drop aggregate is always updated; the correlation stamp is
 * best-effort when a generation tracker is already open.
 */
export const recordCaptureStartupDiscard = (
  reason: string,
  options?: {
    source?: PipelineDropSource;
    count?: number;
    captureGeneration?: number | null;
  },
): void => {
  const normalizedReason = normalizeLabel(reason, "unspecified");
  const source = normalizeLabel(options?.source, "audio");
  recordPipelineDrop(source, options?.count ?? 1, normalizedReason);
  try {
    markCaptureStartupDiscard({
      reason: normalizedReason,
      captureGeneration: options?.captureGeneration,
    });
  } catch {
    // Correlation stamp is best-effort; drop accounting already succeeded.
  }
};

// Explicit aliases keep the API discoverable for callers that refer to the
// store as diagnostics rather than drops.
export const getPipelineDropSnapshot = snapshotPipelineDrops;
export const getPipelineDropDiagnostics = snapshotPipelineDrops;
export const clearPipelineDropDiagnostics = clearPipelineDrops;
