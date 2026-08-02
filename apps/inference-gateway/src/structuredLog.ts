import { randomUUID } from "node:crypto";

export const PROVIDER_TURN_START = "provider_turn.start";
export const PROVIDER_TURN_END = "provider_turn.end";
export const PROVIDER_TURN_SKIP = "provider_turn.skip";

export type CorrelationContext = {
  requestId: string;
  sessionId: string;
  agentId: string | null;
  parentAgentId: string | null;
};

export type StructuredLogFields = Record<string, unknown>;

export const STRUCTURED_LOG_SCHEMA_VERSION = 1;

const REDACTED = "[REDACTED]";
const MAX_CORRELATION_LENGTH = 256;
const MAX_STRING_LENGTH = 4_096;
const MAX_OBJECT_ENTRIES = 64;
const MAX_ARRAY_ENTRIES = 64;
const MAX_SANITIZE_DEPTH = 4;

const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth(?:orization)?|bearer|password|passwd|secret|private[-_]?key|client[-_]?secret|cookie|session[-_]?token|signature|^sig$)/i;

const truncateText = (value: string): string =>
  value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;

const redactText = (value: string): string => {
  let redacted = value;
  redacted = redacted.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
    REDACTED,
  );
  redacted = redacted.replace(/(\bBearer\s+)[A-Za-z0-9._~+\-/=]+/gi, `$1${REDACTED}`);
  redacted = redacted.replace(/(\bBasic\s+)[A-Za-z0-9+/=]+/gi, `$1${REDACTED}`);
  redacted = redacted.replace(/((?:https?|wss?):\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  redacted = redacted.replace(
    /([?&](?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth(?:orization)?|password|passwd|secret|signature|sig|code)=)[^&#\s]+/gi,
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(
    /((?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|authorization|password|passwd|secret|private[-_]?key|client[-_]?secret|cookie|session[-_]?token|signature|sig)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    REDACTED,
  );
  return truncateText(redacted);
};

const boundedCorrelation = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  return value.trim().slice(0, MAX_CORRELATION_LENGTH) || null;
};

const headerValue = (headers: Headers, name: string): string | null =>
  boundedCorrelation(headers.get(name));

export const correlationFromHeaders = (headers: Headers): CorrelationContext => ({
  requestId: headerValue(headers, "x-request-id") ?? randomUUID(),
  sessionId: headerValue(headers, "x-session-id") ?? randomUUID(),
  agentId: headerValue(headers, "x-agent-id"),
  parentAgentId: headerValue(headers, "x-parent-agent-id"),
});

const safeCorrelation = (context: CorrelationContext): CorrelationContext => ({
  requestId: boundedCorrelation(context.requestId) ?? randomUUID(),
  sessionId: boundedCorrelation(context.sessionId) ?? randomUUID(),
  agentId: boundedCorrelation(context.agentId),
  parentAgentId: boundedCorrelation(context.parentAgentId),
});

export const correlationHeaders = (context: CorrelationContext): Record<string, string> => {
  const safe = safeCorrelation(context);
  return {
    "x-request-id": safe.requestId,
    "x-session-id": safe.sessionId,
    ...(safe.agentId ? { "x-agent-id": safe.agentId } : {}),
    ...(safe.parentAgentId ? { "x-parent-agent-id": safe.parentAgentId } : {}),
  };
};

const sanitizeValue = (key: string, value: unknown, depth: number): unknown => {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return value == null ? null : REDACTED;
  }
  if (depth > MAX_SANITIZE_DEPTH) {
    return "[TRUNCATED]";
  }
  if (value == null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ENTRIES).map((entry) => sanitizeValue("", entry, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_ENTRIES)) {
      output[childKey] = sanitizeValue(childKey, childValue, depth + 1);
    }
    return output;
  }
  return "[UNSUPPORTED]";
};

const sanitizeFields = (fields: StructuredLogFields): StructuredLogFields => {
  const output: StructuredLogFields = {};
  try {
    for (const [key, value] of Object.entries(fields).slice(0, MAX_OBJECT_ENTRIES)) {
      output[key] = sanitizeValue(key, value, 0);
    }
  } catch {
    // Diagnostics must never make a request fail.
  }
  return output;
};

export const emitStructuredLog = (
  event: string,
  context: CorrelationContext,
  fields: StructuredLogFields = {},
): void => {
  const safe = safeCorrelation(context);
  const record = {
    ...sanitizeFields(fields),
    schema_version: STRUCTURED_LOG_SCHEMA_VERSION,
    at: new Date().toISOString(),
    event: truncateText(event),
    request_id: safe.requestId,
    session_id: safe.sessionId,
    agent_id: safe.agentId,
    parent_agent_id: safe.parentAgentId,
  };
  // biome-ignore lint/suspicious/noConsole: structured JSON log sink
  console.info(JSON.stringify(record));
};
