import { describe, expect, it } from "vitest";
import { detectCaptionSentenceEnds, selectVisibleCaptionSentence } from "./index.js";

describe("hints-only sticky sentence-boundary regression", () => {
  const cases = [
    {
      label: "carries the prior boundary when a longer prefix loses its fresh end",
      previousText: "今日は晴れです",
      previousEnds: [7],
      text: "今日は晴れです明日は雨",
      expectedEnds: [7],
      expectedVisible: "明日は雨",
    },
    {
      label: "unions the prior copula boundary with a fresh terminal boundary",
      previousText: "今日は晴れです",
      previousEnds: [7],
      text: "今日は晴れです明日も晴れる予報です",
      expectedEnds: [7, 17],
      expectedVisible: "明日も晴れる予報です",
    },
    {
      label: "keeps both carried and fresh punctuation boundaries",
      previousText: "今日は晴れです",
      previousEnds: [7],
      text: "今日は晴れです明日は雨。",
      expectedEnds: [7, 12],
      expectedVisible: "明日は雨。",
    },
    {
      label: "does not carry a boundary across a non-prefix hypothesis",
      previousText: "今日は晴れです",
      previousEnds: [7],
      text: "明日は雨です",
      expectedEnds: [6],
      expectedVisible: "明日は雨です",
    },
    {
      label: "keeps carried offsets in Unicode-scalar units",
      previousText: "😀です",
      previousEnds: [3],
      text: "😀です次",
      expectedEnds: [3],
      expectedVisible: "次",
    },
  ] as const;

  it.each(cases)(
    "$label",
    ({ previousText, previousEnds, text, expectedEnds, expectedVisible }) => {
      const hints = { previousText, previousEnds: [...previousEnds] };

      expect(detectCaptionSentenceEnds(text, hints)).toEqual(expectedEnds);
      expect(selectVisibleCaptionSentence(text, hints)).toBe(expectedVisible);
    },
  );
});
