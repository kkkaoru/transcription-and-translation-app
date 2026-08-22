/**
 * Worker-owned AzooKey user lexicon. Word data is persisted on the server.
 *
 * This file runs with bun.
 */

import {
  defaultUserLexiconDictionary,
  emptyImportJob,
  entryMatchesPrefixSearch,
  importObjectKey,
  isValidDictionaryName,
  normalizeDictionaryName,
  USER_LEXICON_DEFAULT_DICTIONARY_ID,
  USER_LEXICON_MAX_DICTIONARIES,
  type UserLexiconCatalog,
  type UserLexiconDictionary,
  type UserLexiconImportJob,
  type UserLexiconImportQueue,
  type UserLexiconImportStore,
} from "./user-lexicon-catalog.js";

export const USER_LEXICON_VERSION: number = 1;
export const USER_LEXICON_MAX_ENTRIES: number = 100_000;
export const USER_LEXICON_MAX_ID_CHARS: number = 128;
export const USER_LEXICON_MIN_READING_CHARS: number = 2;
export const USER_LEXICON_MAX_READING_CHARS: number = 256;
export const USER_LEXICON_MAX_WORD_CHARS: number = 512;
export const USER_LEXICON_LIST_DEFAULT_LIMIT: number = 50;
export const USER_LEXICON_LIST_MAX_LIMIT: number = 50;
export const USER_LEXICON_MAX_IMPORT_BYTES: number = 16 * 1024 * 1024;
export const USER_LEXICON_HTTP_PATH: string = "/azookey/user-lexicon";
export const USER_LEXICON_ENTRIES_PATH: string = "/azookey/user-lexicon/entries";
export const USER_LEXICON_IMPORT_PATH: string = "/azookey/user-lexicon/import";
export const USER_LEXICON_CONVERT_PATH: string = "/v1/azookey/convert";
export const USER_LEXICON_DO_NAME: string = "hosted-compare";
export const USER_LEXICON_BINDING: string = "USER_LEXICON";
export const USER_LEXICON_INITIAL_REVISION: string = "0";

export interface UserLexiconEntry {
  id: string;
  reading: string;
  word: string;
}

export interface UserLexiconDocument {
  version: number;
  entries: UserLexiconEntry[];
}

export interface UserLexiconMeta {
  revision: string;
  entryCount: number;
  tsvBytes: number;
}

export interface UserLexiconSnapshot {
  revision: string;
  tsv: string;
}

export interface UserLexiconCompactSnapshot {
  revision: string;
  compact: Uint8Array;
}

interface UserLexiconCompactRow {
  readingOff: number;
  readingLen: number;
  surfaceOff: number;
  surfaceLen: number;
  value: number;
}

interface UserLexiconCompactBuild {
  offset: number;
  lengthBits: number;
  rows: UserLexiconCompactRow[];
}

export interface UserLexiconSearchQuery {
  q: string;
  cursor: string;
  limit: number;
  dictionaryId?: string;
}

export interface UserLexiconSearchPage {
  revision: string;
  entryCount: number;
  entries: UserLexiconEntry[];
  nextCursor: string | null;
}

export interface UserLexiconMutation {
  revision: string;
}

export interface UserLexiconUpsertResult {
  revision: string;
  entry: UserLexiconEntry;
}

export interface UserLexiconReplaceResult {
  revision: string;
  entryCount: number;
}

export interface UserLexiconExport {
  revision: string;
  entries: UserLexiconEntry[];
}

export interface UserLexiconStoredEntry extends UserLexiconEntry {
  dictionaryId: string;
}

