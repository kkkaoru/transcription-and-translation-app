import { describe, expect, it } from "vitest";
import { clearDiagnosticEvents, getDiagnosticEvents, pushDiagnosticEvent } from "./diagnostics";

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
});
