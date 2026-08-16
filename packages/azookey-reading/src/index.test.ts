import { describe, expect, it, vi } from "vitest";
import {
  containsKanji,
  isKanji,
  normalizeAsrSourceText,
  readingForAzookey,
  readingForAzookeyAsync,
  readingForAzookeyFromAsr,
  readingForAzookeyFromAsrAsync,
} from "./index.js";

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

  it("strips Japanese ASR token-gap spaces and keeps Latin word spaces", () => {
    expect(normalizeAsrSourceText("暑い 日は暑い 食べ 物を 食べた くない。")).toBe(
      "暑い日は暑い食べ物を食べたくない。",
    );
    expect(normalizeAsrSourceText("降 水 確率 は 六 十 パーセント です。")).toBe(
      "降水確率は六十パーセントです。",
    );
    expect(normalizeAsrSourceText("明日 の天 気は 晴 れ です。")).toBe("明日の天気は晴れです。");
    expect(normalizeAsrSourceText("明日　の　天気")).toBe("明日の天気");
    expect(normalizeAsrSourceText("きょう は いい てんき")).toBe("きょうはいいてんき");
    expect(normalizeAsrSourceText("  hello world  ")).toBe("hello world");
  });

  it("normalizes then extracts a reading only for kanji-bearing ASR text", () => {
    const toHiragana = vi.fn((input: string) => `reading:${input}`);
    expect(readingForAzookeyFromAsr("きょう は いい てんき", toHiragana)).toBe(
      "きょうはいいてんき",
    );
    expect(toHiragana).not.toHaveBeenCalled();
    expect(readingForAzookeyFromAsr("今日 は いい 天気", toHiragana)).toBe(
      "reading:今日はいい天気",
    );
    expect(toHiragana).toHaveBeenCalledTimes(1);
    expect(toHiragana).toHaveBeenCalledWith("今日はいい天気");
  });

  it("keeps the async ASR reading tokenizer uncalled for spaced kana", async () => {
    const toHiragana = vi.fn(async (input: string) => `reading:${input}`);
    await expect(readingForAzookeyFromAsrAsync("きょう は いい てんき", toHiragana)).resolves.toBe(
      "きょうはいいてんき",
    );
    expect(toHiragana).not.toHaveBeenCalled();
    await expect(readingForAzookeyFromAsrAsync("今日 は いい 天気", toHiragana)).resolves.toBe(
      "reading:今日はいい天気",
    );
    expect(toHiragana).toHaveBeenCalledTimes(1);
  });
});