export interface UserLexiconRpc {
  meta: () => Promise<UserLexiconMeta>;
  snapshotTsv: () => Promise<UserLexiconSnapshot>;
  snapshotCompact: () => Promise<UserLexiconCompactSnapshot>;
  exportAll: () => Promise<UserLexiconExport>;
  restore: (snapshot: UserLexiconExport) => Promise<void>;
  search: (query: UserLexiconSearchQuery) => Promise<UserLexiconSearchPage>;
  upsert: (entry: {
    reading: string;
    word: string;
    id?: string;
    dictionaryId?: string;
  }) => Promise<UserLexiconUpsertResult>;
  update: (
    id: string,
    fields: { reading: string; word: string },
  ) => Promise<UserLexiconUpsertResult>;
  remove: (id: string) => Promise<UserLexiconMutation>;
  replaceAll: (entries: readonly UserLexiconEntry[]) => Promise<UserLexiconReplaceResult>;
  clear: () => Promise<UserLexiconMutation>;
  listDictionaries: () => Promise<UserLexiconCatalog>;
  createDictionary: (
    name: string,
  ) => Promise<{ revision: string; dictionary: UserLexiconDictionary }>;
  renameDictionary: (
    id: string,
    name: string,
  ) => Promise<{ revision: string; dictionary: UserLexiconDictionary }>;
  deleteDictionary: (id: string) => Promise<UserLexiconMutation>;
  activateDictionary: (id: string) => Promise<{ revision: string; activeId: string }>;
  startImport: (input: {
    dictionaryId: string;
    body: string;
    filename: string;
  }) => Promise<UserLexiconImportJob>;
  importStatus: (importId: string) => Promise<UserLexiconImportJob>;
  processQueuedImport: (importId: string) => Promise<UserLexiconImportJob>;
}

export interface UserLexiconConvertInput {
  text: string;
  lexiconTsv: string;
}

export interface UserLexiconConverter {
  convert: (input: UserLexiconConvertInput) => Promise<string>;
}

export interface UserLexiconConvertResult {
  convertedText: string;
  lexiconEntryCount: number;
  revision: string;
}

export interface ActiveUserLexicon {
  revision: string;
  handle: number;
}

const EMPTY_CURSOR: string = "";
const EMPTY_QUERY: string = "";
const EMPTY_TSV: string = "";
const TAB: string = "\t";
const HTTP_BAD_REQUEST: number = 400;
const HTTP_NOT_FOUND: number = 404;
const CONTROL_CHARACTERS: RegExp = /[\t\r\n]/u;
const TEXT_ENCODER: TextEncoder = new TextEncoder();
const USER_LEXICON_COMPACT_MAGIC: string = "AZULXC01";
const USER_LEXICON_COMPACT_VERSION: number = 1;
const USER_LEXICON_COMPACT_HEADER_BYTES: number = 32;
const USER_LEXICON_COMPACT_ROW_BYTES: number = 16;
const USER_LEXICON_TWO_MORA_VALUE: number = -7;
const USER_LEXICON_LONG_READING_VALUE: number = -1;
const USER_LEXICON_LENGTH_BIT_CAP: number = 31;
const USER_LEXICON_COMPACT_MAX_STRING_BYTES: number = 65_535;

export class UserLexiconError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const createUserLexiconEntryId = (): string => crypto.randomUUID();

const fieldError = (index: number, name: string, detail: string): UserLexiconError =>
  new UserLexiconError(
    "invalid_user_lexicon_entry",
    `entry ${String(index + 1)} ${name} ${detail}`,
    HTTP_BAD_REQUEST,
  );

export const validateUserLexiconEntries = (
  entries: readonly UserLexiconEntry[],
): UserLexiconEntry[] => {
  if (entries.length > USER_LEXICON_MAX_ENTRIES) {
    throw new UserLexiconError(
      "user_lexicon_too_large",
      `User lexicon supports at most ${String(USER_LEXICON_MAX_ENTRIES)} entries`,
      HTTP_BAD_REQUEST,
    );
  }
  const ids = new Set<string>();
  return entries.map((entry, index) => {
    const id = entry.id.trim();
    const reading = entry.reading.trim();
    const word = entry.word.trim();
    if (!id || [...id].length > USER_LEXICON_MAX_ID_CHARS) {
      throw fieldError(index, "id", "is invalid");
    }
    if (ids.has(id)) {
      throw fieldError(index, "id", "is duplicated");
    }
    ids.add(id);
    if (!reading) {
      throw fieldError(index, "reading", "is required");
    }
    if ([...reading].length < USER_LEXICON_MIN_READING_CHARS) {
      throw fieldError(index, "reading", "is too short");
    }
    if (!word) {
      throw fieldError(index, "word", "is required");
    }
    if (CONTROL_CHARACTERS.test(reading) || CONTROL_CHARACTERS.test(word)) {
      throw fieldError(index, "reading or word", "cannot contain tabs or newlines");
    }
    if ([...reading].length > USER_LEXICON_MAX_READING_CHARS) {
      throw fieldError(index, "reading", "is too long");
    }
    if ([...word].length > USER_LEXICON_MAX_WORD_CHARS) {
      throw fieldError(index, "word", "is too long");
    }
    if (reading.startsWith("#")) {
      throw fieldError(index, "reading", "cannot start with #");
    }
    return { id, reading, word };
  });
};

