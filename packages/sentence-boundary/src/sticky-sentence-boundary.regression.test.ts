import { describe, expect, it } from "vitest";
import {
  mergeCaptionSentenceEndsForStickyPrefix,
  selectVisibleCaptionSentenceWithSticky,
} from "./index.js";

describe("sticky sentence-boundary state API", () => {
  const sticky = {
    previousText: "今日は晴れです",
    previousEnds: [7],
  };

  it("carries a prior boundary when a longer prefix loses its fresh end", () => {
    const currentText = "今日は晴れです明日は雨";

    expect(mergeCaptionSentenceEndsForStickyPrefix(currentText, {}, sticky)).toEqual([7]);
    expect(selectVisibleCaptionSentenceWithSticky(currentText, {}, sticky)).toBe("明日は雨");
  });

  it("merges a new punctuation boundary without restoring the stale lead", () => {
    const currentText = "今日は晴れです明日は雨。";

    expect(mergeCaptionSentenceEndsForStickyPrefix(currentText, {}, sticky)).toEqual([7, 12]);
    expect(selectVisibleCaptionSentenceWithSticky(currentText, {}, sticky)).toBe("明日は雨。");
  });

  it("ignores sticky state when the hypothesis no longer has the previous prefix", () => {
    const currentText = "明日は雨です";

    expect(mergeCaptionSentenceEndsForStickyPrefix(currentText, {}, sticky)).toBeNull();
    expect(selectVisibleCaptionSentenceWithSticky(currentText, {}, sticky)).toBe(currentText);
  });

  it("keeps carried offsets in Unicode-scalar units", () => {
    const currentText = "😀です次";
    const emojiSticky = {
      previousText: "😀です",
      previousEnds: [3],
    };

    expect(selectVisibleCaptionSentenceWithSticky(currentText, {}, emojiSticky)).toBe("次");
  });
});
