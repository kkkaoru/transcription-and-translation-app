/**
 * Tests for the browser custom dictionary.
 *
 * This file runs with bun.
 */

import { expect, it } from "vitest";
import {
  addCustomDictionaryEntry,
  customDictionaryEntriesToTsv,
  loadStoredCustomDictionary,
  parseCustomDictionaryCsv,
  parseCustomDictionaryFile,
  parseCustomDictionaryJson,
  parseCustomDictionaryTsv,
  removeCustomDictionaryEntry,
  saveStoredCustomDictionary,
  serializeCustomDictionaryFile,
  validateCustomDictionaryEntries,
} from "./custom-dictionary";

it("validates entries and round-trips JSON, TSV, and CSV", () => {
  const entries = validateCustomDictionaryEntries([
    { id: "one", reading: "ぶいあーるちゃっと", word: "VRC" },
    { id: "two", reading: "こーど", word: "code" },
  ]);
  expect(entries).toStrictEqual([
    { id: "one", reading: "ぶいあーるちゃっと", word: "VRC" },
    { id: "two", reading: "こーど", word: "code" },
  ]);
  expect(customDictionaryEntriesToTsv(entries)).toBe("ぶいあーるちゃっと\tVRC\nこーど\tcode\n");
  expect(
    parseCustomDictionaryTsv("ぶいあーるちゃっと\tVRC\nこーど\tcode\n").map((entry) => ({
      reading: entry.reading,
      word: entry.word,
    })),
  ).toStrictEqual([
    { reading: "ぶいあーるちゃっと", word: "VRC" },
    { reading: "こーど", word: "code" },
  ]);
  expect(parseCustomDictionaryJson(serializeCustomDictionaryFile(entries))).toStrictEqual(entries);
  expect(
    parseCustomDictionaryCsv("よみ,単語\r\nぶいあーるちゃっと,VRC\r\nこーど,code\r\n").map(
      (entry) => ({ reading: entry.reading, word: entry.word }),
    ),
  ).toStrictEqual([
    { reading: "ぶいあーるちゃっと", word: "VRC" },
    { reading: "こーど", word: "code" },
  ]);
  expect(
    parseCustomDictionaryFile("custom_dictionary.json", serializeCustomDictionaryFile(entries)),
  ).toStrictEqual(entries);
});

it("adds and removes words without mutating the previous list", () => {
  const initial = [{ id: "keep", reading: "よみ", word: "単語" }];
  const added = addCustomDictionaryEntry(initial, "あたらしい", "新しい");
  expect(added).toHaveLength(2);
  expect(added[0]).toStrictEqual({ id: "keep", reading: "よみ", word: "単語" });
  expect(added[1]?.reading).toBe("あたらしい");
  expect(added[1]?.word).toBe("新しい");
  const remaining = removeCustomDictionaryEntry(added, "keep");
  expect(remaining).toHaveLength(1);
  expect(remaining[0]?.reading).toBe("あたらしい");
  expect(remaining[0]?.word).toBe("新しい");
});

it("persists to storage and seeds the VRC sample when empty", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
  };
  expect(loadStoredCustomDictionary(storage)).toStrictEqual([
    { id: "sample-vrchat-vrc", reading: "ぶいあーるちゃっと", word: "VRC" },
  ]);
  const saved = saveStoredCustomDictionary(storage, [
    { id: "kept", reading: "よみ", word: "単語" },
  ]);
  expect(saved).toStrictEqual([{ id: "kept", reading: "よみ", word: "単語" }]);
  expect(loadStoredCustomDictionary(storage)).toStrictEqual([
    { id: "kept", reading: "よみ", word: "単語" },
  ]);
});

it("rejects invalid readings and oversized dictionaries", () => {
  expect(() =>
    validateCustomDictionaryEntries([{ id: "a", reading: "#comment", word: "x" }]),
  ).toThrow("cannot start with #");
  expect(() =>
    validateCustomDictionaryEntries([{ id: "a", reading: "よ\tみ", word: "x" }]),
  ).toThrow("tabs or newlines");
  expect(() => parseCustomDictionaryFile("notes.txt", "a\tb\n")).toThrow(".json, .tsv, or .csv");
});
