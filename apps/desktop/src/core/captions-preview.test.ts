import { describe, expect, it } from "vitest";
import {
  captionItems,
  captionTextLines,
  createEmptyCaption,
  createPreviewCaption,
  SOURCE_CAPTION_MAX_CHARS,
  segmentCaptionText,
  TRANSLATION_CAPTION_MAX_CHARS,
} from "../overlay/captions";
import { mergeCaptionPayload } from "./caption-updates";
import { createDefaultConfig } from "./defaults";

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
