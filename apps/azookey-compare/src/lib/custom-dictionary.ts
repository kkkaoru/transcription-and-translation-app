/**
 * Worker HTTP client for the compare user-lexicon editor.
 *
 * Word data lives on the Worker. This module never persists a browser store,
 * never fetches a TSV snapshot, and never parses an import file into state.
 *
 * This file runs with bun.
 */

import type { ComparisonAuth } from "./contract";
import { COMPARE_USER_LEXICON_HTTP_PATH } from "./inference-proxy";

export interface UserLexiconEntry {
  id: string;
  reading: string;
  word: string;
}

export interface UserLexiconDraft {
  reading: string;
  word: string;
}

export interface UserLexiconMetadata {
  revision: string;
  entryCount: number;
  tsvBytes: number;
}

export interface UserLexiconListPage {
  revision: string;
  entryCount: number;
  entries: UserLexiconEntry[];
  nextCursor: string;
}

export interface UserLexiconWriteResult {
  revision: string;
  entry: UserLexiconEntry;
}

export interface UserLexiconImportResult {
  revision: string;
  entryCount: number;
}

export interface UserLexiconClientRequest {
  baseUrl: string;
  fetcher: typeof fetch;
  auth: ComparisonAuth;
  signal?: AbortSignal;
}

export interface UserLexiconListRequest extends UserLexiconClientRequest {
  q: string;
  limit: number;
  cursor: string;
}

export interface UserLexiconAddRequest extends UserLexiconClientRequest {
  reading: string;
  word: string;
}

export interface UserLexiconUpdateRequest extends UserLexiconAddRequest {
  id: string;
}

export interface UserLexiconDeleteRequest extends UserLexiconClientRequest {
  id: string;
}

export interface UserLexiconImportRequest extends UserLexiconClientRequest {
  file: File;
}

export interface UserLexiconDictionary {
  id: string;
  name: string;
  entryCount: number;
}

export interface UserLexiconCatalogResult {
  revision: string;
  activeId: string;
  dictionaries: UserLexiconDictionary[];
}

export interface UserLexiconImportJobResult {
  id: string;
  dictionaryId: string;
  status: string;
  processed: number;
  accepted: number;
  total: number;
  error: string;
}

export interface UserLexiconWebsocketLocator {
  websocketUrl: string;
  origin: string;
}

export interface UserLexiconCursorState {
  previousCursors: readonly string[];
  currentCursor: string;
}

export const USER_LEXICON_HTTP_PATH: string = COMPARE_USER_LEXICON_HTTP_PATH;
export const USER_LEXICON_ENTRIES_SUFFIX: string = "entries";
export const USER_LEXICON_IMPORT_SUFFIX: string = "import";
export const USER_LEXICON_PAGE_LIMIT: number = 50;
export const USER_LEXICON_PAGE_LIMIT_MAX: number = 50;
export const USER_LEXICON_MIN_READING_CHARS: number = 2;
export const USER_LEXICON_MAX_READING_CHARS: number = 256;
export const USER_LEXICON_MAX_WORD_CHARS: number = 512;
export const USER_LEXICON_IMPORT_FIELD: string = "file";
export const USER_LEXICON_DICTIONARIES_SUFFIX: string = "dictionaries";

const HTTP_NO_CONTENT: number = 204;
const WS_SECURE_PROTOCOL: string = "wss:";
const HTTPS_PROTOCOL: string = "https:";
const WS_PROTOCOL: string = "ws:";
const HTTP_PROTOCOL: string = "http:";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const authorizationHeaders = (auth: ComparisonAuth): Headers => {
  const headers = new Headers();
  if (auth.scheme !== "bearer") {
    return headers;
  }
  const token = auth.token === undefined ? "" : auth.token.trim();
  if (token.length === 0) {
    return headers;
  }
  headers.set("authorization", `Bearer ${token}`);
  return headers;
};

const jsonHeaders = (auth: ComparisonAuth): Headers => {
  const headers = authorizationHeaders(auth);
  headers.set("content-type", "application/json; charset=utf-8");
  return headers;
};

