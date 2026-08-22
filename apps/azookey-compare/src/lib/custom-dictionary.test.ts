/**
 * Tests for the Worker user-lexicon HTTP client.
 *
 * This file runs with bun.
 */

import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import {
  addUserLexiconEntry,
  buildUserLexiconListUrl,
  clearUserLexicon,
  deleteUserLexiconEntry,
  getUserLexiconMetadata,
  importUserLexiconFile,
  listUserLexiconEntries,
  nextUserLexiconCursorState,
  parseUserLexiconImportResult,
  parseUserLexiconListPage,
  parseUserLexiconMetadata,
  parseUserLexiconWriteResult,
  previousUserLexiconCursorState,
  USER_LEXICON_HTTP_PATH,
  USER_LEXICON_MIN_READING_CHARS,
  USER_LEXICON_PAGE_LIMIT,
  USER_LEXICON_PAGE_LIMIT_MAX,
  updateUserLexiconEntry,
  userLexiconEntriesUrl,
  userLexiconEntryUrl,
  userLexiconHttpUrlFromWebsocket,
  userLexiconImportUrl,
  validateUserLexiconDraft,
} from "./custom-dictionary";

const workerBaseUrl = (): string => "http://127.0.0.1:8787/azookey/user-lexicon";

it("builds the Worker lexicon URL from a websocket locator", () => {
  expect(
    userLexiconHttpUrlFromWebsocket({
      websocketUrl: "ws://127.0.0.1:8787/ws/azookey",
      origin: "http://localhost:3000",
    }),
  ).toBe("http://127.0.0.1:8787/azookey/user-lexicon");
  expect(
    userLexiconHttpUrlFromWebsocket({
      websocketUrl: "wss://azookey-compare.kaoru.workers.dev/ws/azookey",
      origin: "https://azookey-compare.kaoru.workers.dev",
    }),
  ).toBe("https://azookey-compare.kaoru.workers.dev/azookey/user-lexicon");
  expect(
    userLexiconHttpUrlFromWebsocket({
      websocketUrl: "/ws/azookey",
      origin: "http://127.0.0.1:3000",
    }),
  ).toBe("http://127.0.0.1:3000/azookey/user-lexicon");
  expect(USER_LEXICON_HTTP_PATH).toBe("/azookey/user-lexicon");
  expect(USER_LEXICON_PAGE_LIMIT).toBe(50);
  expect(USER_LEXICON_PAGE_LIMIT_MAX).toBe(50);
  expect(USER_LEXICON_MIN_READING_CHARS).toBe(2);
  expect(() =>
    userLexiconHttpUrlFromWebsocket({
      websocketUrl: "   ",
      origin: "http://127.0.0.1:3000",
    }),
  ).toThrow("Cloudflare Worker WebSocket URL is required");
  expect(() =>
    userLexiconHttpUrlFromWebsocket({
      websocketUrl: "ftp://example.invalid/ws/azookey",
      origin: "http://127.0.0.1:3000",
    }),
  ).toThrow("http(s) or ws(s)");
});

it("builds metadata, list, entry, and import URLs without a TSV snapshot", () => {
  expect(userLexiconEntriesUrl("http://127.0.0.1:8787/azookey/user-lexicon")).toBe(
    "http://127.0.0.1:8787/azookey/user-lexicon/entries",
  );
  expect(
    buildUserLexiconListUrl({
      baseUrl: "http://127.0.0.1:8787/azookey/user-lexicon",
      fetcher: fetch,
      auth: { scheme: "none" },
      q: "",
      limit: 50,
      cursor: "",
    }),
  ).toBe("http://127.0.0.1:8787/azookey/user-lexicon/entries?limit=50");
  expect(
    buildUserLexiconListUrl({
      baseUrl: "http://127.0.0.1:8787/azookey/user-lexicon",
      fetcher: fetch,
      auth: { scheme: "none" },
      q: "ぶいあーる",
      limit: 200,
      cursor: "cursor-2",
    }),
  ).toBe(
    "http://127.0.0.1:8787/azookey/user-lexicon/entries?limit=50&q=%E3%81%B6%E3%81%84%E3%81%82%E3%83%BC%E3%82%8B&cursor=cursor-2",
  );
  expect(userLexiconEntryUrl("http://127.0.0.1:8787/azookey/user-lexicon", "id-1")).toBe(
    "http://127.0.0.1:8787/azookey/user-lexicon/entries/id-1",
  );
  expect(userLexiconEntryUrl("http://127.0.0.1:8787/azookey/user-lexicon/", "id/slash")).toBe(
    "http://127.0.0.1:8787/azookey/user-lexicon/entries/id%2Fslash",
  );
  expect(userLexiconImportUrl("http://127.0.0.1:8787/azookey/user-lexicon")).toBe(
    "http://127.0.0.1:8787/azookey/user-lexicon/import",
  );
  expect(() => userLexiconEntryUrl("http://127.0.0.1:8787/azookey/user-lexicon", "  ")).toThrow(
    "user-lexicon id is required",
  );
});

