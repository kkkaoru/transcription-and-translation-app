/**
 * End-to-end caption latency spans, joined on turn id with ASR sidecar timestamps.
 *
 * ASR sidecar (sibling workstream) owns these epoch-ms fields on the event:
 *   speech_start, asr_dispatch, first_partial, final
 * Desktop caption pipeline owns:
 *   ipc_or_event_received_at
 *   convert_done_at / convert_duration_ms  (AzooKey/normalize duration only)
 *   first_caption_paint_at                 (text committed to overlay state)
 *   visible_caption_at                     (Syphon/Spout present; may lag paint)
 *   speech_to_first_paint_ms               when speech_start is present
 *
 * Do not invent ASR timestamps here. Pass sibling fields through when present.
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
  speech_start: number | null;
  asr_dispatch: number | null;
  first_partial: number | null;
  final: number | null;
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
  speech_start: null,
  asr_dispatch: null,
  first_partial: null,
  final: null,
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
    origin <= 0
  ) {
    return null;
  }
  return Math.max(0, Math.round(at - origin));
};

const finitePositive = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

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
  speech_start: span.speech_start,
  asr_dispatch: span.asr_dispatch,
  first_partial: span.first_partial,
  final: span.final,
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

export const parseAsrLatencyTimestamps = (
  record: Record<string, unknown>,
): AsrLatencyTimestamps | undefined => {
  const speech_start = finitePositive(
    typeof record.speech_start === "number" ? record.speech_start : null,
  );
  const asr_dispatch = finitePositive(
    typeof record.asr_dispatch === "number" ? record.asr_dispatch : null,
  );
  const first_partial = finitePositive(
    typeof record.first_partial === "number" ? record.first_partial : null,
  );
  const final = finitePositive(typeof record.final === "number" ? record.final : null);
  if (speech_start == null && asr_dispatch == null && first_partial == null && final == null) {
    return undefined;
  }
  return { speech_start, asr_dispatch, first_partial, final };
};

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
    span.speech_start = span.speech_start ?? finitePositive(asr.speech_start) ?? null;
    span.asr_dispatch = span.asr_dispatch ?? finitePositive(asr.asr_dispatch) ?? null;
    span.first_partial = span.first_partial ?? finitePositive(asr.first_partial) ?? null;
    if (finitePositive(asr.final) != null) {
      span.final = finitePositive(asr.final);
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
  const at = finitePositive(input.at) ?? clock();
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
  const at = finitePositive(atMs) ?? clock();
  span.first_caption_paint_at = at;
  span.ipc_to_first_paint_ms = lagMs(span.ipc_or_event_received_at, at);
  span.speech_to_first_paint_ms = lagMs(span.speech_start, at);
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
  const at = finitePositive(atMs) ?? clock();
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
