import { describe, expect, it } from "vitest";
import type { CaptionPayload } from "../core/types";
import {
  rearmPreviewHold,
  retainHeldOverlayCaption,
  shouldHoldCaptionOverPreview,
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
