/** Lightweight in-memory diagnostic event log for the Debug panel. */

import { appendStructuredLog } from "./structuredLog";
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

const MAX_EVENTS = 48;
const events: DiagnosticEvent[] = [];
const listeners = new Set<() => void>();
let sequence = 0;
let storeRevision = 0;

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
  const safeMessage = typeof message === "string" ? message : String(message ?? "");
  const safeDetail = detail == null ? undefined : String(detail).trim() || undefined;
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
