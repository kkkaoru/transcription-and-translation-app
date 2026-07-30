/** Lightweight in-memory diagnostic event log for the Debug panel. */

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
let sequence = 0;

export const pushDiagnosticEvent = (
  kind: DiagnosticEventKind,
  message: string,
  detail?: string,
): DiagnosticEvent => {
  const entry: DiagnosticEvent = {
    id: `evt-${Date.now()}-${sequence++}`,
    at: new Date().toISOString(),
    kind,
    message,
    detail: detail?.trim() ? detail.trim() : undefined,
  };
  events.push(entry);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  return entry;
};

/** Newest first. */
export const getDiagnosticEvents = (): DiagnosticEvent[] => [...events].reverse();

export const clearDiagnosticEvents = (): void => {
  events.length = 0;
};