const readJson = async (response: Response): Promise<unknown> => {
  const body = await response.text();
  if (body.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Worker user-lexicon response is not valid JSON");
  }
};

const errorMessageFromPayload = (payload: unknown, status: number): string => {
  if (!isRecord(payload)) {
    return `Worker user-lexicon request failed (${status})`;
  }
  const nested = payload["error"];
  if (isRecord(nested)) {
    const nestedMessage = nested["message"];
    if (typeof nestedMessage === "string" && nestedMessage.trim().length > 0) {
      return nestedMessage.trim();
    }
  }
  const message = payload["message"];
  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : `Worker user-lexicon request failed (${status})`;
};

const throwIfNotOk = async (response: Response): Promise<void> => {
  if (response.ok) {
    return;
  }
  const body = await response.text();
  if (body.trim().length === 0) {
    throw new Error(`Worker user-lexicon request failed (${response.status})`);
  }
  try {
    throw new Error(errorMessageFromPayload(JSON.parse(body), response.status));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Worker user-lexicon request failed (${response.status})`);
    }
    throw error;
  }
};

const requestWorker = async (
  input: UserLexiconClientRequest,
  url: string,
  init: RequestInit,
): Promise<Response> => {
  try {
    return await input.fetcher(url, {
      ...init,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Worker user-lexicon request failed: ${error.message}`
        : "Worker user-lexicon request failed",
      { cause: error },
    );
  }
};

const parseRevision = (value: unknown): string => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  throw new Error("Worker user-lexicon revision is missing");
};

const parseCount = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Worker user-lexicon ${label} is missing`);
  }
  return value;
};

const parseEntry = (value: unknown, index: number): UserLexiconEntry => {
  if (!isRecord(value)) {
    throw new Error(`Worker user-lexicon item ${index + 1} must be an object`);
  }
  const id = value["id"];
  const reading = value["reading"];
  const word = value["word"];
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`Worker user-lexicon item ${index + 1} is missing id`);
  }
  if (typeof reading !== "string" || reading.trim().length === 0) {
    throw new Error(`Worker user-lexicon item ${index + 1} is missing reading`);
  }
  if (typeof word !== "string" || word.trim().length === 0) {
    throw new Error(`Worker user-lexicon item ${index + 1} is missing word`);
  }
  return { id: id.trim(), reading: reading.trim(), word: word.trim() };
};

const lexiconRoot = (baseUrl: string): URL => {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  return url;
};

const withSuffix = (baseUrl: string, suffix: string): URL => {
  const url = lexiconRoot(baseUrl);
  const prefix = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${prefix}/${suffix}`;
  return url;
};

const clampLimit = (limit: number): number =>
  Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), USER_LEXICON_PAGE_LIMIT_MAX)
    : USER_LEXICON_PAGE_LIMIT;

export const validateUserLexiconDraft = (draft: UserLexiconDraft): UserLexiconDraft => {
  const reading = draft.reading.trim();
  const word = draft.word.trim();
  if (reading.length === 0) {
    throw new Error("reading is required");
  }
  if ([...reading].length < USER_LEXICON_MIN_READING_CHARS) {
    throw new Error("reading must be at least 2 characters");
  }
  if (word.length === 0) {
    throw new Error("word is required");
  }
  if (/[\t\r\n]/u.test(reading) || /[\t\r\n]/u.test(word)) {
    throw new Error("reading or word cannot contain tabs or newlines");
  }
  if ([...reading].length > USER_LEXICON_MAX_READING_CHARS) {
    throw new Error("reading is too long");
  }
  if ([...word].length > USER_LEXICON_MAX_WORD_CHARS) {
    throw new Error("word is too long");
  }
  if (reading.startsWith("#")) {
    throw new Error("reading cannot start with #");
  }
  return { reading, word };
};

