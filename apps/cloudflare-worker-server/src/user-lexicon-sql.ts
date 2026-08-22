/**
 * SQLite-backed user lexicon used by UserLexiconDO.
 *
 * This file runs with bun.
 */

import {
  createMemoryUserLexicon,
  createUserLexiconEntryId,
  type UserLexiconRpc,
} from "@caption-bridge/inference-server-core";

export interface UserLexiconSqlCursor {
  toArray: () => Record<string, unknown>[];
}

export interface UserLexiconSql {
  exec: (query: string, ...binds: (string | number)[]) => UserLexiconSqlCursor | undefined;
}

export interface UserLexiconDoState {
  storage?: {
    sql?: UserLexiconSql;
  };
}

const CREATE_ENTRIES: string = `CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  reading TEXT NOT NULL,
  word TEXT NOT NULL
)`;
const CREATE_READING_INDEX: string =
  "CREATE INDEX IF NOT EXISTS entries_reading ON entries(reading)";
const CREATE_WORD_INDEX: string = "CREATE INDEX IF NOT EXISTS entries_word ON entries(word)";
const CREATE_META: string = "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)";
const SELECT_ENTRIES: string = "SELECT id, reading, word FROM entries ORDER BY id";
const SELECT_META: string = "SELECT k, v FROM meta";
const DELETE_ENTRIES: string = "DELETE FROM entries";
const INSERT_ENTRY: string = "INSERT INTO entries (id, reading, word) VALUES (?, ?, ?)";
const UPSERT_META: string = "INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)";

const textField = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : "";
};

const sqlFromState = (ctx: UserLexiconDoState): UserLexiconSql | undefined => {
  const storage = ctx.storage;
  if (!storage || typeof storage !== "object" || !("sql" in storage)) {
    return undefined;
  }
  const sql = storage.sql;
  if (!sql || typeof sql !== "object" || !("exec" in sql)) {
    return undefined;
  }
  return sql;
};

export const createSqlBackedUserLexicon = (ctx: UserLexiconDoState): UserLexiconRpc => {
  const rpc = createMemoryUserLexicon(createUserLexiconEntryId);
  const sql = sqlFromState(ctx);
  const ensureSchema = (): void => {
    if (!sql) {
      return;
    }
    sql.exec(CREATE_ENTRIES);
    sql.exec(CREATE_READING_INDEX);
    sql.exec(CREATE_WORD_INDEX);
    sql.exec(CREATE_META);
  };
  const hydrate = async (): Promise<void> => {
    if (!sql) {
      return;
    }
    const entryCursor = sql.exec(SELECT_ENTRIES);
    const metaCursor = sql.exec(SELECT_META);
    if (!entryCursor) {
      return;
    }
    const entries = entryCursor.toArray().flatMap((row) => {
      const id = textField(row, "id");
      const reading = textField(row, "reading");
      const word = textField(row, "word");
      if (id.length === 0 || reading.length === 0 || word.length === 0) {
        return [];
      }
      return [{ id, reading, word }];
    });
    const revision = metaCursor
      ? metaCursor.toArray().reduce((current, row) => {
          if (textField(row, "k") === "revision") {
            return textField(row, "v");
          }
          return current;
        }, "0")
      : "0";
    await rpc.restore({ revision, entries });
  };
  const persist = async (): Promise<void> => {
    if (!sql) {
      return;
    }
    const exported = await rpc.exportAll();
    const snapshot = await rpc.snapshotTsv();
    sql.exec(DELETE_ENTRIES);
    exported.entries.map((entry) => sql.exec(INSERT_ENTRY, entry.id, entry.reading, entry.word));
    const catalog = await rpc.listDictionaries();
    sql.exec(UPSERT_META, "revision", exported.revision);
    sql.exec(UPSERT_META, "entry_count", String(exported.entries.length));
    sql.exec(UPSERT_META, "tsv", snapshot.tsv);
    sql.exec(UPSERT_META, "active_id", catalog.activeId);
    sql.exec(UPSERT_META, "dictionaries", JSON.stringify(catalog.dictionaries));
  };
  ensureSchema();
  const ready = hydrate();
  const afterReady = async <T>(work: () => Promise<T>): Promise<T> => {
    await ready;
    return work();
  };
  return {
    meta: () => afterReady(() => rpc.meta()),
    snapshotTsv: () => afterReady(() => rpc.snapshotTsv()),
    snapshotCompact: () => afterReady(() => rpc.snapshotCompact()),
    exportAll: () => afterReady(() => rpc.exportAll()),
    restore: (snapshot) => afterReady(() => rpc.restore(snapshot)),
    search: (query) => afterReady(() => rpc.search(query)),
    upsert: (entry) =>
      afterReady(async () => {
        const result = await rpc.upsert(entry);
        await persist();
        return result;
      }),
    update: (id, fields) =>
      afterReady(async () => {
        const result = await rpc.update(id, fields);
        await persist();
        return result;
      }),
    remove: (id) =>
      afterReady(async () => {
        const result = await rpc.remove(id);
        await persist();
        return result;
      }),
    replaceAll: (entries) =>
      afterReady(async () => {
        const result = await rpc.replaceAll(entries);
        await persist();
        return result;
      }),
    clear: () =>
      afterReady(async () => {
        const result = await rpc.clear();
        await persist();
        return result;
      }),
    listDictionaries: () => afterReady(() => rpc.listDictionaries()),
    createDictionary: (name) =>
      afterReady(async () => {
        const result = await rpc.createDictionary(name);
        await persist();
        return result;
      }),
    renameDictionary: (id, name) =>
      afterReady(async () => {
        const result = await rpc.renameDictionary(id, name);
        await persist();
        return result;
      }),
    deleteDictionary: (id) =>
      afterReady(async () => {
        const result = await rpc.deleteDictionary(id);
        await persist();
        return result;
      }),
    activateDictionary: (id) =>
      afterReady(async () => {
        const result = await rpc.activateDictionary(id);
        await persist();
        return result;
      }),
    startImport: (input) =>
      afterReady(async () => {
        const result = await rpc.startImport(input);
        await persist();
        return result;
      }),
    importStatus: (importId) => afterReady(() => rpc.importStatus(importId)),
    processQueuedImport: (importId) =>
      afterReady(async () => {
        const result = await rpc.processQueuedImport(importId);
        await persist();
        return result;
      }),
  };
};
