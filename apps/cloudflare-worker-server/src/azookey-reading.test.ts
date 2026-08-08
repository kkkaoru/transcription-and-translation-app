import { describe, expect, it, vi } from "vitest";
import { containsKanji, readingForAzookey } from "./azookey-reading.js";

describe("AzooKey reading pre-pass", () => {
  it("detects CJK ideographs the same way as the desktop Vibrato gate", () => {
    expect(containsKanji("東京")).toBe(true);
    expect(containsKanji("きょうは晴れ")).toBe(true);
    expect(containsKanji("きょうははれ")).toBe(false);
    expect(containsKanji("abc123")).toBe(false);
    expect(containsKanji("")).toBe(false);
  });

  it("passes pure kana through and only tokenizes when kanji is present", () => {
    const toHiragana = vi.fn((input: string) => `reading:${input}`);
    expect(readingForAzookey("きょうははれ", toHiragana)).toBe("きょうははれ");
    expect(toHiragana).not.toHaveBeenCalled();
    expect(readingForAzookey("東京都に京都", toHiragana)).toBe("reading:東京都に京都");
    expect(toHiragana).toHaveBeenCalledTimes(1);
    expect(toHiragana).toHaveBeenCalledWith("東京都に京都");
  });
});