export const userLexiconEntriesToTsv = (entries: readonly UserLexiconEntry[]): string =>
  entries.length === 0
    ? EMPTY_TSV
    : `${entries.map((entry) => `${entry.reading}${TAB}${entry.word}`).join("\n")}\n`;

export const parseUserLexiconTsv = (body: string, createId: () => string): UserLexiconEntry[] => {
  const rows = body
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return validateUserLexiconEntries(
    rows.map((line, index) => {
      const columns = line.split(TAB);
      if (columns.length < 2) {
        throw new UserLexiconError(
          "invalid_user_lexicon_tsv",
          `TSV row ${String(index + 1)} must contain reading and word`,
          HTTP_BAD_REQUEST,
        );
      }
      const reading = columns[0];
      const word = columns[1];
      if (reading === undefined || word === undefined) {
        throw new UserLexiconError(
          "invalid_user_lexicon_tsv",
          `TSV row ${String(index + 1)} must contain reading and word`,
          HTTP_BAD_REQUEST,
        );
      }
      return { id: createId(), reading, word };
    }),
  );
};

export const parseUserLexiconDocument = (body: string): UserLexiconEntry[] => {
  if (body.trim().length === 0) {
    return [];
  }
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) {
    throw new UserLexiconError(
      "invalid_user_lexicon_json",
      "User lexicon JSON must be an object",
      HTTP_BAD_REQUEST,
    );
  }
  if (parsed["version"] !== USER_LEXICON_VERSION) {
    throw new UserLexiconError(
      "invalid_user_lexicon_json",
      "Unsupported user lexicon version",
      HTTP_BAD_REQUEST,
    );
  }
  const rawEntries = parsed["entries"];
  if (!Array.isArray(rawEntries)) {
    throw new UserLexiconError(
      "invalid_user_lexicon_json",
      "User lexicon JSON entries must be an array",
      HTTP_BAD_REQUEST,
    );
  }
  return validateUserLexiconEntries(
    rawEntries.map((value, index) => {
      if (!isRecord(value)) {
        throw new UserLexiconError(
          "invalid_user_lexicon_entry",
          `entry ${String(index + 1)} must be an object`,
          HTTP_BAD_REQUEST,
        );
      }
      const id = value["id"];
      const reading = value["reading"];
      const word = value["word"];
      if (typeof id !== "string" || typeof reading !== "string" || typeof word !== "string") {
        throw new UserLexiconError(
          "invalid_user_lexicon_entry",
          `entry ${String(index + 1)} is missing id, reading, or word`,
          HTTP_BAD_REQUEST,
        );
      }
      return { id, reading, word };
    }),
  );
};

const compareUserLexiconId = (left: UserLexiconEntry, right: UserLexiconEntry): number => {
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
};

const compareReadingLengthDesc = (left: UserLexiconEntry, right: UserLexiconEntry): number =>
  [...right.reading].length - [...left.reading].length;

export const clampUserLexiconLimit = (limit: number): number => {
  if (limit < 1) {
    return USER_LEXICON_LIST_DEFAULT_LIMIT;
  }
  return Math.min(limit, USER_LEXICON_LIST_MAX_LIMIT);
};

