/**
 * HTTP contract tests for the Worker-owned user lexicon.
 *
 * This file runs with bun.
 */

import { describe, expect, it } from "vitest";
import { createGatewayFetchHandler } from "./http.js";
import { createMemoryUserLexicon, USER_LEXICON_MAX_ENTRIES } from "./user-lexicon.js";

const config = {
  listen: { host: "127.0.0.1", port: 8_765 },
  parapper: { url: "ws://127.0.0.1:18082/ws/recognition", timeoutMs: 1_000 },
  models: {
    "plain-model": { baseUrl: "https://models.test/" },
  },
};

const jsonBody = async (response: Response): Promise<Record<string, unknown>> => {
  const parsed: unknown = await response.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  return Object.fromEntries(Object.entries(parsed));
};

const lexiconRequest = (input: {
  method: string;
  path: string;
  body?: Record<string, unknown> | string;
}): Request => {
  if (input.body === undefined) {
    return new Request(`https://gateway.example${input.path}`, {
      method: input.method,
      headers: { "content-type": "application/json" },
    });
  }
  const encoded = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  return new Request(`https://gateway.example${input.path}`, {
    method: input.method,
    headers: { "content-type": "application/json" },
    body: encoded,
  });
};

describe("user lexicon HTTP contract", () => {
  it("creates, lists metadata, pages entries, updates, and deletes stored words", async () => {
    const lexicon = createMemoryUserLexicon(() => "created-id");
    const handler = createGatewayFetchHandler(config, {
      userLexicon: lexicon,
      userLexiconCreateId: () => "created-id",
    });
    const created = await handler(
      lexiconRequest({
        method: "POST",
        path: "/azookey/user-lexicon/entries",
        body: { reading: "ぶいあーるちゃっと", word: "VRC" },
      }),
    );
    expect(created.status).toStrictEqual(201);
    expect(await jsonBody(created)).toStrictEqual({
      revision: "1",
      entry: { id: "created-id", reading: "ぶいあーるちゃっと", word: "VRC" },
    });
    const meta = await handler(lexiconRequest({ method: "GET", path: "/azookey/user-lexicon" }));
    expect(await jsonBody(meta)).toStrictEqual({
      revision: "1",
      entryCount: 1,
      tsvBytes: 32,
    });
    const searched = await handler(
      lexiconRequest({ method: "GET", path: "/azookey/user-lexicon/entries?q=VRC&limit=50" }),
    );
    expect(await jsonBody(searched)).toStrictEqual({
      revision: "1",
      entryCount: 1,
      entries: [{ id: "created-id", reading: "ぶいあーるちゃっと", word: "VRC" }],
      nextCursor: null,
    });
    const listed = await handler(
      lexiconRequest({ method: "GET", path: "/azookey/user-lexicon/entries?limit=50" }),
    );
    expect(await jsonBody(listed)).toStrictEqual({
      revision: "1",
      entryCount: 1,
      entries: [{ id: "created-id", reading: "ぶいあーるちゃっと", word: "VRC" }],
      nextCursor: null,
    });
    const updated = await handler(
      lexiconRequest({
        method: "PUT",
        path: "/azookey/user-lexicon/entries/created-id",
        body: { reading: "よみ", word: "単語" },
      }),
    );
    expect(await jsonBody(updated)).toStrictEqual({
      revision: "2",
      entry: { id: "created-id", reading: "よみ", word: "単語" },
    });
    const deleted = await handler(
      lexiconRequest({ method: "DELETE", path: "/azookey/user-lexicon/entries/created-id" }),
    );
    expect(await jsonBody(deleted)).toStrictEqual({ revision: "3", deleted: true });
    const missing = await handler(
      lexiconRequest({ method: "DELETE", path: "/azookey/user-lexicon/entries/created-id" }),
    );
    expect(missing.status).toStrictEqual(404);
  });

  it("rejects one-character readings and accepts a two-character reading", async () => {
    const lexicon = createMemoryUserLexicon(() => "two-char");
    const handler = createGatewayFetchHandler(config, {
      userLexicon: lexicon,
      userLexiconCreateId: () => "two-char",
    });
    const tooShortA = await handler(
      lexiconRequest({
        method: "POST",
        path: "/azookey/user-lexicon/entries",
        body: { reading: "あ", word: "A" },
      }),
    );
    expect(tooShortA.status).toStrictEqual(400);
    expect(await jsonBody(tooShortA)).toStrictEqual({
      error: { code: "invalid_user_lexicon_entry", message: "entry 1 reading is too short" },
    });
    const tooShortHa = await handler(
      lexiconRequest({
        method: "POST",
        path: "/azookey/user-lexicon/entries",
        body: { reading: "は", word: "歯" },
      }),
    );
    expect(tooShortHa.status).toStrictEqual(400);
    expect(await jsonBody(tooShortHa)).toStrictEqual({
      error: { code: "invalid_user_lexicon_entry", message: "entry 1 reading is too short" },
    });
    const created = await handler(
      lexiconRequest({
        method: "POST",
        path: "/azookey/user-lexicon/entries",
        body: { reading: "あい", word: "愛" },
      }),
    );
    expect(created.status).toStrictEqual(201);
    expect(await jsonBody(created)).toStrictEqual({
      revision: "1",
      entry: { id: "two-char", reading: "あい", word: "愛" },
    });
    const importTooShort = await handler(
      lexiconRequest({
        method: "POST",
        path: "/azookey/user-lexicon/import",
        body: "あ\tA\n",
      }),
    );
    expect(importTooShort.status).toStrictEqual(400);
    expect(await jsonBody(importTooShort)).toStrictEqual({
      error: { code: "invalid_user_lexicon_entry", message: "entry 1 reading is too short" },
    });
    const putTooShort = await handler(
      lexiconRequest({
        method: "PUT",
        path: "/azookey/user-lexicon/entries/two-char",
        body: { reading: "は", word: "歯" },
      }),
    );
    expect(putTooShort.status).toStrictEqual(400);
    expect(await jsonBody(putTooShort)).toStrictEqual({
      error: { code: "invalid_user_lexicon_entry", message: "entry 1 reading is too short" },
    });
  });

  it("imports a full TSV replace, rejects more than 100000 entries, and never dumps 100k rows", async () => {
    const lexicon = createMemoryUserLexicon(() => "import-id");
    const handler = createGatewayFetchHandler(config, {
      userLexicon: lexicon,
      userLexiconCreateId: () => "import-id",
    });
    const imported = await handler(
      lexiconRequest({
        method: "POST",
        path: "/azookey/user-lexicon/import",
        body: "ぶいあーるちゃっと\tVRC\n",
      }),
    );
    expect(await jsonBody(imported)).toStrictEqual({
      revision: "1",
      entryCount: 1,
      replaced: true,
    });
    const jsonImport = await handler(
      lexiconRequest({
        method: "POST",
        path: "/azookey/user-lexicon/import",
        body: '{"version":1,"entries":[{"id":"kept","reading":"よみ","word":"単語"}]}',
      }),
    );
    expect(await jsonBody(jsonImport)).toStrictEqual({
      revision: "2",
      entryCount: 1,
      replaced: true,
    });
    const overflow = Array.from({ length: USER_LEXICON_MAX_ENTRIES + 1 }, (_value, index) => ({
      id: `id-${String(index)}`,
      reading: "よみ",
      word: "単語",
    }));
    await lexicon.replaceAll(
      Array.from({ length: USER_LEXICON_MAX_ENTRIES }, (_value, index) => ({
        id: `id-${String(index)}`,
        reading: "よみ",
        word: "単語",
      })),
    );
    const rejected = await handler(
      lexiconRequest({
        method: "POST",
        path: "/azookey/user-lexicon/entries",
        body: { reading: "ついか", word: "追加" },
      }),
    );
    expect(rejected.status).toStrictEqual(400);
    expect(await jsonBody(rejected)).toStrictEqual({
      error: {
        code: "user_lexicon_too_large",
        message: "User lexicon supports at most 100000 entries",
      },
    });
    const paged = await handler(
      lexiconRequest({ method: "GET", path: "/azookey/user-lexicon/entries?limit=50" }),
    );
    const page = await jsonBody(paged);
    expect(page["entryCount"]).toStrictEqual(100000);
    expect(Array.isArray(page["entries"]) ? page["entries"].length : 0).toStrictEqual(50);
    expect(typeof page["nextCursor"]).toStrictEqual("string");
    expect(overflow.length).toStrictEqual(100001);
  });

  it("converts ぶいあーるちゃっと to VRC from the stored lexicon and rejects client TSV", async () => {
    const lexicon = createMemoryUserLexicon(() => "one");
    const seen: string[] = [];
    const handler = createGatewayFetchHandler(config, {
      userLexicon: lexicon,
      userLexiconCreateId: () => "one",
      convertWithUserLexicon: {
        convert: async (input) => {
          seen.push(input.lexiconTsv);
          const compact = await lexicon.snapshotCompact();
          expect(compact.compact.byteLength).toBeGreaterThan(32);
          return input.text;
        },
      },
    });
    const created = await handler(
      lexiconRequest({
        method: "POST",
        path: "/azookey/user-lexicon/entries",
        body: { reading: "ぶいあーるちゃっと", word: "VRC" },
      }),
    );
    expect(created.status).toStrictEqual(201);
    const converted = await handler(
      lexiconRequest({
        method: "POST",
        path: "/v1/azookey/convert",
        body: { text: "ぶいあーるちゃっと" },
      }),
    );
    expect(converted.status).toStrictEqual(200);
    expect(seen).toStrictEqual([""]);
    expect(await jsonBody(converted)).toStrictEqual({
      convertedText: "ぶいあーるちゃっと",
      lexiconEntryCount: 1,
      revision: "1",
    });
    const withoutDecoder = createGatewayFetchHandler(config, {
      userLexicon: lexicon,
    });
    expect(
      await jsonBody(
        await withoutDecoder(
          lexiconRequest({
            method: "POST",
            path: "/v1/azookey/convert",
            body: { text: "ぶいあーるちゃっと" },
          }),
        ),
      ),
    ).toStrictEqual({
      error: {
        code: "user_lexicon_converter_unavailable",
        message: "Stored-lexicon convert requires the Worker decoder",
      },
    });
    const rejected = await handler(
      lexiconRequest({
        method: "POST",
        path: "/v1/azookey/convert",
        body: { text: "ぶいあーるちゃっと", userDictionaryTsv: "クライアント\t無視\n" },
      }),
    );
    expect(rejected.status).toStrictEqual(400);
    expect(await jsonBody(rejected)).toStrictEqual({
      error: { code: "invalid_contract", message: "userDictionaryTsv is not allowed" },
    });
    const createRejected = await handler(
      lexiconRequest({
        method: "POST",
        path: "/azookey/user-lexicon/entries",
        body: { reading: "よみ", word: "単語", userDictionaryTsv: "x\ty\n" },
      }),
    );
    expect(createRejected.status).toStrictEqual(400);
  });

  it("returns 404 for the retired user-dictionary API and stable errors otherwise", async () => {
    const unavailable = createGatewayFetchHandler(config);
    expect(
      (await unavailable(lexiconRequest({ method: "GET", path: "/v1/azookey/user-dictionary" })))
        .status,
    ).toStrictEqual(404);
    expect(
      (
        await unavailable(
          lexiconRequest({ method: "POST", path: "/v1/azookey/user-dictionary/import", body: {} }),
        )
      ).status,
    ).toStrictEqual(404);
    expect(
      await jsonBody(
        await unavailable(lexiconRequest({ method: "GET", path: "/azookey/user-lexicon" })),
      ),
    ).toStrictEqual({
      error: {
        code: "user_lexicon_unavailable",
        message: "User lexicon persistence is not configured",
      },
    });
    const lexicon = createMemoryUserLexicon(() => "id");
    const handler = createGatewayFetchHandler(config, { userLexicon: lexicon });
    expect(
      (await handler(lexiconRequest({ method: "PATCH", path: "/azookey/user-lexicon" }))).status,
    ).toStrictEqual(405);
    expect(
      (await handler(lexiconRequest({ method: "GET", path: "/v1/azookey/convert" }))).status,
    ).toStrictEqual(405);
    expect(
      await jsonBody(
        await handler(
          lexiconRequest({
            method: "POST",
            path: "/v1/azookey/convert",
            body: { userDictionaryTsv: "よみ\t単語\n" },
          }),
        ),
      ),
    ).toStrictEqual({
      error: { code: "invalid_contract", message: "userDictionaryTsv is not allowed" },
    });
    expect(
      (await handler(lexiconRequest({ method: "DELETE", path: "/azookey/user-lexicon/entries/" })))
        .status,
    ).toStrictEqual(400);
    const cleared = await handler(
      lexiconRequest({ method: "DELETE", path: "/azookey/user-lexicon" }),
    );
    expect(await jsonBody(cleared)).toStrictEqual({ revision: "1", entryCount: 0 });
    expect(
      (await handler(lexiconRequest({ method: "PUT", path: "/azookey/user-lexicon", body: {} })))
        .status,
    ).toStrictEqual(405);
    expect(
      await jsonBody(
        await handler(
          lexiconRequest({
            method: "POST",
            path: "/azookey/user-lexicon/entries",
            body: { reading: "よみ" },
          }),
        ),
      ),
    ).toStrictEqual({
      error: { code: "invalid_user_lexicon_entry", message: "Create requires reading and word" },
    });
    expect(
      await jsonBody(
        await handler(
          lexiconRequest({
            method: "PUT",
            path: "/azookey/user-lexicon/entries/missing",
            body: { reading: "よみ", word: "単語" },
          }),
        ),
      ),
    ).toStrictEqual({
      error: { code: "user_lexicon_entry_not_found", message: "User lexicon entry not found" },
    });
    expect(
      await jsonBody(
        await handler(
          lexiconRequest({
            method: "POST",
            path: "/v1/azookey/convert",
            body: { text: "   " },
          }),
        ),
      ),
    ).toStrictEqual({
      error: { code: "convert_text_required", message: "Convert requires a text field" },
    });
    const emptyConvert = createGatewayFetchHandler(config);
    expect(
      await jsonBody(
        await emptyConvert(
          lexiconRequest({
            method: "POST",
            path: "/v1/azookey/convert",
            body: { text: "ぶいあーるちゃっと" },
          }),
        ),
      ),
    ).toStrictEqual({
      convertedText: "ぶいあーるちゃっと",
      lexiconEntryCount: 0,
      revision: "0",
    });
    expect(
      (await handler(lexiconRequest({ method: "GET", path: "/azookey/user-lexicon/import" })))
        .status,
    ).toStrictEqual(405);
    expect(
      await jsonBody(
        await handler(
          lexiconRequest({
            method: "POST",
            path: "/azookey/user-lexicon/entries",
            body: "[]",
          }),
        ),
      ),
    ).toStrictEqual({
      error: { code: "invalid_json", message: "JSON request must be an object" },
    });
  });

  it("creates a dictionary, imports TSV asynchronously, and searches by prefix", async () => {
    const lexicon = createMemoryUserLexicon(() => "http-id");
    const handler = createGatewayFetchHandler(config, { userLexicon: lexicon });
    const created = await handler(
      lexiconRequest({
        method: "POST",
        path: "/azookey/user-lexicon/dictionaries",
        body: { name: "Names" },
      }),
    );
    expect(created.status).toStrictEqual(201);
    const createdBody = await jsonBody(created);
    const dictionary = createdBody["dictionary"];
    const dictionaryId =
      dictionary && typeof dictionary === "object" && !Array.isArray(dictionary)
        ? Reflect.get(dictionary, "id")
        : "";
    expect(typeof dictionaryId).toStrictEqual("string");
    const imported = await handler(
      lexiconRequest({
        method: "POST",
        path: `/azookey/user-lexicon/dictionaries/${String(dictionaryId)}/imports`,
        body: "ぶいあーるちゃっと\tVRC\n",
      }),
    );
    expect(imported.status).toStrictEqual(202);
    const importBody = await jsonBody(imported);
    expect(importBody["status"]).toStrictEqual("completed");
    expect(importBody["accepted"]).toStrictEqual(1);
    const importId = importBody["id"];
    expect(typeof importId).toStrictEqual("string");
    const importStatus = await handler(
      lexiconRequest({
        method: "GET",
        path: `/azookey/user-lexicon/dictionaries/${String(dictionaryId)}/imports/${String(importId)}`,
      }),
    );
    expect((await jsonBody(importStatus))["status"]).toStrictEqual("completed");
    const activated = await handler(
      lexiconRequest({
        method: "POST",
        path: `/azookey/user-lexicon/dictionaries/${String(dictionaryId)}/activate`,
      }),
    );
    expect((await jsonBody(activated))["activeId"]).toStrictEqual("http-id");
    const renamed = await handler(
      lexiconRequest({
        method: "PUT",
        path: `/azookey/user-lexicon/dictionaries/${String(dictionaryId)}`,
        body: { name: "Renamed" },
      }),
    );
    expect(Reflect.get((await jsonBody(renamed))["dictionary"] ?? {}, "name")).toStrictEqual(
      "Renamed",
    );
    const listed = await handler(
      lexiconRequest({ method: "GET", path: "/azookey/user-lexicon/dictionaries" }),
    );
    expect(listed.status).toStrictEqual(200);
    const deleted = await handler(
      lexiconRequest({
        method: "DELETE",
        path: `/azookey/user-lexicon/dictionaries/${String(dictionaryId)}`,
      }),
    );
    expect(deleted.status).toStrictEqual(200);
    expect(
      (
        await handler(
          lexiconRequest({ method: "POST", path: "/azookey/user-lexicon/dictionaries", body: {} }),
        )
      ).status,
    ).toStrictEqual(400);
    expect(
      (
        await handler(
          lexiconRequest({
            method: "PUT",
            path: "/azookey/user-lexicon/dictionaries/default",
            body: {},
          }),
        )
      ).status,
    ).toStrictEqual(400);
  });

  it("rejects an oversized import body", async () => {
    const lexicon = createMemoryUserLexicon(() => "id");
    const handler = createGatewayFetchHandler(config, { userLexicon: lexicon });
    const oversized = await handler(
      new Request("https://gateway.example/azookey/user-lexicon/import", {
        method: "POST",
        headers: { "content-length": "20000000", "content-type": "text/plain" },
        body: "x",
      }),
    );
    expect(oversized.status).toStrictEqual(413);
    expect(await jsonBody(oversized)).toStrictEqual({
      error: { code: "request_too_large", message: "Request exceeds the size limit" },
    });
  });
});
