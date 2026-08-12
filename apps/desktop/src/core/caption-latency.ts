/**
 * End-to-end caption latency spans, joined on turn id with ASR sidecar timestamps.
 *
 * ASR sidecar (sibling workstream) owns session-origin monotonic ms:
 *   speech_start_at, asr_dispatch_at, first_partial_at, asr_final_at
 * Legacy aliases (speech_start, asr_dispatch, first_partial, final) are still
 * accepted on the wire. Those values are not Unix time; do not subtract them
 * from Date.now(). speech_to_first_paint_ms = (asr_event_at - speech_start_at)
 * + ipc_to_first_paint_ms, joining the two clock domains at IPC receipt.
 *
 * Desktop caption pipeline owns wall-clock:
 *   ipc_or_event_received_at
 *   convert_done_at / convert_duration_ms  (AzooKey/normalize duration only)
 *   first_caption_paint_at                 (text committed to overlay state)
 *   visible_caption_at                     (Syphon/Spout present; may lag paint)
 */

import { appendStructuredLog } from "./structuredLog";
import type { AsrLatencyTimestamps } from "./types";

export type { AsrLatencyTimestamps };

export type CaptionLatencyClock = () => number;

export type CaptionLatencySpan = {
  turn_id: string;
  numeric_turn_id: number | null;
  turn_session_id: number | null;
  ipc_or_event_received_at: number | null;
  convert_done_at: number | null;
  convert_duration_ms: number | null;
  first_caption_paint_at: number | null;
  visible_caption_at: number | null;
  speech_start_at: number | null;
  asr_dispatch_at: number | null;
  first_partial_at: number | null;
  asr_final_at: number | null;
  speech_to_event_ms: number | null;
  speech_to_first_paint_ms: number | null;
  ipc_to_first_paint_ms: number | null;
  paint_to_visible_ms: number | null;
};

export type CaptionLatencyStats = {
  turnId: string | null;
  speechToFirstPaintMs: number | null;
  ipcToFirstPaintMs: number | null;
  paintToVisibleMs: number | null;
  convertDurationMs: number | null;
  updatedAt: string | null;
};

const MAX_SPANS = 32;
const spans = new Map<string, CaptionLatencySpan>();

const emptyStats = (): CaptionLatencyStats => ({
  turnId: null,
  speechToFirstPaintMs: null,
  ipcToFirstPaintMs: null,
  paintToVisibleMs: null,
  convertDurationMs: null,
  updatedAt: null,
});

let clock: CaptionLatencyClock = () => Date.now();
let stats: CaptionLatencyStats = emptyStats();
let revision = 0;
const listeners = new Set<() => void>();

const emptySpan = (turnId: string): CaptionLatencySpan => ({
  turn_id: turnId,
  numeric_turn_id: parseNumericTurnId(turnId),
  turn_session_id: null,
  ipc_or_event_received_at: null,
  convert_done_at: null,
  convert_duration_ms: null,
  first_caption_paint_at: null,
  visible_caption_at: null,
  speech_start_at: null,
  asr_dispatch_at: null,
  first_partial_at: null,
  asr_final_at: null,
  speech_to_event_ms: null,
  speech_to_first_paint_ms: null,
  ipc_to_first_paint_ms: null,
  paint_to_visible_ms: null,
});

const lagMs = (origin: number | null, at: number | null): number | null => {
  if (
    origin == null ||
    at == null ||
    !Number.isFinite(origin) ||
    !Number.isFinite(at) ||
    origin < 0
  ) {
    return null;
  }
  return Math.max(0, Math.round(at - origin));
};

/** Session-origin monotonic ms may be 0; wall-clock Date.now() is never 0 in practice. */
const finiteNonNegative = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const notify = (): void => {
  revision += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A stale DebugPanel subscriber must not interrupt caption rendering.
    }
  }
};

const rememberSpan = (turnId: string, span: CaptionLatencySpan): CaptionLatencySpan => {
  spans.set(turnId, span);
  if (spans.size > MAX_SPANS) {
    const oldest = spans.keys().next().value;
    if (oldest !== undefined && oldest !== turnId) {
      spans.delete(oldest);
    }
  }
  return span;
};

const getOrCreate = (turnId: string): CaptionLatencySpan => {
  const existing = spans.get(turnId);
  if (existing) {
    return existing;
  }
  return rememberSpan(turnId, emptySpan(turnId));
};