export const userLexiconHttpUrlFromWebsocket = (input: UserLexiconWebsocketLocator): string => {
  const trimmed = input.websocketUrl.trim();
  if (trimmed.length === 0) {
    throw new Error("Cloudflare Worker WebSocket URL is required");
  }
  const url = new URL(trimmed, input.origin);
  if (
    url.protocol !== WS_PROTOCOL &&
    url.protocol !== WS_SECURE_PROTOCOL &&
    url.protocol !== HTTP_PROTOCOL &&
    url.protocol !== HTTPS_PROTOCOL
  ) {
    throw new Error("Cloudflare Worker user-lexicon URL must be http(s) or ws(s)");
  }
  url.protocol =
    url.protocol === WS_SECURE_PROTOCOL || url.protocol === HTTPS_PROTOCOL
      ? HTTPS_PROTOCOL
      : HTTP_PROTOCOL;
  url.pathname = USER_LEXICON_HTTP_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const userLexiconEntriesUrl = (baseUrl: string): string =>
  withSuffix(baseUrl, USER_LEXICON_ENTRIES_SUFFIX).toString();

export const buildUserLexiconListUrl = (input: UserLexiconListRequest): string => {
  const url = withSuffix(input.baseUrl, USER_LEXICON_ENTRIES_SUFFIX);
  url.searchParams.set("limit", String(clampLimit(input.limit)));
  if (input.q.trim().length > 0) {
    url.searchParams.set("q", input.q.trim());
  }
  if (input.cursor.trim().length > 0) {
    url.searchParams.set("cursor", input.cursor.trim());
  }
  return url.toString();
};

export const userLexiconEntryUrl = (baseUrl: string, id: string): string => {
  const trimmedId = id.trim();
  if (trimmedId.length === 0) {
    throw new Error("user-lexicon id is required");
  }
  const url = withSuffix(baseUrl, USER_LEXICON_ENTRIES_SUFFIX);
  const prefix = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.pathname = `${prefix}${encodeURIComponent(trimmedId)}`;
  return url.toString();
};

export const userLexiconImportUrl = (baseUrl: string): string =>
  withSuffix(baseUrl, USER_LEXICON_IMPORT_SUFFIX).toString();

export const parseUserLexiconMetadata = (payload: unknown): UserLexiconMetadata => {
  if (!isRecord(payload)) {
    throw new Error("Worker user-lexicon metadata must be an object");
  }
  return {
    revision: parseRevision(payload["revision"]),
    entryCount: parseCount(payload["entryCount"], "entryCount"),
    tsvBytes: parseCount(payload["tsvBytes"], "tsvBytes"),
  };
};

export const parseUserLexiconListPage = (payload: unknown): UserLexiconListPage => {
  if (!isRecord(payload)) {
    throw new Error("Worker user-lexicon list must be an object");
  }
  const rawEntries = payload["entries"];
  if (!Array.isArray(rawEntries)) {
    throw new Error("Worker user-lexicon list entries must be an array");
  }
  const nextRaw = payload["nextCursor"];
  return {
    revision: parseRevision(payload["revision"]),
    entryCount: parseCount(payload["entryCount"], "entryCount"),
    entries: rawEntries.map((value, index) => parseEntry(value, index)),
    nextCursor: typeof nextRaw === "string" && nextRaw.trim().length > 0 ? nextRaw.trim() : "",
  };
};

export const parseUserLexiconWriteResult = (payload: unknown): UserLexiconWriteResult => {
  if (!isRecord(payload)) {
    throw new Error("Worker user-lexicon write result must be an object");
  }
  return {
    revision: parseRevision(payload["revision"]),
    entry: parseEntry(payload["entry"], 0),
  };
};

export const parseUserLexiconImportResult = (payload: unknown): UserLexiconImportResult => {
  if (!isRecord(payload)) {
    throw new Error("Worker user-lexicon import result must be an object");
  }
  return {
    revision: parseRevision(payload["revision"]),
    entryCount: parseCount(payload["entryCount"], "entryCount"),
  };
};

export const getUserLexiconMetadata = async (
  input: UserLexiconClientRequest,
): Promise<UserLexiconMetadata> => {
  const response = await requestWorker(input, lexiconRoot(input.baseUrl).toString(), {
    method: "GET",
    headers: authorizationHeaders(input.auth),
  });
  await throwIfNotOk(response);
  return parseUserLexiconMetadata(await readJson(response));
};

export const listUserLexiconEntries = async (
  input: UserLexiconListRequest,
): Promise<UserLexiconListPage> => {
  const response = await requestWorker(input, buildUserLexiconListUrl(input), {
    method: "GET",
    headers: authorizationHeaders(input.auth),
  });
  await throwIfNotOk(response);
  return parseUserLexiconListPage(await readJson(response));
};

export const addUserLexiconEntry = async (
  input: UserLexiconAddRequest,
): Promise<UserLexiconWriteResult> => {
  const draft = validateUserLexiconDraft({ reading: input.reading, word: input.word });
  const response = await requestWorker(input, userLexiconEntriesUrl(input.baseUrl), {
    method: "POST",
    headers: jsonHeaders(input.auth),
    body: JSON.stringify(draft),
  });
  await throwIfNotOk(response);
  return parseUserLexiconWriteResult(await readJson(response));
};

export const updateUserLexiconEntry = async (
  input: UserLexiconUpdateRequest,
): Promise<UserLexiconWriteResult> => {
  const draft = validateUserLexiconDraft({ reading: input.reading, word: input.word });
  const response = await requestWorker(input, userLexiconEntryUrl(input.baseUrl, input.id), {
    method: "PUT",
    headers: jsonHeaders(input.auth),
    body: JSON.stringify(draft),
  });
  await throwIfNotOk(response);
  return parseUserLexiconWriteResult(await readJson(response));
};

export const deleteUserLexiconEntry = async (input: UserLexiconDeleteRequest): Promise<void> => {
  const response = await requestWorker(input, userLexiconEntryUrl(input.baseUrl, input.id), {
    method: "DELETE",
    headers: authorizationHeaders(input.auth),
  });
  await throwIfNotOk(response);
  if (response.status === HTTP_NO_CONTENT) {
    return;
  }
  await readJson(response);
};

export const clearUserLexicon = async (input: UserLexiconClientRequest): Promise<void> => {
  const response = await requestWorker(input, lexiconRoot(input.baseUrl).toString(), {
    method: "DELETE",
    headers: authorizationHeaders(input.auth),
  });
  await throwIfNotOk(response);
  if (response.status === HTTP_NO_CONTENT) {
    return;
  }
  await readJson(response);
};

export const importUserLexiconFile = async (
  input: UserLexiconImportRequest,
): Promise<UserLexiconImportResult> => {
  const form = new FormData();
  form.set(USER_LEXICON_IMPORT_FIELD, input.file);
  const response = await requestWorker(input, userLexiconImportUrl(input.baseUrl), {
    method: "POST",
    headers: authorizationHeaders(input.auth),
    body: form,
  });
  await throwIfNotOk(response);
  return parseUserLexiconImportResult(await readJson(response));
};

const parseCatalog = (value: unknown): UserLexiconCatalogResult => {
  if (!isRecord(value)) {
    throw new Error("Worker dictionary catalog is missing");
  }
  const dictionaries = value["dictionaries"];
  if (!Array.isArray(dictionaries)) {
    throw new Error("Worker dictionary catalog is missing dictionaries");
  }
  return {
    revision: String(value["revision"] ?? ""),
    activeId: String(value["activeId"] ?? ""),
    dictionaries: dictionaries.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      return [
        {
          id: String(item["id"] ?? ""),
          name: String(item["name"] ?? ""),
          entryCount: Number(item["entryCount"] ?? 0),
        },
      ];
    }),
  };
};