it("validates add/update drafts without parsing import files", () => {
  expect(
    validateUserLexiconDraft({ reading: " ぶいあーるちゃっと ", word: " VRC " }),
  ).toStrictEqual({
    reading: "ぶいあーるちゃっと",
    word: "VRC",
  });
  expect(() => validateUserLexiconDraft({ reading: "", word: "x" })).toThrow("reading is required");
  expect(() => validateUserLexiconDraft({ reading: "よみ", word: "" })).toThrow("word is required");
  expect(() => validateUserLexiconDraft({ reading: "#comment", word: "x" })).toThrow(
    "cannot start with #",
  );
  expect(() => validateUserLexiconDraft({ reading: "よ\tみ", word: "x" })).toThrow(
    "tabs or newlines",
  );
  expect(() => validateUserLexiconDraft({ reading: "あい", word: "い\nう" })).toThrow(
    "tabs or newlines",
  );
  expect(() => validateUserLexiconDraft({ reading: "あ".repeat(257), word: "x" })).toThrow(
    "reading is too long",
  );
  expect(() => validateUserLexiconDraft({ reading: "あい", word: "い".repeat(513) })).toThrow(
    "word is too long",
  );
});

it("rejects a one-character reading and accepts two characters", () => {
  expect(() => validateUserLexiconDraft({ reading: "あ", word: "A" })).toThrow(
    "reading must be at least 2 characters",
  );
  expect(validateUserLexiconDraft({ reading: "あい", word: "愛" })).toStrictEqual({
    reading: "あい",
    word: "愛",
  });
});

it("parses Worker metadata, list, write, and import envelopes", () => {
  expect(parseUserLexiconMetadata({ revision: 3, entryCount: 12, tsvBytes: 128 })).toStrictEqual({
    revision: "3",
    entryCount: 12,
    tsvBytes: 128,
  });
  expect(
    parseUserLexiconListPage({
      revision: "rev-2",
      entryCount: 2,
      entries: [{ id: "one", reading: "ぶいあーるちゃっと", word: "VRC" }],
      nextCursor: "cursor-2",
    }),
  ).toStrictEqual({
    revision: "rev-2",
    entryCount: 2,
    entries: [{ id: "one", reading: "ぶいあーるちゃっと", word: "VRC" }],
    nextCursor: "cursor-2",
  });
  expect(
    parseUserLexiconWriteResult({
      revision: "rev-3",
      entry: { id: "created", reading: "よみ", word: "単語" },
    }),
  ).toStrictEqual({
    revision: "rev-3",
    entry: { id: "created", reading: "よみ", word: "単語" },
  });
  expect(parseUserLexiconImportResult({ revision: "rev-9", entryCount: 4 })).toStrictEqual({
    revision: "rev-9",
    entryCount: 4,
  });
  expect(() => parseUserLexiconMetadata(null)).toThrow("metadata must be an object");
  expect(() => parseUserLexiconMetadata({ entryCount: 1, tsvBytes: 2 })).toThrow(
    "revision is missing",
  );
  expect(() => parseUserLexiconListPage({ revision: "1", entryCount: 0 })).toThrow(
    "entries must be an array",
  );
  expect(() => parseUserLexiconListPage({ revision: "1", entryCount: 1, entries: ["x"] })).toThrow(
    "must be an object",
  );
  expect(() => parseUserLexiconWriteResult({ revision: "1" })).toThrow("must be an object");
  expect(() => parseUserLexiconImportResult({})).toThrow("revision is missing");
  expect(() => parseUserLexiconListPage(null)).toThrow("list must be an object");
  expect(() => parseUserLexiconImportResult(null)).toThrow("import result must be an object");
  expect(() =>
    parseUserLexiconListPage({
      revision: "1",
      entryCount: 1,
      entries: [{ reading: "あ", word: "A" }],
    }),
  ).toThrow("missing id");
  expect(() =>
    parseUserLexiconListPage({
      revision: "1",
      entryCount: 1,
      entries: [{ id: "1", word: "A" }],
    }),
  ).toThrow("missing reading");
  expect(() =>
    parseUserLexiconListPage({
      revision: "1",
      entryCount: 1,
      entries: [{ id: "1", reading: "あ" }],
    }),
  ).toThrow("missing word");
  expect(() => parseUserLexiconMetadata({ revision: "1", tsvBytes: 1 })).toThrow(
    "entryCount is missing",
  );
  expect(() => parseUserLexiconMetadata({ revision: "1", entryCount: 1 })).toThrow(
    "tsvBytes is missing",
  );
  expect(() => parseUserLexiconImportResult({ revision: "1" })).toThrow("entryCount is missing");
  expect(
    parseUserLexiconListPage({
      revision: "1",
      entryCount: 0,
      entries: [],
      nextCursor: "  ",
    }),
  ).toStrictEqual({ revision: "1", entryCount: 0, entries: [], nextCursor: "" });
});

