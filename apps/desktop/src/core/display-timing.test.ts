// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCaptionDisplayTiming,
  getCaptionDisplayTimingStats,
  markCaptionDisplay,
  subscribeCaptionDisplayTiming,
} from "./display-timing";
import { setVerbosePipelineLogging } from "./pipelineStages";
import { __resetStructuredLogForTests, getStructuredLogs } from "./structuredLog";
import type { CaptionPayload } from "./types";

const caption = (overrides: Partial<CaptionPayload> = {}): CaptionPayload => ({
  id: "utterance-1",
  sourceText: "こんにちは",
  translationText: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 1_400,
  receivedAt: 1_900,
  stage: "source",
  sequence: 0,
  isFinal: false,
  confidence: undefined,
  ...overrides,
});

afterEach(() => {
  clearCaptionDisplayTiming();
  setVerbosePipelineLogging(false);
  __resetStructuredLogForTests();
  vi.restoreAllMocks();
});

describe("caption display timing", () => {
  it("logs pipeline-to-display and event-to-display latency for the first source paint", () => {
    setVerbosePipelineLogging(true);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    markCaptionDisplay(caption());

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("[display] first-paint id=utterance-1"),
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining("sincePipelineStart=600ms"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("sinceReceived=100ms"));
    expect(getCaptionDisplayTimingStats()).toMatchObject({
      sourceSincePipelineStartMs: 600,
      sourceEventToPaintMs: 100,
      utteranceId: "utterance-1",
    });
    expect(
      getStructuredLogs({ maxLevel: "trace" }).find((row) => row.stage === "display"),
    ).toMatchObject({
      source: "frontend",
      stage: "display",
      chunkId: "utterance-1",
      message: "normalized source painted",
      durationMs: 600,
    });
  });

  it("logs translation paint latency from both pipeline start and first source paint", () => {
    setVerbosePipelineLogging(true);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(2_000).mockReturnValueOnce(2_350);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    markCaptionDisplay(caption());
    markCaptionDisplay(
      caption({
        translationText: "Hello",
        receivedAt: 2_300,
        stage: "translation",
        sequence: 1,
        isFinal: true,
      }),
    );

    expect(info).toHaveBeenLastCalledWith(
      expect.stringContaining("[display] translation-paint id=utterance-1"),
    );
    expect(info).toHaveBeenLastCalledWith(expect.stringContaining("sinceFirstPaint=350ms"));
    expect(info).toHaveBeenLastCalledWith(expect.stringContaining("sincePipelineStart=950ms"));
    expect(info).toHaveBeenLastCalledWith(expect.stringContaining("sinceReceived=50ms"));
    expect(getCaptionDisplayTimingStats()).toMatchObject({
      translationSincePipelineStartMs: 950,
      translationEventToPaintMs: 50,
      translationSinceSourcePaintMs: 350,
    });
    expect(
      getStructuredLogs({ maxLevel: "trace" }).find((row) => row.message === "translation painted"),
    ).toMatchObject({
      stage: "display",
      message: "translation painted",
      durationMs: 950,
    });
  });

  it("never schedules a timer or dwell when recording the first source paint", () => {
    // display-timing is metrics-only: first paint must not be gated by setTimeout.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    markCaptionDisplay(caption({ sourceText: "遅延なし", translationText: "" }));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("suppresses structured log when verbose logging is off", () => {
    setVerbosePipelineLogging(false);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    markCaptionDisplay(caption());

    expect(info.mock.calls.some((call) => String(call[0]).includes("[display]"))).toBe(false);
    // But stats are still recorded.
    expect(getCaptionDisplayTimingStats()).toMatchObject({
      sourceSincePipelineStartMs: 600,
      sourceEventToPaintMs: 100,
      utteranceId: "utterance-1",
    });
  });

  it("returns null for lagPart when origin is zero or non-finite", () => {
    setVerbosePipelineLogging(true);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    markCaptionDisplay(caption({ startedAt: 0, receivedAt: Number.NaN }));

    // Console output should not include sincePipelineStart or sinceReceived since origins are null.
    const calls = info.mock.calls.map((c) => c[0]);
    const output = calls.join(" ");
    expect(output).toContain("[display] first-paint");
    expect(output).not.toContain("sincePipelineStart=");
    expect(output).not.toContain("sinceReceived=");
  });

  it("ignores empty source text for first paint tracking", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);

    markCaptionDisplay(caption({ sourceText: "", translationText: "Hello" }));
    markCaptionDisplay(caption({ sourceText: "   ", translationText: "こんにちは" }));

    // No first paint should be recorded for empty/whitespace source.
    const stats = getCaptionDisplayTimingStats();
    expect(stats.sourceSincePipelineStartMs).toBeNull();
  });

  it("tracks source paint when it arrives first, then translation without prior source", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(2_000).mockReturnValueOnce(2_500);

    // Translation caption arriving with non-empty source but no prior source paint.
    markCaptionDisplay(
      caption({
        sourceText: "こんにちは",
        translationText: "Hello",
        stage: "translation",
        isFinal: true,
        sequence: 0,
      }),
    );

    const stats = getCaptionDisplayTimingStats();
    // Should have remembered the source paint time even though it was not a separate paint.
    // wall = 2500, first remembered at 2500, so sinceSourcePaint = 0
    expect(stats.translationSinceSourcePaintMs).toBe(0);
  });

  it("suppresses console and structured log for translation when verbose is off", () => {
    setVerbosePipelineLogging(false);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(2_000).mockReturnValueOnce(2_350);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    markCaptionDisplay(caption());
    expect(info.mock.calls.some((call) => String(call[0]).includes("[display]"))).toBe(false);

    markCaptionDisplay(
      caption({
        translationText: "Hello",
        receivedAt: 2_300,
        stage: "translation",
        sequence: 1,
        isFinal: true,
      }),
    );

    // Second call should not log the display-timing console line either.
    expect(info.mock.calls.some((call) => String(call[0]).includes("[display]"))).toBe(false);
    // But stats should be updated. (2350 - 1400 startedAt = 950ms)
    expect(getCaptionDisplayTimingStats()).toMatchObject({
      translationSincePipelineStartMs: 950,
      translationEventToPaintMs: 50,
      translationSinceSourcePaintMs: 350,
    });
  });

  it("handles caption with null/undefined origins gracefully", () => {
    setVerbosePipelineLogging(true);
    vi.spyOn(Date, "now").mockReturnValue(2_000);

    markCaptionDisplay(caption({ startedAt: 0, receivedAt: undefined }));

    const stats = getCaptionDisplayTimingStats();
    expect(stats.sourceSincePipelineStartMs).toBeNull();
    expect(stats.sourceEventToPaintMs).toBeNull();
  });

  it("tracks translation paint with null sinceSourcePaint when no prior source", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(2_000).mockReturnValueOnce(2_500);

    // Translation paint arrives first, with empty source text (no prior paint).
    markCaptionDisplay(
      caption({
        sourceText: "",
        translationText: "Hello",
        stage: "translation",
        isFinal: true,
      }),
    );

    const stats = getCaptionDisplayTimingStats();
    expect(stats.translationSinceSourcePaintMs).toBeNull();
  });

  it("evicts oldest caption id when firstPaintById exceeds MAX_TRACKED (32)", () => {
    const now = vi.spyOn(Date, "now");

    // Create and paint 33 captions with distinct ids.
    for (let i = 0; i < 33; i++) {
      now.mockReturnValueOnce(2_000 + i);
      markCaptionDisplay(
        caption({
          id: `utterance-${i}`,
          sourceText: `text-${i}`,
          translationText: "",
        }),
      );
    }

    // Now paint a translation for utterance-0. It should not be tracked (evicted).
    now.mockReturnValueOnce(3_500);
    markCaptionDisplay(
      caption({
        id: "utterance-0",
        sourceText: "text-0",
        translationText: "Hello",
        stage: "translation",
        isFinal: true,
      }),
    );

    const stats = getCaptionDisplayTimingStats();
    // Even though utterance-0's source was evicted, the translation paint re-remembers it
    // at the translation paint time (3500), so sinceSourcePaintMs = 0
    expect(stats.translationSinceSourcePaintMs).toBe(0);
  });

  it("notifies subscribers when display stats change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCaptionDisplayTiming(listener);
    vi.spyOn(Date, "now").mockReturnValue(2_000);

    markCaptionDisplay(caption());

    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    markCaptionDisplay(caption({ id: "utterance-2", sourceText: "more" }));

    // Listener should not be called after unsubscribe.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("recovers when a display subscriber throws", () => {
    const throwingListener = vi.fn(() => {
      throw new Error("Display listener error");
    });
    const goodListener = vi.fn();
    subscribeCaptionDisplayTiming(throwingListener);
    subscribeCaptionDisplayTiming(goodListener);

    vi.spyOn(Date, "now").mockReturnValue(2_000);

    // Both listeners should be called despite the throw.
    markCaptionDisplay(caption());

    expect(throwingListener).toHaveBeenCalled();
    expect(goodListener).toHaveBeenCalled();
  });

  it("clears display timing and notifies subscribers", () => {
    const listener = vi.fn();
    subscribeCaptionDisplayTiming(listener);
    vi.spyOn(Date, "now").mockReturnValue(2_000);

    markCaptionDisplay(caption());
    expect(getCaptionDisplayTimingStats().utteranceId).toBe("utterance-1");

    clearCaptionDisplayTiming();

    expect(getCaptionDisplayTimingStats()).toMatchObject({
      sourceSincePipelineStartMs: null,
      sourceEventToPaintMs: null,
      translationSincePipelineStartMs: null,
      translationEventToPaintMs: null,
      translationSinceSourcePaintMs: null,
      utteranceId: null,
      updatedAt: null,
    });
    expect(listener).toHaveBeenCalledTimes(2); // Once for paint, once for clear.
  });

  it("recovers when a clear subscriber throws", () => {
    const throwingListener = vi.fn(() => {
      throw new Error("Clear listener error");
    });
    const goodListener = vi.fn();
    subscribeCaptionDisplayTiming(throwingListener);
    subscribeCaptionDisplayTiming(goodListener);

    vi.spyOn(Date, "now").mockReturnValue(2_000);
    markCaptionDisplay(caption());

    // Both should be called during clear despite the throw.
    clearCaptionDisplayTiming();

    expect(throwingListener).toHaveBeenCalledTimes(2); // paint + clear
    expect(goodListener).toHaveBeenCalledTimes(2);
  });

  it("treats translation with isFinal=true and non-empty translation as a translation paint", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);

    markCaptionDisplay(caption());
    markCaptionDisplay(
      caption({
        translationText: "実装完了",
        isFinal: true,
        // stage is not explicitly set, but isFinal + translationText triggers translation path
      }),
    );

    const stats = getCaptionDisplayTimingStats();
    expect(stats.translationSincePipelineStartMs).toBe(600);
  });

  it("includes structured log fields for display timing", () => {
    setVerbosePipelineLogging(true);
    vi.spyOn(Date, "now").mockReturnValue(2_000);

    markCaptionDisplay(caption());

    const logs = getStructuredLogs({ maxLevel: "trace" });
    const displayLog = logs.find((l) => l.stage === "display" && l.message.includes("source"));
    expect(displayLog).toBeDefined();
    expect(displayLog?.fields).toMatchObject({
      phase: "source",
      stageName: "source",
      sincePipelineStartMs: 600,
      eventToPaintMs: 100,
      sourceChars: 5, // Default caption has "こんにちは" (5 chars)
    });
  });
});