const parseImportJob = (value: unknown): UserLexiconImportJobResult => {
  if (!isRecord(value)) {
    throw new Error("Worker import job is missing");
  }
  return {
    id: String(value["id"] ?? ""),
    dictionaryId: String(value["dictionaryId"] ?? ""),
    status: String(value["status"] ?? ""),
    processed: Number(value["processed"] ?? 0),
    accepted: Number(value["accepted"] ?? 0),
    total: Number(value["total"] ?? 0),
    error: String(value["error"] ?? ""),
  };
};

export const listUserLexiconDictionaries = async (
  input: UserLexiconClientRequest,
): Promise<UserLexiconCatalogResult> => {
  const response = await requestWorker(
    input,
    withSuffix(input.baseUrl, USER_LEXICON_DICTIONARIES_SUFFIX).toString(),
    { method: "GET", headers: authorizationHeaders(input.auth) },
  );
  await throwIfNotOk(response);
  return parseCatalog(await readJson(response));
};

export const createUserLexiconDictionary = async (
  input: UserLexiconClientRequest & { name: string },
): Promise<UserLexiconCatalogResult> => {
  const response = await requestWorker(
    input,
    withSuffix(input.baseUrl, USER_LEXICON_DICTIONARIES_SUFFIX).toString(),
    {
      method: "POST",
      headers: jsonHeaders(input.auth),
      body: JSON.stringify({ name: input.name }),
    },
  );
  await throwIfNotOk(response);
  await readJson(response);
  return listUserLexiconDictionaries(input);
};

