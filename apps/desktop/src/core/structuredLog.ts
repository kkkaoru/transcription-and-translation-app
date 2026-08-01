/**
 * Structured debug log foundation for frontend + backend-originated events.
 * Levels: error / warn / info / debug / trace. Ring buffer + JSON/JSONL export.
 */

import type { LogLevel, PipelineStageEvent } from "./types";

export type LogSource = "frontend" | "backend";

export type StructuredLogRecord = {
  id: string;
  /** ISO-8601 wall clock. */
  at: string;
  epochMs: number;
  level: LogLevel;
  source: LogSource;
  /** Pipeline stage when applicable: asr | normalize | translate */
  stage: string | null;
  /** Utterance / chunk correlation id. */
  chunkId: string | null;
  message: string;
  inputBytes: number | null;
  outputBytes: number | null;
  durationMs: number | null;
  error: string | null;
  fields: Record<string, string | number | boolean | null>;
};

export type StructuredLogInput = {
  level: LogLevel;
  source?: LogSource;
  message: string;
  stage?: string | null;
  chunkId?: string | null;
  inputBytes?: number | null;
  outputBytes?: number | null;
  durationMs?: number | null;
  error?: string | null;
  fields?: Record<string, string | number | boolean | null>;
  /** Override wall clock (tests / backend replay). */
  epochMs?: number;
};

const MAX_LOGS = 400;
const LEVEL_STORAGE_KEY = "kotoba-beacon.debug.logLevel";

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug", "trace"];

const REDACTED = "[REDACTED]";

const optionalText = (value: unknown): string | null => {
  if (value == null) {
    return null;
  }
  try {
    const text = typeof value === "string" ? value : String(value);
    return text.trim() || null;
  } catch {
    return null;
  }
};

// Keep this list deliberately conservative: diagnostic logs may include URLs,
// updater error envelopes, and user-provided model paths.  We redact values
// that are credential-shaped while retaining harmless context such as endpoint
// hosts and HTTP status codes.
const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth(?:orization)?|bearer|password|passwd|secret|private[-_]?key|client[-_]?secret|cookie|session[-_]?token|signature|^sig$)/i;

const redactCredentialText = (text: string): string => {
  let value = text;
  // PEM/private key blocks must be removed before line-oriented patterns.
  value = value.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
    REDACTED,
  );
  // Authorization and proxy credentials in URLs/headers.
  value = value.replace(/(\bBearer\s+)[A-Za-z0-9._~+\-/=]+/gi, `$1${REDACTED}`);
  value = value.replace(/(\bBasic\s+)[A-Za-z0-9+/=]+/gi, `$1${REDACTED}`);
  value = value.replace(/((?:https?|wss?):\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  // Secrets embedded in query strings. Keep the parameter name for support
  // searches while never persisting its value.
  value = value.replace(
    /([?&](?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth(?:orization)?|password|passwd|secret|signature|sig|code)=)[^&#\s]+/gi,
    `$1${REDACTED}`,
  );
  // JSON/log-style key/value assignments, including quoted values.
  value = value.replace(
    /((?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|authorization|password|passwd|secret|private[-_]?key|client[-_]?secret|cookie|session[-_]?token|signature|sig)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    `$1${REDACTED}`,
  );
  // JWTs are credential material even when emitted without a key name.
  value = value.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    REDACTED,
  );
  return value;
};

/** Redact credential-shaped values before a diagnostic message reaches logs. */
export const redactSensitiveText = (value: string | null | undefined): string | null => {
  if (value == null) {
    return null;
  }
  try {
    const trimmed = String(value).trim();
    return trimmed ? redactCredentialText(trimmed) : null;
  } catch {
    return null;
  }
};

/**
 * Sanitize arbitrary structured fields without dropping useful non-secret
 * metadata. Sensitive field names are replaced wholesale; other strings pass
 * through the credential-pattern scrubber above.
 */
export const sanitizeStructuredFields = (
  fields: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> => {
  const sanitized: Record<string, string | number | boolean | null> = {};
  try {
    for (const [key, raw] of Object.entries(fields ?? {})) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = raw == null ? null : REDACTED;
      } else if (typeof raw === "string") {
        sanitized[key] = redactCredentialText(raw);
      } else if (raw == null || typeof raw === "number" || typeof raw === "boolean") {
        sanitized[key] = raw;
      } else {
        // Keep the public record JSON-safe. Unknown nested values are not
        // trusted enough to retain verbatim (they may contain credentials or
        // circular references), so replace them wholesale.
        sanitized[key] = REDACTED;
      }
    }
  } catch {
    // Malformed IPC fields should not make the diagnostics path throw.
  }
  return sanitized;
};

const records: StructuredLogRecord[] = [];
const listeners = new Set<() => void>();
let sequence = 0;
let storeRevision = 0;

const readLevelPreference = (): LogLevel => {
  try {
    if (typeof localStorage === "undefined") {
      return "info";
    }
    return normalizeLogLevel(localStorage.getItem(LEVEL_STORAGE_KEY));
  } catch {
    return "info";
  }
};

// Keep module initialization safe in browser runtimes where localStorage is
// already available.  The preference reader calls normalizeLogLevel, so the
// initial value is assigned only after that helper's const binding exists.
let currentLevel: LogLevel = "info";

const notify = (): void => {
  storeRevision += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A diagnostic subscriber must not break future log writes.
    }
  }
};

