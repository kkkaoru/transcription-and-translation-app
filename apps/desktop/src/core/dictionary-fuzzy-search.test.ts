import { describe, expect, it } from "vitest";
import {
  filterCustomDictionaryEntries,
  normalizeDictionaryReading,
  normalizeDictionaryWord,
  readingNeedsWarning,
} from "./dictionary-fuzzy-search";
import type { CustomDictionaryEntry } from "./types";

const entries: CustomDictionaryEntry[] = [
  { id: "1", reading: "ことばびーこん", word: "Kotoba Beacon" },
  { id: "2", reading: "とうきょう", word: "東京都" },
  { id: "3", reading: "きょうと", word: "京都" },
];

describe("custom dictionary fuzzy search", () => {
  it("normalizes width, case, and katakana readings", () => {
    expect(normalizeDictionaryReading(" トウキョウ ")).toBe("とうきょう");
    expect(normalizeDictionaryWord(" ＫＯＴＯＢＡ Beacon ")).toBe("kotoba beacon");
  });

  it("searches readings by normalized partial match", () => {
    expect(
      filterCustomDictionaryEntries(entries, { reading: "ﾋﾞｰｺﾝ", word: "" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["1"]);
    expect(
      filterCustomDictionaryEntries(entries, { reading: "キョウ", word: "" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["2", "3"]);
  });

  it("searches words by normalized partial match", () => {
    expect(
      filterCustomDictionaryEntries(entries, { reading: "", word: "ＫＯＴＯＢＡ" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["1"]);
    expect(
      filterCustomDictionaryEntries(entries, { reading: "", word: "都" }).map((entry) => entry.id),
    ).toEqual(["2", "3"]);
  });

  it("combines reading and word filters and returns all entries for empty queries", () => {
    expect(filterCustomDictionaryEntries(entries, { reading: "きょう", word: "東京" })).toEqual([
      entries[1],
    ]);
    expect(filterCustomDictionaryEntries(entries, { reading: "", word: "" })).toEqual(entries);
  });

  it("warns for non-hiragana while allowing long marks and small kana", () => {
    expect(readingNeedsWarning("きゃぷしょんびーこん")).toBe(false);
    expect(readingNeedsWarning("スーパー")).toBe(true);
    expect(readingNeedsWarning("caption")).toBe(true);
    expect(readingNeedsWarning("東京")).toBe(true);
    expect(readingNeedsWarning("")).toBe(false);
  });
});