it("loads metadata and one search page from the Worker", async () => {
  const metaUrls: string[] = [];
  const metadata = await getUserLexiconMetadata({
    baseUrl: workerBaseUrl(),
    fetcher: (input) => {
      metaUrls.push(String(input));
      return Promise.resolve(Response.json({ revision: "rev-1", entryCount: 12, tsvBytes: 256 }));
    },
    auth: { scheme: "none" },
  });
  expect(metadata).toStrictEqual({ revision: "rev-1", entryCount: 12, tsvBytes: 256 });
  expect(metaUrls).toStrictEqual(["http://127.0.0.1:8787/azookey/user-lexicon"]);

  const urls: string[] = [];
  const methods: Array<string | undefined> = [];
  const page = await listUserLexiconEntries({
    baseUrl: workerBaseUrl(),
    fetcher: (input, init) => {
      urls.push(String(input));
      methods.push(init?.method);
      return Promise.resolve(
        Response.json({
          revision: "rev-1",
          entryCount: 12,
          entries: [{ id: "one", reading: "ぶいあーるちゃっと", word: "VRC" }],
          nextCursor: "cursor-2",
        }),
      );
    },
    auth: { scheme: "none" },
    q: "ぶい",
    limit: 50,
    cursor: "",
  });
  expect(page).toStrictEqual({
    revision: "rev-1",
    entryCount: 12,
    entries: [{ id: "one", reading: "ぶいあーるちゃっと", word: "VRC" }],
    nextCursor: "cursor-2",
  });
  expect(urls).toStrictEqual([
    "http://127.0.0.1:8787/azookey/user-lexicon/entries?limit=50&q=%E3%81%B6%E3%81%84",
  ]);
  expect(methods).toStrictEqual(["GET"]);
});

it("adds and updates a word through the entries collection", async () => {
  const urls: string[] = [];
  const methods: Array<string | undefined> = [];
  const bodies: Array<BodyInit | null | undefined> = [];
  const authorizations: Array<string | null> = [];
  const created = await addUserLexiconEntry({
    baseUrl: workerBaseUrl(),
    fetcher: (input, init) => {
      urls.push(String(input));
      methods.push(init?.method);
      bodies.push(init?.body);
      const headers = init?.headers;
      authorizations.push(headers instanceof Headers ? headers.get("authorization") : null);
      return Promise.resolve(
        Response.json({
          revision: "rev-2",
          entry: { id: "created", reading: "ぶいあーるちゃっと", word: "VRC" },
        }),
      );
    },
    auth: { scheme: "bearer", token: " secret " },
    reading: " ぶいあーるちゃっと ",
    word: " VRC ",
  });
  expect(created).toStrictEqual({
    revision: "rev-2",
    entry: { id: "created", reading: "ぶいあーるちゃっと", word: "VRC" },
  });
  expect(urls).toStrictEqual(["http://127.0.0.1:8787/azookey/user-lexicon/entries"]);
  expect(methods).toStrictEqual(["POST"]);
  expect(bodies).toStrictEqual(['{"reading":"ぶいあーるちゃっと","word":"VRC"}']);
  expect(authorizations).toStrictEqual(["Bearer secret"]);

  const updateUrls: string[] = [];
  const updateMethods: Array<string | undefined> = [];
  const updated = await updateUserLexiconEntry({
    baseUrl: workerBaseUrl(),
    fetcher: (input, init) => {
      updateUrls.push(String(input));
      updateMethods.push(init?.method);
      return Promise.resolve(
        Response.json({
          revision: "rev-3",
          entry: { id: "created", reading: "ぶいあーるちゃっと", word: "VRChat" },
        }),
      );
    },
    auth: { scheme: "none" },
    id: "created",
    reading: "ぶいあーるちゃっと",
    word: "VRChat",
  });
  expect(updated).toStrictEqual({
    revision: "rev-3",
    entry: { id: "created", reading: "ぶいあーるちゃっと", word: "VRChat" },
  });
  expect(updateUrls).toStrictEqual(["http://127.0.0.1:8787/azookey/user-lexicon/entries/created"]);
  expect(updateMethods).toStrictEqual(["PUT"]);
});