export const isLogLevel = (value: unknown): value is LogLevel =>
  value === "error" ||
  value === "warn" ||
  value === "info" ||
  value === "debug" ||
  value === "trace";

export const normalizeLogLevel = (value: unknown, fallback: LogLevel = "info"): LogLevel => {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim().toLowerCase();
  return isLogLevel(trimmed) ? trimmed : fallback;
};

currentLevel = readLevelPreference();

export const logLevelRank = (level: LogLevel): number => LEVEL_RANK[level];

export const isLevelEnabled = (level: LogLevel, threshold: LogLevel = currentLevel): boolean =>
  logLevelRank(level) <= logLevelRank(threshold);

export const getLogLevel = (): LogLevel => currentLevel;

export const setLogLevel = (level: LogLevel | string): LogLevel => {
  const next = normalizeLogLevel(level, currentLevel);
  currentLevel = next;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LEVEL_STORAGE_KEY, next);
    }
  } catch {
    // Ignore quota / private mode failures.
  }
  notify();
  return next;
};

export const getStructuredLogRevision = (): number => storeRevision;

export const subscribeStructuredLogs = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Newest first. Optionally filter by maximum level rank (inclusive). */
export const getStructuredLogs = (options?: {
  limit?: number;
  maxLevel?: LogLevel;
}): StructuredLogRecord[] => {
  const limit = options?.limit ?? MAX_LOGS;
  const maxLevel = options?.maxLevel;
  const filtered =
    maxLevel == null ? records : records.filter((entry) => isLevelEnabled(entry.level, maxLevel));
  return [...filtered].reverse().slice(0, Math.max(0, limit));
};

export const clearStructuredLogs = (): void => {
  records.length = 0;
  notify();
};

const utf8ByteLength = (text: string): number => {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  // Fallback for rare environments without TextEncoder.
  return unescape(encodeURIComponent(text)).length;
};

/** Parse `wavBytes=1234` style ASR input snippets; otherwise UTF-8 length of text. */
export const estimateInputBytes = (snippet: string | null | undefined): number | null => {
  if (snippet == null || !snippet.trim()) {
    return null;
  }
  const match = /wavBytes\s*=\s*(\d+)/i.exec(snippet);
  if (match?.[1]) {
    return Number(match[1]);
  }
  return utf8ByteLength(snippet);
};

export const estimateOutputBytes = (text: string | null | undefined): number | null => {
  if (text == null || text === "") {
    return null;
  }
  return utf8ByteLength(text);
};

const writeConsole = (record: StructuredLogRecord): void => {
  if (typeof console === "undefined") {
    return;
  }
  const label = `[${record.level}] [${record.source}]${record.stage ? ` [${record.stage}]` : ""} ${record.message}`;
  const detail = {
    id: record.id,
    at: record.at,
    chunkId: record.chunkId,
    inputBytes: record.inputBytes,
    outputBytes: record.outputBytes,
    durationMs: record.durationMs,
    error: record.error,
    fields: Object.keys(record.fields).length > 0 ? record.fields : undefined,
  };
  // Structured debug logger intentionally mirrors filtered events to the console.
  // Console adapters can be missing/throwing in embedded webviews; logging must
  // never prevent the in-memory row or its subscribers from progressing.
  try {
    if (record.level === "error") {
      // biome-ignore lint/suspicious/noConsole: structured debug logger
      console.error(label, detail);
    } else if (record.level === "warn") {
      // biome-ignore lint/suspicious/noConsole: structured debug logger
      console.warn(label, detail);
    } else if (record.level === "info") {
      // biome-ignore lint/suspicious/noConsole: structured debug logger
      console.info(label, detail);
    } else {
      // biome-ignore lint/suspicious/noConsole: structured debug logger
      console.debug(label, detail);
    }
  } catch {
    // Ignore console transport failures; the ring buffer remains authoritative.
  }
};

