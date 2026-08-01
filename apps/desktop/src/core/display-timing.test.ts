// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCaptionDisplayTiming, markCaptionDisplay } from "./display-timing";
import { setVerbosePipelineLogging } from "./pipelineStages";
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
  });
});
