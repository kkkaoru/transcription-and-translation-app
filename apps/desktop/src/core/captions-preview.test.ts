import { describe, expect, it } from "vitest";
import { captionItems, createPreviewCaption } from "../overlay/captions";
import { createDefaultConfig } from "./defaults";

describe("caption preview content", () => {
  it("uses live caption text by default so the OBS stage can show recognition", () => {
    const caption = createPreviewCaption();
    const items = captionItems(createDefaultConfig(), caption);
    expect(items.map((item) => item.text)).toEqual([caption.sourceText, caption.translationText]);
  });

  it("can still force static sample copy for empty design mocks", () => {
    const caption = createPreviewCaption();
    const items = captionItems(createDefaultConfig(), caption, true);
    expect(items[0]?.text).toContain("日本語");
    expect(items[1]?.text).toContain("English");
  });
});
