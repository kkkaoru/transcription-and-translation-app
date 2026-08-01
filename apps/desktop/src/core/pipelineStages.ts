/**
 * In-memory store for independent pipeline stage events (ASR / normalize / translate).
 * Used by DebugPanel for continuous latency + text inspection without React coupling.
 */

import { pushDiagnosticEvent } from "./diagnostics";
import { logPipelineStageEvent } from "./structuredLog";
import type { PipelineStageEvent, PipelineStageName, UtteranceStageGroup } from "./types";

const MAX_STAGE_EVENTS = 96;
const MAX_UTTERANCES = 24;
const ASR_STAGE_ORDER = 0;
const NORMALIZE_STAGE_ORDER = 1;
const TRANSLATE_STAGE_ORDER = 2;
const UNKNOWN_STAGE_ORDER = 9;
const VERBOSE_STORAGE_KEY = "kotoba-beacon.debug.verbosePipeline";
/** Keep the settings Debug panel open across reloads during development. */
export const DEBUG_PANEL_OPEN_STORAGE_KEY = "kotoba-beacon.debug.panelOpen";

const stages: PipelineStageEvent[] = [];
const listeners = new Set<() => void>();
let sequence = 0;
/** Monotonic revision for useSyncExternalStore (stable getSnapshot identity). */
let storeRevision = 0;

