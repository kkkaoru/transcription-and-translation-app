/**
 * Catalog search and import helpers.
 *
 * This file runs with bun.
 */

import { describe, expect, it } from "vitest";
import {
  compareReadingThenId,
  createMemoryImportStore,
  defaultUserLexiconDictionary,
  emptyImportJob,
  entryMatchesPrefixSearch,
  importObjectKey,
  isValidDictionaryName,
  pagePrefixSearch,
  sliceImportBatch,
} from "./user-lexicon-catalog.js";

describe("user lexicon catalog helpers", () => {
  it("matches prefix search on reading or word", () => {
    expect(
      entryMatchesPrefixSearch({ id: "a", reading: "ぶいあーるちゃっと", word: "VRC" }, "ぶい"),
    ).toStrictEqual(true);
    expect(
      entryMatchesPrefixSearch({ id: "a", reading: "ぶいあーるちゃっと", word: "VRC" }, "VRC"),
    ).toStrictEqual(true);
    expect(
      entryMatchesPrefixSearch({ id: "a", reading: "ぶいあーるちゃっと", word: "VRC" }, "ちゃ"),
    ).toStrictEqual(false);
    expect(isValidDictionaryName("")).toStrictEqual(false);
    expect(isValidDictionaryName("Names")).toStrictEqual(true);
    expect(defaultUserLexiconDictionary()).toStrictEqual({
      id: "default",
      name: "Custom",
      entryCount: 0,
    });
    expect(importObjectKey("job-1")).toStrictEqual("imports/job-1");
    expect(
      pagePrefixSearch(
        [
          { id: "b", reading: "あい", word: "愛" },
          { id: "a", reading: "ぶいあーるちゃっと", word: "VRC" },
        ],
        { q: "あ", cursor: "", limit: 50 },
      ),
    ).toStrictEqual({
      entries: [{ id: "b", reading: "あい", word: "愛" }],
      matched: 1,
      nextCursor: null,
    });
  });

  it("sorts, paginates, and slices import batches deterministically", () => {
    expect(
      compareReadingThenId(
        { id: "b", reading: "あ", word: "B" },
        { id: "a", reading: "い", word: "A" },
      ),
    ).toStrictEqual(-1);
    expect(
      compareReadingThenId(
        { id: "a", reading: "い", word: "A" },
        { id: "b", reading: "あ", word: "B" },
      ),
    ).toStrictEqual(1);
    expect(
      compareReadingThenId(
        { id: "a", reading: "あ", word: "A" },
        { id: "b", reading: "あ", word: "B" },
      ),
    ).toStrictEqual(-1);
    expect(
      compareReadingThenId(
        { id: "b", reading: "あ", word: "B" },
        { id: "a", reading: "あ", word: "A" },
      ),
    ).toStrictEqual(1);
    expect(
      compareReadingThenId(
        { id: "a", reading: "あ", word: "A" },
        { id: "a", reading: "あ", word: "A" },
      ),
    ).toStrictEqual(0);
    expect(
      pagePrefixSearch(
        [
          { id: "b", reading: "あ", word: "B" },
          { id: "a", reading: "あ", word: "A" },
          { id: "c", reading: "い", word: "C" },
        ],
        { q: "", cursor: "", limit: 1 },
      ),
    ).toStrictEqual({
      entries: [{ id: "a", reading: "あ", word: "A" }],
      matched: 3,
      nextCursor: "a",
    });
    expect(
      pagePrefixSearch(
        [
          { id: "b", reading: "あ", word: "B" },
          { id: "a", reading: "あ", word: "A" },
        ],
        { q: "", cursor: "a", limit: 5 },
      ),
    ).toStrictEqual({
      entries: [{ id: "b", reading: "あ", word: "B" }],
      matched: 2,
      nextCursor: null,
    });
    expect(sliceImportBatch([{ id: "a", reading: "あ", word: "A" }], 1)).toStrictEqual([]);
    expect(emptyImportJob({ id: "job", dictionaryId: "dictionary" })).toStrictEqual({
      id: "job",
      dictionaryId: "dictionary",
      status: "queued",
      processed: 0,
      accepted: 0,
      total: 0,
      error: "",
    });
  });

  it("stores import bodies in memory", async () => {
    const store = createMemoryImportStore();
    expect(await store.get("missing")).toStrictEqual(null);
    await store.put("imports/job", "body");
    expect(await store.get("imports/job")).toStrictEqual("body");
    expect(store.bodies).toStrictEqual(new Map([["imports/job", "body"]]));
    await store.delete("imports/job");
    expect(await store.get("imports/job")).toStrictEqual(null);
  });
});
