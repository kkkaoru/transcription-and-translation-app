import { describe, expect, it, vi } from "vitest";
import { containsKanji, isKanji, readingForAzookey, readingForAzookeyAsync } from "./index.js";

describe("AzooKey reading pre-pass", () => {
  it("detects CJK ideographs the same way as the desktop Vibrato gate", () => {
    expect(isKanji("")).toBe(false);
    expect(isKanji("\u33ff")).toBe(false);
    expect(isKanji("\u3400")).toBe(true);
    expect(isKanji("\u4dbf")).toBe(true);
    expect(isKanji("\u4dc0")).toBe(false);
    expect(isKanji("東")).toBe(true);
    expect(isKanji("\u9fff")).toBe(true);
    expect(isKanji("\uf900")).toBe(true);
    expect(isKanji("\ufaff")).toBe(true);
    expect(isKanji("a")).toBe(false);
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

  it("keeps the async converter uncalled for pure kana", async () => {
    const toHiragana = vi.fn(async (input: string) => `reading:${input}`);
    await expect(readingForAzookeyAsync("きょうははれ", toHiragana)).resolves.toBe("きょうははれ");
    expect(toHiragana).not.toHaveBeenCalled();
    await expect(readingForAzookeyAsync("東京都に京都", toHiragana)).resolves.toBe(
      "reading:東京都に京都",
    );
    expect(toHiragana).toHaveBeenCalledTimes(1);
  });
});
