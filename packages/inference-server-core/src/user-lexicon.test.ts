/**
 * Worker-owned user lexicon domain tests.
 *
 * This file runs with bun.
 */

import { describe, expect, it } from "vitest";
import {
  applyStoredLexiconReadings,
  convertWithStoredUserLexicon,
  createMemoryUserLexicon,
  createUserLexiconEntryId,
  encodeUserLexiconCompact,
  pageUserLexiconEntries,
  parseUserLexiconCsv,
  parseUserLexiconDocument,
  parseUserLexiconImportBody,
  parseUserLexiconSearchQuery,
  parseUserLexiconTsv,
  USER_LEXICON_MAX_ENTRIES,
  userLexiconEntriesToTsv,
  userLexiconEntryFromUnknown,
  validateUserLexiconEntries,
} from "./user-lexicon.js";
import { createMemoryImportStore } from "./user-lexicon-catalog.js";

describe("worker-owned user lexicon", () => {
  it("round-trips TSV and JSON documents without a browser store", () => {
    expect(
      userLexiconEntriesToTsv([
        { id: "one", reading: "よみ", word: "単語" },
        { id: "two", reading: "ぶいあーるちゃっと", word: "VRC" },
      ]),
    ).toStrictEqual("よみ\t単語\nぶいあーるちゃっと\tVRC\n");
    expect(userLexiconEntriesToTsv([])).toStrictEqual("");
    expect(parseUserLexiconTsv("よみ\t単語\n", () => "one")).toStrictEqual([
      { id: "one", reading: "よみ", word: "単語" },
    ]);
    expect(parseUserLexiconTsv("ぶいあーるちゃっと\tVRC\n", () => "two")).toStrictEqual([
      { id: "two", reading: "ぶいあーるちゃっと", word: "VRC" },
    ]);
    expect(
      parseUserLexiconDocument(
        '{"version":1,"entries":[{"id":"kept","reading":"よみ","word":"単語"}]}',
      ),
    ).toStrictEqual([{ id: "kept", reading: "よみ", word: "単語" }]);
    expect(parseUserLexiconDocument("")).toStrictEqual([]);
    expect(parseUserLexiconImportBody("ぶいあーるちゃっと\tVRC\n", () => "tsv-id")).toStrictEqual([
      { id: "tsv-id", reading: "ぶいあーるちゃっと", word: "VRC" },
    ]);
    expect(
      parseUserLexiconImportBody(
        '{"version":1,"entries":[{"id":"json","reading":"よみ","word":"単語"}]}',
        () => "ignored",
      ),
    ).toStrictEqual([{ id: "json", reading: "よみ", word: "単語" }]);
  });

  it("rejects invalid entries, TSV rows, and JSON documents", () => {
    expect(() => validateUserLexiconEntries([{ id: "", reading: "よみ", word: "単語" }])).toThrow(
      "id is invalid",
    );
    expect(() =>
      validateUserLexiconEntries([
        { id: "dup", reading: "あい", word: "A" },
        { id: "dup", reading: "いう", word: "I" },
      ]),
    ).toThrow("id is duplicated");
    expect(() => validateUserLexiconEntries([{ id: "a", reading: "", word: "単語" }])).toThrow(
      "reading is required",
    );
    expect(() => validateUserLexiconEntries([{ id: "a", reading: "あ", word: "A" }])).toThrow(
      "reading is too short",
    );
    expect(() => validateUserLexiconEntries([{ id: "a", reading: "は", word: "歯" }])).toThrow(
      "reading is too short",
    );
    expect(validateUserLexiconEntries([{ id: "a", reading: "あい", word: "愛" }])).toStrictEqual([
      { id: "a", reading: "あい", word: "愛" },
    ]);
    expect(() => validateUserLexiconEntries([{ id: "a", reading: "よみ", word: "" }])).toThrow(
      "word is required",
    );
    expect(() =>
      validateUserLexiconEntries([{ id: "a", reading: "よ\tみ", word: "単語" }]),
    ).toThrow("cannot contain tabs or newlines");
    expect(() => validateUserLexiconEntries([{ id: "a", reading: "#よみ", word: "単語" }])).toThrow(
      "cannot start with #",
    );
    expect(() =>
      validateUserLexiconEntries([{ id: "a".repeat(129), reading: "よみ", word: "単語" }]),
    ).toThrow("id is invalid");
    expect(() =>
      validateUserLexiconEntries([{ id: "a", reading: "あ".repeat(257), word: "単語" }]),
    ).toThrow("reading is too long");
    expect(() =>
      validateUserLexiconEntries([{ id: "a", reading: "よみ", word: "語".repeat(513) }]),
    ).toThrow("word is too long");
    expect(() => parseUserLexiconTsv("よみだけ", () => "id")).toThrow(
      "TSV row 1 must contain reading and word",
    );
    expect(() => parseUserLexiconDocument("[]")).toThrow("must be an object");
    expect(() => parseUserLexiconDocument('{"version":2,"entries":[]}')).toThrow(
      "Unsupported user lexicon version",
    );
    expect(() => parseUserLexiconDocument('{"version":1,"entries":null}')).toThrow(
      "entries must be an array",
    );
    expect(() => parseUserLexiconDocument('{"version":1,"entries":["bad"]}')).toThrow(
      "must be an object",
    );
    expect(() =>
      parseUserLexiconDocument('{"version":1,"entries":[{"id":1,"reading":"a","word":"b"}]}'),
    ).toThrow("missing id, reading, or word");
    expect(() => parseUserLexiconDocument("{")).toThrow();
    expect(() => userLexiconEntryFromUnknown(null, () => "id")).toThrow("must be an object");
    expect(() => userLexiconEntryFromUnknown({ reading: "よみ" }, () => "id")).toThrow(
      "requires reading and word",
    );
    expect(
      userLexiconEntryFromUnknown({ id: "kept", reading: "よみ", word: "単語" }, () => "new"),
    ).toStrictEqual({ id: "kept", reading: "よみ", word: "単語" });
    expect(createUserLexiconEntryId().length).toBeGreaterThan(0);
  });

  it("rejects more than 100000 entries", () => {
    const overflow = Array.from({ length: USER_LEXICON_MAX_ENTRIES + 1 }, (_value, index) => ({
      id: `id-${String(index)}`,
      reading: "よみ",
      word: "単語",
    }));
    expect(() => validateUserLexiconEntries(overflow)).toThrow(
      "User lexicon supports at most 100000 entries",
    );
  });

  it("searches and paginates without dumping the whole lexicon", () => {
    expect(
      parseUserLexiconSearchQuery(
        new URL("https://worker.example/azookey/user-lexicon/entries?q=単語&limit=3&cursor=a"),
      ),
    ).toStrictEqual({ q: "単語", limit: 3, cursor: "a", dictionaryId: "default" });
    expect(
      parseUserLexiconSearchQuery(new URL("https://worker.example/azookey/user-lexicon/entries")),
    ).toStrictEqual({ q: "", limit: 50, cursor: "", dictionaryId: "default" });
    expect(
      parseUserLexiconSearchQuery(
        new URL("https://worker.example/azookey/user-lexicon/entries?limit=nope"),
      ),
    ).toStrictEqual({ q: "", limit: 50, cursor: "", dictionaryId: "default" });
    expect(
      pageUserLexiconEntries(
        [
          { id: "a", reading: "よみ", word: "単語" },
          { id: "c", reading: "ぶいあーるちゃっと", word: "VRC" },
        ],
        { q: "VRC", cursor: "", limit: 0, dictionaryId: "default" },
      ),
    ).toStrictEqual({
      entries: [{ id: "c", reading: "ぶいあーるちゃっと", word: "VRC" }],
      matched: 1,
      nextCursor: null,
    });
    expect(
      pageUserLexiconEntries(
        [
          { id: "a", reading: "よみ", word: "単語" },
          { id: "b", reading: "よみ", word: "別" },
        ],
        { q: "よみ", cursor: "a", limit: 1, dictionaryId: "default" },
      ),
    ).toStrictEqual({
      entries: [{ id: "b", reading: "よみ", word: "別" }],
      matched: 2,
      nextCursor: null,
    });
  });

  it("persists through the RPC contract and never exposes snapshotTsv as HTTP state", async () => {
    const lexicon = createMemoryUserLexicon(() => "created-id");
    expect(await lexicon.meta()).toStrictEqual({ revision: "0", entryCount: 0, tsvBytes: 0 });
    const created = await lexicon.upsert({ reading: "ぶいあーるちゃっと", word: "VRC" });
    expect(created).toStrictEqual({
      revision: "1",
      entry: { id: "created-id", reading: "ぶいあーるちゃっと", word: "VRC" },
    });
    expect(await lexicon.snapshotTsv()).toStrictEqual({
      revision: "1",
      tsv: "ぶいあーるちゃっと\tVRC\n",
    });
    expect((await lexicon.snapshotCompact()).revision).toStrictEqual("1");
    expect((await lexicon.snapshotCompact()).compact.byteLength).toBeGreaterThan(32);
    expect(await lexicon.search({ q: "VRC", cursor: "", limit: 50 })).toStrictEqual({
      revision: "1",
      entryCount: 1,
      entries: [{ id: "created-id", reading: "ぶいあーるちゃっと", word: "VRC" }],
      nextCursor: null,
    });
    const updated = await lexicon.update("created-id", { reading: "よみ", word: "単語" });
    expect(updated.entry).toStrictEqual({ id: "created-id", reading: "よみ", word: "単語" });
    await lexicon.replaceAll([{ id: "kept", reading: "ぶいあーるちゃっと", word: "VRC" }]);
    expect((await lexicon.meta()).entryCount).toStrictEqual(1);
    await lexicon.remove("kept");
    expect(await lexicon.meta()).toStrictEqual({ revision: "4", entryCount: 0, tsvBytes: 0 });
    await lexicon.clear();
    expect((await lexicon.meta()).revision).toStrictEqual("5");
    await lexicon.restore({
      revision: "9",
      entries: [{ id: "restored", reading: "ぶいあーるちゃっと", word: "VRC" }],
    });
    expect(await lexicon.exportAll()).toStrictEqual({
      revision: "9",
      entries: [{ id: "restored", reading: "ぶいあーるちゃっと", word: "VRC" }],
    });
  });

  it("converts ぶいあーるちゃっと with the stored Worker lexicon", async () => {
    const lexicon = createMemoryUserLexicon(() => "one");
    await lexicon.upsert({ reading: "ぶいあーるちゃっと", word: "VRC" });
    expect(
      applyStoredLexiconReadings("ぶいあーるちゃっと", "ぶいあーるちゃっと\tVRC\n"),
    ).toStrictEqual("VRC");
    expect(applyStoredLexiconReadings("そのまま", "")).toStrictEqual("そのまま");
    const seen: string[] = [];
    const result = await convertWithStoredUserLexicon({
      lexicon,
      converter: {
        convert: async (input) => {
          seen.push(input.lexiconTsv);
          const compact = await lexicon.snapshotCompact();
          expect(compact.compact.byteLength).toBeGreaterThan(32);
          return input.text;
        },
      },
      text: "ぶいあーるちゃっと",
    });
    expect(seen).toStrictEqual([""]);
    expect(result).toStrictEqual({
      convertedText: "ぶいあーるちゃっと",
      lexiconEntryCount: 1,
      revision: "1",
    });
  });

  it("rejects a missing update target and a 100001st upsert", async () => {
    const lexicon = createMemoryUserLexicon(() => "overflow");
    expect(() => lexicon.update("missing", { reading: "よみ", word: "単語" })).toThrow(
      "User lexicon entry not found",
    );
    expect(() => lexicon.remove("missing")).toThrow("User lexicon entry not found");
    await lexicon.replaceAll(
      Array.from({ length: USER_LEXICON_MAX_ENTRIES }, (_value, index) => ({
        id: `id-${String(index)}`,
        reading: "よみ",
        word: "単語",
      })),
    );
    expect(() => lexicon.upsert({ reading: "ついか", word: "追加" })).toThrow(
      "User lexicon supports at most 100000 entries",
    );
  });

  it("manages multiple dictionaries and queues a TSV import with progress", async () => {
    const ids = { n: 0 };
    const lexicon = createMemoryUserLexicon(() => {
      ids.n += 1;
      return `id-${String(ids.n)}`;
    });
    const created = await lexicon.createDictionary("Names");
    expect(created.dictionary.name).toStrictEqual("Names");
    await lexicon.activateDictionary(created.dictionary.id);
    const job = await lexicon.startImport({
      dictionaryId: created.dictionary.id,
      body: "ぶいあーるちゃっと\tVRC\nあい\t愛\n",
      filename: "words.tsv",
    });
    expect(job.status).toStrictEqual("completed");
    expect(job.accepted).toStrictEqual(2);
    expect(job.processed).toStrictEqual(2);
    const status = await lexicon.importStatus(job.id);
    expect(status.status).toStrictEqual("completed");
    const searched = await lexicon.search({
      q: "ぶい",
      cursor: "",
      limit: 50,
      dictionaryId: created.dictionary.id,
    });
    expect(searched.entries.length).toStrictEqual(1);
    expect(searched.entries[0]?.reading).toStrictEqual("ぶいあーるちゃっと");
    expect(searched.entries[0]?.word).toStrictEqual("VRC");
    const renamed = await lexicon.renameDictionary(created.dictionary.id, "Proper nouns");
    expect(renamed.dictionary.name).toStrictEqual("Proper nouns");
    const listed = await lexicon.listDictionaries();
    expect(listed.dictionaries.length).toStrictEqual(2);
    await lexicon.deleteDictionary(created.dictionary.id);
    const afterDelete = await lexicon.listDictionaries();
    expect(afterDelete.dictionaries).toStrictEqual([
      { id: "default", name: "Custom", entryCount: 0 },
    ]);
  });

  it("rejects missing dictionaries, invalid catalog mutations, and malformed CSV", async () => {
    const lexicon = createMemoryUserLexicon(() => "created");
    expect(() => lexicon.search({ q: "", cursor: "", limit: 1, dictionaryId: "missing" })).toThrow(
      "Dictionary missing was not found",
    );
    expect(() => lexicon.activateDictionary("missing")).toThrow("Dictionary missing was not found");
    expect(() => lexicon.createDictionary(" ")).toThrow("Dictionary name is required");
    expect(() => lexicon.renameDictionary("default", " ")).toThrow("Dictionary name is required");
    expect(() => lexicon.deleteDictionary("default")).toThrow(
      "At least one dictionary is required",
    );
    expect(() => lexicon.importStatus("missing")).toThrow("Import missing was not found");
    await expect(lexicon.processQueuedImport("missing")).rejects.toThrow(
      "Import missing was not found",
    );
    expect(() => parseUserLexiconCsv("broken", () => "csv-id")).toThrow(
      "CSV row 1 must contain reading and word",
    );
    expect(parseUserLexiconImportBody("よみ,単語\nあい,愛\n", () => "csv-id")).toStrictEqual([
      { id: "csv-id", reading: "あい", word: "愛" },
    ]);
    expect((await lexicon.listDictionaries()).activeId).toStrictEqual("default");
  });

  it("queues imports in an external store and marks a missing body as failed", async () => {
    const ids = { next: 0 };
    const sent: Array<{ importId: string }> = [];
    const store = createMemoryImportStore();
    const lexicon = createMemoryUserLexicon(
      () => {
        ids.next += 1;
        return `queued-${String(ids.next)}`;
      },
      {
        importStore: store,
        importQueue: {
          send: (message) => {
            sent.push(message);
            return Promise.resolve();
          },
        },
      },
    );
    const queued = await lexicon.startImport({
      dictionaryId: "default",
      body: "あい\t愛\n",
      filename: "words.tsv",
    });
    expect(queued.status).toStrictEqual("queued");
    expect(sent).toStrictEqual([{ importId: "queued-1" }]);
    await store.delete("imports/queued-1");
    expect(await lexicon.processQueuedImport("queued-1")).toStrictEqual({
      id: "queued-1",
      dictionaryId: "default",
      status: "failed",
      processed: 0,
      accepted: 0,
      total: 0,
      error: "Import object is missing",
    });
  });

  it("processes and deletes a queued external import body", async () => {
    const ids = { next: 0 };
    const store = createMemoryImportStore();
    const lexicon = createMemoryUserLexicon(
      () => {
        ids.next += 1;
        return `external-${String(ids.next)}`;
      },
      { importStore: store, importQueue: { send: () => Promise.resolve() } },
    );
    const queued = await lexicon.startImport({
      dictionaryId: "default",
      body: "あい\t愛\n",
      filename: "words.tsv",
    });
    expect((await lexicon.processQueuedImport(queued.id)).status).toStrictEqual("completed");
    expect(await store.get(`imports/${queued.id}`)).toStrictEqual(null);
  });

  it("encodes a packed user lexicon without a convert-time TSV body", () => {
    expect([...encodeUserLexiconCompact([{ id: "a", reading: "あい", word: "愛" }])]).toStrictEqual(
      [
        65, 90, 85, 76, 88, 67, 48, 49, 1, 0, 0, 0, 1, 0, 0, 0, 9, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 6, 0, 0, 0, 3, 0, 0, 0, 224, 192, 227, 129, 130, 227, 129,
        132, 230, 132, 155,
      ],
    );
    expect(encodeUserLexiconCompact([]).byteLength).toStrictEqual(32);
    expect(
      encodeUserLexiconCompact([{ id: "long", reading: "あ".repeat(31), word: "長" }]).byteLength,
    ).toBeGreaterThan(32);
  });
});