export const parseUserLexiconSearchQuery = (url: URL): UserLexiconSearchQuery => {
  const rawLimit = url.searchParams.get("limit");
  const parsedLimit =
    rawLimit === null || rawLimit.trim().length === 0 ? Number.NaN : Number(rawLimit);
  const hasValidLimit = Number.isInteger(parsedLimit) && parsedLimit > 0;
  return {
    q: url.searchParams.get("q") ?? EMPTY_QUERY,
    limit: hasValidLimit ? parsedLimit : USER_LEXICON_LIST_DEFAULT_LIMIT,
    cursor: url.searchParams.get("cursor") ?? EMPTY_CURSOR,
    dictionaryId: url.searchParams.get("dictionaryId") ?? USER_LEXICON_DEFAULT_DICTIONARY_ID,
  };
};

export const pageUserLexiconEntries = (
  entries: readonly UserLexiconEntry[],
  query: UserLexiconSearchQuery,
): { entries: UserLexiconEntry[]; nextCursor: string | null; matched: number } => {
  const filtered = entries
    .filter((entry) => entryMatchesPrefixSearch(entry, query.q))
    .slice()
    .sort(compareUserLexiconId);
  const afterCursor =
    query.cursor.length === 0 ? filtered : filtered.filter((entry) => entry.id > query.cursor);
  const limit = clampUserLexiconLimit(query.limit);
  const page = afterCursor.slice(0, limit);
  const last = page[page.length - 1];
  return {
    entries: page,
    matched: filtered.length,
    nextCursor: last && afterCursor.length > page.length ? last.id : null,
  };
};

const userLexiconLengthMask = (charCount: number): number => {
  if (charCount <= 0) {
    return 0;
  }
  return charCount >= USER_LEXICON_LENGTH_BIT_CAP
    ? 1 << USER_LEXICON_LENGTH_BIT_CAP
    : 1 << charCount;
};

export const encodeUserLexiconCompact = (entries: readonly UserLexiconEntry[]): Uint8Array => {
  const readings = entries.map((entry) => TEXT_ENCODER.encode(entry.reading));
  const words = entries.map((entry) => TEXT_ENCODER.encode(entry.word));
  const built = entries.reduce<UserLexiconCompactBuild>(
    (state, entry, index) => {
      const reading = readings[index];
      const word = words[index];
      if (reading === undefined || word === undefined) {
        return state;
      }
      if (
        reading.byteLength > USER_LEXICON_COMPACT_MAX_STRING_BYTES ||
        word.byteLength > USER_LEXICON_COMPACT_MAX_STRING_BYTES
      ) {
        throw new UserLexiconError(
          "invalid_user_lexicon_entry",
          "reading or word exceeds compact string limit",
          HTTP_BAD_REQUEST,
        );
      }
      return {
        offset: state.offset + reading.byteLength + word.byteLength,
        lengthBits: state.lengthBits | userLexiconLengthMask([...entry.reading].length),
        rows: [
          ...state.rows,
          {
            readingOff: state.offset,
            readingLen: reading.byteLength,
            surfaceOff: state.offset + reading.byteLength,
            surfaceLen: word.byteLength,
            value:
              [...entry.reading].length <= 2
                ? USER_LEXICON_TWO_MORA_VALUE
                : USER_LEXICON_LONG_READING_VALUE,
          },
        ],
      };
    },
    { offset: 0, lengthBits: 0, rows: [] },
  );
  const bytes = new Uint8Array(
    USER_LEXICON_COMPACT_HEADER_BYTES +
      built.rows.length * USER_LEXICON_COMPACT_ROW_BYTES +
      built.offset,
  );
  const view = new DataView(bytes.buffer);
  TEXT_ENCODER.encodeInto(USER_LEXICON_COMPACT_MAGIC, bytes);
  view.setUint32(8, USER_LEXICON_COMPACT_VERSION, true);
  view.setUint32(12, built.rows.length, true);
  view.setUint32(16, built.offset, true);
  view.setUint32(20, built.lengthBits, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);
  built.rows.map((row, index) => {
    const rowOffset = USER_LEXICON_COMPACT_HEADER_BYTES + index * USER_LEXICON_COMPACT_ROW_BYTES;
    view.setUint32(rowOffset, row.readingOff, true);
    view.setUint16(rowOffset + 4, row.readingLen, true);
    view.setUint32(rowOffset + 6, row.surfaceOff, true);
    view.setUint16(rowOffset + 10, row.surfaceLen, true);
    view.setFloat32(rowOffset + 12, row.value, true);
    return rowOffset;
  });
  const arenaStart =
    USER_LEXICON_COMPACT_HEADER_BYTES + built.rows.length * USER_LEXICON_COMPACT_ROW_BYTES;
  entries.reduce((offset, _entry, index) => {
    const reading = readings[index];
    const word = words[index];
    if (reading === undefined || word === undefined) {
      return offset;
    }
    bytes.set(reading, arenaStart + offset);
    bytes.set(word, arenaStart + offset + reading.byteLength);
    return offset + reading.byteLength + word.byteLength;
  }, 0);
  return bytes;
};

