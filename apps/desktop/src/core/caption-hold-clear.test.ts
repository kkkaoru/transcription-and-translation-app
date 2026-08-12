import { describe, expect, it } from "vitest";
import { CAPTION_HOLD_CLEAR_MS, captionHoldClearDelayMs } from "./caption-hold-clear";
import type { CaptionPayload } from "./types";

const caption = (partial: Partial<CaptionPayload>): CaptionPayload => ({
  id: "u-1",
  sourceText: "今日は晴れ",
  translationText: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 1,
  receivedAt: 1,
  stage: "source",
  sequence: 0,
  isFinal: false,
  ...partial,
});

describe("captionHoldClearDelayMs", () => {
  it("skips empty, preview, and placeholder captions", () => {
    expect(captionHoldClearDelayMs(caption({ sourceText: "", translationText: "" }))).toBeNull();
    expect(captionHoldClearDelayMs(caption({ id: "preview" }))).toBeNull();
    expect(captionHoldClearDelayMs(caption({ id: "empty", sourceText: "x" }))).toBeNull();
  });

  it("gives finalized and translated captions a stream-readable hold", () => {
    expect(CAPTION_HOLD_CLEAR_MS).toBeGreaterThanOrEqual(4_000);
    expect(captionHoldClearDelayMs(caption({ isFinal: true }))).toBe(CAPTION_HOLD_CLEAR_MS);
    expect(
      captionHoldClearDelayMs(caption({ isFinal: false, translationText: "It is sunny today" })),
    ).toBe(CAPTION_HOLD_CLEAR_MS);
  });

  it("does not auto-clear non-final captions during long speech gaps", () => {
    expect(captionHoldClearDelayMs(caption({ isFinal: false, provisional: true }))).toBeNull();
    expect(captionHoldClearDelayMs(caption({ isFinal: false }))).toBeNull();
  });
});
