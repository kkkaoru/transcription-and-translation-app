import { describe, expect, it } from "vitest";
import { wrapNativeText } from "../overlay/NativeFramePublisher";

describe("native caption layout", () => {
  const measure = (value: string): number => Array.from(value).length * 10;

  it("wraps Japanese text by measured width without dropping characters", () => {
    const text = "これは長い字幕です。次の文も表示します。";
    const lines = wrapNativeText(text, 60, measure);

    expect(lines).toHaveLength(4);
    expect(lines.every((line) => measure(line) <= 60)).toBe(true);
    expect(lines.join("")).toBe(text);
  });

  it("preserves explicit line breaks and empty paragraphs", () => {
    expect(wrapNativeText("一\n\n二", 100, measure)).toEqual(["一", "", "二"]);
  });

  it("breaks an oversized Latin token instead of shrinking the whole caption", () => {
    const text = "superlongcaption";
    const lines = wrapNativeText(text, 50, measure);

    expect(lines).toEqual(["super", "longc", "aptio", "n"]);
    expect(lines.join("")).toBe(text);
  });
});
