/**
 * Durable Object user lexicon persist tests. SQL is faked.
 *
 * This file runs with bun.
 */

import { describe, expect, it } from "vitest";
import { createSqlBackedUserLexicon, type UserLexiconSqlCursor } from "./user-lexicon-sql.js";

interface StoredRow {
  id: string;
  reading: string;
  word: string;
}

const createSql = (seed: StoredRow[]) => {
  const entries: StoredRow[] = [...seed];
  const meta = new Map<string, string>([
    ["revision", "3"],
    ["entry_count", String(seed.length)],
    ["tsv", ""],
  ]);
  const exec = (query: string, ...binds: (string | number)[]): UserLexiconSqlCursor | undefined => {
    if (query.startsWith("CREATE")) {
      return;
    }
    if (query.startsWith("SELECT id, reading, word")) {
      return { toArray: () => entries.map((row) => ({ ...row })) };
    }
    if (query.startsWith("SELECT k, v")) {
      return {
        toArray: () => [...meta.entries()].map(([k, v]) => ({ k, v })),
      };
    }
    if (query.startsWith("DELETE FROM entries")) {
      entries.splice(0, entries.length);
      return;
    }
    if (query.startsWith("INSERT INTO entries")) {
      entries.push({
        id: String(binds[0] ?? ""),
        reading: String(binds[1] ?? ""),
        word: String(binds[2] ?? ""),
      });
      return;
    }
    if (query.startsWith("INSERT OR REPLACE INTO meta")) {
      meta.set(String(binds[0] ?? ""), String(binds[1] ?? ""));
    }
    return undefined;
  };
  return { exec, entries, meta };
};

describe("UserLexiconDO SQL backing", () => {
  it("hydrates stored rows and rewrites SQLite on upsert", async () => {
    const sql = createSql([{ id: "seed", reading: "よみ", word: "単語" }]);
    const lexicon = createSqlBackedUserLexicon({ storage: { sql } });
    expect(await lexicon.meta()).toStrictEqual({
      revision: "3",
      entryCount: 1,
      tsvBytes: 14,
    });
    const created = await lexicon.upsert({ reading: "ぶいあーるちゃっと", word: "VRC" });
    expect(created.entry.reading).toStrictEqual("ぶいあーるちゃっと");
    expect(created.entry.word).toStrictEqual("VRC");
    expect(sql.meta.get("revision")).toStrictEqual(created.revision);
    expect(sql.entries.length).toStrictEqual(2);
    await lexicon.update(created.entry.id, { reading: "よみ", word: "単語" });
    await lexicon.remove("seed");
    await lexicon.replaceAll([{ id: "kept", reading: "ぶいあーるちゃっと", word: "VRC" }]);
    expect((await lexicon.exportAll()).entries).toStrictEqual([
      { id: "kept", reading: "ぶいあーるちゃっと", word: "VRC" },
    ]);
    await lexicon.clear();
    expect((await lexicon.meta()).entryCount).toStrictEqual(0);
    expect((await lexicon.snapshotCompact()).compact.byteLength).toBeGreaterThan(0);
    expect(
      await lexicon.search({ q: "", cursor: "", limit: 1, dictionaryId: "default" }),
    ).toStrictEqual({ revision: "8", entryCount: 0, entries: [], nextCursor: null });
    expect((await lexicon.listDictionaries()).activeId).toStrictEqual("default");
    const dictionary = await lexicon.createDictionary("Names");
    await lexicon.activateDictionary(dictionary.dictionary.id);
    const renamed = await lexicon.renameDictionary(dictionary.dictionary.id, "Renamed");
    expect(renamed.dictionary.name).toStrictEqual("Renamed");
    const imported = await lexicon.startImport({
      dictionaryId: dictionary.dictionary.id,
      body: "あい\t愛\n",
      filename: "words.tsv",
    });
    expect((await lexicon.importStatus(imported.id)).status).toStrictEqual("completed");
    expect((await lexicon.processQueuedImport(imported.id)).status).toStrictEqual("failed");
    await lexicon.deleteDictionary(dictionary.dictionary.id);
  });

  it("works without SQL and still serves RPC", async () => {
    const nonObjectStorage = Object.defineProperty({}, "storage", { value: 1 });
    expect((await createSqlBackedUserLexicon(nonObjectStorage).meta()).entryCount).toStrictEqual(0);
    const nonObjectSqlStorage = Object.defineProperty({}, "sql", { value: 1 });
    expect(
      (await createSqlBackedUserLexicon({ storage: nonObjectSqlStorage }).meta()).entryCount,
    ).toStrictEqual(0);
    const lexicon = createSqlBackedUserLexicon({});
    const created = await lexicon.upsert({
      id: "fixed",
      reading: "ぶいあーるちゃっと",
      word: "VRC",
    });
    expect(created).toStrictEqual({
      revision: "1",
      entry: { id: "fixed", reading: "ぶいあーるちゃっと", word: "VRC" },
    });
    expect(await lexicon.snapshotTsv()).toStrictEqual({
      revision: "1",
      tsv: "ぶいあーるちゃっと\tVRC\n",
    });
    await lexicon.restore({ revision: "8", entries: [] });
    expect(await lexicon.meta()).toStrictEqual({ revision: "8", entryCount: 0, tsvBytes: 0 });
  });

  it("skips empty SQL rows and missing cursors during hydrate", async () => {
    const exec = (query: string): UserLexiconSqlCursor | undefined => {
      if (query.startsWith("CREATE") || query.startsWith("DELETE") || query.startsWith("INSERT")) {
        return undefined;
      }
      if (query.startsWith("SELECT id, reading, word")) {
        return {
          toArray: () => [
            { id: "", reading: "よみ", word: "単語" },
            { id: "ok", reading: "", word: "単語" },
            { id: "ok2", reading: "よみ", word: "" },
            { id: "kept", reading: "ぶいあーるちゃっと", word: "VRC" },
          ],
        };
      }
      return undefined;
    };
    const lexicon = createSqlBackedUserLexicon({ storage: { sql: { exec } } });
    expect(await lexicon.exportAll()).toStrictEqual({
      revision: "0",
      entries: [{ id: "kept", reading: "ぶいあーるちゃっと", word: "VRC" }],
    });
    const noSql = createSqlBackedUserLexicon({ storage: {} });
    expect((await noSql.meta()).entryCount).toStrictEqual(0);
    const missingCursor = createSqlBackedUserLexicon({
      storage: { sql: { exec: () => undefined } },
    });
    expect((await missingCursor.meta()).revision).toStrictEqual("0");
  });
});
