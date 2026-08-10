import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import {
  captionGraphemes,
  captionItems,
  captionTextLines,
  collapseRunawayGraphemeRuns,
  createPreviewCaption,
  sanitizeCaptionDisplayText,
  segmentCaptionText,
  stripCaptionContinuationMarker,
} from "./captions";

describe("POS soft breaks before maxChars", () => {
  it("wraps before maxChars at a particle soft-break instead of mid-phrase", () => {
    const text = "今日はとても良い天気で明日も";
    const segments = segmentCaptionText(text, 12);
    expect(segments.join("")).toBe(text);
    expect(segments.length).toBeGreaterThan(1);
    // Soft break after は should be preferred over a hard cut at 12.
    expect(segments[0]?.endsWith("は") || segments[0]?.endsWith("で")).toBe(true);
    expect(segments.every((line) => captionGraphemes(line).length <= 12)).toBe(true);
  });

  it("keeps mid-utterance characters until the hard maxChars×maxLines budget fills", () => {
    // Soft breaks wrap lines; they must not early-page away the speaker's
    // in-progress text while it still fits in the 2-line display window.
    const text = "隣の客はよく柿を食べる客だそうですよ";
    const lines = captionTextLines({
      key: "source",
      text,
      maxChars: 10,
      softBreakOffsets: [3, 5, 7, 10, 12],
    });
    expect(lines.join("")).toBe(text);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.every((line) => captionGraphemes(line).length <= 10)).toBe(true);
  });

  it("clamps soft-wrapped segments to CAPTION_MAX_VISIBLE_LINES", () => {
    // Soft breaks every few graphemes would otherwise yield 3+ logical lines
    // inside the grapheme budget; the plate must still show at most two.
    const text = "あいうえおかきくけこさしすせそたちつてとなにぬねの";
    const softBreakOffsets = [5, 10, 15, 20, 25];
    const lines = captionTextLines({
      key: "source",
      text,
      maxChars: 12,
      softBreakOffsets,
    });
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.join("").length).toBeLessThanOrEqual(24);
    expect(text.endsWith(lines.join(""))).toBe(true);
  });

  it("still drops older graphemes once the hard display window overflows", () => {
    const text = "隣の客はよく柿を食べる客だそうですよみなさん";
    const lines = captionTextLines({
      key: "source",
      text,
      maxChars: 10,
      softBreakOffsets: [3, 5, 7, 10, 12, 16],
    });
    expect(lines.join("").length).toBeLessThanOrEqual(20);
    expect(lines.join("").endsWith("そうですよみなさん") || lines.join("").endsWith("みなさん")).toBe(
      true,
    );
    expect(lines.join("")).not.toBe(text);
  });
});

describe("caption display sanitization", () => {
  it("strips trailing Parapper continuation markers without touching mid-text ellipsis", () => {
    expect(stripCaptionContinuationMarker("今日は...")).toBe("今日は");
    expect(stripCaptionContinuationMarker("今日は…")).toBe("今日は");
    expect(stripCaptionContinuationMarker("待ち…ます")).toBe("待ち…ます");
  });

  it("collapses runaway single-Kanji stutter but leaves normal kana repetition alone", () => {
    expect(collapseRunawayGraphemeRuns("為".repeat(20))).toBe("為".repeat(2));
    expect(collapseRunawayGraphemeRuns("あ".repeat(24))).toBe("あ".repeat(24));
    expect(sanitizeCaptionDisplayText(`${"為".repeat(12)}...`)).toBe("為".repeat(2));
  });
});

