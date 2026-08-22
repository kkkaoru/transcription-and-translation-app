/**
 * HTTP contract for the Worker-owned AzooKey user lexicon.
 *
 * This file runs with bun.
 */

import {
  convertWithStoredUserLexicon,
  createUserLexiconEntryId,
  parseUserLexiconImportBody,
  parseUserLexiconSearchQuery,
  USER_LEXICON_CONVERT_PATH,
  USER_LEXICON_ENTRIES_PATH,
  USER_LEXICON_HTTP_PATH,
  USER_LEXICON_IMPORT_PATH,
  USER_LEXICON_MAX_IMPORT_BYTES,
  type UserLexiconConverter,
  UserLexiconError,
  type UserLexiconRpc,
} from "./user-lexicon.js";
import { USER_LEXICON_DICTIONARIES_PATH } from "./user-lexicon-catalog.js";

export interface UserLexiconHttpDependencies {
  lexicon?: UserLexiconRpc;
  converter?: UserLexiconConverter;
  createId?: () => string;
}

interface UserLexiconWriteBody {
  reading?: unknown;
  word?: unknown;
  text?: unknown;
  name?: unknown;
  userDictionaryTsv?: unknown;
}

const HTTP_OK: number = 200;
const HTTP_CREATED: number = 201;
const HTTP_ACCEPTED: number = 202;
const HTTP_BAD_REQUEST: number = 400;
const HTTP_METHOD_NOT_ALLOWED: number = 405;
const HTTP_REQUEST_TOO_LARGE: number = 413;
const HTTP_SERVICE_UNAVAILABLE: number = 503;
const DEFAULT_CONTENT_LENGTH: number = 0;
const ENTRIES_PREFIX: string = `${USER_LEXICON_ENTRIES_PATH}/`;

const json = (status: number, body: object): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isUserLexiconError = (error: unknown): error is UserLexiconError =>
  error instanceof UserLexiconError;

const fail = (status: number, code: string, message: string): never => {
  throw new UserLexiconError(code, message, status);
};

const requiredLexicon = (lexicon: UserLexiconRpc | undefined): UserLexiconRpc => {
  if (!lexicon) {
    return fail(
      HTTP_SERVICE_UNAVAILABLE,
      "user_lexicon_unavailable",
      "User lexicon persistence is not configured",
    );
  }
  return lexicon;
};

const entryIdFromPath = (pathname: string): string | undefined => {
  if (!pathname.startsWith(ENTRIES_PREFIX)) {
    return undefined;
  }
  const raw = pathname.slice(ENTRIES_PREFIX.length);
  if (raw.length === 0 || raw.includes("/")) {
    return undefined;
  }
  return decodeURIComponent(raw);
};

const rejectClientTsv = (payload: UserLexiconWriteBody): void => {
  if (payload.userDictionaryTsv !== undefined) {
    fail(HTTP_BAD_REQUEST, "invalid_contract", "userDictionaryTsv is not allowed");
  }
};

const readBoundedBody = async (request: Request, maxBytes: number): Promise<string> => {
  const contentLength = Number(request.headers.get("content-length") ?? DEFAULT_CONTENT_LENGTH);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    fail(HTTP_REQUEST_TOO_LARGE, "request_too_large", "Request exceeds the size limit");
  }
  const body = await request
    .text()
    .catch(() => fail(HTTP_BAD_REQUEST, "invalid_body", "Could not read the request body"));
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    fail(HTTP_REQUEST_TOO_LARGE, "request_too_large", "Request exceeds the size limit");
  }
  return body;
};

const readJsonObject = async (request: Request): Promise<UserLexiconWriteBody> => {
  const body = await readBoundedBody(request, USER_LEXICON_MAX_IMPORT_BYTES);
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
      return fail(HTTP_BAD_REQUEST, "invalid_json", "JSON request must be an object");
    }
    return {
      reading: parsed["reading"],
      word: parsed["word"],
      text: parsed["text"],
      name: parsed["name"],
      userDictionaryTsv: parsed["userDictionaryTsv"],
    };
  } catch (error) {
    if (isUserLexiconError(error)) {
      throw error;
    }
    return fail(HTTP_BAD_REQUEST, "invalid_json", "Could not parse the JSON request");
  }
};

const handleMeta = async (lexicon: UserLexiconRpc): Promise<Response> => {
  const meta = await lexicon.meta();
  return json(HTTP_OK, {
    revision: meta.revision,
    entryCount: meta.entryCount,
    tsvBytes: meta.tsvBytes,
  });
};

