import { selectVisibleCaptionSentence } from "@caption-bridge/sentence-boundary";
import { describe, expect, it } from "vitest";
import { captionGraphemes } from "../overlay/captions";
import {
  applyCaptionFreshnessWindow,
  CAPTION_FRESHNESS_MS,
  freshnessCloseOffsets,
  stampGraphemePaintedAt,
} from "./caption-freshness";
import type { CaptionPayload } from "./types";

const caption = (partial: Partial<CaptionPayload> = {}): CaptionPayload => ({
  id: "parapper:session:turn:1",
  sourceText: "",
  translationText: "It is sunny",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 1,
  receivedAt: 1,
  stage: "source",
  sequence: 0,
  isFinal: false,
  ...partial,
});

const paintedAt = (text: string, at = 0): number[] => captionGraphemes(text).map(() => at);

const windowOf = (
  sourceText: string,
  now: number,
  extra: {
    sentenceEndOffsets?: number[];
    softBreakOffsets?: number[];
    tokenCharEnds?: number[];
    graphemePaintedAt?: number[];
    lastGrowthAt?: number;
    previousSourceText?: string;
    translationText?: string;
  } = {},
): CaptionPayload =>
  applyCaptionFreshnessWindow({
    caption: caption({
      sourceText,
      translationText: extra.translationText ?? "It is sunny",
      sentenceEndOffsets: extra.sentenceEndOffsets,
      softBreakOffsets: extra.softBreakOffsets,
    }),
    now,
    graphemePaintedAt: extra.graphemePaintedAt ?? paintedAt(sourceText),
    lastGrowthAt: extra.lastGrowthAt ?? 0,
    previousSourceText: extra.previousSourceText ?? sourceText,
    tokenCharEnds: extra.tokenCharEnds,
  });

