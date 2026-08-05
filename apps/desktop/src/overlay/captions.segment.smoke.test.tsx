import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import {
  captionGraphemes,
  captionItems,
  captionTextLines,
  createPreviewCaption,
  segmentCaptionText,
} from "./captions";

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

    // Long text split by the configured per-row budget.
    const longSource = "あ".repeat(60);
    const lines = captionTextLines({ key: "source", text: longSource, maxChars: 20 });
    expect(lines.join("")).toBe(longSource);
    expect(lines.length).toBeGreaterThan(1);
  });

  it("places placeholder copy when requested", () => {
    const config = createDefaultConfig();
    const items = captionItems(config, createPreviewCaption(), true);
    expect(items[0]?.text).toContain("日本語の音声認識");
    expect(items[1]?.text).toContain("English translation");
  });
});