const readVerbosePreference = (): boolean => {
  try {
    if (typeof localStorage === "undefined") {
      return false;
    }
    return localStorage.getItem(VERBOSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

export const readDebugPanelOpenPreference = (): boolean => {
  try {
    if (typeof localStorage === "undefined") {
      // The live route mounts the panel for every session. Keep it expanded by
      // default so stage timing is immediately visible even before a preference
      // has been written (or when the webview has no storage access).
      return true;
    }
    // "0" is the only explicit opt-out; missing/legacy values keep debug
    // mode visible so a fresh install can be inspected without extra clicks.
    return localStorage.getItem(DEBUG_PANEL_OPEN_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
};

export const writeDebugPanelOpenPreference = (open: boolean): void => {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(DEBUG_PANEL_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // Ignore quota / private mode failures.
  }
};

let verboseLogging = readVerbosePreference();

const notify = (): void => {
  storeRevision += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A stale DebugPanel subscriber must not stop stage capture/logging.
    }
  }
};

/** Stable snapshot token — changes only when stages/verbose preference change. */
export const getPipelineStageStoreRevision = (): number => storeRevision;

export const isPipelineStageName = (value: string): value is PipelineStageName =>
  value === "asr" || value === "normalize" || value === "translate";

export const isVerbosePipelineLogging = (): boolean => verboseLogging;

export const setVerbosePipelineLogging = (enabled: boolean): void => {
  verboseLogging = enabled;
  try {
    if (typeof localStorage !== "undefined") {
      if (enabled) {
        localStorage.setItem(VERBOSE_STORAGE_KEY, "1");
      } else {
        localStorage.removeItem(VERBOSE_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore quota / private mode failures; in-memory flag still works.
  }
  notify();
};

const logStage = (event: PipelineStageEvent): void => {
  // Always record a structured row (level-filtered in the log viewer / console).
  logPipelineStageEvent(event, { verbose: verboseLogging, source: "backend" });
  if (!verboseLogging && event.ok) {
    // Quiet mode: keep the diagnostic feed free of high-volume success rows.
    return;
  }
  const detail = [
    `id=${event.utteranceId}`,
    event.modelId ? `model=${event.modelId}` : null,
    `startedAt=${event.startedAt}`,
    `endedAt=${event.at}`,
    event.inputSnippet ? `in=${event.inputSnippet}` : null,
    event.outputText ? `out=${event.outputText}` : null,
    event.error ? `error=${event.error}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Stage already wrote a structured log row; only keep the lightweight diagnostic feed.
  pushDiagnosticEvent(
    event.ok ? "caption" : "error",
    `${event.stage} ${event.ok ? "ok" : "failed"} (${event.durationMs}ms)`,
    detail,
    { mirrorStructured: false },
  );
};

/** Normalize partial/unknown payloads from Tauri into a stable event shape. */
export const normalizePipelineStageEvent = (raw: unknown): PipelineStageEvent | null => {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  // Bracket access required: noPropertyAccessFromIndexSignature.
  const record = raw as Record<string, unknown>;
  const stage = typeof record["stage"] === "string" ? record["stage"] : "";
  if (!stage) {
    return null;
  }
  const utteranceId =
    typeof record["utteranceId"] === "string"
      ? record["utteranceId"]
      : typeof record["utterance_id"] === "string"
        ? record["utterance_id"]
        : "";
  const modelIdRaw = record["modelId"] ?? record["model_id"];
  const modelId = typeof modelIdRaw === "string" ? modelIdRaw : "";
  const durationMsRaw = record["durationMs"] ?? record["duration_ms"];
  const durationMs =
    typeof durationMsRaw === "number" && Number.isFinite(durationMsRaw)
      ? Math.max(0, Math.round(durationMsRaw))
      : 0;
  const atRaw = record["at"] ?? record["endedAt"] ?? record["ended_at"];
  const at = typeof atRaw === "number" && Number.isFinite(atRaw) ? atRaw : Date.now();
  const startedRaw = record["startedAt"] ?? record["started_at"];
  const startedAt =
    typeof startedRaw === "number" && Number.isFinite(startedRaw)
      ? Math.max(0, Math.round(startedRaw))
      : Math.max(0, Math.round(at - durationMs));
  const errorValue = record["error"];
  const error = typeof errorValue === "string" && errorValue.trim() ? errorValue.trim() : null;
  const ok = record["ok"] !== false && error == null;
  const inputSnippet =
    typeof record["inputSnippet"] === "string"
      ? record["inputSnippet"]
      : typeof record["input_snippet"] === "string"
        ? record["input_snippet"]
        : "";
  const outputText =
    typeof record["outputText"] === "string"
      ? record["outputText"]
      : typeof record["output_text"] === "string"
        ? record["output_text"]
        : "";
  const surfaceTextRaw = record["surfaceText"] ?? record["surface_text"];
  const surfaceText =
    typeof surfaceTextRaw === "string" && surfaceTextRaw.trim() ? surfaceTextRaw : undefined;
  return {
    stage,
    utteranceId: utteranceId || `stage-${Date.now()}-${sequence}`,
    modelId,
    inputSnippet,
    outputText,
    ...(surfaceText ? { surfaceText } : {}),
    startedAt,
    at,
    durationMs,
    ok: Boolean(ok) && !error,
    error,
  };
};

export const pushPipelineStageEvent = (raw: unknown): PipelineStageEvent | null => {
  const event = normalizePipelineStageEvent(raw);
  if (!event) {
    return null;
  }
  stages.push(event);
  if (stages.length > MAX_STAGE_EVENTS) {
    stages.splice(0, stages.length - MAX_STAGE_EVENTS);
  }
  sequence += 1;
  logStage(event);
  notify();
  return event;
};

/**
 * Merge a backend stage-history snapshot into the live ring buffer.
 *
 * The live `pipeline:stage` subscription is intentionally app-wide, but a
 * DebugPanel can still be mounted after stages have already completed (or the
 * native event may have been emitted while the webview was reconnecting).
 * Hydration makes the panel resilient to that gap without replaying every
 * historical row into the diagnostic feed.  Rows are deduplicated by their
 * stable utterance/stage/timing identity, while preserving the normal
 * chronological ordering used by `getUtteranceStageGroups`.
 */
export const hydratePipelineStageEvents = (raw: unknown): PipelineStageEvent[] => {
  if (!Array.isArray(raw)) {
    return [];
  }

  const normalized = raw
    .map((entry) => normalizePipelineStageEvent(entry))
    .filter((entry): entry is PipelineStageEvent => entry !== null);
  if (normalized.length === 0) {
    return [];
  }

  const identity = (event: PipelineStageEvent): string =>
    [
      event.utteranceId,
      event.stage,
      event.startedAt,
      event.at,
      event.durationMs,
      event.modelId,
      event.ok ? "ok" : "error",
      event.error ?? "",
      event.outputText,
      event.surfaceText ?? "",
    ].join("\u001f");

  const existing = new Set(stages.map(identity));
  let changed = false;
  let added = 0;
  // Native snapshots are newest-first while the mutable ring is oldest-first.
  // Insert by timestamp so getPipelineStageEvents() remains newest-first after
  // its reverse operation and latest-by-stage never regresses to an old row.
  const chronological = normalized
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      if (left.event.at !== right.event.at) {
        return left.event.at - right.event.at;
      }
      if (left.event.startedAt !== right.event.startedAt) {
        return left.event.startedAt - right.event.startedAt;
      }
      return left.index - right.index;
    })
    .map(({ event }) => event);
  for (const event of chronological) {
    const key = identity(event);
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    stages.push(event);
    changed = true;
    added += 1;
  }

  if (changed) {
    // A refresh can return a snapshot that lags a live event already in the
    // browser. Keep the mutable ring globally chronological so an older
    // hydrated row cannot become the "latest" card for its stage.
    stages.sort((left, right) => {
      if (left.at !== right.at) {
        return left.at - right.at;
      }
      if (left.startedAt !== right.startedAt) {
        return left.startedAt - right.startedAt;
      }
      return 0;
    });
  }

  if (stages.length > MAX_STAGE_EVENTS) {
    stages.splice(0, stages.length - MAX_STAGE_EVENTS);
    changed = true;
  }
  if (changed) {
    sequence += added;
    notify();
  }
  return normalized;
};

/** Newest first. */
export const getPipelineStageEvents = (): PipelineStageEvent[] => [...stages].reverse();

export const getLatestPipelineStageByName = (
  stage: PipelineStageName,
): PipelineStageEvent | null => {
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    const event = stages[index];
    if (event?.stage === stage) {
      return event;
    }
  }
  return null;
};

/**
 * Group chronological stage events by utterance id (newest utterance first).
 * Stages inside each group keep pipeline order: asr → normalize → translate.
 */
export const groupStagesByUtterance = (
  events: PipelineStageEvent[],
  limit = MAX_UTTERANCES,
): UtteranceStageGroup[] => {
  const stageOrder = (name: string): number => {
    switch (name) {
      case "asr":
        return ASR_STAGE_ORDER;
      case "normalize":
        return NORMALIZE_STAGE_ORDER;
      case "translate":
        return TRANSLATE_STAGE_ORDER;
      default:
        return UNKNOWN_STAGE_ORDER;
    }
  };

  // Accept newest-first or oldest-first input; sort by time then stage for grouping.
  const chronological = [...events].sort((left, right) => {
    if (left.at !== right.at) {
      return left.at - right.at;
    }
    return stageOrder(left.stage) - stageOrder(right.stage);
  });

  const groups = new Map<string, UtteranceStageGroup>();
  const order: string[] = [];

  for (const event of chronological) {
    let group = groups.get(event.utteranceId);
    if (!group) {
      group = {
        utteranceId: event.utteranceId,
        at: event.at,
        stages: [],
        totalDurationMs: 0,
        ok: true,
      };
      groups.set(event.utteranceId, group);
      order.push(event.utteranceId);
    }
    group.stages.push(event);
    group.totalDurationMs += event.durationMs;
    group.ok = group.ok && event.ok;
    group.at = Math.max(group.at, event.at);
  }

  for (const group of groups.values()) {
    group.stages.sort((left, right) => {
      if (left.at !== right.at) {
        return left.at - right.at;
      }
      return stageOrder(left.stage) - stageOrder(right.stage);
    });
  }

  // Newest utterance first (order collected oldest→newest).
  return order
    .slice()
    .reverse()
    .slice(0, Math.max(0, limit))
    .map((id) => groups.get(id))
    .filter((group): group is UtteranceStageGroup => Boolean(group));
};

export const getUtteranceStageGroups = (limit = MAX_UTTERANCES): UtteranceStageGroup[] =>
  groupStagesByUtterance(stages, limit);

export const clearPipelineStageEvents = (): void => {
  stages.length = 0;
  notify();
};

export const subscribePipelineStages = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const stageDisplayLabel = (stage: string): string => {
  switch (stage) {
    case "asr":
      return "ASR (parapper)";
    case "normalize":
      return "Normalizer (azookey/zenz)";
    case "translate":
      return "Translator (HY-MT2)";
    default:
      return stage;
  }
};

/** Relative offset from the earliest stage start within an utterance (ms). */
export const relativeStageOffsetMs = (
  event: PipelineStageEvent,
  group: UtteranceStageGroup,
): number => {
  let origin = event.startedAt;
  for (const stage of group.stages) {
    if (stage.startedAt > 0 && stage.startedAt < origin) {
      origin = stage.startedAt;
    }
  }
  if (!Number.isFinite(origin) || origin <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(event.startedAt - origin));
};
