import { describe, expect, it } from "vitest";
import { captionItems, createPreviewCaption } from "../overlay/captions";
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

  it("can still force static sample copy for empty design mocks", () => {
    const caption = createPreviewCaption();
    const items = captionItems(createDefaultConfig(), caption, true);
    expect(items[0]?.text).toContain("日本語");
    expect(items[1]?.text).toContain("English");
  });
});