it("deletes one entry, clears the lexicon, and posts the import file", async () => {
  const deleteUrls: string[] = [];
  const deleteMethods: Array<string | undefined> = [];
  await deleteUserLexiconEntry({
    baseUrl: workerBaseUrl(),
    fetcher: (input, init) => {
      deleteUrls.push(String(input));
      deleteMethods.push(init?.method);
      return Promise.resolve(Response.json({ deleted: true }));
    },
    auth: { scheme: "none" },
    id: "one",
  });
  expect(deleteUrls).toStrictEqual(["http://127.0.0.1:8787/azookey/user-lexicon/entries/one"]);
  expect(deleteMethods).toStrictEqual(["DELETE"]);

  const clearUrls: string[] = [];
  const clearMethods: Array<string | undefined> = [];
  await clearUserLexicon({
    baseUrl: workerBaseUrl(),
    fetcher: (input, init) => {
      clearUrls.push(String(input));
      clearMethods.push(init?.method);
      return Promise.resolve(new Response(null, { status: 204 }));
    },
    auth: { scheme: "none" },
  });
  expect(clearUrls).toStrictEqual(["http://127.0.0.1:8787/azookey/user-lexicon"]);
  expect(clearMethods).toStrictEqual(["DELETE"]);

  await deleteUserLexiconEntry({
    baseUrl: workerBaseUrl(),
    fetcher: () => Promise.resolve(new Response(null, { status: 204 })),
    auth: { scheme: "none" },
    id: "gone-204",
  });
  await clearUserLexicon({
    baseUrl: workerBaseUrl(),
    fetcher: () => Promise.resolve(Response.json({ cleared: true })),
    auth: { scheme: "none" },
  });

  const importUrls: string[] = [];
  const importMethods: Array<string | undefined> = [];
  const importBodies: Array<BodyInit | null | undefined> = [];
  const file = new File(["ぶいあーるちゃっと\tVRC\n"], "words.tsv", {
    type: "text/tab-separated-values",
  });
  const imported = await importUserLexiconFile({
    baseUrl: workerBaseUrl(),
    fetcher: (input, init) => {
      importUrls.push(String(input));
      importMethods.push(init?.method);
      importBodies.push(init?.body);
      return Promise.resolve(Response.json({ revision: "rev-9", entryCount: 1 }));
    },
    auth: { scheme: "none" },
    file,
  });
  expect(imported).toStrictEqual({ revision: "rev-9", entryCount: 1 });
  expect(importUrls).toStrictEqual(["http://127.0.0.1:8787/azookey/user-lexicon/import"]);
  expect(importMethods).toStrictEqual(["POST"]);
  expect(importBodies[0] instanceof FormData).toBe(true);
});