const handleSearch = async (request: Request, lexicon: UserLexiconRpc): Promise<Response> => {
  const page = await lexicon.search(parseUserLexiconSearchQuery(new URL(request.url)));
  return json(HTTP_OK, {
    revision: page.revision,
    entryCount: page.entryCount,
    entries: page.entries,
    nextCursor: page.nextCursor,
  });
};

const handleCreate = async (input: {
  lexicon: UserLexiconRpc;
  payload: UserLexiconWriteBody;
}): Promise<Response> => {
  rejectClientTsv(input.payload);
  const reading = input.payload.reading;
  const word = input.payload.word;
  if (typeof reading !== "string" || typeof word !== "string") {
    return fail(HTTP_BAD_REQUEST, "invalid_user_lexicon_entry", "Create requires reading and word");
  }
  const result = await input.lexicon.upsert({ reading, word });
  return json(HTTP_CREATED, { revision: result.revision, entry: result.entry });
};

const handleUpdate = async (input: {
  lexicon: UserLexiconRpc;
  id: string;
  payload: UserLexiconWriteBody;
}): Promise<Response> => {
  rejectClientTsv(input.payload);
  const reading = input.payload.reading;
  const word = input.payload.word;
  if (typeof reading !== "string" || typeof word !== "string") {
    return fail(HTTP_BAD_REQUEST, "invalid_user_lexicon_entry", "Update requires reading and word");
  }
  const result = await input.lexicon.update(input.id, { reading, word });
  return json(HTTP_OK, { revision: result.revision, entry: result.entry });
};

const handleImport = async (input: {
  lexicon: UserLexiconRpc;
  body: string;
  createId: () => string;
}): Promise<Response> => {
  const entries = parseUserLexiconImportBody(input.body, input.createId);
  const result = await input.lexicon.replaceAll(entries);
  return json(HTTP_OK, {
    revision: result.revision,
    entryCount: result.entryCount,
    replaced: true,
  });
};

const identityLexiconConverter: UserLexiconConverter = {
  convert: (input) => Promise.resolve(input.text),
};

const handleConvert = async (input: {
  lexicon: UserLexiconRpc | undefined;
  converter: UserLexiconConverter | undefined;
  payload: UserLexiconWriteBody;
}): Promise<Response> => {
  rejectClientTsv(input.payload);
  const text = input.payload.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return fail(HTTP_BAD_REQUEST, "convert_text_required", "Convert requires a text field");
  }
  if (!input.lexicon) {
    const convertedText = await (input.converter ?? identityLexiconConverter).convert({
      text,
      lexiconTsv: "",
    });
    return json(HTTP_OK, {
      convertedText,
      lexiconEntryCount: 0,
      revision: "0",
    });
  }
  if (!input.converter) {
    return fail(
      HTTP_SERVICE_UNAVAILABLE,
      "user_lexicon_converter_unavailable",
      "Stored-lexicon convert requires the Worker decoder",
    );
  }
  const result = await convertWithStoredUserLexicon({
    lexicon: input.lexicon,
    converter: input.converter,
    text,
  });
  return json(HTTP_OK, {
    convertedText: result.convertedText,
    lexiconEntryCount: result.lexiconEntryCount,
    revision: result.revision,
  });
};

const handleDictionaryError = (error: unknown): Response => {
  if (isUserLexiconError(error)) {
    return json(error.status, { error: { code: error.code, message: error.message } });
  }
  throw error;
};

const methodNotAllowed = (): Response =>
  json(HTTP_METHOD_NOT_ALLOWED, {
    error: { code: "method_not_allowed", message: "Method not allowed" },
  });

