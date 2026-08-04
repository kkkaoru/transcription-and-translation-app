import { describe, expect, it } from "vitest";
import {
  CAPTION_MAX_CHARS_MAX,
  CAPTION_MAX_CHARS_MIN,
  captionItems,
  captionTextLines,
  createEmptyCaption,
  createPreviewCaption,
  resolveCaptionMaxChars,
  SOURCE_CAPTION_MAX_CHARS,
  segmentCaptionText,
  TRANSLATION_CAPTION_MAX_CHARS,
} from "../overlay/captions";
import { mergeCaptionPayload } from "./caption-updates";
import {
  clampCaptionMaxChars,
  createDefaultConfig,
  mergeCaptionMaxChars,
  mergeConfig,
} from "./defaults";
import type { AppConfig } from "./types";

describe("caption preview content", () => {
  it("uses live caption text by default so the in-app stage can show recognition without OBS", () => {
    const caption = createPreviewCaption();
    const items = captionItems(createDefaultConfig(), caption);
    expect(items.map((item) => item.text)).toEqual([caption.sourceText, caption.translationText]);
    // Must not force the old static design placeholders when previewing live data.
    expect(items.map((item) => item.text).join(" ")).not.toContain(
      "日本語の音声認識結果がここに表示されます",
    );
    expect(items.map((item) => item.text).join(" ")).not.toContain(
      "English translation will appear here",
    );
  });

  it("reflects live recognition updates without OBS (placeholder stays off)", () => {
    const config = createDefaultConfig();
    const live = {
      ...createPreviewCaption(),
      id: "live-1",
      sourceText: "こんにちは、世界。",
      translationText: "Hello, world.",
    };
    const items = captionItems(config, live, false);
    expect(items[0]?.text).toBe("こんにちは、世界。");
    expect(items[1]?.text).toBe("Hello, world.");
  });

  it("paints a newer same-utterance recognition revision in the live caption lines", () => {
    const config = createDefaultConfig();
    const translated = {
      ...createPreviewCaption(),
      id: "utterance-1",
      sourceText: "明日の天気は",
      translationText: "The weather tomorrow",
      receivedAt: 20,
      stage: "translation" as const,
      sequence: 1,
      isFinal: true,
    };
    const revised = {
      ...translated,
      sourceText: "明日の天気は晴れ",
      translationText: "",
      receivedAt: 30,
      stage: "source" as const,
      sequence: 0,
      isFinal: false,
    };
    const merged = mergeCaptionPayload(translated, revised);
    if (!merged) {
      throw new Error("same-utterance source revision should be paintable");
    }

    const items = captionItems(config, merged, false);
    expect(items.find((item) => item.key === "source")?.text).toBe("明日の天気は晴れ");
    expect(items.find((item) => item.key === "translation")?.text).toBe("The weather tomorrow");
  });

  it("can still force static sample copy for empty design mocks", () => {
    const caption = createPreviewCaption();
    const items = captionItems(createDefaultConfig(), caption, true);
    expect(items[0]?.text).toContain("日本語");
    expect(items[1]?.text).toContain("English");
  });

  it("provides an empty live caption state without showing sample text", () => {
    const empty = createEmptyCaption();
    expect(empty.sourceText).toBe("");
    expect(empty.translationText).toBe("");
    expect(empty.startedAt).toBe(0);
    expect(empty.receivedAt).toBe(0);
    expect(captionItems(createDefaultConfig(), empty).map((item) => item.text)).toEqual(["", ""]);
  });

  it("segments long source and translation text without dropping characters", () => {
    const source = `これは長い日本語字幕を読みやすい単位に分割するためのテストです。${"追加".repeat(8)}`;
    const translation = `This is a deliberately long translation line that must remain readable while every word is preserved ${"again ".repeat(8)}`;
    const sourceLines = segmentCaptionText(source, SOURCE_CAPTION_MAX_CHARS);
    const translationLines = segmentCaptionText(translation, TRANSLATION_CAPTION_MAX_CHARS);

    expect(sourceLines.every((line) => Array.from(line).length <= SOURCE_CAPTION_MAX_CHARS)).toBe(
      true,
    );
    expect(
      translationLines.every((line) => Array.from(line).length <= TRANSLATION_CAPTION_MAX_CHARS),
    ).toBe(true);
    expect(sourceLines.join("")).toBe(source);
    expect(translationLines.join(" ")).toBe(translation.trim().replace(/\s+/gu, " "));
  });

  it("keeps explicit line breaks and uses the source/translation budgets", () => {
    const config = createDefaultConfig();
    const caption = {
      ...createPreviewCaption(),
      sourceText: `一行目\r\n${"二".repeat(SOURCE_CAPTION_MAX_CHARS + 1)}`,
      translationText: `first\n${"second ".repeat(TRANSLATION_CAPTION_MAX_CHARS)}`,
    };
    const items = captionItems(config, caption);
    const sourceItem = items[0];
    const translationItem = items[1];
    if (!sourceItem || !translationItem) {
      throw new Error("caption items must include source and translation");
    }
    const sourceLines = captionTextLines(sourceItem);
    const translationLines = captionTextLines(translationItem);

    expect(sourceLines[0]).toBe("一行目");
    expect(sourceLines.every((line) => Array.from(line).length <= SOURCE_CAPTION_MAX_CHARS)).toBe(
      true,
    );
    expect(translationLines[0]).toBe("first");
    expect(
      translationLines.every((line) => Array.from(line).length <= TRANSLATION_CAPTION_MAX_CHARS),
    ).toBe(true);
  });
});

