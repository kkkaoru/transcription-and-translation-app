import { describe, expect, it } from "vitest";
import { detectCaptionSentenceEnds, selectVisibleCaptionSentence } from "./index.js";

describe("hints-only sticky sentence-boundary regression", () => {
  const cases = [
    {
      label: "keeps an open same-utterance tail joined instead of paging the lead away",
      previousText: "今日は晴れです",
      previousEnds: [7],
      text: "今日は晴れです明日は雨",
      expectedEnds: [],
      expectedVisible: "今日は晴れです明日は雨",
    },
    {
      label: "does not page a related copula tail until the next sentence is complete",
      previousText: "今日は晴れです",
      previousEnds: [7],
      text: "今日は晴れです明日も晴れる予報です",
      expectedEnds: [17],
      expectedVisible: "今日は晴れです明日も晴れる予報です",
    },
    {
      label: "pages only after a finished punctuated sentence, not a carried open copula",
      previousText: "今日は晴れです",
      previousEnds: [7],
      text: "今日は晴れです明日は雨。",
      expectedEnds: [12],
      expectedVisible: "今日は晴れです明日は雨。",
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
      label: "keeps a short emoji copula lead joined to a one-character related tail",
      previousText: "😀です",
      previousEnds: [3],
      text: "😀です次",
      expectedEnds: [],
      expectedVisible: "😀です次",
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
