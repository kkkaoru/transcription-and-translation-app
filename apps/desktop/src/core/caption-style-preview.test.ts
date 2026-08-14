import { describe, expect, it } from "vitest";
import { createPreviewCaption } from "../overlay/captions";
import { captionForStylePreviewLines } from "./caption-style-preview";

describe("caption style preview lines", () => {
  it("keeps the source and hides translation in one-line mode", () => {
    const sample = createPreviewCaption();
    expect(captionForStylePreviewLines(sample, 1)).toEqual({
      ...sample,
      translationText: "",
    });
    expect(sample.translationText).not.toBe("");
  });

  it("returns the unchanged two-row sample in two-line mode", () => {
    const sample = createPreviewCaption();
    expect(captionForStylePreviewLines(sample, 2)).toBe(sample);
  });
});