export const applyStoredLexiconReadings = (text: string, lexiconTsv: string): string => {
  if (lexiconTsv.trim().length === 0) {
    return text;
  }
  const entries = parseUserLexiconTsv(lexiconTsv, createUserLexiconEntryId).sort(
    compareReadingLengthDesc,
  );
  return entries.reduce((current, entry) => current.replaceAll(entry.reading, entry.word), text);
};

export const storedLexiconConverter: UserLexiconConverter = {
  convert: (input) => Promise.resolve(applyStoredLexiconReadings(input.text, input.lexiconTsv)),
};

const EMPTY_LEXICON_TSV: string = "";

export const convertWithStoredUserLexicon = async (input: {
  lexicon: UserLexiconRpc;
  converter: UserLexiconConverter;
  text: string;
}): Promise<UserLexiconConvertResult> => {
  const meta = await input.lexicon.meta();
  const convertedText = await input.converter.convert({
    text: input.text,
    lexiconTsv: EMPTY_LEXICON_TSV,
  });
  return {
    convertedText,
    lexiconEntryCount: meta.entryCount,
    revision: meta.revision,
  };
};

const incrementRevision = (revision: string): string => (BigInt(revision) + 1n).toString();

const tsvBytesOf = (tsv: string): number => TEXT_ENCODER.encode(tsv).byteLength;

