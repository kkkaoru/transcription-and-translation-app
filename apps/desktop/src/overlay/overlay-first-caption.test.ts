import { describe, expect, it } from "vitest";
import type { CaptionPayload } from "../core/types";
import {
  isStaleOverlayAsrStage,
  overlayAsrFenceFromCaption,
  overlayAsrSessionKey,
  overlayAsrStageFence,
  parapperSessionKey,
  rearmPreviewHold,
  retainHeldOverlayCaption,
  shouldBufferOverlayAsrStageForFold,
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

  it("drops untagged delayed live ASR from the idle Parapper session", () => {
    const fence = overlayAsrStageFence({
      utteranceId: "parapper:s:1:8",
      at: 80,
      startedAt: 40,
    });
    const idleSession = overlayAsrSessionKey(fence.utteranceId);
    expect(idleSession).toBe("parapper:s:1");
    expect(parapperSessionKey(fence.utteranceId)).toBe("s:1");
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:1:8", at: 200, startedAt: 150 },
        fence,
        true,
        "live",
        idleSession,
      ),
    ).toBe(true);
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:1:9", at: 220, startedAt: 180 },
        fence,
        true,
        "live",
        idleSession,
      ),
    ).toBe(true);
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:1:9", at: 220, startedAt: 180 },
        overlayAsrStageFence({
          utteranceId: "parapper:s:2:1",
          at: 40,
          startedAt: 10,
        }),
        false,
        "live",
        idleSession,
      ),
    ).toBe(true);
  });

  it("keeps untagged live ASR from a new Parapper session after idle", () => {
    const fence = overlayAsrStageFence({
      utteranceId: "parapper:s:1:8",
      at: 80,
      startedAt: 40,
    });
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:2:1", at: 10, startedAt: 1 },
        fence,
        true,
        "live",
        overlayAsrSessionKey(fence.utteranceId),
      ),
    ).toBe(false);
  });

  it("drops untagged delayed live ASR with a non-parapper id after idle", () => {
    const fence = overlayAsrStageFence({
      utteranceId: "chunk-1",
      at: 80,
      startedAt: 40,
    });
    const idleSession = overlayAsrSessionKey(fence.utteranceId);
    expect(idleSession).toBe("chunk-1");
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "chunk-1", at: 200, startedAt: 150 },
        fence,
        true,
        "live",
        idleSession,
      ),
    ).toBe(true);
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "chunk-2", at: 220, startedAt: 180 },
        fence,
        true,
        "live",
        idleSession,
      ),
    ).toBe(true);
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:2:1", at: 10, startedAt: 1 },
        fence,
        true,
        "live",
        idleSession,
      ),
    ).toBe(false);
  });

  it("drops untagged delayed ASR history from the idle session even when at is later", () => {
    const fence = overlayAsrStageFence({
      utteranceId: "parapper:s:1:8",
      at: 80,
      startedAt: 40,
    });
    const idleSession = overlayAsrSessionKey(fence.utteranceId);
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:1:8", at: 220, startedAt: 180 },
        fence,
        true,
        "history",
        idleSession,
      ),
    ).toBe(true);
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:1:9", at: 240, startedAt: 200 },
        fence,
        true,
        "history",
        idleSession,
      ),
    ).toBe(true);
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "chunk-2", at: 220, startedAt: 180 },
        overlayAsrStageFence({
          utteranceId: "chunk-1",
          at: 80,
          startedAt: 40,
        }),
        true,
        "history",
        "chunk-1",
      ),
    ).toBe(true);
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "parapper:s:2:1", at: 10, startedAt: 1 },
        fence,
        true,
        "history",
        idleSession,
      ),
    ).toBe(false);
  });

  it("keeps untagged live ASR from a new web-speech attempt after idle", () => {
    const fence = overlayAsrStageFence({
      utteranceId: "web-speech:1:1000",
      at: 80,
      startedAt: 40,
    });
    expect(overlayAsrSessionKey(fence.utteranceId)).toBe("web-speech:1");
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "web-speech:1:1500", at: 200, startedAt: 150 },
        fence,
        true,
        "live",
        overlayAsrSessionKey(fence.utteranceId),
      ),
    ).toBe(true);
    expect(
      isStaleOverlayAsrStage(
        { utteranceId: "web-speech:2:10", at: 10, startedAt: 1 },
        fence,
        true,
        "live",
        overlayAsrSessionKey(fence.utteranceId),
      ),
    ).toBe(false);
  });
});

describe("shouldBufferOverlayAsrStageForFold", () => {
  const fence = overlayAsrStageFence({
    utteranceId: "parapper:s:1:8",
    at: 80,
    startedAt: 10,
  });

  it("keeps same-turn older history rows after a live tail-only fence", () => {
    expect(
      shouldBufferOverlayAsrStageForFold(
        { utteranceId: "parapper:s:1:8", at: 40, startedAt: 10 },
        fence,
        false,
        "history",
      ),
    ).toBe(true);
    expect(
      shouldBufferOverlayAsrStageForFold(
        { utteranceId: "parapper:s:1:8", at: 80, startedAt: 10 },
        fence,
        false,
        "history",
      ),
    ).toBe(true);
  });

  it("does not buffer previous-session or idle rows", () => {
    expect(
      shouldBufferOverlayAsrStageForFold(
        { utteranceId: "parapper:s:1:8", at: 40, startedAt: 10, captureGeneration: 1 },
        overlayAsrStageFence({
          utteranceId: "parapper:s:1:8",
          at: 80,
          startedAt: 10,
          captureGeneration: 2,
        }),
        true,
        "history",
      ),
    ).toBe(false);
    expect(
      shouldBufferOverlayAsrStageForFold(
        { utteranceId: "parapper:s:1:8", at: 200, startedAt: 150 },
        fence,
        true,
        "live",
        overlayAsrSessionKey(fence.utteranceId),
      ),
    ).toBe(false);
  });
});