const publishLatest = (span: CaptionLatencySpan, at: number): void => {
  stats = {
    turnId: span.turn_id,
    speechToFirstPaintMs: span.speech_to_first_paint_ms,
    ipcToFirstPaintMs: span.ipc_to_first_paint_ms,
    paintToVisibleMs: span.paint_to_visible_ms,
    convertDurationMs: span.convert_duration_ms,
    updatedAt: new Date(at).toISOString(),
  };
  notify();
};

const spanFields = (
  span: CaptionLatencySpan,
): Record<string, string | number | boolean | null> => ({
  turn_id: span.numeric_turn_id,
  turn_session_id: span.turn_session_id,
  ipc_or_event_received_at: span.ipc_or_event_received_at,
  convert_done_at: span.convert_done_at,
  convert_duration_ms: span.convert_duration_ms,
  first_caption_paint_at: span.first_caption_paint_at,
  visible_caption_at: span.visible_caption_at,
  speech_start_at: span.speech_start_at,
  asr_dispatch_at: span.asr_dispatch_at,
  first_partial_at: span.first_partial_at,
  asr_final_at: span.asr_final_at,
  speech_to_event_ms: span.speech_to_event_ms,
  speech_to_first_paint_ms: span.speech_to_first_paint_ms,
  ipc_to_first_paint_ms: span.ipc_to_first_paint_ms,
  paint_to_visible_ms: span.paint_to_visible_ms,
});

const logSpan = (
  span: CaptionLatencySpan,
  message: string,
  durationMs: number | null,
  at: number,
): void => {
  appendStructuredLog({
    level: "info",
    source: "frontend",
    stage: "caption-latency",
    chunkId: span.turn_id,
    message,
    durationMs,
    fields: spanFields(span),
    epochMs: at,
  });
};

/** Caption id `parapper:session:turnSession:turnId` → join key used on both sides. */
export const captionLatencyJoinKey = (parts: {
  sessionId: string;
  turnSessionId: number;
  turnId: number;
}): string => `parapper:${parts.sessionId}:${parts.turnSessionId}:${parts.turnId}`;

export const parseNumericTurnId = (turnId: string): number | null => {
  const last = turnId.split(":").at(-1);
  if (last == null || last === "") {
    return null;
  }
  const numeric = Number(last);
  return Number.isFinite(numeric) ? numeric : null;
};

const readEpochField = (record: Record<string, unknown>, key: string): number | null =>
  finiteNonNegative(typeof record[key] === "number" ? record[key] : null);

const pickAsrAt = (
  record: Record<string, unknown>,
  canonical: string,
  alias: string,
): number | null => readEpochField(record, canonical) ?? readEpochField(record, alias);

export const parseAsrLatencyTimestamps = (
  record: Record<string, unknown>,
): AsrLatencyTimestamps | undefined => {
  const nestedRaw = record["caption_latency"];
  const nested =
    nestedRaw && typeof nestedRaw === "object" ? (nestedRaw as Record<string, unknown>) : null;
  const source = nested ?? record;
  const speech_start_at = pickAsrAt(source, "speech_start_at", "speech_start");
  const asr_dispatch_at = pickAsrAt(source, "asr_dispatch_at", "asr_dispatch");
  const first_partial_at = pickAsrAt(source, "first_partial_at", "first_partial");
  const asr_final_at = pickAsrAt(source, "asr_final_at", "final");
  if (
    speech_start_at == null &&
    asr_dispatch_at == null &&
    first_partial_at == null &&
    asr_final_at == null
  ) {
    return undefined;
  }
  return { speech_start_at, asr_dispatch_at, first_partial_at, asr_final_at };
};

const pickLatencyAt = (
  asr: AsrLatencyTimestamps,
  canonical: keyof AsrLatencyTimestamps,
  alias: keyof AsrLatencyTimestamps,
): number | null => finiteNonNegative(asr[canonical]) ?? finiteNonNegative(asr[alias]);

export const setCaptionLatencyClockForTests = (next: CaptionLatencyClock | null): void => {
  clock = next ?? (() => Date.now());
};

export const getCaptionLatencySpan = (turnId: string): CaptionLatencySpan | null => {
  const span = spans.get(turnId);
  return span ? { ...span } : null;
};

export const getCaptionLatencyStats = (): CaptionLatencyStats => ({ ...stats });

export const getCaptionLatencyRevision = (): number => revision;

export const subscribeCaptionLatency = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export type CaptionIpcReceivedInput = {
  turnId?: number | null;
  turnSessionId?: number | null;
  asrLatency?: AsrLatencyTimestamps | null;
};