export const createMemoryUserLexicon = (
  createId: () => string,
  options?: {
    importStore?: UserLexiconImportStore;
    importQueue?: UserLexiconImportQueue;
  },
): UserLexiconRpc => {
  const defaultDictionary = defaultUserLexiconDictionary();
  const state: {
    revision: string;
    activeId: string;
    dictionaries: Map<string, { id: string; name: string }>;
    entries: Map<string, UserLexiconStoredEntry>;
    tsv: string;
    imports: Map<string, UserLexiconImportJob>;
    importBodies: Map<string, string>;
  } = {
    revision: USER_LEXICON_INITIAL_REVISION,
    activeId: defaultDictionary.id,
    dictionaries: new Map([[defaultDictionary.id, defaultDictionary]]),
    entries: new Map<string, UserLexiconStoredEntry>(),
    tsv: EMPTY_TSV,
    imports: new Map<string, UserLexiconImportJob>(),
    importBodies: new Map<string, string>(),
  };
  const activeEntries = (): UserLexiconEntry[] =>
    [...state.entries.values()]
      .filter((entry) => entry.dictionaryId === state.activeId)
      .sort(compareUserLexiconId);
  const dictionaryEntries = (dictionaryId: string): UserLexiconStoredEntry[] =>
    [...state.entries.values()].filter((entry) => entry.dictionaryId === dictionaryId);
  const commit = (): void => {
    state.revision = incrementRevision(state.revision);
    state.tsv = userLexiconEntriesToTsv(activeEntries());
  };
  const requireDictionary = (id: string): { id: string; name: string } => {
    const dictionary = state.dictionaries.get(id);
    if (!dictionary) {
      throw new UserLexiconError("dictionary_not_found", `Dictionary ${id} was not found`, 404);
    }
    return dictionary;
  };
  const catalog = (): UserLexiconCatalog => ({
    revision: state.revision,
    activeId: state.activeId,
    dictionaries: [...state.dictionaries.values()].map((dictionary) => ({
      id: dictionary.id,
      name: dictionary.name,
      entryCount: dictionaryEntries(dictionary.id).length,
    })),
  });
  const processImport = async (importId: string): Promise<UserLexiconImportJob> => {
    const job = state.imports.get(importId);
    if (!job) {
      throw new UserLexiconError("import_not_found", `Import ${importId} was not found`, 404);
    }
    const key = importObjectKey(importId);
    const body = options?.importStore
      ? await options.importStore.get(key)
      : (state.importBodies.get(key) ?? null);
    if (body === null) {
      const failed = { ...job, status: "failed" as const, error: "Import object is missing" };
      state.imports.set(importId, failed);
      return failed;
    }
    const running = { ...job, status: "running" as const };
    state.imports.set(importId, running);
    const rows = parseUserLexiconImportBody(body, createId);
    const accepted = rows.reduce((count, row) => {
      if (dictionaryEntries(job.dictionaryId).length >= USER_LEXICON_MAX_ENTRIES) {
        return count;
      }
      state.entries.set(row.id, { ...row, dictionaryId: job.dictionaryId });
      return count + 1;
    }, 0);
    commit();
    const completed: UserLexiconImportJob = {
      ...running,
      status: "completed",
      processed: rows.length,
      accepted,
      total: rows.length,
      error: "",
    };
    state.imports.set(importId, completed);
    if (options?.importStore) {
      await options.importStore.delete(key);
    } else {
      state.importBodies.delete(key);
    }
    return completed;
  };
  return {
    meta: () =>
      Promise.resolve({
        revision: state.revision,
        entryCount: activeEntries().length,
        tsvBytes: tsvBytesOf(state.tsv),
      }),
    snapshotTsv: () => Promise.resolve({ revision: state.revision, tsv: state.tsv }),
    snapshotCompact: () =>
      Promise.resolve({
        revision: state.revision,
        compact: encodeUserLexiconCompact(activeEntries()),
      }),
    exportAll: () =>
      Promise.resolve({
        revision: state.revision,
        entries: activeEntries().map((entry) => ({
          id: entry.id,
          reading: entry.reading,
          word: entry.word,
        })),
      }),
    restore: (snapshot) => {
      const validated = validateUserLexiconEntries([...snapshot.entries]);
      state.entries = new Map(
        validated.map((entry) => [
          entry.id,
          { ...entry, dictionaryId: USER_LEXICON_DEFAULT_DICTIONARY_ID },
        ]),
      );
      state.activeId = USER_LEXICON_DEFAULT_DICTIONARY_ID;
      if (!state.dictionaries.has(USER_LEXICON_DEFAULT_DICTIONARY_ID)) {
        state.dictionaries.set(USER_LEXICON_DEFAULT_DICTIONARY_ID, defaultUserLexiconDictionary());
      }
      state.revision = snapshot.revision;
      state.tsv = userLexiconEntriesToTsv(validated);
      return Promise.resolve();
    },
    search: (query) => {
      const dictionaryId =
        query.dictionaryId === undefined || query.dictionaryId.length === 0
          ? state.activeId
          : query.dictionaryId;
      requireDictionary(dictionaryId);
      const scoped = dictionaryEntries(dictionaryId);
      const page = pageUserLexiconEntries(scoped, query);
      return Promise.resolve({
        revision: state.revision,
        entryCount: scoped.length,
        entries: page.entries.map((entry) => ({
          id: entry.id,
          reading: entry.reading,
          word: entry.word,
        })),
        nextCursor: page.nextCursor,
      });
    },
    upsert: (input) => {
      const dictionaryId = input.dictionaryId ?? state.activeId;
      requireDictionary(dictionaryId);
      const id = input.id ?? createId();
      const [entry] = validateUserLexiconEntries([
        { id, reading: input.reading, word: input.word },
      ]);
      if (!entry) {
        throw new UserLexiconError(
          "invalid_user_lexicon_entry",
          "Entry requires reading and word",
          HTTP_BAD_REQUEST,
        );
      }
      if (
        !state.entries.has(entry.id) &&
        dictionaryEntries(dictionaryId).length >= USER_LEXICON_MAX_ENTRIES
      ) {
        throw new UserLexiconError(
          "user_lexicon_too_large",
          `User lexicon supports at most ${String(USER_LEXICON_MAX_ENTRIES)} entries`,
          HTTP_BAD_REQUEST,
        );
      }
      state.entries.set(entry.id, { ...entry, dictionaryId });
      commit();
      return Promise.resolve({ revision: state.revision, entry });
    },
    update: (id, fields) => {
      if (!state.entries.has(id)) {
        throw new UserLexiconError(
          "user_lexicon_entry_not_found",
          "User lexicon entry not found",
          HTTP_NOT_FOUND,
        );
      }
      const [entry] = validateUserLexiconEntries([
        { id, reading: fields.reading, word: fields.word },
      ]);
      if (!entry) {
        throw new UserLexiconError(
          "invalid_user_lexicon_entry",
          "Entry requires reading and word",
          HTTP_BAD_REQUEST,
        );
      }
      const previous = state.entries.get(id);
      state.entries.set(id, {
        ...entry,
        dictionaryId: previous?.dictionaryId ?? state.activeId,
      });
      commit();
      return Promise.resolve({ revision: state.revision, entry });
    },
    remove: (id) => {
      if (!state.entries.delete(id)) {
        throw new UserLexiconError(
          "user_lexicon_entry_not_found",
          "User lexicon entry not found",
          HTTP_NOT_FOUND,
        );
      }
      commit();
      return Promise.resolve({ revision: state.revision });
    },
    replaceAll: (entries) => {
      const validated = validateUserLexiconEntries([...entries]);
      const kept = [...state.entries.values()].filter(
        (entry) => entry.dictionaryId !== state.activeId,
      );
      state.entries = new Map([
        ...kept.map((entry) => [entry.id, entry] as const),
        ...validated.map(
          (entry) => [entry.id, { ...entry, dictionaryId: state.activeId }] as const,
        ),
      ]);
      commit();
      return Promise.resolve({
        revision: state.revision,
        entryCount: dictionaryEntries(state.activeId).length,
      });
    },
    clear: () => {
      [...state.entries.values()]
        .filter((entry) => entry.dictionaryId === state.activeId)
        .map((entry) => state.entries.delete(entry.id));
      commit();
      return Promise.resolve({ revision: state.revision });
    },
    listDictionaries: () => Promise.resolve(catalog()),
    createDictionary: (name) => {
      if (!isValidDictionaryName(name)) {
        throw new UserLexiconError(
          "invalid_dictionary_name",
          "Dictionary name is required",
          HTTP_BAD_REQUEST,
        );
      }
      if (state.dictionaries.size >= USER_LEXICON_MAX_DICTIONARIES) {
        throw new UserLexiconError(
          "too_many_dictionaries",
          `At most ${String(USER_LEXICON_MAX_DICTIONARIES)} dictionaries are supported`,
          HTTP_BAD_REQUEST,
        );
      }
      const dictionary = {
        id: createId(),
        name: normalizeDictionaryName(name),
      };
      state.dictionaries.set(dictionary.id, dictionary);
      commit();
      return Promise.resolve({
        revision: state.revision,
        dictionary: { ...dictionary, entryCount: 0 },
      });
    },
    renameDictionary: (id, name) => {
      const dictionary = requireDictionary(id);
      if (!isValidDictionaryName(name)) {
        throw new UserLexiconError(
          "invalid_dictionary_name",
          "Dictionary name is required",
          HTTP_BAD_REQUEST,
        );
      }
      const renamed = { ...dictionary, name: normalizeDictionaryName(name) };
      state.dictionaries.set(id, renamed);
      commit();
      return Promise.resolve({
        revision: state.revision,
        dictionary: { ...renamed, entryCount: dictionaryEntries(id).length },
      });
    },
    deleteDictionary: (id) => {
      requireDictionary(id);
      if (state.dictionaries.size <= 1) {
        throw new UserLexiconError(
          "cannot_delete_last_dictionary",
          "At least one dictionary is required",
          HTTP_BAD_REQUEST,
        );
      }
      state.dictionaries.delete(id);
      [...state.entries.values()]
        .filter((entry) => entry.dictionaryId === id)
        .map((entry) => state.entries.delete(entry.id));
      if (state.activeId === id) {
        const next = [...state.dictionaries.keys()][0];
        state.activeId = next ?? USER_LEXICON_DEFAULT_DICTIONARY_ID;
      }
      commit();
      return Promise.resolve({ revision: state.revision });
    },
    activateDictionary: (id) => {
      requireDictionary(id);
      state.activeId = id;
      commit();
      return Promise.resolve({ revision: state.revision, activeId: id });
    },
    startImport: async (input) => {
      requireDictionary(input.dictionaryId);
      const importId = createId();
      const job = emptyImportJob({ id: importId, dictionaryId: input.dictionaryId });
      state.imports.set(importId, job);
      const key = importObjectKey(importId);
      if (options?.importStore) {
        await options.importStore.put(key, input.body);
      } else {
        state.importBodies.set(key, input.body);
      }
      if (options?.importQueue) {
        await options.importQueue.send({ importId });
        return job;
      }
      return processImport(importId);
    },
    importStatus: (importId) => {
      const job = state.imports.get(importId);
      if (!job) {
        throw new UserLexiconError("import_not_found", `Import ${importId} was not found`, 404);
      }
      return Promise.resolve(job);
    },
    processQueuedImport: processImport,
  };
};