describe("configurable caption line budget", () => {
  const withBudget = (source: number, translation: number): AppConfig => {
    const config = createDefaultConfig();
    config.overlay.captionMaxChars = { source, translation };
    return config;
  };

  it("defaults each row to its own budget", () => {
    const config = createDefaultConfig();

    expect(config.overlay.captionMaxChars).toEqual({
      source: SOURCE_CAPTION_MAX_CHARS,
      translation: TRANSLATION_CAPTION_MAX_CHARS,
    });
    expect(resolveCaptionMaxChars(config, "source")).toBe(SOURCE_CAPTION_MAX_CHARS);
    expect(resolveCaptionMaxChars(config, "translation")).toBe(TRANSLATION_CAPTION_MAX_CHARS);
  });

  it("clamps out-of-range and non-finite budgets instead of passing them to the segmenter", () => {
    expect(clampCaptionMaxChars(1, "source")).toBe(CAPTION_MAX_CHARS_MIN);
    expect(clampCaptionMaxChars(10_000, "translation")).toBe(CAPTION_MAX_CHARS_MAX);
    expect(clampCaptionMaxChars(12.9, "source")).toBe(12);
    expect(clampCaptionMaxChars(Number.NaN, "source")).toBe(SOURCE_CAPTION_MAX_CHARS);
    expect(clampCaptionMaxChars(Number.POSITIVE_INFINITY, "translation")).toBe(
      TRANSLATION_CAPTION_MAX_CHARS,
    );
    expect(clampCaptionMaxChars("30", "source")).toBe(SOURCE_CAPTION_MAX_CHARS);
    expect(clampCaptionMaxChars(undefined, "translation")).toBe(TRANSLATION_CAPTION_MAX_CHARS);

    expect(resolveCaptionMaxChars(withBudget(1, 10_000), "source")).toBe(CAPTION_MAX_CHARS_MIN);
    expect(resolveCaptionMaxChars(withBudget(1, 10_000), "translation")).toBe(
      CAPTION_MAX_CHARS_MAX,
    );
  });

  it("falls back to the per-row defaults for a legacy config without the field", () => {
    const legacy = createDefaultConfig();
    // Legacy persisted configs predate `overlay.captionMaxChars` entirely.
    legacy.overlay.captionMaxChars = undefined;

    expect(resolveCaptionMaxChars(legacy, "source")).toBe(SOURCE_CAPTION_MAX_CHARS);
    expect(resolveCaptionMaxChars(legacy, "translation")).toBe(TRANSLATION_CAPTION_MAX_CHARS);
    // Items built without a resolved budget keep the per-row default too.
    expect(captionTextLines({ key: "source", text: "あ".repeat(40) })).toEqual(
      captionTextLines({
        key: "source",
        text: "あ".repeat(40),
        maxChars: SOURCE_CAPTION_MAX_CHARS,
      }),
    );
  });

  it("restores a missing, partial, or out-of-range budget when merging a persisted config", () => {
    const legacy = mergeConfig({
      overlay: { ...createDefaultConfig().overlay, captionMaxChars: undefined },
    });
    expect(legacy.overlay.captionMaxChars).toEqual({
      source: SOURCE_CAPTION_MAX_CHARS,
      translation: TRANSLATION_CAPTION_MAX_CHARS,
    });

    const partial = mergeConfig({
      overlay: { ...createDefaultConfig().overlay, captionMaxChars: { source: 16 } as never },
    });
    expect(partial.overlay.captionMaxChars).toEqual({
      source: 16,
      translation: TRANSLATION_CAPTION_MAX_CHARS,
    });

    // The backend rejects the entire config when a budget is out of range, so
    // the merge must clamp rather than persist an unsavable value.
    const hostile = mergeConfig({
      overlay: {
        ...createDefaultConfig().overlay,
        captionMaxChars: { source: 0, translation: 5_000 },
      },
    });
    expect(hostile.overlay.captionMaxChars).toEqual({
      source: CAPTION_MAX_CHARS_MIN,
      translation: CAPTION_MAX_CHARS_MAX,
    });

    expect(mergeCaptionMaxChars(undefined, undefined)).toEqual({
      source: SOURCE_CAPTION_MAX_CHARS,
      translation: TRANSLATION_CAPTION_MAX_CHARS,
    });
    expect(mergeCaptionMaxChars({ source: 12, translation: 20 }, undefined)).toEqual({
      source: 12,
      translation: 20,
    });
  });

  it("changes the rendered line split when the configured budget changes", () => {
    const text = "あ".repeat(24);
    const caption = { ...createPreviewCaption(), sourceText: text, translationText: text };

    const wide = captionItems(withBudget(24, 24), caption).find((item) => item.key === "source");
    const narrow = captionItems(withBudget(6, 6), caption).find((item) => item.key === "source");
    if (!wide || !narrow) {
      throw new Error("caption items must include the source row");
    }

    expect(captionTextLines(wide)).toEqual([text]);
    expect(captionTextLines(narrow)).toEqual([
      "あ".repeat(6),
      "あ".repeat(6),
      "あ".repeat(6),
      "あ".repeat(6),
    ]);
    // Every grapheme survives at both budgets; only breaks are inserted.
    expect(captionTextLines(narrow).join("")).toBe(text);
  });
});
