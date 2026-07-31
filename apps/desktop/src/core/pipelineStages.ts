/**
 * In-memory store for independent pipeline stage events (ASR / normalize / translate).
 * Used by DebugPanel for continuous latency + text inspection without React coupling.
 */

import { pushDiagnosticEvent } from "./diagnostics";
import type { PipelineStageEvent, PipelineStageName, UtteranceStageGroup } from "./types";

const MAX_STAGE_EVENTS = 96;
const MAX_UTTERANCES = 24;
const VERBOSE_STORAGE_KEY = "kotoba-beacon.debug.verbosePipeline";

const stages: PipelineStageEvent[] = [];
const listeners = new Set<() => void>();
let sequence = 0;
/** Monotonic revision for useSyncExternalStore (stable getSnapshot identity). */
let storeRevision = 0;

const readVerbosePreference = (): boolean => {
  if (typeof localStorage === "undefined") {
    return false;
  }
  try {
    return localStorage.getItem(VERBOSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

let verboseLogging = readVerbosePreference();

const notify = (): void => {
  storeRevision += 1;
  for (const listener of listeners) {
    listener();
  }
};

/** Stable snapshot token — changes only when stages/verbose preference change. */
export const getPipelineStageStoreRevision = (): number => storeRevision;

export const isPipelineStageName = (value: string): value is PipelineStageName =>
  value === "asr" || value === "normalize" || value === "translate";

export const isVerbosePipelineLogging = (): boolean => verboseLogging;

export const setVerbosePipelineLogging = (enabled: boolean): void => {
  verboseLogging = enabled;
  if (typeof localStorage !== "undefined") {
    try {
      if (enabled) {
        localStorage.setItem(VERBOSE_STORAGE_KEY, "1");
      } else {
        localStorage.removeItem(VERBOSE_STORAGE_KEY);
      }
    } catch {
      // Ignore quota / private mode failures; in-memory flag still works.
    }
  }
  notify();
};

const logStage = (event: PipelineStageEvent): void => {
  if (!verboseLogging) {
    return;
  }
  const label = `[pipeline:${event.stage}] ${event.ok ? "ok" : "ERR"} ${event.durationMs}ms`;
  const detail = [
    `id=${event.utteranceId}`,
    event.modelId ? `model=${event.modelId}` : null,
    event.inputSnippet ? `in=${event.inputSnippet}` : null,
    event.outputText ? `out=${event.outputText}` : null,
    event.error ? `error=${event.error}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (event.ok) {
    // Intentional developer-facing verbose pipeline diagnostics.
    // biome-ignore lint/suspicious/noConsole: verbose debug mode writes stage samples to the console
    console.info(label, detail);
  } else {
    // biome-ignore lint/suspicious/noConsole: verbose debug mode writes stage samples to the console
    console.warn(label, detail);
  }
  pushDiagnosticEvent(
    event.ok ? "caption" : "error",
    `${event.stage} ${event.ok ? "ok" : "failed"} (${event.durationMs}ms)`,
    detail,
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
  const atRaw = record["at"];
  const at = typeof atRaw === "number" && Number.isFinite(atRaw) ? atRaw : Date.now();
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
  return {
    stage,
    utteranceId: utteranceId || `stage-${Date.now()}-${sequence}`,
    modelId,
    inputSnippet,
    outputText,
    durationMs,
    ok: Boolean(ok) && !error,
    error,
    at,
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
        return 0;
      case "normalize":
        return 1;
      case "translate":
        return 2;
      default:
        return 9;
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
