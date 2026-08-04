import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import {
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