describe("segmentCaptionText edge cases", () => {
  it("normalizes CRLF/CR line breaks and trims surrounding whitespace", () => {
    expect(segmentCaptionText(" あいう\r\nえお \r ", 10)).toEqual(["あいう", "えお"]);
  });

  it("returns an empty list for blank input", () => {
    expect(segmentCaptionText("   \n  ", 10)).toEqual([]);
    expect(segmentCaptionText("", 10)).toEqual([]);
  });

  it("splits a long line preferring punctuation near the limit", () => {
    const segments = segmentCaptionText("ああああ。いいいい。ううううう", 10);
    expect(segments.join("")).toBe("ああああ。いいいい。ううううう");
    expect(segments.length).toBeGreaterThan(1);
  });

  it("keeps a single short line intact", () => {
    expect(segmentCaptionText("こんにちは", 10)).toEqual(["こんにちは"]);
  });

  it("breaks after a preferred-break punctuation that carries a combining mark", () => {
    // The budget is a user-visible grapheme count. A full-width punctuation that
    // forms one multi-codepoint grapheme with a trailing combining mark is still
    // a preferred break site; the OBS browser source (browser_source.rs) must
    // break at the same boundary. This pins the DOM/native reference output so
    // the Rust port can be checked against it.
    const punct = "ああああ！\u0301あああああ";
    expect(segmentCaptionText(punct, 8)).toEqual(["ああああ！\u0301", "あああああ"]);

    const spaced = "ああああ \u0301あああああ";
    expect(segmentCaptionText(spaced, 8)).toEqual(["ああああ \u0301", "あああああ"]);
  });

  it("does not split ZWJ emoji or combining marks across the character budget", () => {
    // Caption budgets are user-visible characters. Splitting a ZWJ family
    // sequence or a dakuten combining mark mid-cluster paints broken glyphs.
    const graphemesOf = (text: string): string[] =>
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
        (part) => part.segment,
      );
    const family = "👨‍👩‍👧";
    const familyLines = segmentCaptionText(family.repeat(3), 2);
    expect(familyLines.flatMap(graphemesOf)).toEqual([family, family, family]);
    expect(familyLines.every((line) => graphemesOf(line).length <= 2)).toBe(true);
    expect(familyLines.some((line) => line.startsWith("\u200D"))).toBe(false);

    const combining = "か\u3099き\u3099く\u3099け\u3099こ\u3099";
    const combiningLines = segmentCaptionText(combining, 2);
    expect(combiningLines.flatMap(graphemesOf).join("")).toBe(combining);
    expect(combiningLines.every((line) => graphemesOf(line).length <= 2)).toBe(true);
    expect(combiningLines.some((line) => line.startsWith("\u3099"))).toBe(false);
  });

  it("does not split a whitespace grapheme cluster when trimming the remaining tail", () => {
    // A space plus a combining mark (U+0020 + U+0301) is one grapheme cluster.
    // When the hard break falls *before* it, String.prototype.trimStart on the
    // joined remaining would strip the space and leave a bare combining mark
    // at the start of the next line. The segmenter must trim whole clusters.
    const graphemesOf = (text: string): string[] =>
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
        (part) => part.segment,
      );
    const text = "\u3042\u3042\u3042 \u0301\u3042\u3042\u3042";
    const lines = segmentCaptionText(text, 3);
    expect(lines.some((line) => line.startsWith("\u0301"))).toBe(false);
    expect(lines.flatMap(graphemesOf).join("")).toBe(text);
  });

  it("consumes pure-whitespace grapheme clusters at break boundaries", () => {
    // A pure space at the break point is consumed: it is trimmed from the
    // segment tail (trimGraphemes) and from the remaining head
    // (trimStartGraphemes). No caption line should start or end with a bare
    // space, and the non-whitespace content is preserved.
    const text = "\u3042\u3042 \u3042\u3042\u3042  \u3042\u3042\u3042";
    const lines = segmentCaptionText(text, 3);
    expect(lines.every((line) => !line.startsWith(" ") && !line.endsWith(" "))).toBe(true);
    expect(lines.join("")).toBe(text.replace(/\s/gu, ""));
  });

  it("falls back to code-point splitting when Intl.Segmenter is unavailable", () => {
    // Some embedded WebViews still lack Intl.Segmenter. The fallback splits by
    // code points (Array.from) instead of grapheme clusters; it is less
    // accurate for ZWJ emoji but keeps caption segmentation functional.
    const originalSegmenter = Intl.Segmenter;
    const intl = Intl as { Segmenter?: typeof Intl.Segmenter };
    delete intl.Segmenter;
    try {
      expect(captionGraphemes("abc")).toEqual(["a", "b", "c"]);
      expect(captionGraphemes("\u3042\u3044\u3046")).toEqual(["\u3042", "\u3044", "\u3046"]);
    } finally {
      intl.Segmenter = originalSegmenter;
    }
  });
});