it("surfaces Worker HTTP errors and transport failures", async () => {
  await expect(
    addUserLexiconEntry({
      baseUrl: workerBaseUrl(),
      fetcher: vi.fn(),
      auth: { scheme: "none" },
      reading: "",
      word: "VRC",
    }),
  ).rejects.toThrow("reading is required");
  await expect(
    updateUserLexiconEntry({
      baseUrl: workerBaseUrl(),
      fetcher: vi.fn(),
      auth: { scheme: "none" },
      id: "x",
      reading: "よみ",
      word: "",
    }),
  ).rejects.toThrow("word is required");
  await expect(
    listUserLexiconEntries({
      baseUrl: workerBaseUrl(),
      fetcher: () => Promise.resolve(new Response("", { status: 200 })),
      auth: { scheme: "none" },
      q: "",
      limit: 50,
      cursor: "",
    }),
  ).rejects.toThrow("list must be an object");
  await expect(
    listUserLexiconEntries({
      baseUrl: workerBaseUrl(),
      fetcher: vi.fn(() =>
        Promise.resolve(
          Response.json({ error: { message: "lexicon unavailable" } }, { status: 503 }),
        ),
      ),
      auth: { scheme: "none" },
      q: "",
      limit: 50,
      cursor: "",
    }),
  ).rejects.toThrow("lexicon unavailable");
  await expect(
    getUserLexiconMetadata({
      baseUrl: workerBaseUrl(),
      fetcher: vi.fn(() => Promise.resolve(new Response("not-json", { status: 200 }))),
      auth: { scheme: "none" },
    }),
  ).rejects.toThrow("not valid JSON");
  await expect(
    listUserLexiconEntries({
      baseUrl: workerBaseUrl(),
      fetcher: vi.fn(() => Promise.reject(new Error("offline"))),
      auth: { scheme: "none" },
      q: "",
      limit: 50,
      cursor: "",
    }),
  ).rejects.toThrow("Worker user-lexicon request failed: offline");
  await expect(
    deleteUserLexiconEntry({
      baseUrl: workerBaseUrl(),
      fetcher: vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))),
      auth: { scheme: "none" },
      id: "missing",
    }),
  ).rejects.toThrow("Worker user-lexicon request failed (500)");
  await expect(
    clearUserLexicon({
      baseUrl: workerBaseUrl(),
      fetcher: vi.fn(() => Promise.resolve(new Response("", { status: 500 }))),
      auth: { scheme: "none" },
    }),
  ).rejects.toThrow("Worker user-lexicon request failed (500)");
  await expect(
    listUserLexiconEntries({
      baseUrl: workerBaseUrl(),
      fetcher: () =>
        Promise.resolve(
          Response.json({ error: { message: "  " }, message: "fallback" }, { status: 400 }),
        ),
      auth: { scheme: "none" },
      q: "",
      limit: 50,
      cursor: "",
    }),
  ).rejects.toThrow("fallback");
  await expect(
    listUserLexiconEntries({
      baseUrl: workerBaseUrl(),
      fetcher: vi.fn(() => Promise.reject("offline")),
      auth: { scheme: "none" },
      q: "",
      limit: 50,
      cursor: "",
    }),
  ).rejects.toThrow("Worker user-lexicon request failed");
});

it("moves only the current search cursor when paging", () => {
  expect(
    nextUserLexiconCursorState({
      previousCursors: [],
      currentCursor: "",
      nextCursor: "page-2",
    }),
  ).toStrictEqual({ previousCursors: [""], currentCursor: "page-2" });
  expect(
    previousUserLexiconCursorState({
      previousCursors: ["", "page-2"],
      currentCursor: "page-3",
    }),
  ).toStrictEqual({ previousCursors: [""], currentCursor: "page-2" });
  expect(
    previousUserLexiconCursorState({
      previousCursors: [],
      currentCursor: "",
    }),
  ).toStrictEqual({ previousCursors: [], currentCursor: "" });
});

it("forwards abort signals and omits empty Bearer tokens", async () => {
  const signal = new AbortController().signal;
  const listUrls: string[] = [];
  const listSignals: Array<AbortSignal | null | undefined> = [];
  const listAuthorizations: Array<string | null> = [];
  await listUserLexiconEntries({
    baseUrl: workerBaseUrl(),
    fetcher: (input, init) => {
      listUrls.push(String(input));
      listSignals.push(init?.signal);
      const headers = init?.headers;
      listAuthorizations.push(
        headers instanceof Headers ? headers.get("authorization") : "missing",
      );
      return Promise.resolve(
        Response.json({ revision: "rev-1", entryCount: 0, entries: [], nextCursor: null }),
      );
    },
    auth: { scheme: "bearer", token: "   " },
    q: "",
    limit: 0,
    cursor: "page-2",
    signal,
  });
  expect(listUrls).toStrictEqual([
    "http://127.0.0.1:8787/azookey/user-lexicon/entries?limit=50&cursor=page-2",
  ]);
  expect(listSignals).toStrictEqual([signal]);
  expect(listAuthorizations).toStrictEqual([null]);
});

it("does not persist words or parse import files in the browser", () => {
  const source = readFileSync(new URL("./custom-dictionary.ts", import.meta.url), "utf8");
  expect(source.indexOf("localStorage")).toBe(-1);
  expect(source.indexOf("sessionStorage")).toBe(-1);
  expect(source.indexOf("indexedDB")).toBe(-1);
  expect(source.indexOf("CacheStorage")).toBe(-1);
  expect(source.indexOf("userDictionaryTsv")).toBe(-1);
  expect(source.indexOf("parseUserDictionaryTsv")).toBe(-1);
  expect(source.indexOf("parseUserDictionaryCsv")).toBe(-1);
  expect(source.indexOf("parseUserDictionaryJson")).toBe(-1);
  expect(source.indexOf("/v1/azookey/user-dictionary")).toBe(-1);
  expect(source.indexOf("COMPARE_USER_LEXICON_HTTP_PATH")).not.toBe(-1);
  expect(source.indexOf("USER_LEXICON_ENTRIES_SUFFIX")).not.toBe(-1);
});