export const handleUserLexiconHttp = async (
  request: Request,
  dependencies: UserLexiconHttpDependencies,
): Promise<Response | undefined> => {
  const pathname = new URL(request.url).pathname;
  const createId = dependencies.createId ?? createUserLexiconEntryId;
  try {
    if (pathname === USER_LEXICON_CONVERT_PATH && request.method === "POST") {
      return await handleConvert({
        lexicon: dependencies.lexicon,
        converter: dependencies.converter,
        payload: await readJsonObject(request),
      });
    }
    if (pathname === USER_LEXICON_HTTP_PATH && request.method === "GET") {
      return await handleMeta(requiredLexicon(dependencies.lexicon));
    }
    if (pathname === USER_LEXICON_HTTP_PATH && request.method === "DELETE") {
      const result = await requiredLexicon(dependencies.lexicon).clear();
      return json(HTTP_OK, { revision: result.revision, entryCount: 0 });
    }
    if (pathname === USER_LEXICON_ENTRIES_PATH && request.method === "GET") {
      return await handleSearch(request, requiredLexicon(dependencies.lexicon));
    }
    if (pathname === USER_LEXICON_ENTRIES_PATH && request.method === "POST") {
      return await handleCreate({
        lexicon: requiredLexicon(dependencies.lexicon),
        payload: await readJsonObject(request),
      });
    }
    if (pathname === USER_LEXICON_IMPORT_PATH && request.method === "POST") {
      return await handleImport({
        lexicon: requiredLexicon(dependencies.lexicon),
        body: await readBoundedBody(request, USER_LEXICON_MAX_IMPORT_BYTES),
        createId,
      });
    }
    if (pathname === USER_LEXICON_DICTIONARIES_PATH && request.method === "GET") {
      return json(HTTP_OK, await requiredLexicon(dependencies.lexicon).listDictionaries());
    }
    if (pathname === USER_LEXICON_DICTIONARIES_PATH && request.method === "POST") {
      const payload = await readJsonObject(request);
      if (typeof payload.name !== "string") {
        return fail(HTTP_BAD_REQUEST, "invalid_dictionary_name", "Create requires a name");
      }
      const created = await requiredLexicon(dependencies.lexicon).createDictionary(payload.name);
      return json(HTTP_CREATED, created);
    }
    const dictionaryMatch = pathname.match(
      /^\/azookey\/user-lexicon\/dictionaries\/([^/]+)(?:\/(activate|imports)(?:\/([^/]+))?)?$/,
    );
    if (dictionaryMatch) {
      const dictionaryId = decodeURIComponent(dictionaryMatch[1] ?? "");
      const action = dictionaryMatch[2];
      const importId = dictionaryMatch[3];
      const lexicon = requiredLexicon(dependencies.lexicon);
      if (action === "activate" && request.method === "POST") {
        return json(HTTP_OK, await lexicon.activateDictionary(dictionaryId));
      }
      if (action === "imports" && request.method === "POST" && importId === undefined) {
        const body = await readBoundedBody(request, USER_LEXICON_MAX_IMPORT_BYTES);
        const job = await lexicon.startImport({
          dictionaryId,
          body,
          filename: request.headers.get("x-filename") ?? "upload.tsv",
        });
        return json(HTTP_ACCEPTED, job);
      }
      if (action === "imports" && request.method === "GET" && importId !== undefined) {
        return json(HTTP_OK, await lexicon.importStatus(importId));
      }
      if (action === undefined && request.method === "PUT") {
        const payload = await readJsonObject(request);
        if (typeof payload.name !== "string") {
          return fail(HTTP_BAD_REQUEST, "invalid_dictionary_name", "Rename requires a name");
        }
        return json(HTTP_OK, await lexicon.renameDictionary(dictionaryId, payload.name));
      }
      if (action === undefined && request.method === "DELETE") {
        return json(HTTP_OK, await lexicon.deleteDictionary(dictionaryId));
      }
    }
    if (request.method === "PUT" || request.method === "DELETE") {
      const id = entryIdFromPath(pathname);
      if (id === undefined) {
        if (pathname.startsWith(ENTRIES_PREFIX)) {
          return fail(HTTP_BAD_REQUEST, "invalid_user_lexicon_id", "User lexicon id is required");
        }
        if (pathname === USER_LEXICON_HTTP_PATH || pathname === USER_LEXICON_ENTRIES_PATH) {
          return methodNotAllowed();
        }
        return undefined;
      }
      if (request.method === "DELETE") {
        const result = await requiredLexicon(dependencies.lexicon).remove(id);
        return json(HTTP_OK, { revision: result.revision, deleted: true });
      }
      return await handleUpdate({
        lexicon: requiredLexicon(dependencies.lexicon),
        id,
        payload: await readJsonObject(request),
      });
    }
    if (
      pathname === USER_LEXICON_HTTP_PATH ||
      pathname === USER_LEXICON_ENTRIES_PATH ||
      pathname === USER_LEXICON_IMPORT_PATH ||
      pathname === USER_LEXICON_CONVERT_PATH
    ) {
      return methodNotAllowed();
    }
    return undefined;
  } catch (error) {
    return handleDictionaryError(error);
  }
};