describe("caption freshness window", () => {
  it("closes after です and shows 明日は雨 after 5s even when 2× KEEP would retain the lead", () => {
    const text = "今日は晴れです明日は雨";
    expect(selectVisibleCaptionSentence(text, { sentenceEndOffsets: [7] })).toBe(text);
    expect(windowOf(text, 0, { sentenceEndOffsets: [7] }).sourceText).toBe(text);
    expect(windowOf(text, CAPTION_FRESHNESS_MS, { sentenceEndOffsets: [7] }).sourceText).toBe(
      "明日は雨",
    );
    expect(windowOf(text, CAPTION_FRESHNESS_MS, { sentenceEndOffsets: [7] }).translationText).toBe(
      "It is sunny",
    );
  });

  it("closes 形容詞基本形 + 明日は", () => {
    const text = "今日は寒い明日は";
    expect(windowOf(text, CAPTION_FRESHNESS_MS, { sentenceEndOffsets: [5] }).sourceText).toBe(
      "明日は",
    );
  });

  it("lets punctuation page immediately after freshness without waiting 5s", () => {
    const text = "終わりです。次";
    const fresh = windowOf(text, 0, { sentenceEndOffsets: [6] });
    expect(fresh.sourceText).toBe(text);
    expect(
      selectVisibleCaptionSentence(fresh.sourceText, {
        sentenceEndOffsets: fresh.sentenceEndOffsets,
      }),
    ).toBe("次");
  });

  it.each(["晴れですが寒い", "食べて", "隣の客は", "水を", "えー今日は", "東京駅は"])(
    "does not close %s",
    (text) => {
      expect(freshnessCloseOffsets(text, [])).toEqual([]);
      expect(windowOf(text, 0, { sentenceEndOffsets: [] }).sourceText).toBe(text);
    },
  );

  it("does not close こんにちはーきこえますかー or snap on interior に/は", () => {
    const text = "こんにちはーきこえますかー";
    expect(freshnessCloseOffsets(text, [5])).toEqual([]);
    const midKeep = windowOf(text, 1_000, {
      sentenceEndOffsets: [5],
      softBreakOffsets: [2, 4],
      graphemePaintedAt: paintedAt(text, 0),
    });
    expect(midKeep.sourceText).toBe(text);
    expect(midKeep.sourceText.startsWith("ー")).toBe(false);
  });

  it("does not close もう走る次いく from a surface copula guess", () => {
    const text = "もう走る次いく";
    expect(freshnessCloseOffsets(text, [])).toEqual([]);
    expect(windowOf(text, 0, { sentenceEndOffsets: [] }).sourceText).toBe(text);
    expect(
      applyCaptionFreshnessWindow({
        caption: caption({ sourceText: text, isFinal: true, translationText: "It is sunny" }),
        now: CAPTION_FRESHNESS_MS,
        graphemePaintedAt: paintedAt(text),
        lastGrowthAt: 0,
        previousSourceText: text,
      }).sourceText,
    ).toBe("");
  });

  it("keeps a pure interim without translation after 5s", () => {
    const text = "もう走る次いく";
    const display = applyCaptionFreshnessWindow({
      caption: caption({ sourceText: text, isFinal: false, translationText: "" }),
      now: CAPTION_FRESHNESS_MS,
      graphemePaintedAt: paintedAt(text),
      lastGrowthAt: 0,
      previousSourceText: text,
    });
    expect(display.sourceText).toBe(text);
  });

  it("allows a finalized standalone うん to expire after 5s idle without a translation", () => {
    const finalized = (sourceText: string, now: number): CaptionPayload =>
      applyCaptionFreshnessWindow({
        caption: caption({
          sourceText,
          isFinal: true,
          translationText: "",
        }),
        now,
        graphemePaintedAt: paintedAt(sourceText),
        lastGrowthAt: 0,
        previousSourceText: sourceText,
      });
    expect(finalized("うん", 0).sourceText).toBe("うん");
    expect(finalized("うん", CAPTION_FRESHNESS_MS).sourceText).toBe("");
    expect(finalized("うん", CAPTION_FRESHNESS_MS).translationText).toBe("");
  });

  it("allows a non-final translated caption to expire after 5s idle", () => {
    const text = "うん";
    const held = applyCaptionFreshnessWindow({
      caption: caption({ sourceText: text, isFinal: false, translationText: "yeah" }),
      now: CAPTION_FRESHNESS_MS - 1,
      graphemePaintedAt: paintedAt(text),
      lastGrowthAt: 0,
      previousSourceText: text,
    });
    expect(held.sourceText).toBe(text);
    expect(held.translationText).toBe("yeah");
    const expired = applyCaptionFreshnessWindow({
      caption: caption({ sourceText: text, isFinal: false, translationText: "yeah" }),
      now: CAPTION_FRESHNESS_MS,
      graphemePaintedAt: paintedAt(text),
      lastGrowthAt: 0,
      previousSourceText: text,
    });
    expect(expired.sourceText).toBe("");
    expect(expired.translationText).toBe("");
  });

  it("does not close 助動詞マス in 連用 or 基本, and does close です/でした/だった", () => {
    expect(freshnessCloseOffsets("しています今日は", [5])).toEqual([]);
    expect(freshnessCloseOffsets("今日は晴れです明日は", [7])).toEqual([7]);
    expect(freshnessCloseOffsets("昨日は雨でした今日は", [8])).toEqual([8]);
    expect(freshnessCloseOffsets("学生だった次", [5])).toEqual([5]);
    expect(
      windowOf("しています今日は", CAPTION_FRESHNESS_MS, { sentenceEndOffsets: [5] }).sourceText,
    ).toBe("");
  });

  it("keeps the newest chunk while the source is still growing instead of going empty", () => {
    const lead = "今日は晴れです";
    const text = "今日は晴れです明日は";
    const display = windowOf(text, CAPTION_FRESHNESS_MS, {
      sentenceEndOffsets: [7],
      previousSourceText: lead,
      lastGrowthAt: CAPTION_FRESHNESS_MS,
      graphemePaintedAt: [
        ...paintedAt(lead, 0),
        ...captionGraphemes("明日は").map(() => CAPTION_FRESHNESS_MS),
      ],
    });
    expect(display.sourceText).toBe("明日は");
    expect(display.sourceText.length).toBeGreaterThan(0);
  });

  it("keeps the newest open chunk when a rewrite would otherwise empty the plate", () => {
    const text = "明日は";
    const display = windowOf(text, CAPTION_FRESHNESS_MS, {
      previousSourceText: "昨日",
      lastGrowthAt: CAPTION_FRESHNESS_MS,
      graphemePaintedAt: paintedAt(text, 0),
    });
    expect(display.sourceText).toBe(text);
  });

  it("empties an idle open chunk at lastGrowthAt+5000 and clears translation with it", () => {
    const text = "食べて";
    const empty = windowOf(text, CAPTION_FRESHNESS_MS, {
      lastGrowthAt: 0,
      previousSourceText: text,
      translationText: "eating",
    });
    expect(empty.sourceText).toBe("");
    expect(empty.translationText).toBe("");
    const stillHeld = windowOf(text, CAPTION_FRESHNESS_MS - 1, {
      lastGrowthAt: 0,
      previousSourceText: text,
      translationText: "eating",
    });
    expect(stillHeld.sourceText).toBe(text);
    expect(stillHeld.translationText).toBe("eating");
    const waitingForIdle = windowOf(text, CAPTION_FRESHNESS_MS, {
      lastGrowthAt: 1_000,
      previousSourceText: text,
      translationText: "eating",
      graphemePaintedAt: paintedAt(text, 0),
    });
    expect(waitingForIdle.sourceText).toBe(text);
    expect(waitingForIdle.translationText).toBe("eating");
  });

  it("snaps to a soft break then walks back so the plate does not start with ー", () => {
    const text = "今日はー続く";
    const display = applyCaptionFreshnessWindow({
      caption: caption({
        sourceText: text,
        sentenceEndOffsets: [],
        softBreakOffsets: [3],
      }),
      now: CAPTION_FRESHNESS_MS,
      graphemePaintedAt: paintedAt(text, 0),
      lastGrowthAt: 0,
      previousSourceText: text,
    });
    expect(display.sourceText.startsWith("ー")).toBe(false);
  });

  it("snaps to the leftmost soft inside the current token when no left close exists", () => {
    const text = "今日はとても良い";
    const display = applyCaptionFreshnessWindow({
      caption: caption({
        sourceText: text,
        sentenceEndOffsets: [],
        softBreakOffsets: [5],
      }),
      now: 8_000,
      graphemePaintedAt: [...paintedAt("今日はと", 0), ...paintedAt("ても良い", 7_500)],
      lastGrowthAt: 7_500,
      previousSourceText: text,
      tokenCharEnds: [8],
    });
    expect(display.sourceText).toBe("も良い");
  });

  it("stamps prefix growth and rewrites grapheme paintedAt without sleeping", () => {
    expect(stampGraphemePaintedAt("こん", [1, 1], "こんにちは", 9)).toEqual([1, 1, 9, 9, 9]);
    expect(stampGraphemePaintedAt("あした", [1, 1, 1], "明日は", 4)).toEqual([4, 4, 4]);
    expect(stampGraphemePaintedAt("こんにちは", [1, 2, 3, 4, 5], "こんにちは", 9)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(stampGraphemePaintedAt("x", [1], "", 9)).toEqual([]);
  });

  it("returns an empty plate for blank source and restamps mismatched paintedAt", () => {
    expect(
      applyCaptionFreshnessWindow({
        caption: caption({ sourceText: "  ", translationText: "kept" }),
        now: 10,
        graphemePaintedAt: [0],
        lastGrowthAt: 0,
        previousSourceText: "",
      }).sourceText,
    ).toBe("");
    const restamped = applyCaptionFreshnessWindow({
      caption: caption({ sourceText: "明日は", sentenceEndOffsets: [] }),
      now: 10,
      graphemePaintedAt: [0],
      lastGrowthAt: 10,
      previousSourceText: "",
    });
    expect(restamped.sourceText).toBe("明日は");
  });

  it("keeps a same-length grammar lead substitution instead of inheriting stale paintedAt", () => {
    const previous = "アイウ今日は晴れ";
    const next = "エオカ今日は晴れ";
    const display = applyCaptionFreshnessWindow({
      caption: caption({ sourceText: next, translationText: "sunny" }),
      now: 5_001,
      graphemePaintedAt: paintedAt(previous, 0),
      lastGrowthAt: 4_900,
      previousSourceText: previous,
    });
    expect(display.sourceText.startsWith("エオカ")).toBe(true);
  });

  it("clamps keepFrom back to the newest chunk start while that chunk is still growing", () => {
    const text = "今日は晴れです明日は雨です";
    const display = applyCaptionFreshnessWindow({
      caption: caption({ sourceText: text, sentenceEndOffsets: [7] }),
      now: 8_000,
      graphemePaintedAt: [
        ...paintedAt("今日は晴れです", 0),
        ...paintedAt("明日は", 1_000),
        ...paintedAt("雨です", 7_500),
      ],
      lastGrowthAt: 8_000,
      previousSourceText: "今日は晴れです明日は雨",
    });
    expect(display.sourceText).toBe("明日は雨です");
  });
});