export const userLexiconEntryFromUnknown = (
  value: unknown,
  createId: () => string,
): UserLexiconEntry => {
  if (!isRecord(value)) {
    throw new UserLexiconError(
      "invalid_user_lexicon_entry",
      "Entry must be an object",
      HTTP_BAD_REQUEST,
    );
  }
  const reading = value["reading"];
  const word = value["word"];
  if (typeof reading !== "string" || typeof word !== "string") {
    throw new UserLexiconError(
      "invalid_user_lexicon_entry",
      "Entry requires reading and word",
      HTTP_BAD_REQUEST,
    );
  }
  const rawId = value["id"];
  const id = typeof rawId === "string" && rawId.trim().length > 0 ? rawId : createId();
  const [entry] = validateUserLexiconEntries([{ id, reading, word }]);
  if (!entry) {
    throw new UserLexiconError(
      "invalid_user_lexicon_entry",
      "Entry requires reading and word",
      HTTP_BAD_REQUEST,
    );
  }
  return entry;
};

export const parseUserLexiconCsv = (body: string, createId: () => string): UserLexiconEntry[] => {
  const rows = body
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return validateUserLexiconEntries(
    rows.flatMap((line, index) => {
      const lower = line.toLowerCase();
      if (lower === "よみ,単語" || lower === "reading,word") {
        return [];
      }
      const comma = line.indexOf(",");
      if (comma <= 0 || comma === line.length - 1) {
        throw new UserLexiconError(
          "invalid_user_lexicon_csv",
          `CSV row ${String(index + 1)} must contain reading and word`,
          HTTP_BAD_REQUEST,
        );
      }
      return [
        {
          id: createId(),
          reading: line.slice(0, comma).trim(),
          word: line.slice(comma + 1).trim(),
        },
      ];
    }),
  );
};

export const parseUserLexiconImportBody = (
  body: string,
  createId: () => string,
): UserLexiconEntry[] => {
  const trimmed = body.replace(/^\uFEFF/u, "").trim();
  if (trimmed.startsWith("{")) {
    return parseUserLexiconDocument(trimmed);
  }
  if (trimmed.includes(TAB)) {
    return parseUserLexiconTsv(body, createId);
  }
  return parseUserLexiconCsv(body, createId);
};
