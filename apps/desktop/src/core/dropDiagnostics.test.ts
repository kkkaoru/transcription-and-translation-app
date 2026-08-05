import { afterEach, describe, expect, it, vi } from "vitest";
import * as diagnostics from "./diagnostics";
import { clearDiagnosticEvents, getDiagnosticEvents } from "./diagnostics";
import {
  clearPipelineDrops,
  MAX_PIPELINE_DROP_BUCKETS,
  recordPipelineDrop,
  snapshotPipelineDrops,
} from "./dropDiagnostics";

afterEach(() => {
  clearPipelineDrops();
  clearDiagnosticEvents();
});

describe("pipeline drop diagnostics", () => {
  it("aggregates a drop by source and reason and emits a visible signal", () => {
    recordPipelineDrop("audio", 2, "silence-gate");
    recordPipelineDrop("audio", 1, "silence-gate");

    expect(snapshotPipelineDrops()).toEqual({
      total: 3,
      bySource: { audio: 3 },
      byReason: { "silence-gate": 3 },
      signals: [{ source: "audio", reason: "silence-gate", count: 3 }],
    });
    expect(
      getDiagnosticEvents().filter((event) => event.message === "Pipeline drop signal"),
    ).toHaveLength(2);
  });

  it("ignores invalid counts and bounds distinct buckets", () => {
    recordPipelineDrop("audio", 0, "ignored");
    recordPipelineDrop("audio", Number.NaN, "ignored");
    recordPipelineDrop("audio", -1, "ignored");
    // Runtime IPC callers can still provide non-string labels despite the
    // public type; normalize those values without throwing.
    recordPipelineDrop(42 as unknown as string, 1, 42 as unknown as string);
    expect(snapshotPipelineDrops()).toMatchObject({
      total: 1,
      bySource: { unknown: 1 },
      byReason: { unspecified: 1 },
    });
    clearPipelineDrops();

    for (let index = 0; index < MAX_PIPELINE_DROP_BUCKETS + 4; index += 1) {
      recordPipelineDrop("queue", 1, `reason-${index}`);
    }
    const snapshot = snapshotPipelineDrops();
    expect(snapshot.total).toBe(MAX_PIPELINE_DROP_BUCKETS + 4);
    expect(snapshot.signals.length).toBe(MAX_PIPELINE_DROP_BUCKETS);
  });

  it("normalizes whitespace-only labels to their fallback defaults", () => {
    recordPipelineDrop("   ", 1, "   ");
    expect(snapshotPipelineDrops()).toMatchObject({
      total: 1,
      bySource: { unknown: 1 },
      byReason: { unspecified: 1 },
    });
  });

  it("keeps the aggregate when a diagnostic subscriber throws", () => {
    const push = vi.spyOn(diagnostics, "pushDiagnosticEvent").mockImplementation(() => {
      throw new Error("diagnostic unavailable");
    });
    try {
      recordPipelineDrop("audio", 1, "stream-frame");
    } finally {
      push.mockRestore();
    }
    expect(snapshotPipelineDrops()).toMatchObject({ total: 1, bySource: { audio: 1 } });
  });

  it("aggregates native translation retirement as a fourth source", () => {
    recordPipelineDrop("translation", 1, "retired");
    expect(snapshotPipelineDrops()).toMatchObject({
      total: 1,
      bySource: { translation: 1 },
      byReason: { retired: 1 },
      signals: [{ source: "translation", reason: "retired", count: 1 }],
    });
  });

  it("clears all aggregate state at a capture boundary", () => {
    recordPipelineDrop("parapper-output-queue", 4, "stale-final-cursor");
    clearPipelineDrops();
    expect(snapshotPipelineDrops()).toEqual({ total: 0, bySource: {}, byReason: {}, signals: [] });
  });
});
