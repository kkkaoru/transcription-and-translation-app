// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCaptionDisplayTiming,
  getCaptionDisplayTimingStats,
  markCaptionDisplay,
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
    expect(getStructuredLogs({ maxLevel: "trace" })[0]).toMatchObject({
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
    expect(getStructuredLogs({ maxLevel: "trace" })[0]).toMatchObject({
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
});
