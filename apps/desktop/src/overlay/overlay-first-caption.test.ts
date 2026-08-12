import { describe, expect, it } from "vitest";
import type { CaptionPayload } from "../core/types";
import {
  isStaleOverlayAsrStage,
  overlayAsrFenceFromCaption,
  overlayAsrStageFence,
  rearmPreviewHold,
  retainHeldOverlayCaption,
  shouldHoldCaptionOverPreview,
  shouldSettleAsrHistoryReplay,
} from "./overlay-first-caption";

const caption = (overrides: Partial<CaptionPayload>): CaptionPayload => ({
  id: "parapper:s:1:8",
  sourceText: "今日は",
  translationText: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 10,
  receivedAt: 20,
  stage: "source",
  sequence: 0,
  isFinal: false,
  ...overrides,
});

describe("shouldHoldCaptionOverPreview", () => {
  it("holds a short non-provisional latest while ASR history is still in flight", () => {
    expect(shouldHoldCaptionOverPreview("preview", caption({}), false)).toBe(true);
  });

  it("lets provisional ASR replace preview before history settles", () => {
    expect(
      shouldHoldCaptionOverPreview(
        "preview",
        caption({ sourceText: "きょうはいいてんきですね", provisional: true }),
        false,
      ),
    ).toBe(false);
  });

  it("does not hold after ASR history has settled or once preview is gone", () => {
    expect(shouldHoldCaptionOverPreview("preview", caption({}), true)).toBe(false);
    expect(shouldHoldCaptionOverPreview("parapper:s:1:8", caption({}), false)).toBe(false);
  });
});

describe("rearmPreviewHold", () => {
  it("re-arms the short-latest hold when idle restores preview", () => {
    const next = rearmPreviewHold("preview", true);
    expect(next.asrHistorySettled).toBe(false);
    expect(next.heldOverPreview).toBeNull();
    expect(shouldHoldCaptionOverPreview("preview", caption({}), next.asrHistorySettled)).toBe(true);
  });

  it("does not hold forever when idle restores empty or pipeline stages are unavailable", () => {
    expect(rearmPreviewHold("empty", true).asrHistorySettled).toBe(true);
    expect(rearmPreviewHold("preview", false).asrHistorySettled).toBe(true);
    expect(
      shouldHoldCaptionOverPreview(
        "preview",
        caption({}),
        rearmPreviewHold("preview", false).asrHistorySettled,
      ),
    ).toBe(false);
  });
});

describe("retainHeldOverlayCaption", () => {
  it("keeps a longer held surface over a later shorter candidate", () => {
    const longer = caption({
      sourceText: "きょうはいいてんきですね",
      azookeyInputText: "きょうはいいてんきですね",
      startedAt: 40,
      receivedAt: 80,
    });
    const shorter = caption({ sourceText: "今日は", receivedAt: 90 });
    expect(retainHeldOverlayCaption(null, longer)).toEqual(longer);
    expect(retainHeldOverlayCaption(longer, shorter)?.sourceText).toBe("きょうはいいてんきですね");
  });
});

describe("isStaleOverlayAsrStage", () => {
  const previous = overlayAsrStageFence({
    utteranceId: "parapper:s:1:8",
    at: 80,
    startedAt: 40,
    captureGeneration: 1,
  });

  it("ignores previous-session history after idle even when the snapshot is still present", () => {
    expect(isStaleOverlayAsrStage(previous, previous, true, "history")).toBe(true);
    expect(
      isStaleOverlayAsrStage(
        { ...previous, utteranceId: "parapper:s:1:7", at: 70, captureGeneration: 1 },
        previous,
        true,
        "history",
      ),
    ).toBe(true);
  });

  it("keeps a newer capture generation so the next session can still replay ASR first", () => {
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:2:1", at: 10, startedAt: 1, captureGeneration: 2 },
        previous,
        true,
        "history",
      ),
    ).toBe(false);
  });

  it("drops live ASR from the idle generation and accepts the next generation", () => {
    expect(isStaleOverlayAsrStage(previous, previous, true, "live")).toBe(true);
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:2:1", at: 10, startedAt: 1, captureGeneration: 2 },
        previous,
        true,
        "live",
      ),
    ).toBe(false);
  });

  it("treats an invalidated history snapshot without a fence as stale", () => {
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:1:8", at: 80, startedAt: 40 },
        null,
        true,
        "history",
      ),
    ).toBe(true);
    expect(shouldSettleAsrHistoryReplay(false, true)).toBe(false);
    expect(shouldSettleAsrHistoryReplay(true, true)).toBe(true);
    expect(shouldSettleAsrHistoryReplay(false, false)).toBe(true);
  });

  it("does not treat a newer no-generation history row as the idle fence", () => {
    const fromCaption = overlayAsrFenceFromCaption(caption({ receivedAt: 20 }));
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:1:8", at: 80, startedAt: 40 },
        fromCaption,
        true,
        "history",
      ),
    ).toBe(false);
  });
});