/** First desktop receipt of a turn event (WebSocket / IPC). Idempotent per turn. */
export const markCaptionIpcReceived = (
  joinKey: string,
  input: CaptionIpcReceivedInput = {},
): CaptionLatencySpan | null => {
  const turnId = joinKey.trim();
  if (!turnId || turnId === "preview") {
    return null;
  }
  const at = clock();
  const span = getOrCreate(turnId);
  if (span.ipc_or_event_received_at == null) {
    span.ipc_or_event_received_at = at;
  }
  if (typeof input.turnId === "number" && Number.isFinite(input.turnId)) {
    span.numeric_turn_id = input.turnId;
  }
  if (typeof input.turnSessionId === "number" && Number.isFinite(input.turnSessionId)) {
    span.turn_session_id = input.turnSessionId;
  }
  const asr = input.asrLatency;
  if (asr) {
    span.speech_start_at =
      span.speech_start_at ?? pickLatencyAt(asr, "speech_start_at", "speech_start");
    span.asr_dispatch_at =
      span.asr_dispatch_at ?? pickLatencyAt(asr, "asr_dispatch_at", "asr_dispatch");
    span.first_partial_at =
      span.first_partial_at ?? pickLatencyAt(asr, "first_partial_at", "first_partial");
    const asrFinal = pickLatencyAt(asr, "asr_final_at", "final");
    if (asrFinal != null) {
      span.asr_final_at = asrFinal;
    }
  }
  rememberSpan(turnId, span);
  return { ...span };
};

/** Normalize/AzooKey finished. Records duration only; does not change conversion. */
export const markCaptionConvertDone = (
  joinKey: string,
  input: { at?: number; durationMs?: number } = {},
): CaptionLatencySpan | null => {
  const turnId = joinKey.trim();
  if (!turnId || turnId === "preview") {
    return null;
  }
  const span = getOrCreate(turnId);
  if (span.convert_done_at != null) {
    return { ...span };
  }
  const at = finiteNonNegative(input.at) ?? clock();
  span.convert_done_at = at;
  span.convert_duration_ms =
    typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
      ? Math.max(0, Math.round(input.durationMs))
      : lagMs(span.ipc_or_event_received_at, at);
  rememberSpan(turnId, span);
  publishLatest(span, at);
  return { ...span };
};

/** First non-empty source text committed to overlay/Live state. */
export const markCaptionFirstPaint = (
  joinKey: string,
  atMs?: number,
): CaptionLatencySpan | null => {
  const turnId = joinKey.trim();
  if (!turnId || turnId === "preview") {
    return null;
  }
  const span = getOrCreate(turnId);
  if (span.first_caption_paint_at != null) {
    return { ...span };
  }
  const at = finiteNonNegative(atMs) ?? clock();
  span.first_caption_paint_at = at;
  span.ipc_to_first_paint_ms = lagMs(span.ipc_or_event_received_at, at);
  const asrEventAt = span.first_partial_at ?? span.asr_final_at ?? span.asr_dispatch_at;
  span.speech_to_event_ms = lagMs(span.speech_start_at, asrEventAt);
  span.speech_to_first_paint_ms =
    span.speech_to_event_ms == null
      ? null
      : span.speech_to_event_ms + (span.ipc_to_first_paint_ms ?? 0);
  rememberSpan(turnId, span);
  publishLatest(span, at);
  logSpan(
    span,
    "caption first paint",
    span.speech_to_first_paint_ms ?? span.ipc_to_first_paint_ms,
    at,
  );
  return { ...span };
};

/** First pixels presented to Syphon/Spout (may lag React paint by rAF/fonts). */
export const markCaptionVisible = (joinKey: string, atMs?: number): CaptionLatencySpan | null => {
  const turnId = joinKey.trim();
  if (!turnId || turnId === "preview") {
    return null;
  }
  const span = getOrCreate(turnId);
  if (span.visible_caption_at != null) {
    return { ...span };
  }
  const at = finiteNonNegative(atMs) ?? clock();
  span.visible_caption_at = at;
  span.paint_to_visible_ms = lagMs(span.first_caption_paint_at, at);
  rememberSpan(turnId, span);
  publishLatest(span, at);
  logSpan(span, "caption visible", span.paint_to_visible_ms ?? span.speech_to_first_paint_ms, at);
  return { ...span };
};

export const clearCaptionLatency = (): void => {
  spans.clear();
  stats = emptyStats();
  notify();
};
