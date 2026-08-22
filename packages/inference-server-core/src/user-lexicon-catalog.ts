/**
 * Multi-dictionary catalog, prefix search, and queued import jobs.
 *
 * This file runs with bun.
 */

export const USER_LEXICON_DEFAULT_DICTIONARY_ID: string = "default";
export const USER_LEXICON_DEFAULT_DICTIONARY_NAME: string = "Custom";
export const USER_LEXICON_MAX_DICTIONARIES: number = 32;
export const USER_LEXICON_MAX_DICTIONARY_NAME_CHARS: number = 64;
export const USER_LEXICON_IMPORT_BATCH: number = 500;
export const USER_LEXICON_DICTIONARIES_PATH: string = "/azookey/user-lexicon/dictionaries";

export interface CatalogSearchEntry {
  id: string;
  reading: string;
  word: string;
}

export interface UserLexiconDictionary {
  id: string;
  name: string;
  entryCount: number;
}

export interface UserLexiconCatalog {
  revision: string;
  activeId: string;
  dictionaries: UserLexiconDictionary[];
}

export interface UserLexiconImportJob {
  id: string;
  dictionaryId: string;
  status: "queued" | "running" | "completed" | "failed";
  processed: number;
  accepted: number;
  total: number;
  error: string;
}

export interface UserLexiconImportStore {
  put: (key: string, body: string) => Promise<void>;
  get: (key: string) => Promise<string | null>;
  delete: (key: string) => Promise<void>;
}

export interface UserLexiconImportQueue {
  send: (message: { importId: string }) => Promise<void>;
}

export const normalizeDictionaryName = (name: string): string => name.trim();

export const isValidDictionaryName = (name: string): boolean => {
  const trimmed = normalizeDictionaryName(name);
  return trimmed.length > 0 && [...trimmed].length <= USER_LEXICON_MAX_DICTIONARY_NAME_CHARS;
};

export const defaultUserLexiconDictionary = (): UserLexiconDictionary => ({
  id: USER_LEXICON_DEFAULT_DICTIONARY_ID,
  name: USER_LEXICON_DEFAULT_DICTIONARY_NAME,
  entryCount: 0,
});

export const entryMatchesPrefixSearch = (entry: CatalogSearchEntry, query: string): boolean => {
  const needle = query.trim();
  return needle.length === 0
    ? true
    : entry.reading.startsWith(needle) || entry.word.startsWith(needle);
};

export const compareReadingThenId = (
  left: CatalogSearchEntry,
  right: CatalogSearchEntry,
): number => {
  if (left.reading < right.reading) {
    return -1;
  }
  if (left.reading > right.reading) {
    return 1;
  }
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
};

export const pagePrefixSearch = (
  entries: readonly CatalogSearchEntry[],
  query: { q: string; cursor: string; limit: number },
): { entries: CatalogSearchEntry[]; nextCursor: string | null; matched: number } => {
  const filtered = entries.filter((entry) => entryMatchesPrefixSearch(entry, query.q)).slice();
  filtered.sort(compareReadingThenId);
  const afterCursor =
    query.cursor.length === 0 ? filtered : filtered.filter((entry) => entry.id > query.cursor);
  const page = afterCursor.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    entries: page,
    matched: filtered.length,
    nextCursor: last && afterCursor.length > page.length ? last.id : null,
  };
};

export const sliceImportBatch = (
  rows: readonly CatalogSearchEntry[],
  processed: number,
): CatalogSearchEntry[] => rows.slice(processed, processed + USER_LEXICON_IMPORT_BATCH);

export const importObjectKey = (importId: string): string => `imports/${importId}`;

export const emptyImportJob = (input: {
  id: string;
  dictionaryId: string;
}): UserLexiconImportJob => ({
  id: input.id,
  dictionaryId: input.dictionaryId,
  status: "queued",
  processed: 0,
  accepted: 0,
  total: 0,
  error: "",
});

export const createMemoryImportStore = (): UserLexiconImportStore & {
  bodies: Map<string, string>;
} => {
  const bodies = new Map<string, string>();
  return {
    bodies,
    put: (key, body) => {
      bodies.set(key, body);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(bodies.get(key) ?? null),
    delete: (key) => {
      bodies.delete(key);
      return Promise.resolve();
    },
  };
};