describe("captionTextLines and captionItems", () => {
  it("uses the configured budget and honours the display order", () => {
    const config = createDefaultConfig();
    config.overlay.order = "translation-first";
    const caption = createPreviewCaption();

    const items = captionItems(config, caption);
    expect(items[0]?.key).toBe("translation");
    expect(items[1]?.key).toBe("source");

    // Long text is wrapped by the per-row budget, then capped to the visible
    // window (CAPTION_MAX_VISIBLE_LINES) so the overlay plate cannot grow
    // without bound.
    const longSource = "あ".repeat(60);
    const lines = captionTextLines({ key: "source", text: longSource, maxChars: 20 });
    expect(lines.join("")).toBe("あ".repeat(40));
    expect(lines).toHaveLength(2);

    const overflowing = "い".repeat(120);
    const windowed = captionTextLines({ key: "source", text: overflowing, maxChars: 20 });
    // CAPTION_MAX_VISIBLE_LINES=2 → keep the newest maxChars×2 graphemes.
    expect(windowed.join("").length).toBe(40);
    expect(windowed.join("")).toBe("い".repeat(40));
  });

  it("switches to the newest Japanese sentence instead of stacking two finished lines", () => {
    const lines = captionTextLines({
      key: "source",
      text: "今日は晴れです。明日は雨です。",
      maxChars: 28,
    });
    expect(lines).toEqual(["明日は雨です。"]);
  });

  it("keeps an in-progress sentence after a completed AzooKey copula ending", () => {
    const lines = captionTextLines({
      key: "source",
      text: "今日は晴れです明日は雨",
      azookeyInputText: "きょうははれですあしたはあめ",
      maxChars: 28,
    });
    expect(lines).toEqual(["明日は雨"]);
  });

  it("keeps mid-speech characters when sentence paging is deferred for live interim", () => {
    const text = "今日は晴れです明日は雨";
    const lines = captionTextLines({
      key: "source",
      text,
      azookeyInputText: "きょうははれですあしたはあめ",
      maxChars: 28,
      deferSentencePaging: true,
    });
    expect(lines.join("")).toBe(text);
  });

  it("defers sentence paging for provisional captionItems so spoken text stays visible", () => {
    const config = createDefaultConfig();
    const items = captionItems(config, {
      id: "u-1",
      sourceText: "それはとても良い天気だと思いますね今日は",
      translationText: "",
      sourceLanguage: "ja",
      targetLanguage: "en",
      startedAt: 1,
      receivedAt: 2,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const source = items.find((item) => item.key === "source");
    expect(source?.deferSentencePaging).toBe(true);
    expect(captionTextLines(source!).join("")).toContain("それはとても良い天気");
  });

  it("pages English translation by sentence punctuation", () => {
    const lines = captionTextLines({
      key: "translation",
      text: "It is sunny today. It will rain tomorrow.",
      maxChars: 48,
    });
    expect(lines).toEqual(["It will rain tomorrow."]);
  });

  it("uses Vibrato sentence offsets when the pipeline supplies them", () => {
    const text = "短いです続く文";
    const lines = captionTextLines({
      key: "source",
      text,
      maxChars: 28,
      sentenceEndOffsets: [4],
    });
    expect(lines).toEqual(["続く文"]);
  });

  it("pages messy live speech from Vibrato POS offsets rather than surface copulas", () => {
    expect(
      captionTextLines({
        key: "source",
        text: "もう走る次いく",
        maxChars: 28,
        sentenceEndOffsets: [],
      }),
    ).toEqual(["もう走る次いく"]);
    expect(
      captionTextLines({
        key: "source",
        text: "えー今日は",
        maxChars: 28,
        sentenceEndOffsets: [],
      }),
    ).toEqual(["えー今日は"]);
    expect(
      captionTextLines({
        key: "source",
        text: "ちょっと待って",
        maxChars: 28,
        sentenceEndOffsets: [],
      }),
    ).toEqual(["ちょっと待って"]);
  });

  it("drops older recognition once the display window is exceeded", () => {
    // With a 2-line window, 5×28 graphemes keep only the newest 56.
    // Use kana so Kanji stutter collapsing cannot interfere with the window test.
    const older = "ふ".repeat(28);
    const newer = "あ".repeat(56);
    const lines = captionTextLines({
      key: "source",
      text: `${older}${newer}`,
      maxChars: 28,
    });
    expect(lines.join("")).toBe(newer);
    expect(lines.join("")).not.toContain("ふ");
  });

  it("places placeholder copy when requested", () => {
    const config = createDefaultConfig();
    const items = captionItems(config, createPreviewCaption(), true);
    expect(items[0]?.text).toContain("日本語の音声認識");
    expect(items[1]?.text).toContain("English translation");
  });
});