export const renameUserLexiconDictionary = async (
  input: UserLexiconClientRequest & { id: string; name: string },
): Promise<void> => {
  const response = await requestWorker(
    input,
    `${withSuffix(input.baseUrl, USER_LEXICON_DICTIONARIES_SUFFIX).toString()}/${encodeURIComponent(input.id)}`,
    {
      method: "PUT",
      headers: jsonHeaders(input.auth),
      body: JSON.stringify({ name: input.name }),
    },
  );
  await throwIfNotOk(response);
};

export const deleteUserLexiconDictionary = async (
  input: UserLexiconClientRequest & { id: string },
): Promise<void> => {
  const response = await requestWorker(
    input,
    `${withSuffix(input.baseUrl, USER_LEXICON_DICTIONARIES_SUFFIX).toString()}/${encodeURIComponent(input.id)}`,
    { method: "DELETE", headers: authorizationHeaders(input.auth) },
  );
  await throwIfNotOk(response);
};

export const activateUserLexiconDictionary = async (
  input: UserLexiconClientRequest & { id: string },
): Promise<void> => {
  const response = await requestWorker(
    input,
    `${withSuffix(input.baseUrl, USER_LEXICON_DICTIONARIES_SUFFIX).toString()}/${encodeURIComponent(input.id)}/activate`,
    { method: "POST", headers: authorizationHeaders(input.auth) },
  );
  await throwIfNotOk(response);
};

export const startUserLexiconQueuedImport = async (
  input: UserLexiconClientRequest & { dictionaryId: string; file: File },
): Promise<UserLexiconImportJobResult> => {
  const response = await requestWorker(
    input,
    `${withSuffix(input.baseUrl, USER_LEXICON_DICTIONARIES_SUFFIX).toString()}/${encodeURIComponent(input.dictionaryId)}/imports`,
    {
      method: "POST",
      headers: (() => {
        const headers = authorizationHeaders(input.auth);
        headers.set("content-type", "text/plain; charset=utf-8");
        headers.set("x-filename", input.file.name);
        return headers;
      })(),
      body: await input.file.text(),
    },
  );
  await throwIfNotOk(response);
  return parseImportJob(await readJson(response));
};

export const readUserLexiconImportJob = async (
  input: UserLexiconClientRequest & { dictionaryId: string; importId: string },
): Promise<UserLexiconImportJobResult> => {
  const response = await requestWorker(
    input,
    `${withSuffix(input.baseUrl, USER_LEXICON_DICTIONARIES_SUFFIX).toString()}/${encodeURIComponent(input.dictionaryId)}/imports/${encodeURIComponent(input.importId)}`,
    { method: "GET", headers: authorizationHeaders(input.auth) },
  );
  await throwIfNotOk(response);
  return parseImportJob(await readJson(response));
};

export const nextUserLexiconCursorState = (input: {
  previousCursors: readonly string[];
  currentCursor: string;
  nextCursor: string;
}): UserLexiconCursorState => ({
  previousCursors: [...input.previousCursors, input.currentCursor],
  currentCursor: input.nextCursor,
});

export const previousUserLexiconCursorState = (
  input: UserLexiconCursorState,
): UserLexiconCursorState => {
  const last = input.previousCursors.at(-1);
  return last === undefined
    ? { previousCursors: [], currentCursor: "" }
    : {
        previousCursors: input.previousCursors.slice(0, -1),
        currentCursor: last,
      };
};