export const appendStructuredLog = (input: StructuredLogInput): StructuredLogRecord => {
  const epochMs =
    typeof input.epochMs === "number" && Number.isFinite(input.epochMs)
      ? Math.round(input.epochMs)
      : Date.now();
  // IPC callers and replay tools are not type-safe at runtime. Normalize the
  // severity/source before retaining or filtering a row so malformed payloads
  // can never make the Debug panel disappear or poison the ring buffer.
  const level = normalizeLogLevel(input.level, "info");
  const source: LogSource = input.source === "backend" ? "backend" : "frontend";
  const message = optionalText(input.message) ?? "(empty)";
  const stage = optionalText(input.stage);
  const chunkId = optionalText(input.chunkId);
  const error = optionalText(input.error);
  const record: StructuredLogRecord = {
    id: `slog-${epochMs}-${sequence++}`,
    at: new Date(epochMs).toISOString(),
    epochMs,
    level,
    source,
    stage: stage ? redactCredentialText(stage) : null,
    chunkId: chunkId ? redactCredentialText(chunkId) : null,
    message: redactCredentialText(message) || "(empty)",
    inputBytes:
      typeof input.inputBytes === "number" && Number.isFinite(input.inputBytes)
        ? Math.max(0, Math.round(input.inputBytes))
        : null,
    outputBytes:
      typeof input.outputBytes === "number" && Number.isFinite(input.outputBytes)
        ? Math.max(0, Math.round(input.outputBytes))
        : null,
    durationMs:
      typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
        ? Math.max(0, Math.round(input.durationMs))
        : null,
    error: error ? redactCredentialText(error) : null,
    fields: sanitizeStructuredFields(input.fields),
  };
  records.push(record);
  if (records.length > MAX_LOGS) {
    records.splice(0, records.length - MAX_LOGS);
  }
  if (isLevelEnabled(record.level)) {
    writeConsole(record);
  }
  notify();
  return record;
};

/** Convenience wrapper used by app code. */
export const logStructured = (input: StructuredLogInput): StructuredLogRecord =>
  appendStructuredLog(input);

/**
 * Convert a pipeline stage event into a structured log row.
 * Failures → warn/error; successes → info (so per-stage activity is visible at default level).
 * Verbose flag controls payload detail (I/O sample inclusion), not the log level.
 */
export const logPipelineStageEvent = (
  event: PipelineStageEvent,
  options?: { verbose?: boolean; source?: LogSource },
): StructuredLogRecord => {
  const verbose = options?.verbose ?? false;
  // Successes are always logged at info level so they're visible in the debug panel
  // at the default log level. The verbose flag controls only payload detail (I/O samples).
  const level: LogLevel = event.ok ? "info" : event.error ? "error" : "warn";
  const inputBytes = estimateInputBytes(event.inputSnippet);
  const outputBytes = estimateOutputBytes(event.outputText);
  return appendStructuredLog({
    level,
    source: options?.source ?? "backend",
    stage: event.stage,
    chunkId: event.utteranceId,
    message: event.ok
      ? `stage ${event.stage} ok (${event.durationMs}ms)`
      : `stage ${event.stage} failed (${event.durationMs}ms)`,
    inputBytes,
    outputBytes,
    durationMs: event.durationMs,
    error: event.error ?? null,
    epochMs: event.at > 0 ? event.at : undefined,
    fields: {
      modelId: event.modelId || null,
      startedAt: event.startedAt,
      endedAt: event.at,
      ok: event.ok,
      ...(verbose
        ? {
            inputSnippet: event.inputSnippet || null,
            outputText: event.outputText || null,
          }
        : {}),
    },
  });
};

export const formatLogsAsJson = (logs: StructuredLogRecord[] = getStructuredLogs()): string =>
  JSON.stringify(logs, null, 2);

export const formatLogsAsJsonl = (logs: StructuredLogRecord[] = getStructuredLogs()): string =>
  logs
    .slice()
    .reverse() // chronological for file consumers
    .map((entry) => JSON.stringify(entry))
    .join("\n");

export const buildLogExportFilename = (format: "json" | "jsonl", now = new Date()): string => {
  const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `kotoba-beacon-logs-${stamp}.${format}`;
};

/**
 * Trigger a browser/Tauri webview download of the current structured log buffer.
 * Returns the filename used (or null when download APIs are unavailable).
 */
export const downloadStructuredLogs = (
  format: "json" | "jsonl" = "jsonl",
  options?: { maxLevel?: LogLevel; limit?: number },
): string | null => {
  if (typeof document === "undefined") {
    return null;
  }
  const logs = getStructuredLogs({
    maxLevel: options?.maxLevel,
    limit: options?.limit,
  });
  // Export chronological when writing files.
  const body = format === "json" ? formatLogsAsJson(logs) : formatLogsAsJsonl(logs);
  const filename = buildLogExportFilename(format);
  const mime = format === "json" ? "application/json" : "application/x-ndjson";
  const blob = new Blob([body], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the browser has a chance to start the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
  return filename;
};

/** Reset module state for unit tests. */
export const __resetStructuredLogForTests = (): void => {
  records.length = 0;
  sequence = 0;
  storeRevision = 0;
  currentLevel = "info";
  listeners.clear();
};
