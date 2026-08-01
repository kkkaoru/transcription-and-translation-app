import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDiagnosticEvents,
  getDiagnosticEvents,
  getDiagnosticStoreRevision,
  pushDiagnosticEvent,
  subscribeDiagnosticEvents,
} from "./diagnostics";
import { __resetStructuredLogForTests, getStructuredLogs } from "./structuredLog";

afterEach(() => {
  clearDiagnosticEvents();
  __resetStructuredLogForTests();
});

describe("diagnostic event log", () => {
  it("records newest-first events and caps history", () => {
    clearDiagnosticEvents();
    for (let index = 0; index < 50; index += 1) {
      pushDiagnosticEvent("info", `event-${index}`);
    }
    const events = getDiagnosticEvents();
    expect(events).toHaveLength(48);
    expect(events[0]?.message).toBe("event-49");
    expect(events.at(-1)?.message).toBe("event-2");
    clearDiagnosticEvents();
    expect(getDiagnosticEvents()).toEqual([]);
  });

  it("mirrors diagnostic events into the structured log foundation", () => {
    pushDiagnosticEvent("error", "boom", "detail-x");
    const logs = getStructuredLogs({ maxLevel: "error" });
    expect(logs.some((entry) => entry.message.includes("boom") && entry.error === "detail-x")).toBe(
      true,
    );
  });

  it("notifies subscribers for additions and clears without coupling producers", () => {
    const listener = vi.fn();
    const throwingListener = vi.fn(() => {
      throw new Error("listener failed");
    });
    const before = getDiagnosticStoreRevision();
    const unsubscribe = subscribeDiagnosticEvents(listener);
    const unsubscribeThrowing = subscribeDiagnosticEvents(throwingListener);

    pushDiagnosticEvent("info", "live");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(throwingListener).toHaveBeenCalledTimes(1);
    expect(getDiagnosticStoreRevision()).toBeGreaterThan(before);

    clearDiagnosticEvents();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    unsubscribeThrowing();
    pushDiagnosticEvent("info", "after-unsubscribe");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
