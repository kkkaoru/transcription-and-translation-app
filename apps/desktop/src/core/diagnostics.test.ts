import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginCaptureStartupCorrelation,
  clearCaptureStartupCorrelations,
  clearDiagnosticEvents,
  getActiveCaptureStartupCorrelation,
  getDiagnosticEvents,
  getDiagnosticStoreRevision,
  MAX_CAPTURE_STARTUP_CORRELATION_EVENTS,
  MAX_CAPTURE_STARTUP_CORRELATIONS,
  markCaptureFirstCaption,
  markCaptureFirstForwardedPcm,
  markCaptureFirstSpeech,
  markCapturePrerollStats,
  markCaptureSessionReady,
  markCaptureStartupDiscard,
  pushDiagnosticEvent,
  snapshotCaptureStartupCorrelations,
  subscribeDiagnosticEvents,
} from "./diagnostics";
import * as structuredLog from "./structuredLog";
import { __resetStructuredLogForTests, getStructuredLogs } from "./structuredLog";

afterEach(() => {
  clearDiagnosticEvents();
  clearCaptureStartupCorrelations();
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

  it("redacts credential-shaped diagnostic details before UI retention", () => {
    const entry = pushDiagnosticEvent(
      "error",
      "request failed Authorization: Bearer abc.def.ghi",
      "https://example.test/?access_token=top-secret",
      { mirrorStructured: false },
    );

    expect(entry.message).not.toContain("abc.def.ghi");
    expect(entry.detail).not.toContain("top-secret");
    expect(entry.detail).toContain("[REDACTED]");
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

describe("capture startup correlation", () => {
  it("correlates prepare → ready → first PCM → speech → caption under one generation", () => {
    beginCaptureStartupCorrelation({
      captureGeneration: 3,
      mode: "parapper-continuous",
      epochMs: 1_000,
    });
    markCaptureSessionReady({ captureGeneration: 3, epochMs: 1_250 });
    markCapturePrerollStats(
      { prerollFrameCount: 4, prerollSampleCount: 6_400, prerollDurationMs: 400 },
      { captureGeneration: 3 },
    );
    markCaptureFirstForwardedPcm({ captureGeneration: 3, epochMs: 1_300 });
    markCaptureFirstSpeech({ captureGeneration: 3, epochMs: 1_400 });
    markCaptureFirstCaption({
      captureGeneration: 3,
      epochMs: 1_800,
      captionId: "parapper:sess:1:1",
    });

    const active = getActiveCaptureStartupCorrelation();
    expect(active).toMatchObject({
      captureGeneration: 3,
      mode: "parapper-continuous",
      prepareAtMs: 1_000,
      sessionReadyAtMs: 1_250,
      prepareToReadyMs: 250,
      prerollFrameCount: 4,
      prerollSampleCount: 6_400,
      prerollDurationMs: 400,
      firstForwardedPcmAtMs: 1_300,
      readyToFirstPcmMs: 50,
      firstSpeechAtMs: 1_400,
      firstCaptionAtMs: 1_800,
      prepareToFirstCaptionMs: 800,
      discardReason: null,
    });

    const events = getDiagnosticEvents();
    expect(events.some((event) => event.message.includes("prepare"))).toBe(true);
    expect(events.some((event) => event.message.includes("session.ready"))).toBe(true);
    expect(events.some((event) => event.message.includes("first forwarded PCM"))).toBe(true);
    expect(events.some((event) => event.message.includes("first caption"))).toBe(true);
    expect(events[0]?.detail).toContain("generation=3");

    const logs = getStructuredLogs();
    const correlationLogs = logs.filter((entry) => entry.stage === "capture-startup");
    expect(correlationLogs.length).toBeGreaterThanOrEqual(5);
    expect(correlationLogs.every((entry) => entry.fields["captureGeneration"] === 3)).toBe(true);
    expect(
      correlationLogs.some((entry) => entry.fields["correlationPhase"] === "first-caption"),
    ).toBe(true);
    expect(correlationLogs.some((entry) => entry.chunkId === "capture-gen:3")).toBe(true);
  });

  it("keeps first-* milestones idempotent and records discard reason once", () => {
    beginCaptureStartupCorrelation({ captureGeneration: 1, epochMs: 100 });
    markCaptureFirstForwardedPcm({ captureGeneration: 1, epochMs: 200 });
    markCaptureFirstForwardedPcm({ captureGeneration: 1, epochMs: 999 });
    markCaptureStartupDiscard({ reason: "superseded-generation", captureGeneration: 1 });
    markCaptureStartupDiscard({ reason: "later-reason", captureGeneration: 1 });

    const snapshot = snapshotCaptureStartupCorrelations();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.firstForwardedPcmAtMs).toBe(200);
    expect(snapshot[0]?.discardReason).toBe("superseded-generation");
  });

  it("swallows diagnostic/log transport failures while recording milestones", () => {
    beginCaptureStartupCorrelation({ captureGeneration: 42, epochMs: 10 });
    const append = vi.spyOn(structuredLog, "appendCaptureCorrelationLog").mockImplementation(() => {
      throw new Error("structured log unavailable");
    });
    try {
      expect(() => markCaptureSessionReady({ captureGeneration: 42, epochMs: 20 })).not.toThrow();
      expect(getActiveCaptureStartupCorrelation()?.sessionReadyAtMs).toBe(20);
    } finally {
      append.mockRestore();
    }
  });

  it("bounds retained correlation history across generations", () => {
    for (let generation = 1; generation <= MAX_CAPTURE_STARTUP_CORRELATIONS + 5; generation += 1) {
      beginCaptureStartupCorrelation({ captureGeneration: generation, epochMs: generation * 10 });
    }
    const snapshot = snapshotCaptureStartupCorrelations();
    expect(snapshot).toHaveLength(MAX_CAPTURE_STARTUP_CORRELATIONS);
    expect(snapshot[0]?.captureGeneration).toBe(MAX_CAPTURE_STARTUP_CORRELATIONS + 5);
    expect(snapshot.at(-1)?.captureGeneration).toBe(6);
  });

  it("covers null-generation, invalid inputs, and no-op milestone guards", () => {
    expect(getActiveCaptureStartupCorrelation()).toBeNull();
    expect(markCaptureSessionReady()).toBeNull();
    expect(markCaptureFirstForwardedPcm()).toBeNull();
    expect(markCaptureFirstSpeech()).toBeNull();
    expect(markCaptureFirstCaption()).toBeNull();
    expect(markCapturePrerollStats({ prerollFrameCount: 1 })).toBeNull();
    expect(markCaptureStartupDiscard({ reason: "start-failed" })).toBeNull();

    // No generation: bind the active (null-generation) correlation.
    beginCaptureStartupCorrelation({ mode: "  ", epochMs: Number.NaN });
    const active = getActiveCaptureStartupCorrelation();
    expect(active?.captureGeneration).toBeNull();
    expect(active?.mode).toBeNull();
    expect(active?.prepareAtMs).toBeTypeOf("number");

    // Idempotent prepare + mode fill-in once a real mode arrives.
    beginCaptureStartupCorrelation({ mode: "parapper-continuous", epochMs: 50 });
    expect(getActiveCaptureStartupCorrelation()?.mode).toBe("parapper-continuous");
    expect(getActiveCaptureStartupCorrelation()?.prepareAtMs).toBe(active?.prepareAtMs);

    // Invalid generation falls back to the active correlation.
    expect(markCaptureSessionReady({ captureGeneration: -1, epochMs: 80 })?.sessionReadyAtMs).toBe(
      80,
    );
    expect(
      markCaptureSessionReady({ captureGeneration: Number.NaN as unknown as number })
        ?.sessionReadyAtMs,
    ).toBe(80);
    expect(markCaptureSessionReady({ captureGeneration: "x" as unknown as number })).not.toBeNull();

    // Invalid preroll stats are ignored; only finite non-negative ints apply.
    markCapturePrerollStats(
      {
        prerollFrameCount: -3,
        prerollSampleCount: Number.NaN,
        prerollDurationMs: "nope" as unknown as number,
      },
      {},
    );
    expect(getActiveCaptureStartupCorrelation()?.prerollFrameCount).toBeNull();
    markCapturePrerollStats({
      prerollFrameCount: 2,
      prerollSampleCount: 3_200,
      prerollDurationMs: 200,
    });
    markCapturePrerollStats({
      prerollFrameCount: 2,
      prerollSampleCount: 3_200,
      prerollDurationMs: 200,
    });
    expect(getActiveCaptureStartupCorrelation()).toMatchObject({
      prerollFrameCount: 2,
      prerollSampleCount: 3_200,
      prerollDurationMs: 200,
    });

    markCaptureFirstSpeech({ epochMs: 120 });
    markCaptureFirstSpeech({ epochMs: 999 });
    markCaptureFirstCaption({ epochMs: 150, captionId: "   " });
    markCaptureFirstCaption({ epochMs: 999, captionId: "ignored-second" });
    expect(getActiveCaptureStartupCorrelation()?.firstSpeechAtMs).toBe(120);
    expect(getActiveCaptureStartupCorrelation()?.firstCaptionAtMs).toBe(150);

    markCaptureStartupDiscard({ reason: "   ", epochMs: 160 });
    expect(getActiveCaptureStartupCorrelation()?.discardReason).toBe("unspecified");
  });

  it("rebinds a historical generation and creates missing generations on demand", () => {
    beginCaptureStartupCorrelation({ captureGeneration: 10, mode: "a", epochMs: 1 });
    beginCaptureStartupCorrelation({ captureGeneration: 11, mode: "b", epochMs: 2 });
    expect(getActiveCaptureStartupCorrelation()?.captureGeneration).toBe(11);

    markCaptureFirstForwardedPcm({ captureGeneration: 10, epochMs: 40 });
    expect(getActiveCaptureStartupCorrelation()?.captureGeneration).toBe(10);
    expect(getActiveCaptureStartupCorrelation()?.firstForwardedPcmAtMs).toBe(40);

    // Unknown generation creates a tracker that inherits the previous mode.
    markCaptureFirstSpeech({ captureGeneration: 12, epochMs: 55 });
    expect(getActiveCaptureStartupCorrelation()).toMatchObject({
      captureGeneration: 12,
      mode: "a",
      firstSpeechAtMs: 55,
    });
  });

  it("stops emitting diagnostic events after the correlation event cap", () => {
    for (
      let generation = 1;
      generation <= MAX_CAPTURE_STARTUP_CORRELATION_EVENTS + 3;
      generation += 1
    ) {
      beginCaptureStartupCorrelation({ captureGeneration: generation, epochMs: generation });
      markCaptureSessionReady({ captureGeneration: generation, epochMs: generation + 1 });
    }
    const correlationEvents = getDiagnosticEvents().filter((event) =>
      event.message.startsWith("Capture startup:"),
    );
    expect(correlationEvents.length).toBeLessThanOrEqual(MAX_CAPTURE_STARTUP_CORRELATION_EVENTS);
  });
});
