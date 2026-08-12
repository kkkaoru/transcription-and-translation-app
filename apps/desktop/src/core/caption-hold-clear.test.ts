import { describe, expect, it } from "vitest";
import {
  CAPTION_HOLD_CLEAR_MS,
  captionHoldClearDelayMs,
  captionHoldClearEpoch,
  shouldApplyCaptionHoldClear,
  shouldBlankCaptionForHoldClear,
} from "./caption-hold-clear";
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

describe("shouldApplyCaptionHoldClear", () => {
  it("rejects a stale hold when a newer utterance already replaced the plate", () => {
    const held = caption({
      id: "parapper:s:t:1",
      sourceText: "今日は晴れです",
      isFinal: true,
      receivedAt: 1_000,
    });
    const nextTurn = caption({
      id: "parapper:s:t:2",
      sourceText: "明日は雨です",
      isFinal: true,
      receivedAt: 1_000 + CAPTION_HOLD_CLEAR_MS,
    });
    const heldEpoch = captionHoldClearEpoch(held);
    expect(shouldApplyCaptionHoldClear(heldEpoch, held)).toBe(true);
    expect(shouldApplyCaptionHoldClear(heldEpoch, nextTurn)).toBe(false);
  });
});

describe("shouldBlankCaptionForHoldClear", () => {
  it("blanks only when the epoch still matches a non-empty live caption", () => {
    const held = caption({
      id: "parapper:s:t:1",
      sourceText: "今日は晴れです",
      isFinal: true,
      receivedAt: 1_000,
    });
    const heldEpoch = captionHoldClearEpoch(held);
    expect(shouldBlankCaptionForHoldClear(heldEpoch, held)).toBe(true);
    expect(
      shouldBlankCaptionForHoldClear(
        heldEpoch,
        caption({
          id: "parapper:s:t:2",
          sourceText: "明日は雨です",
          isFinal: true,
          receivedAt: 1_000 + CAPTION_HOLD_CLEAR_MS,
        }),
      ),
    ).toBe(false);
    expect(
      shouldBlankCaptionForHoldClear(
        captionHoldClearEpoch(caption({ id: "preview" })),
        caption({ id: "preview" }),
      ),
    ).toBe(false);
    expect(
      shouldBlankCaptionForHoldClear(
        captionHoldClearEpoch(caption({ sourceText: "", translationText: "", isFinal: true })),
        caption({ sourceText: "", translationText: "", isFinal: true }),
      ),
    ).toBe(false);
  });
});
