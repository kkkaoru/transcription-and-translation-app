// This file runs with bun.
import { readFileSync } from "node:fs";
import { createMemoryUserLexicon } from "@caption-bridge/inference-server-core";
import { describe, expect, it, vi } from "vitest";
import {
  AZOOKEY_MAX_ID_BYTES,
  AZOOKEY_MAX_MESSAGE_BYTES,
  AZOOKEY_MAX_TEXT_BYTES,
  AZOOKEY_MIN_ELAPSED_MS,
  AZOOKEY_MODE,
  AZOOKEY_MODEL,
  AZOOKEY_MODEL_FALLBACK_UNCONFIGURED_ROUTE,
  AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED,
  AZOOKEY_ZENZ_HEALTH_PATH,
  AZOOKEY_ZENZ_SMALL_MODEL,
  AZOOKEY_ZENZ_UPSTREAM_USER_AGENT,
  AZOOKEY_ZENZ_XSMALL_MODEL,
  type AzookeyConnectionState,
  type AzookeyConverter,
  type AzookeyRuntime,
  advertisedConvertModels,
  attachAzookeySocket,
  azookeyDictionaryTimeoutMs,
  azookeyPongMessage,
  azookeyTimeoutMs,
  bearerTokenMatches,
  convertAzookeyMessage,
  convertTextWithStoredUserLexicon,
  createVibratoHttpConverter,
  createWasmConverter,
  elapsedMsFromDuration,
  INFERENCE_PUBLIC_HOST,
  invalidateIsolateUserLexiconCache,
  isAzookeyTimingLog,
  isPublicInferenceRequest,
  isWebSocketUpgrade,
  isZenzConvertModel,
  openAzookeySocket,
  parseAzookeyMessage,
  parseAzookeyPingMessage,
  parseAzookeyTimingLog,
  parseModelRoutes,
  readyAzookeyMessage,
  resolveAzookeyHandshakeAuthorization,
  VIBRATO_MAX_RESPONSE_BYTES,
  warmZenzUpstreams,
  wrapUserLexiconWrites,
} from "./azookey.js";

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  accepted = false;
  closed = false;

  send(value: string): void {
    this.sent.push(value);
  }

  accept(): void {
    this.accepted = true;
  }

  close(): void {
    this.closed = true;
  }

  emit(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }

  emitClose(): void {
    this.dispatchEvent(new Event("close"));
  }
}

const valid = {
  type: "azookey.convert",
  requestId: "req-1",
  source: "web-speech",
  language: "ja",
  sourceText: "きょうははいしんです",
  vibratoInput: "きょうははいしんです",
  mode: "worker-vibrato",
  auth: { scheme: "bearer", token: "secret" },
} as const;

describe("AzooKey Worker text contract", () => {
  it("clamps timeout configuration and publishes the ready protocol envelope", () => {
    expect(azookeyTimeoutMs({})).toBe(2_000);
    expect(azookeyTimeoutMs({ AZOOKEY_TIMEOUT_MS: " " })).toBe(2_000);
    expect(azookeyTimeoutMs({ AZOOKEY_TIMEOUT_MS: "not-a-number" })).toBe(2_000);
    expect(azookeyTimeoutMs({ AZOOKEY_TIMEOUT_MS: "1" })).toBe(25);
    expect(azookeyTimeoutMs({ AZOOKEY_TIMEOUT_MS: "250.6" })).toBe(251);
    expect(azookeyTimeoutMs({ AZOOKEY_TIMEOUT_MS: "99999" })).toBe(2_000);
    expect(azookeyDictionaryTimeoutMs({})).toBe(10_000);
    expect(azookeyDictionaryTimeoutMs({ AZOOKEY_DICTIONARY_TIMEOUT_MS: "1" })).toBe(1_000);
    expect(azookeyDictionaryTimeoutMs({ AZOOKEY_DICTIONARY_TIMEOUT_MS: "999999" })).toBe(60_000);
    expect(JSON.parse(readyAzookeyMessage(125))).toMatchObject({
      type: "azookey.ready",
      protocol: "azookey.text.v1",
      timeoutMs: 125,
    });
    expect(JSON.parse(readyAzookeyMessage(125, true))).toMatchObject({
      vibrato: { workerStage: "configured" },
    });
    expect(JSON.parse(readyAzookeyMessage(125, false))).toMatchObject({
      vibrato: { workerStage: "unconfigured" },
    });
    expect(JSON.parse(readyAzookeyMessage(125, "passthrough"))).toMatchObject({
      vibrato: {
        workerStage: "passthrough",
        workerInput: "sourceText",
        workerPassthrough: true,
      },
      dictionary: { transport: "builtin", configured: false },
    });
    expect(JSON.parse(readyAzookeyMessage(125, "passthrough", {}, "portable-wasm"))).toMatchObject({
      dictionary: { transport: "portable-wasm", configured: true },
      models: [AZOOKEY_MODEL],
    });
    expect(
      JSON.parse(
        readyAzookeyMessage(
          125,
          "passthrough",
          { [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" } },
          "portable-wasm",
        ),
      ),
    ).toMatchObject({
      models: [AZOOKEY_MODEL, AZOOKEY_ZENZ_SMALL_MODEL],
    });
    expect(JSON.parse(readyAzookeyMessage(125, "passthrough", {}, "builtin"))).toMatchObject({
      models: [AZOOKEY_MODEL],
    });
    expect(
      JSON.parse(readyAzookeyMessage(125, "passthrough", {}, "portable-wasm")).models,
    ).not.toContain(AZOOKEY_ZENZ_XSMALL_MODEL);
  });

  it("advertises Zenz ids only when MODEL_ROUTES has a non-empty baseUrl", () => {
    expect(advertisedConvertModels({})).toStrictEqual(["azookey-rust-wasm"]);
    expect(
      advertisedConvertModels({
        "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.example" },
      }),
    ).toStrictEqual(["azookey-rust-wasm", "zenz-v3.2-small-gguf"]);
    expect(parseModelRoutes('{"zenz-v3.2-small-gguf":{"baseUrl":"   "}}')).toStrictEqual({});
    expect(
      parseModelRoutes('{"zenz-v3.2-small-gguf":{"baseUrl":"https://zenz.example/"}}'),
    ).toStrictEqual({
      "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.example" },
    });
  });

  it("rejects every malformed request field and authentication shape", () => {
    const cases: Array<[unknown, string]> = [
      [null, "JSON object"],
      [[], "JSON object"],
      [{ ...valid, requestId: "" }, "requestId"],
      [{ ...valid, requestId: "あ".repeat(200) }, "requestId"],
      [{ ...valid, source: "microphone" }, "source"],
      [{ ...valid, language: "" }, "language"],
      [{ ...valid, language: "あ".repeat(100) }, "language"],
      [{ ...valid, sourceText: "" }, "sourceText"],
      [{ ...valid, sourceText: "あ".repeat(AZOOKEY_MAX_TEXT_BYTES) }, "sourceText"],
      [{ ...valid, vibratoInput: "" }, "vibratoInput"],
      [{ ...valid, mode: "unsupported" }, "mode"],
      [{ ...valid, auth: 1 }, "auth"],
      [{ ...valid, auth: { scheme: "invalid" } }, "auth.scheme"],
      [{ ...valid, auth: { scheme: "bearer" } }, "auth.token"],
      [{ ...valid, auth: { scheme: "bearer", token: "" } }, "auth.token"],
      [{ ...valid, auth: { scheme: "none", token: "secret" } }, "auth.token"],
      [{ ...valid, auth: { scheme: "bearer", token: "a".repeat(600) } }, "auth.token"],
    ];
    for (const [value, message] of cases) {
      expect(() => parseAzookeyMessage(JSON.stringify(value))).toThrow(message);
    }
    expect(
      parseAzookeyMessage(JSON.stringify({ ...valid, auth: { scheme: "none" } })).auth,
    ).toEqual({
      scheme: "none",
    });
    expect(parseAzookeyMessage(JSON.stringify({ ...valid, auth: { type: "none" } })).auth).toEqual({
      scheme: "none",
    });
  });

  it("parses the next-app request fields and rejects browser-only mode", () => {
    expect(parseAzookeyMessage(JSON.stringify(valid))).toMatchObject({
      type: "azookey.convert",
      requestId: "req-1",
      sourceText: "きょうははいしんです",
      vibratoInput: "きょうははいしんです",
      mode: AZOOKEY_MODE,
    });
    expect(() =>
      parseAzookeyMessage(JSON.stringify({ ...valid, mode: "browser-vibrato" })),
    ).toThrow("client-only");
    expect(() => parseAzookeyMessage(JSON.stringify({ ...valid, type: "convert" }))).toThrow(
      "azookey.convert",
    );
    expect(
      parseAzookeyMessage(JSON.stringify({ ...valid, vibratoExecution: "worker" })),
    ).toMatchObject({ vibratoExecution: "worker" });
    expect(
      parseAzookeyMessage(JSON.stringify({ ...valid, model: AZOOKEY_ZENZ_XSMALL_MODEL })),
    ).toMatchObject({
      model: AZOOKEY_ZENZ_XSMALL_MODEL,
    });
    expect(
      parseAzookeyMessage(
        JSON.stringify({ ...valid, leftContext: "子供がお菓子を食べています。" }),
      ),
    ).toMatchObject({
      leftContext: "子供がお菓子を食べています。",
    });
    expect(
      parseAzookeyMessage(JSON.stringify({ ...valid, leftContext: " " })).leftContext,
    ).toBeUndefined();
    expect(() =>
      parseAzookeyMessage(
        JSON.stringify({ ...valid, userDictionaryTsv: "ぶいあーるちゃっと\tVRC\n" }),
      ),
    ).toThrow("userDictionaryTsv is not allowed");
    expect(() => parseAzookeyMessage(JSON.stringify({ ...valid, userDictionaryTsv: 1 }))).toThrow(
      "userDictionaryTsv is not allowed",
    );
    expect(() => parseAzookeyMessage(JSON.stringify({ ...valid, leftContext: 1 }))).toThrow(
      "leftContext must be a string",
    );
    expect(() =>
      parseAzookeyMessage(
        JSON.stringify({ ...valid, leftContext: "あ".repeat(AZOOKEY_MAX_TEXT_BYTES) }),
      ),
    ).toThrow("leftContext exceeds its byte limit");
    expect(() => parseAzookeyMessage(JSON.stringify({ ...valid, model: "unknown-model" }))).toThrow(
      "model must be azookey-rust-wasm",
    );
    expect(isZenzConvertModel(AZOOKEY_ZENZ_XSMALL_MODEL)).toBe(true);
    expect(isZenzConvertModel(AZOOKEY_MODEL)).toBe(false);
    expect(() =>
      parseAzookeyMessage(JSON.stringify({ ...valid, vibratoExecution: "heuristic" })),
    ).toThrow("vibratoExecution");
    expect(
      parseAzookeyMessage(
        JSON.stringify({ ...valid, utteranceId: "capture-1", resetContext: true }),
      ),
    ).toMatchObject({ utteranceId: "capture-1", resetContext: true });
    expect(() => parseAzookeyMessage(JSON.stringify({ ...valid, utteranceId: "" }))).toThrow(
      "utteranceId",
    );
    expect(() => parseAzookeyMessage(JSON.stringify({ ...valid, resetContext: "yes" }))).toThrow(
      "resetContext",
    );
  });

  it("enforces UTF-8 input limits before conversion", () => {
    const tooLarge = { ...valid, vibratoInput: "あ".repeat(AZOOKEY_MAX_TEXT_BYTES) };
    expect(new TextEncoder().encode(tooLarge.vibratoInput).byteLength).toBeGreaterThan(
      AZOOKEY_MAX_TEXT_BYTES,
    );
    expect(() => parseAzookeyMessage(JSON.stringify(tooLarge))).toThrow("byte limit");
    expect(() => parseAzookeyMessage("not-json")).toThrow("valid JSON");
  });

  it("parses azookey.ping without convert fields and builds azookey.pong", () => {
    expect(parseAzookeyPingMessage('{"type":"azookey.ping"}')).toStrictEqual({
      type: "azookey.ping",
    });
    expect(parseAzookeyPingMessage('{"type":"azookey.ping","requestId":"pin-1"}')).toStrictEqual({
      type: "azookey.ping",
      requestId: "pin-1",
    });
    expect(
      parseAzookeyPingMessage('{"type":"azookey.ping","requestId":"","extra":true}'),
    ).toStrictEqual({
      type: "azookey.ping",
      requestId: "",
    });
    expect(parseAzookeyPingMessage('{"type":"azookey.ping","requestId":1}')).toStrictEqual({
      type: "azookey.ping",
    });
    expect(
      parseAzookeyPingMessage(
        `{"type":"azookey.ping","requestId":"${"a".repeat(AZOOKEY_MAX_ID_BYTES + 1)}"}`,
      ),
    ).toStrictEqual({
      type: "azookey.ping",
    });
    expect(parseAzookeyPingMessage('{"type":"azookey.convert"}')).toBeUndefined();
    expect(parseAzookeyPingMessage("not-json")).toBeUndefined();
    expect(parseAzookeyPingMessage("[]")).toBeUndefined();
    expect(parseAzookeyPingMessage("null")).toBeUndefined();
    expect(azookeyPongMessage()).toStrictEqual({ type: "azookey.pong" });
    expect(azookeyPongMessage("pin-1")).toStrictEqual({
      type: "azookey.pong",
      requestId: "pin-1",
    });
    expect(() => parseAzookeyMessage('{"type":"azookey.ping"}')).toThrow("azookey.convert");
  });

  it("returns the stable next-app response shape and preserves source text", async () => {
    const runtime: AzookeyRuntime = {
      timeoutMs: 250,
      converter: (text) => `今日は配信です:${text}`,
    };
    const result = await convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), runtime);
    expect(result).toMatchObject({
      type: "azookey.result",
      requestId: "req-1",
      sourceText: "きょうははいしんです",
      convertedText: "今日は配信です:きょうははいしんです",
      mode: "worker-vibrato",
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(AZOOKEY_MIN_ELAPSED_MS);
    expect(result).toMatchObject({
      conversionStatus: 0,
      contextUsed: false,
      usedCompletion: false,
    });
  });

  it("applies the stored Worker lexicon without a client TSV frame", async () => {
    const lexicon = createMemoryUserLexicon(() => "one");
    await lexicon.upsert({ reading: "ぶいあーるちゃっと", word: "VRC" });
    const seen: number[] = [];
    const runtime: AzookeyRuntime = {
      timeoutMs: 250,
      userLexicon: lexicon,
      converter: Object.assign((text: string) => `plain:${text}`, {
        syncUserLexicon: async () => {
          const snapshot = await lexicon.snapshotCompact();
          return snapshot.compact.byteLength === 0 ? 0 : 7;
        },
        convertWithContext: (
          text: string,
          _signal?: AbortSignal,
          _preceding?: unknown,
          lexiconHandle?: number,
        ) => {
          seen.push(lexiconHandle ?? 0);
          return lexiconHandle === 7 && text === "ぶいあーるちゃっと" ? "VRC" : `ignored:${text}`;
        },
      }),
    };
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          vibratoInput: "ぶいあーるちゃっと",
          sourceText: "ぶいあーるちゃっと",
        }),
      ),
      runtime,
    );
    expect(result.convertedText).toBe("VRC");
    expect(seen).toStrictEqual([7]);
  });

  it("HTTP convert applies VRC through the compact WASM handle", async () => {
    const lexicon = createMemoryUserLexicon(() => "one");
    await lexicon.upsert({ reading: "ぶいあーるちゃっと", word: "VRC" });
    const wasmModule = new WebAssembly.Module(
      readFileSync(new URL("../wasm/azookey.wasm", import.meta.url)),
    );
    const converter = createWasmConverter(wasmModule);
    const converted = await convertTextWithStoredUserLexicon({
      converter,
      lexicon,
      text: "ぶいあーるちゃっと",
    });
    expect(converted).toBe("VRC");
    expect((await lexicon.snapshotCompact()).compact.byteLength).toBeGreaterThan(32);
  }, 20_000);

  it("keeps the default conversion when the compact lexicon snapshot is empty", async () => {
    const lexicon = createMemoryUserLexicon(() => "one");
    vi.spyOn(lexicon, "snapshotCompact").mockResolvedValue({
      revision: "empty",
      compact: new Uint8Array(),
    });
    const wasmModule = new WebAssembly.Module(
      readFileSync(new URL("../wasm/azookey.wasm", import.meta.url)),
    );
    const converter = createWasmConverter(wasmModule);
    const converted = await convertTextWithStoredUserLexicon({
      converter,
      lexicon,
      text: "かんじ",
    });
    expect(converted.length).toBeGreaterThan(0);
  }, 20_000);

  it("does not snapshot or open_compact when the isolate lexicon revision is unchanged", async () => {
    const lexicon = createMemoryUserLexicon(() => "one");
    await lexicon.upsert({ reading: "ぶいあーるちゃっと", word: "VRC" });
    const snapshot = vi.spyOn(lexicon, "snapshotCompact");
    const wasmModule = new WebAssembly.Module(
      readFileSync(new URL("../wasm/azookey.wasm", import.meta.url)),
    );
    const converter = createWasmConverter(wasmModule);
    const first = await convertTextWithStoredUserLexicon({
      converter,
      lexicon,
      text: "ぶいあーるちゃっと",
    });
    const second = await convertTextWithStoredUserLexicon({
      converter,
      lexicon,
      text: "ぶいあーるちゃっと",
    });
    expect(first).toBe("VRC");
    expect(second).toBe("VRC");
    expect(snapshot).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("skips lexicon meta() inside the one-second TTL and rechecks after expiry", async () => {
    const lexicon = createMemoryUserLexicon(() => "one");
    await lexicon.upsert({ reading: "ぶいあーるちゃっと", word: "VRC" });
    const meta = vi.spyOn(lexicon, "meta");
    const snapshot = vi.spyOn(lexicon, "snapshotCompact");
    const wasmModule = new WebAssembly.Module(
      readFileSync(new URL("../wasm/azookey.wasm", import.meta.url)),
    );
    const converter = createWasmConverter(wasmModule);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_700_000_000_000);
    await convertTextWithStoredUserLexicon({
      converter,
      lexicon,
      text: "ぶいあーるちゃっと",
    });
    await convertTextWithStoredUserLexicon({
      converter,
      lexicon,
      text: "ぶいあーるちゃっと",
    });
    expect(meta).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_700_000_001_001);
    await convertTextWithStoredUserLexicon({
      converter,
      lexicon,
      text: "ぶいあーるちゃっと",
    });
    expect(meta).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledTimes(1);
    now.mockRestore();
  }, 20_000);

  it("rechecks lexicon meta() immediately after a write invalidates the TTL", async () => {
    const lexicon = wrapUserLexiconWrites(createMemoryUserLexicon(() => "one"));
    await lexicon.upsert({ reading: "ぶいあーるちゃっと", word: "VRC" });
    const meta = vi.spyOn(lexicon, "meta");
    const wasmModule = new WebAssembly.Module(
      readFileSync(new URL("../wasm/azookey.wasm", import.meta.url)),
    );
    const converter = createWasmConverter(wasmModule);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_700_000_100_000);
    await convertTextWithStoredUserLexicon({
      converter,
      lexicon,
      text: "ぶいあーるちゃっと",
    });
    expect(meta).toHaveBeenCalledTimes(1);
    await lexicon.upsert({ reading: "ぶいあーるちゃっと", word: "VRC" });
    await convertTextWithStoredUserLexicon({
      converter,
      lexicon,
      text: "ぶいあーるちゃっと",
    });
    expect(meta).toHaveBeenCalledTimes(2);
    invalidateIsolateUserLexiconCache();
    await convertTextWithStoredUserLexicon({
      converter,
      lexicon,
      text: "ぶいあーるちゃっと",
    });
    expect(meta).toHaveBeenCalledTimes(3);
    now.mockRestore();
  }, 20_000);

  it("forwards every wrapped user lexicon RPC and invalidates write caches", async () => {
    const lexicon = wrapUserLexiconWrites(createMemoryUserLexicon(() => "wrapped"));
    await lexicon.upsert({ id: "entry", reading: "あい", word: "愛" });
    expect((await lexicon.snapshotTsv()).tsv).toBe("あい\t愛\n");
    expect((await lexicon.snapshotCompact()).compact.byteLength).toBeGreaterThan(0);
    expect((await lexicon.exportAll()).entries).toStrictEqual([
      { id: "entry", reading: "あい", word: "愛" },
    ]);
    expect((await lexicon.search({ q: "あ", cursor: "", limit: 1 })).entries).toStrictEqual([
      { id: "entry", reading: "あい", word: "愛" },
    ]);
    await lexicon.update("entry", { reading: "よみ", word: "単語" });
    await lexicon.remove("entry");
    await lexicon.restore({
      revision: "10",
      entries: [{ id: "restored", reading: "ふくげん", word: "復元" }],
    });
    await lexicon.replaceAll([{ id: "replaced", reading: "おきかえ", word: "置換" }]);
    await lexicon.clear();
    expect((await lexicon.listDictionaries()).activeId).toBe("default");
    const dictionary = await lexicon.createDictionary("Names");
    await lexicon.renameDictionary(dictionary.dictionary.id, "Renamed");
    await lexicon.activateDictionary(dictionary.dictionary.id);
    const imported = await lexicon.startImport({
      dictionaryId: dictionary.dictionary.id,
      body: "あい\t愛\n",
      filename: "words.tsv",
    });
    expect((await lexicon.importStatus(imported.id)).status).toBe("completed");
    expect((await lexicon.processQueuedImport(imported.id)).status).toBe("failed");
    await lexicon.deleteDictionary(dictionary.dictionary.id);
  });

  it("clamps non-finite timing elapsed values to zero", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
      timeoutMs: 250,
      converter: (text) => text,
      wsOrHttp: "ws",
    });
    expect(parseAzookeyTimingLog(String(log.mock.calls[0]?.[0]))?.elapsedMs).toBe(0);
    log.mockRestore();
    now.mockRestore();
  });

  it("emits azookey_timing convert and total logs for a WebSocket convert", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      if (typeof value === "string") {
        lines.push(value);
      }
    });
    await convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
      timeoutMs: 250,
      converter: (text) => `今日は配信です:${text}`,
      wsOrHttp: "ws",
    });
    spy.mockRestore();
    const convertLog = parseAzookeyTimingLog(lines[0] ?? "");
    const totalLog = parseAzookeyTimingLog(lines[1] ?? "");
    expect(isAzookeyTimingLog(lines[0])).toBe(true);
    expect(isAzookeyTimingLog({ event: "azookey_timing" })).toBe(false);
    expect(convertLog?.event).toBe("azookey_timing");
    expect(convertLog?.phase).toBe("dictionary_convert");
    expect(convertLog?.nBest).toBe(64);
    expect(convertLog?.cacheHit).toBe(false);
    expect(convertLog?.wsOrHttp).toBe("ws");
    expect(convertLog?.inputChars).toBe(10);
    expect(typeof convertLog?.elapsedMs).toBe("number");
    expect(totalLog?.phase).toBe("total");
    expect(totalLog?.wsOrHttp).toBe("ws");
    expect(parseAzookeyTimingLog("{")).toBeUndefined();
    expect(parseAzookeyTimingLog("[]")).toBeUndefined();
    expect(parseAzookeyTimingLog(JSON.stringify({ event: "other" }))).toBeUndefined();
    expect(parseAzookeyTimingLog(JSON.stringify({ event: "azookey_timing" }))).toBeUndefined();
    expect(
      parseAzookeyTimingLog(JSON.stringify({ event: "azookey_timing", phase: "convert" })),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(JSON.stringify({ event: "azookey_timing", phase: "total" })),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({ event: "azookey_timing", phase: "total", elapsedMs: "0" }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({ event: "azookey_timing", phase: "total", elapsedMs: 0 }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "total",
          elapsedMs: 0,
          inputChars: "0",
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "total",
          elapsedMs: 0,
          inputChars: 0,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "total",
          elapsedMs: 0,
          inputChars: 0,
          nBest: 1,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "total",
          elapsedMs: 0,
          inputChars: 0,
          nBest: 64,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "total",
          elapsedMs: 0,
          inputChars: 0,
          nBest: 64,
          cacheHit: "false",
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "total",
          elapsedMs: 0,
          inputChars: 0,
          nBest: 64,
          cacheHit: false,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "total",
          elapsedMs: 0,
          inputChars: 0,
          nBest: 64,
          cacheHit: false,
          wsOrHttp: "invalid",
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "total",
          elapsedMs: 0,
          inputChars: 0,
          nBest: 64,
          cacheHit: false,
          wsOrHttp: "http",
          zenzHttpReason: "invalid",
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({ event: "azookey_timing", phase: "convert", elapsedMs: 1 }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "convert",
          elapsedMs: 1,
          inputChars: 0,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "convert",
          elapsedMs: 1,
          inputChars: 0,
          nBest: 64,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "convert",
          elapsedMs: 1,
          inputChars: 0,
          nBest: 64,
          cacheHit: false,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "unknown",
          elapsedMs: 1,
          inputChars: 0,
          nBest: 64,
          cacheHit: false,
          wsOrHttp: "ws",
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "convert",
          elapsedMs: 1,
          inputChars: 0,
          nBest: 64,
          cacheHit: false,
          wsOrHttp: "tcp",
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "convert",
          elapsedMs: 1,
          inputChars: 0,
          nBest: 8,
          cacheHit: false,
          wsOrHttp: "ws",
        }),
      ),
    ).toBeUndefined();
  });

  it("emits lexicon_meta lexicon_open dictionary_convert and total logs on the HTTP convert path", async () => {
    const lexicon = createMemoryUserLexicon(() => "one");
    await lexicon.upsert({ reading: "ぶいあーるちゃっと", word: "VRC" });
    const wasmModule = new WebAssembly.Module(
      readFileSync(new URL("../wasm/azookey.wasm", import.meta.url)),
    );
    const converter = createWasmConverter(wasmModule);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      if (typeof value === "string") {
        lines.push(value);
      }
    });
    const converted = await convertTextWithStoredUserLexicon({
      converter,
      lexicon,
      text: "ぶいあーるちゃっと",
    });
    spy.mockRestore();
    expect(converted).toBe("VRC");
    const lexiconLog = parseAzookeyTimingLog(lines[0] ?? "");
    const openLog = parseAzookeyTimingLog(lines[1] ?? "");
    const convertLog = parseAzookeyTimingLog(lines[2] ?? "");
    const totalLog = parseAzookeyTimingLog(lines[3] ?? "");
    expect(lexiconLog?.phase).toBe("lexicon_meta");
    expect(lexiconLog?.cacheHit).toBe(false);
    expect(lexiconLog?.wsOrHttp).toBe("http");
    expect(openLog?.phase).toBe("lexicon_open");
    expect(openLog?.cacheHit).toBe(false);
    expect(convertLog?.phase).toBe("dictionary_convert");
    expect(convertLog?.wsOrHttp).toBe("http");
    expect(totalLog?.phase).toBe("total");
    expect(totalLog?.wsOrHttp).toBe("http");
  }, 20_000);

  it("reuses one builtin WASM instance for the same module", () => {
    const bytes = readFileSync(new URL("../wasm/azookey.wasm", import.meta.url));
    const module = new WebAssembly.Module(bytes);
    const first = createWasmConverter(module);
    const second = createWasmConverter(module);
    expect(first).toBe(second);
    expect(first("きょうのてんき")).toBe("今日の天気");
  });

  it("strips Japanese ASR token-gap spaces before the shipped converter input", async () => {
    const seen: string[] = [];
    const runtime: AzookeyRuntime = {
      timeoutMs: 250,
      converter: (text) => {
        seen.push(text);
        return `converted:${text}`;
      },
    };
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          type: "azookey.convert",
          requestId: "req-spaces",
          source: "web-speech",
          language: "ja",
          sourceText: "きょう は いい てんき",
          vibratoInput: "きょう は いい てんき",
          mode: "worker-vibrato",
        }),
      ),
      runtime,
    );
    expect(seen).toStrictEqual(["きょうはいいてんき"]);
    expect(result.convertedText).toBe("converted:きょうはいいてんき");
    expect(result.vibratoInput).toBe("きょうはいいてんき");
  });

  it("passes trailing context to the next chunk on the same connection", async () => {
    const precedingCalls: Array<AzookeyConnectionState["preceding"]> = [];
    const converter = ((
      text: string,
      _signal: AbortSignal | undefined,
      preceding: AzookeyConnectionState["preceding"],
    ) => {
      precedingCalls.push(preceding);
      return {
        text: preceding ? `with-context:${text}` : `first:${text}`,
        status: 0,
        trailing: preceding ? undefined : { rcid: 17, mid: 23 },
        dictionaryRevision: "rev-a",
      };
    }) as unknown as AzookeyConverter;
    converter.dictionaryRevision = "rev-a";
    const state: AzookeyConnectionState = {};
    const first = await convertAzookeyMessage(
      parseAzookeyMessage(JSON.stringify({ ...valid, utteranceId: "capture-1" })),
      { timeoutMs: 250, converter },
      state,
    );
    const second = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          requestId: "req-2",
          vibratoInput: "つづき",
          utteranceId: "capture-1",
        }),
      ),
      { timeoutMs: 250, converter },
      state,
    );
    expect(first).toMatchObject({
      convertedText: "first:きょうははいしんです",
      contextUsed: false,
    });
    expect(second).toMatchObject({
      convertedText: "with-context:つづき",
      contextUsed: true,
      conversionStatus: 0,
    });
    expect(precedingCalls).toEqual([undefined, { rcid: 17, mid: 23 }]);
    expect(state.preceding).toBeUndefined();
  });

  it("discards connection context at an utterance boundary and exposes the discard", async () => {
    const precedingCalls: Array<AzookeyConnectionState["preceding"]> = [];
    const converter = ((
      text: string,
      _signal: AbortSignal | undefined,
      preceding: AzookeyConnectionState["preceding"],
    ) => {
      precedingCalls.push(preceding);
      return {
        text,
        status: 0,
        trailing: { rcid: 3, mid: 5 },
        dictionaryRevision: "rev-a",
      };
    }) as unknown as AzookeyConverter;
    converter.dictionaryRevision = "rev-a";
    const state: AzookeyConnectionState = {};
    await convertAzookeyMessage(
      parseAzookeyMessage(JSON.stringify({ ...valid, utteranceId: "capture-1" })),
      { timeoutMs: 250, converter },
      state,
    );
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({ ...valid, requestId: "req-2", utteranceId: "capture-2" }),
      ),
      { timeoutMs: 250, converter },
      state,
    );
    expect(precedingCalls).toEqual([undefined, undefined]);
    expect(result).toMatchObject({ contextUsed: false, contextDiscarded: "utterance-boundary" });
  });

  it("discards connection context when the dictionary revision changes", async () => {
    let revision = "rev-a";
    const precedingCalls: Array<AzookeyConnectionState["preceding"]> = [];
    const converter = ((
      text: string,
      _signal: AbortSignal | undefined,
      preceding: AzookeyConnectionState["preceding"],
    ) => {
      precedingCalls.push(preceding);
      return { text, status: 0, trailing: { rcid: 7, mid: 9 }, dictionaryRevision: revision };
    }) as unknown as AzookeyConverter;
    Object.defineProperty(converter, "dictionaryRevision", { get: () => revision });
    const state: AzookeyConnectionState = {};
    await convertAzookeyMessage(
      parseAzookeyMessage(JSON.stringify({ ...valid, utteranceId: "capture-1" })),
      { timeoutMs: 250, converter },
      state,
    );
    revision = "rev-b";
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({ ...valid, requestId: "req-2", utteranceId: "capture-1" }),
      ),
      { timeoutMs: 250, converter },
      state,
    );
    expect(precedingCalls).toEqual([undefined, undefined]);
    expect(result).toMatchObject({ contextUsed: false, contextDiscarded: "dictionary-revision" });
  });

  it("resets context for an explicit boundary and for a model change", async () => {
    const precedingCalls: Array<AzookeyConnectionState["preceding"]> = [];
    const converter = ((
      text: string,
      _signal: AbortSignal | undefined,
      preceding: AzookeyConnectionState["preceding"],
    ) => {
      precedingCalls.push(preceding);
      return {
        text,
        status: 0,
        trailing: { rcid: 31, mid: 37 },
        dictionaryRevision: "rev-a",
      };
    }) as unknown as AzookeyConverter;
    converter.dictionaryRevision = "rev-a";
    const state: AzookeyConnectionState = {};

    await convertAzookeyMessage(
      parseAzookeyMessage(JSON.stringify({ ...valid, utteranceId: "capture-1" })),
      { timeoutMs: 250, converter },
      state,
    );
    const resetResult = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          requestId: "req-2",
          utteranceId: "capture-1",
          resetContext: true,
        }),
      ),
      { timeoutMs: 250, converter },
      state,
    );
    expect(resetResult).toMatchObject({
      contextUsed: false,
      contextDiscarded: "utterance-boundary",
    });

    const modelChangeState: AzookeyConnectionState = {
      model: AZOOKEY_ZENZ_XSMALL_MODEL,
      preceding: { rcid: 41, mid: 43 },
      dictionaryRevision: "rev-a",
    };
    const modelChangeResult = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({ ...valid, requestId: "req-3", model: AZOOKEY_ZENZ_XSMALL_MODEL }),
      ),
      { timeoutMs: 250, converter, modelRoutes: {} },
      modelChangeState,
    );
    expect(modelChangeResult).toMatchObject({
      contextUsed: false,
      contextDiscarded: "model-change",
      modelFallback: AZOOKEY_MODEL_FALLBACK_UNCONFIGURED_ROUTE,
    });

    const azookeyToZenzState: AzookeyConnectionState = {
      model: AZOOKEY_MODEL,
      preceding: { rcid: 71, mid: 73 },
      dictionaryRevision: "rev-a",
    };
    const azookeyToZenzResult = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({ ...valid, requestId: "req-4", model: AZOOKEY_ZENZ_XSMALL_MODEL }),
      ),
      { timeoutMs: 250, converter, modelRoutes: {} },
      azookeyToZenzState,
    );
    expect(azookeyToZenzResult.contextDiscarded).toBe("model-change");
    expect(precedingCalls).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("does not invent a dictionary revision for an adapter that omits one", async () => {
    const converter = ((
      text: string,
      _signal: AbortSignal | undefined,
      _preceding: AzookeyConnectionState["preceding"],
    ) => ({ text, status: 0, trailing: { rcid: 47, mid: 53 } })) as unknown as AzookeyConverter;
    const state: AzookeyConnectionState = {};
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(JSON.stringify(valid)),
      { timeoutMs: 250, converter },
      state,
    );
    expect(result.contextUsed).toBe(false);
    expect(state.preceding).toEqual({ rcid: 47, mid: 53 });
    expect(state.dictionaryRevision).toBeUndefined();
  });

  it("fills the active dictionary revision for legacy object results", async () => {
    const converter = ((text: string) => ({ text, status: 0 })) as unknown as AzookeyConverter;
    converter.dictionaryRevision = "rev-legacy";
    const result = await convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
      timeoutMs: 250,
      converter,
    });
    expect(result.conversionStatus).toBe(0);
    expect(result.convertedText).toBe(valid.vibratoInput);
  });

  it("rejects invalid status and trailing metadata from a context-aware adapter", async () => {
    const invalidStatus = ((text: string) => ({
      text,
      status: Number.NaN,
    })) as unknown as AzookeyConverter;
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 250,
        converter: invalidStatus,
      }),
    ).rejects.toMatchObject({ code: "conversion_failed" });

    const invalidTrailing = ((text: string) => ({
      text,
      status: 0,
      trailing: { rcid: 0x1_0000, mid: 1 },
    })) as unknown as AzookeyConverter;
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 250,
        converter: invalidTrailing,
      }),
    ).rejects.toMatchObject({ code: "conversion_failed" });
  });

  it("does not run Zenz on the azookey-rust-wasm caption path even when MODEL_ROUTES is live", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ content: "無視" }), { status: 200 }),
    );
    const result = await convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
      timeoutMs: 250,
      converter: (text) => `dict:${text}`,
      modelRoutes: {
        [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
      },
      fetcher,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.usedCompletion).toBe(false);
    expect(result.model).toBe("azookey-rust-wasm");
    expect(result.convertedText).toBe(`dict:${valid.vibratoInput}`);
  });

  it("falls back to portable WASM when Zenzai models are absent from MODEL_ROUTES", async () => {
    const runtime: AzookeyRuntime = {
      timeoutMs: 250,
      converter: (text) => `dict:${text}`,
      modelRoutes: {},
    };
    for (const model of [AZOOKEY_ZENZ_XSMALL_MODEL, AZOOKEY_ZENZ_SMALL_MODEL] as const) {
      const message = parseAzookeyMessage(JSON.stringify({ ...valid, model }));
      const result = await convertAzookeyMessage(message, runtime);
      expect(result).toMatchObject({
        convertedText: `dict:${valid.vibratoInput}`,
        model: AZOOKEY_MODEL,
        requestedModel: model,
        modelFallback: AZOOKEY_MODEL_FALLBACK_UNCONFIGURED_ROUTE,
      });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(AZOOKEY_MIN_ELAPSED_MS);
    }
  });

  it("falls back to portable WASM when a configured Zenzai upstream fails", async () => {
    const fetcher = vi.fn(async () => new Response("upstream offline", { status: 503 }));
    const converter = vi.fn((text: string) => `dict:${text}`);
    const message = parseAzookeyMessage(
      JSON.stringify({
        ...valid,
        model: AZOOKEY_ZENZ_XSMALL_MODEL,
        leftContext: "子供がお菓子を食べています。",
      }),
    );
    const result = await convertAzookeyMessage(message, {
      timeoutMs: 250,
      converter,
      modelRoutes: {
        [AZOOKEY_ZENZ_XSMALL_MODEL]: { baseUrl: "https://zenz.example" },
      },
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://zenz.example/completion",
      expect.objectContaining({ method: "POST" }),
    );
    expect(converter).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      convertedText: `dict:${valid.vibratoInput}`,
      model: AZOOKEY_MODEL,
      requestedModel: AZOOKEY_ZENZ_XSMALL_MODEL,
      modelFallback: AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED,
    });
  });

  it("keeps the dictionary baseline when a configured Zenz model has no left context", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ content: "設定済みの変換" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(JSON.stringify({ ...valid, model: AZOOKEY_ZENZ_XSMALL_MODEL })),
      {
        timeoutMs: 1_000,
        converter: (text) => `dict:${text}`,
        modelRoutes: { [AZOOKEY_ZENZ_XSMALL_MODEL]: { baseUrl: "https://zenz.example" } },
        fetcher,
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      convertedText: `dict:${valid.vibratoInput}`,
      model: AZOOKEY_ZENZ_XSMALL_MODEL,
      conversionStatus: 0,
    });
  });

  it("falls back to portable WASM when a configured Zenzai upstream connection fails", async () => {
    // Local MODEL_ROUTES often points at 127.0.0.1:8081 for xsmall. When that
    // llama-server is down, fetch throws TypeError — not HTTP 5xx — and must
    // still use the portable dictionary instead of "AzooKey conversion failed".
    const fetcher = vi.fn(() => {
      throw new TypeError("fetch failed");
    });
    const message = parseAzookeyMessage(
      JSON.stringify({
        ...valid,
        model: AZOOKEY_ZENZ_XSMALL_MODEL,
        leftContext: "子供がお菓子を食べています。",
      }),
    );
    const result = await convertAzookeyMessage(message, {
      timeoutMs: 250,
      converter: (text) => `dict:${text}`,
      modelRoutes: {
        [AZOOKEY_ZENZ_XSMALL_MODEL]: { baseUrl: "http://127.0.0.1:8081" },
      },
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8081/completion",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toMatchObject({
      convertedText: `dict:${valid.vibratoInput}`,
      model: AZOOKEY_MODEL,
      requestedModel: AZOOKEY_ZENZ_XSMALL_MODEL,
      modelFallback: AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED,
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(AZOOKEY_MIN_ELAPSED_MS);
  });

  it("uses a configured Zenzai upstream when MODEL_ROUTES exposes the model", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ content: "今日は配信です" }), { status: 200 }),
    );
    const message = parseAzookeyMessage(
      JSON.stringify({ ...valid, model: AZOOKEY_ZENZ_SMALL_MODEL }),
    );
    const result = await convertAzookeyMessage(message, {
      timeoutMs: 250,
      converter: (text) => `dict:${text}`,
      modelRoutes: {
        [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
      },
      fetcher,
    });
    expect(result).toMatchObject({
      convertedText: `dict:${valid.vibratoInput}`,
      model: AZOOKEY_ZENZ_SMALL_MODEL,
      usedCompletion: false,
      completionSkipReason: "empty-left-context",
    });
    expect(result.requestedModel).toBeUndefined();
    expect(result.modelFallback).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("orchestrates one Zenz completion against the local lattice when left context is present", async () => {
    const captured: string[] = [];
    const fetcher: AzookeyRuntime["fetcher"] = (_input, init) => {
      captured.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ content: "感じ" }), { status: 200 });
    };
    const prefixes: string[] = [];
    const converter = ((text: string) => `dict:${text}`) as AzookeyConverter;
    converter.openLattice = () => ({
      searchOutputPrefix: (prefix) => {
        prefixes.push(new TextDecoder().decode(prefix));
        return "感じ";
      },
      close: vi.fn(),
    });
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          model: AZOOKEY_ZENZ_SMALL_MODEL,
          leftContext: "子供がお菓子を食べています。",
        }),
      ),
      {
        timeoutMs: 250,
        converter,
        modelRoutes: {
          [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
        },
        fetcher,
      },
    );
    expect(captured).toHaveLength(1);
    const body = JSON.parse(captured[0] ?? "{}") as { prompt?: string; n_predict?: number };
    expect(body.prompt).toBe(
      "\u{EE02}子供がお菓子を食べています。\u{EE00}キョウハハイシンデス\u{EE01}",
    );
    expect(body.n_predict).toBe(64);
    expect(prefixes).toStrictEqual(["感"]);
    expect(result).toMatchObject({
      convertedText: "感じ",
      model: AZOOKEY_ZENZ_SMALL_MODEL,
      usedCompletion: true,
    });
    expect(result.completionSkipReason).toBeUndefined();
  });

  it("defers dictionary materialization and caps low-CPU completion tokens", async () => {
    const phases: string[] = [];
    const requests: string[] = [];
    const converter: AzookeyConverter = Object.assign(
      (text: string) => {
        phases.push("dictionary");
        return `dict:${text}`;
      },
      {
        openLattice: () => {
          phases.push("lattice");
          return {
            searchOutputPrefix: () => "感じ",
            close: vi.fn(),
          };
        },
      },
    );
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          model: AZOOKEY_ZENZ_SMALL_MODEL,
          leftContext: "前文です。",
        }),
      ),
      {
        timeoutMs: 250,
        converter,
        deferDictionaryUntilZenz: true,
        zenzNPredict: 32,
        modelRoutes: {
          [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
        },
        fetcher: (_input, init) => {
          phases.push("zenz");
          requests.push(String(init?.body));
          return new Response(JSON.stringify({ content: "感じ" }), { status: 200 });
        },
      },
    );
    expect(phases).toStrictEqual(["zenz", "dictionary", "lattice"]);
    expect(JSON.parse(requests[0] ?? "{}")).toMatchObject({ n_predict: 32 });
    expect(result.usedCompletion).toBe(true);
  });

  it("keeps the dictionary baseline when lattice open is unavailable", async () => {
    const fetcher = vi.fn(() => new Response(JSON.stringify({ content: "感じ" }), { status: 200 }));
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          model: AZOOKEY_ZENZ_SMALL_MODEL,
          leftContext: "子供がお菓子を食べています。",
        }),
      ),
      {
        timeoutMs: 250,
        converter: (text) => `dict:${text}`,
        modelRoutes: {
          [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
        },
        fetcher,
      },
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      convertedText: `dict:${valid.vibratoInput}`,
      model: AZOOKEY_ZENZ_SMALL_MODEL,
      usedCompletion: false,
      completionSkipReason: "lattice-unavailable",
    });
    expect(result.modelFallback).toBeUndefined();
  });

  it("closes the lattice after constrained search throws", async () => {
    const close = vi.fn();
    const converter = ((text: string) => `dict:${text}`) as AzookeyConverter;
    converter.openLattice = () => ({
      searchOutputPrefix: () => {
        throw new Error("wasm trap");
      },
      close,
    });
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          model: AZOOKEY_ZENZ_SMALL_MODEL,
          leftContext: "子供がお菓子を食べています。",
        }),
      ),
      {
        timeoutMs: 250,
        converter,
        modelRoutes: {
          [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
        },
        fetcher: () => new Response(JSON.stringify({ content: "感じ" }), { status: 200 }),
      },
    );
    expect(close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      convertedText: `dict:${valid.vibratoInput}`,
      model: AZOOKEY_ZENZ_SMALL_MODEL,
      usedCompletion: true,
    });
  });

  it("falls back when a configured Zenzai upstream times out", async () => {
    // Zenzai is capped (AZOOKEY_ZENZ_UPSTREAM_MAX_MS) so a hanging llama-server
    // (e.g. local xsmall :8081) still leaves room for portable WASM.
    const fetcher = vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const message = parseAzookeyMessage(
      JSON.stringify({
        ...valid,
        model: AZOOKEY_ZENZ_XSMALL_MODEL,
        leftContext: "子供がお菓子を食べています。",
      }),
    );
    const converter = vi.fn((text: string) => `dict:${text}`);
    const result = await convertAzookeyMessage(message, {
      timeoutMs: 2_000,
      converter,
      modelRoutes: {
        [AZOOKEY_ZENZ_XSMALL_MODEL]: { baseUrl: "http://127.0.0.1:8081" },
      },
      fetcher,
    });
    expect(converter).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      convertedText: `dict:${valid.vibratoInput}`,
      model: AZOOKEY_MODEL,
      requestedModel: AZOOKEY_ZENZ_XSMALL_MODEL,
      modelFallback: AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED,
    });
  });

  it("falls back when a configured Zenzai upstream returns empty content", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ content: "   " }), { status: 200 }),
    );
    const message = parseAzookeyMessage(
      JSON.stringify({
        ...valid,
        model: AZOOKEY_ZENZ_XSMALL_MODEL,
        leftContext: "子供がお菓子を食べています。",
      }),
    );
    const result = await convertAzookeyMessage(message, {
      timeoutMs: 250,
      converter: (text) => `dict:${text}`,
      modelRoutes: {
        [AZOOKEY_ZENZ_XSMALL_MODEL]: { baseUrl: "https://zenz.example" },
      },
      fetcher,
    });
    expect(result).toMatchObject({
      convertedText: `dict:${valid.vibratoInput}`,
      modelFallback: AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED,
    });
  });

  it("posts Zenz /completion once on TypeError and does not retry", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: "感じ" }), { status: 200 }));
    const converter = vi.fn((text: string) => `dict:${text}`);
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          model: AZOOKEY_ZENZ_SMALL_MODEL,
          leftContext: "子供がお菓子を食べています。",
        }),
      ),
      {
        timeoutMs: 1_000,
        converter,
        modelRoutes: {
          [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
        },
        fetcher,
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(converter).toHaveBeenCalledTimes(1);
    expect(result.convertedText).toBe("dict:きょうははいしんです");
    expect(result.model).toBe("azookey-rust-wasm");
    expect(result.modelFallback).toBe("upstream-failed");
    expect(result.usedCompletion).toBe(false);
  });

  it("does not retry a protocol HTTP 4xx from Zenz", async () => {
    const fetcher = vi.fn(async () => new Response("bad request", { status: 400 }));
    const converter = vi.fn((text: string) => `dict:${text}`);
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          model: AZOOKEY_ZENZ_SMALL_MODEL,
          leftContext: "子供がお菓子を食べています。",
        }),
      ),
      {
        timeoutMs: 250,
        converter,
        modelRoutes: {
          [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
        },
        fetcher,
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(converter).toHaveBeenCalledTimes(1);
    expect(result.modelFallback).toBe("upstream-failed");
    expect(result.convertedText).toBe("dict:きょうははいしんです");
  });

  it("records zenz_http ok timeout fetch and empty reasons without text", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      if (typeof value === "string") {
        lines.push(value);
      }
    });
    const latticeConverter = ((text: string) => `dict:${text}`) as AzookeyConverter;
    latticeConverter.openLattice = () => ({
      searchOutputPrefix: () => "感じ",
      close: vi.fn(),
    });
    await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          model: AZOOKEY_ZENZ_SMALL_MODEL,
          leftContext: "子供がお菓子を食べています。",
        }),
      ),
      {
        timeoutMs: 250,
        converter: latticeConverter,
        modelRoutes: {
          [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
        },
        fetcher: () => new Response(JSON.stringify({ content: "感じ" }), { status: 200 }),
      },
    );
    await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          requestId: "req-timeout",
          model: AZOOKEY_ZENZ_SMALL_MODEL,
          leftContext: "子供がお菓子を食べています。",
        }),
      ),
      {
        timeoutMs: 80,
        converter: (text) => `dict:${text}`,
        modelRoutes: {
          [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
        },
        fetcher: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      },
    );
    await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          requestId: "req-fetch",
          model: AZOOKEY_ZENZ_SMALL_MODEL,
          leftContext: "子供がお菓子を食べています。",
        }),
      ),
      {
        timeoutMs: 250,
        converter: (text) => `dict:${text}`,
        modelRoutes: {
          [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
        },
        fetcher: () => {
          throw new TypeError("fetch failed");
        },
      },
    );
    await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          ...valid,
          requestId: "req-empty",
          model: AZOOKEY_ZENZ_SMALL_MODEL,
          leftContext: "子供がお菓子を食べています。",
        }),
      ),
      {
        timeoutMs: 250,
        converter: (text) => `dict:${text}`,
        modelRoutes: {
          [AZOOKEY_ZENZ_SMALL_MODEL]: { baseUrl: "https://zenz.example" },
        },
        fetcher: () => new Response(JSON.stringify({ content: "   " }), { status: 200 }),
      },
    );
    spy.mockRestore();
    const zenzLogs = lines
      .map((line) => parseAzookeyTimingLog(line))
      .filter((entry) => entry?.phase === "zenz_http");
    expect(zenzLogs[0]?.zenzHttpReason).toBe("ok");
    expect(zenzLogs[1]?.zenzHttpReason).toBe("timeout");
    expect(zenzLogs[2]?.zenzHttpReason).toBe("fetch");
    expect(zenzLogs[3]?.zenzHttpReason).toBe("empty");
    expect(zenzLogs[0] && "prompt" in zenzLogs[0]).toBe(false);
    expect(zenzLogs[0] && "content" in zenzLogs[0]).toBe(false);
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "zenz_http",
          elapsedMs: 1,
          inputChars: 0,
          nBest: 64,
          cacheHit: false,
          wsOrHttp: "ws",
          zenzHttpReason: "ok",
        }),
      )?.zenzHttpReason,
    ).toBe("ok");
    expect(
      parseAzookeyTimingLog(
        JSON.stringify({
          event: "azookey_timing",
          phase: "zenz_http",
          elapsedMs: 1,
          inputChars: 0,
          nBest: 64,
          cacheHit: false,
          wsOrHttp: "ws",
          zenzHttpReason: "nope",
        }),
      ),
    ).toBeUndefined();
  });

  it("warms configured Zenz origins with a cheap GET /health and swallows failures", async () => {
    const fetcher = vi.fn((input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toBe("https://zenz.example/health");
      return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    });
    await warmZenzUpstreams(
      {
        "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.example" },
        "zenz-v3.2-xsmall-gguf": { baseUrl: "https://zenz.example" },
      },
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://zenz.example/health",
      expect.objectContaining({
        method: "GET",
        headers: { "user-agent": AZOOKEY_ZENZ_UPSTREAM_USER_AGENT },
      }),
    );
    const failing = vi.fn(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      warmZenzUpstreams({ "zenz-v3.2-small-gguf": { baseUrl: "https://down.example" } }, failing),
    ).resolves.toBeUndefined();
    expect(AZOOKEY_ZENZ_HEALTH_PATH).toBe("/health");
  });

  it("falls back when a configured Zenzai upstream returns oversized output", async () => {
    const oversized = "あ".repeat(AZOOKEY_MAX_TEXT_BYTES + 1);
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ content: oversized }), { status: 200 }),
    );
    const message = parseAzookeyMessage(
      JSON.stringify({
        ...valid,
        model: AZOOKEY_ZENZ_XSMALL_MODEL,
        leftContext: "子供がお菓子を食べています。",
      }),
    );
    const result = await convertAzookeyMessage(message, {
      timeoutMs: 250,
      converter: (text) => `dict:${text}`,
      modelRoutes: {
        [AZOOKEY_ZENZ_XSMALL_MODEL]: { baseUrl: "https://zenz.example" },
      },
      fetcher,
    });
    expect(result).toMatchObject({
      convertedText: `dict:${valid.vibratoInput}`,
      modelFallback: AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED,
    });
  });

  it("rejects when the Zenzai deadline is spent before dictionary fallback can run", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ content: "今日は配信です" }), { status: 200 }),
    );
    let calls = 0;
    vi.stubGlobal("performance", {
      now: () => {
        calls += 1;
        return calls <= 2 ? 0 : 10_000;
      },
    });
    const message = parseAzookeyMessage(
      JSON.stringify({ ...valid, model: AZOOKEY_ZENZ_XSMALL_MODEL }),
    );
    await expect(
      convertAzookeyMessage(message, {
        timeoutMs: 250,
        converter: (text) => `dict:${text}`,
        modelRoutes: {
          [AZOOKEY_ZENZ_XSMALL_MODEL]: { baseUrl: "https://zenz.example" },
        },
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "conversion_timeout", requestId: "req-1" });
    vi.unstubAllGlobals();
  });

  it("rounds measured conversion time to integer elapsedMs and never reports 0", async () => {
    expect(elapsedMsFromDuration(0)).toBe(1);
    expect(elapsedMsFromDuration(0.4)).toBe(1);
    expect(elapsedMsFromDuration(1.4)).toBe(1);
    expect(elapsedMsFromDuration(1.5)).toBe(2);
    expect(elapsedMsFromDuration(12.6)).toBe(13);
    expect(elapsedMsFromDuration(Number.NaN)).toBe(1);
    expect(elapsedMsFromDuration(Number.POSITIVE_INFINITY)).toBe(1);
    expect(elapsedMsFromDuration(-3)).toBe(1);

    vi.stubGlobal("performance", { now: vi.fn(() => 10) });
    const zeroDuration = await convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
      timeoutMs: 250,
      converter: (text) => `converted:${text}`,
    });
    expect(zeroDuration.elapsedMs).toBe(AZOOKEY_MIN_ELAPSED_MS);
    expect(Number.isInteger(zeroDuration.elapsedMs)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("runs a configured Worker Vibrato stage before AzooKey", async () => {
    const calls: string[] = [];
    const message = parseAzookeyMessage(JSON.stringify({ ...valid, vibratoExecution: "worker" }));
    const result = await convertAzookeyMessage(message, {
      timeoutMs: 250,
      vibrato: (text, language) => {
        calls.push(`vibrato:${language}:${text}`);
        return "きょうははいしんです";
      },
      converter: (text) => {
        calls.push(`azookey:${text}`);
        return "今日は配信です";
      },
    });
    expect(calls).toEqual(["vibrato:ja:きょうははいしんです", "azookey:きょうははいしんです"]);
    expect(result.convertedText).toBe("今日は配信です");
    await expect(
      convertAzookeyMessage(message, { timeoutMs: 250, converter: (text) => text }),
    ).rejects.toMatchObject({ code: "vibrato_unavailable", requestId: "req-1" });
  });

  it("uses an explicit HTTP Vibrato adapter contract without phrase fallbacks", async () => {
    const fetcher = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("https://vibrato.example/v1/convert");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        authorization: "Bearer vibrato-secret",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ text: "漢字混じり", language: "ja" });
      return new Response(JSON.stringify({ text: "かんじまじり" }), { status: 200 });
    });
    const convert = createVibratoHttpConverter(
      {
        VIBRATO_UPSTREAM_URL: "https://vibrato.example/v1/convert",
        VIBRATO_API_TOKEN: " vibrato-secret ",
      },
      fetcher,
    );
    await expect(convert?.("漢字混じり", "ja")).resolves.toBe("かんじまじり");
    await expect(convert?.("きょうははれ", "ja")).resolves.toBe("きょうははれ");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(createVibratoHttpConverter({})).toBeUndefined();
    expect(() =>
      createVibratoHttpConverter({ VIBRATO_UPSTREAM_URL: "file:///tmp/vibrato" }),
    ).toThrow("http://");
    const invalidResponse = createVibratoHttpConverter(
      { VIBRATO_UPSTREAM_URL: "https://vibrato.example" },
      async () => new Response(JSON.stringify({ nope: "not-reading" }), { status: 200 }),
    );
    await expect(invalidResponse?.("入力", "ja")).rejects.toThrow("no non-empty text");
  });

  it("aborts the HTTP Vibrato upstream when the conversion deadline expires", async () => {
    let seenSignal: AbortSignal | undefined;
    const upstream = vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seenSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const convert = createVibratoHttpConverter(
      { VIBRATO_UPSTREAM_URL: "https://vibrato.example/v1/convert" },
      upstream as unknown as typeof fetch,
    );
    expect(convert).toBeDefined();
    await expect(
      convertAzookeyMessage(
        parseAzookeyMessage(
          JSON.stringify({
            ...valid,
            sourceText: "今日は配信です",
            vibratoInput: "今日は配信です",
            vibratoExecution: "worker",
          }),
        ),
        {
          timeoutMs: 25,
          vibrato: convert as Exclude<typeof convert, undefined>,
          converter: (text) => text,
        },
      ),
    ).rejects.toMatchObject({ code: "vibrato_timeout", requestId: "req-1" });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("rejects an oversized HTTP Vibrato response before parsing it", async () => {
    const oversized = "あ".repeat(VIBRATO_MAX_RESPONSE_BYTES + 1);
    const fetcher = vi.fn(async () => new Response(oversized, { status: 200 }));
    const convert = createVibratoHttpConverter(
      { VIBRATO_UPSTREAM_URL: "https://vibrato.example/v1/convert" },
      fetcher,
    );
    await expect(convert?.("入力", "ja")).rejects.toThrow("exceeds the byte limit");
  });

  it("enforces the converter output byte limit before building the result", async () => {
    const oversized = "あ".repeat(AZOOKEY_MAX_TEXT_BYTES + 1);
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 250,
        converter: () => oversized,
      }),
    ).rejects.toMatchObject({ code: "conversion_failed", requestId: "req-1" });
  });

  it("rejects the Vibrato stage immediately when its deadline is already spent", async () => {
    vi.stubGlobal("performance", {
      now: vi
        .fn()
        .mockReturnValueOnce(0) // startedAt
        .mockReturnValueOnce(25), // pre-vibrato remaining check (budget spent)
    });
    const vibrato = vi.fn((text: string) => text);
    await expect(
      convertAzookeyMessage(
        parseAzookeyMessage(JSON.stringify({ ...valid, vibratoExecution: "worker" })),
        {
          timeoutMs: 25,
          vibrato,
          converter: (text) => text,
        },
      ),
    ).rejects.toMatchObject({ code: "vibrato_timeout", requestId: "req-1" });
    expect(vibrato).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects immediately when the deadline is already exhausted before conversion", async () => {
    vi.stubGlobal("performance", {
      now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(25),
    });
    const converter = vi.fn((text: string) => text);
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 25,
        converter,
      }),
    ).rejects.toMatchObject({ code: "conversion_timeout", requestId: "req-1" });
    expect(converter).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects the AzooKey stage when the deadline expired during conversion", async () => {
    vi.stubGlobal("performance", {
      now: vi
        .fn()
        .mockReturnValueOnce(0) // startedAt
        .mockReturnValueOnce(0) // pre-vibrato remaining check
        .mockReturnValueOnce(0) // withTimeout vibrato budget
        .mockReturnValueOnce(5) // post-vibrato deadline check (within budget)
        .mockReturnValueOnce(5) // pre-converter remaining check
        .mockReturnValueOnce(20) // withTimeout converter budget (within budget)
        .mockReturnValueOnce(25), // post-converter deadline check (budget exhausted)
    });
    const converter = vi.fn((text: string) => text);
    await expect(
      convertAzookeyMessage(
        parseAzookeyMessage(JSON.stringify({ ...valid, vibratoExecution: "worker" })),
        {
          timeoutMs: 25,
          vibrato: (text) => text,
          converter,
        },
      ),
    ).rejects.toMatchObject({ code: "conversion_timeout", requestId: "req-1" });
    expect(converter).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("rejects before the AzooKey stage runs when its deadline is already spent", async () => {
    vi.stubGlobal("performance", {
      now: vi
        .fn()
        .mockReturnValueOnce(0) // startedAt
        .mockReturnValueOnce(0) // pre-vibrato remaining check
        .mockReturnValueOnce(0) // withTimeout vibrato budget
        .mockReturnValueOnce(20) // post-vibrato deadline check (within budget)
        .mockReturnValueOnce(25), // pre-converter remaining check (budget spent)
    });
    const converter = vi.fn((text: string) => text);
    await expect(
      convertAzookeyMessage(
        parseAzookeyMessage(JSON.stringify({ ...valid, vibratoExecution: "worker" })),
        {
          timeoutMs: 25,
          vibrato: (text) => text,
          converter,
        },
      ),
    ).rejects.toMatchObject({ code: "conversion_timeout", requestId: "req-1" });
    expect(converter).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("shares one absolute deadline: vibrato exhaustion skips the AzooKey stage", async () => {
    vi.stubGlobal("performance", {
      now: vi
        .fn()
        .mockReturnValueOnce(0) // startedAt
        .mockReturnValueOnce(0) // pre-vibrato remaining check
        .mockReturnValueOnce(0) // withTimeout vibrato budget
        .mockReturnValueOnce(25), // post-vibrato deadline check (budget exhausted)
    });
    const converter = vi.fn((text: string) => text);
    await expect(
      convertAzookeyMessage(
        parseAzookeyMessage(JSON.stringify({ ...valid, vibratoExecution: "worker" })),
        {
          timeoutMs: 25,
          vibrato: (text) => text,
          converter,
        },
      ),
    ).rejects.toMatchObject({ code: "vibrato_timeout", requestId: "req-1" });
    expect(converter).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("maps converter failures, non-string output, and elapsed timeout to protocol errors", async () => {
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 250,
        converter: () => {
          throw new Error("converter failed");
        },
      }),
    ).rejects.toMatchObject({ code: "conversion_failed", requestId: "req-1" });
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 250,
        converter: () => 42 as unknown as string,
      }),
    ).rejects.toMatchObject({ code: "conversion_failed", requestId: "req-1" });

    vi.stubGlobal("performance", { now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(500) });
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 250,
        converter: () => "遅い",
      }),
    ).rejects.toMatchObject({ code: "conversion_timeout", requestId: "req-1" });
    vi.unstubAllGlobals();

    vi.stubGlobal("performance", undefined);
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 250,
        converter: () => "performance fallback",
      }),
    ).resolves.toMatchObject({ convertedText: "performance fallback" });
    vi.unstubAllGlobals();
  });

  it("uses the raw Wasm ABI converter and rejects malformed modules", () => {
    const bytes = readFileSync(new URL("../wasm/azookey.wasm", import.meta.url));
    const converter = createWasmConverter(new WebAssembly.Module(bytes));
    expect(converter("きょうのてんき")).toBe("今日の天気");
    expect(() =>
      createWasmConverter(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))),
    ).toThrow("required raw ABI");
  });

  it("aborts and retries a dictionary fetch that exceeds its cold-load deadline", async () => {
    const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const converter = createWasmConverter(emptyModule, "/azookey/dictionary.gz", fetcher, 10);

    await expect(converter.warmup?.()).rejects.toThrow("dictionary fetch timed out");
    expect(signal?.aborted).toBe(true);
    await expect(converter.warmup?.()).rejects.toThrow("dictionary fetch timed out");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the dictionary deadline while a response body never finishes", async () => {
    const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    let signal: AbortSignal | undefined;
    const neverEndingBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const converter = createWasmConverter(
      emptyModule,
      "/azookey/dictionary.gz",
      (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Response(neverEndingBody);
      },
      10,
    );

    await expect(converter.warmup?.()).rejects.toThrow("dictionary fetch timed out");
    expect(signal?.aborted).toBe(true);
  });

  it("reports a bounded dictionary warmup failure as converter unavailability", async () => {
    const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const response = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      { AZOOKEY_DICTIONARY_URL: "/azookey/dictionary.gz" },
      {
        wasmModule: emptyModule,
        dictionaryTimeoutMs: 10,
        azookeyDictionaryFetcher: () => new Promise<Response>(() => undefined),
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "converter_unavailable",
        message: "AzooKey converter or dictionary is unavailable",
      },
    });
  });

  it("closes both WebSocket endpoints when warmup fails before upgrade", async () => {
    const client = new FakeSocket();
    const server = new FakeSocket();
    const socketPair = vi.fn(() => ({
      client: client as unknown as WebSocket,
      server: server as unknown as WebSocket,
    }));
    const converter = Object.assign((text: string) => text, {
      warmup: vi.fn(async () => undefined),
    });
    const vibratoConverter = Object.assign((text: string) => text, {
      warmup: vi.fn(() => Promise.reject(new Error("dictionary offline"))),
    });

    const response = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      {},
      { converter, vibratoConverter, socketPair },
    );

    expect(response.status).toBe(503);
    expect(socketPair).toHaveBeenCalledOnce();
    expect(server.accepted).toBe(false);
    expect(server.closed).toBe(true);
    expect(client.closed).toBe(true);
  });

  it("rejects a Wasm module that only exposes the 1-best convert export", () => {
    const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const memory = new WebAssembly.Memory({ initial: 1 });
    const instance = vi.spyOn(WebAssembly, "Instance");
    try {
      instance.mockImplementation(
        () =>
          ({
            exports: {
              memory,
              azookey_alloc: vi.fn(() => 8),
              azookey_dealloc: vi.fn(),
              azookey_convert: vi.fn(() => 1n),
              azookey_abi_version: vi.fn(() => 2),
            },
          }) as unknown as WebAssembly.Instance,
      );
      expect(() => createWasmConverter(emptyModule)).toThrow("required raw ABI");
    } finally {
      instance.mockRestore();
    }
  });

  it("guards raw Wasm allocation before n-best conversion", () => {
    const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const memory = new WebAssembly.Memory({ initial: 1 });
    const instance = vi.spyOn(WebAssembly, "Instance");
    const dealloc = vi.fn();
    const alloc = vi.fn(() => 8);
    const nBest = vi.fn(() => 0n);
    instance.mockImplementation(
      () =>
        ({
          exports: {
            memory,
            azookey_alloc: alloc,
            azookey_dealloc: dealloc,
            azookey_convert: vi.fn(() => 0n),
            azookey_convert_n_best: nBest,
            azookey_abi_version: vi.fn(() => 2),
          },
        }) as unknown as WebAssembly.Instance,
    );
    const converter = createWasmConverter(emptyModule);
    alloc.mockReturnValueOnce(0);
    expect(() => converter("入力")).toThrow("input allocation failed");
    expect(() => converter("入力")).toThrow("n-best conversion allocation failed");
    expect(dealloc).toHaveBeenCalled();
    instance.mockRestore();
  });

  it("validates the n-best Wasm record before exposing context metadata", () => {
    const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const memory = new WebAssembly.Memory({ initial: 1 });
    const instance = vi.spyOn(WebAssembly, "Instance");
    const dealloc = vi.fn();
    const alloc = vi.fn(() => 8);
    const nBest =
      vi.fn<
        (
          _pointer: number,
          _length: number,
          _nBest: number,
          _hasPreceding: number,
          _rcid: number,
          _mid: number,
        ) => bigint | number
      >();
    const packed = (pointer: number, length: number): bigint =>
      (BigInt(pointer) << 32n) | BigInt(length);
    const view = new DataView(memory.buffer);
    const clearOutput = (): void => {
      new Uint8Array(memory.buffer, 32, 128).fill(0);
    };
    const writeHeader = (status: number, count: number): void => {
      clearOutput();
      view.setUint32(32, status, true);
      view.setUint32(36, count, true);
    };
    const writeCandidate = (
      options: { score?: number; trailing?: number; append?: number } = {},
    ): number => {
      const text = new TextEncoder().encode("候補");
      let offset = 40;
      view.setUint32(offset, text.byteLength, true);
      offset += 4;
      new Uint8Array(memory.buffer, offset, text.byteLength).set(text);
      offset += text.byteLength;
      view.setFloat32(offset, options.score ?? -1.5, true);
      offset += 4;
      new Uint8Array(memory.buffer)[offset] = options.trailing ?? 1;
      offset += 1;
      view.setUint16(offset, 61, true);
      offset += 2;
      view.setUint16(offset, 67, true);
      offset += 2;
      return offset - 32 + (options.append ?? 0);
    };
    instance.mockImplementation(
      () =>
        ({
          exports: {
            memory,
            azookey_alloc: alloc,
            azookey_dealloc: dealloc,
            azookey_convert: vi.fn(() => 0n),
            azookey_convert_n_best: nBest,
            azookey_abi_version: vi.fn(() => 2),
          },
        }) as unknown as WebAssembly.Instance,
    );
    try {
      const converter = createWasmConverter(emptyModule);
      const convertWithContext = converter.convertWithContext;
      if (!convertWithContext) {
        throw new Error("context-aware converter was not installed");
      }

      nBest.mockReturnValue(packed(0, 2));
      expect(() => convertWithContext("入力")).toThrow("null n-best output pointer");
      nBest.mockReturnValue(packed(memory.buffer.byteLength, 1));
      expect(() => convertWithContext("入力")).toThrow("invalid n-best output range");
      nBest.mockReturnValue(packed(32, 7));
      expect(() => convertWithContext("入力")).toThrow("truncated n-best header");

      writeHeader(0, 0);
      nBest.mockReturnValue(packed(32, 8));
      expect(() => convertWithContext("入力")).toThrow("invalid n-best count");
      writeHeader(0, 65);
      expect(() => convertWithContext("入力")).toThrow("invalid n-best count");

      writeHeader(0, 1);
      nBest.mockReturnValue(packed(32, 8));
      expect(() => convertWithContext("入力")).toThrow("truncated n-best text length");
      writeHeader(0, 1);
      view.setUint32(40, 1, true);
      nBest.mockReturnValue(packed(32, 12));
      expect(() => convertWithContext("入力")).toThrow("truncated n-best candidate");

      writeHeader(0, 1);
      view.setUint32(40, 0, true);
      view.setFloat32(44, Number.NaN, true);
      nBest.mockReturnValue(packed(32, 21));
      expect(() => convertWithContext("入力")).toThrow("non-finite n-best score");

      writeHeader(0, 1);
      const invalidTrailingLength = writeCandidate({ trailing: 2 });
      nBest.mockReturnValue(packed(32, invalidTrailingLength));
      expect(() => convertWithContext("入力")).toThrow("invalid trailing flag");

      writeHeader(0, 1);
      const extraRecordLength = writeCandidate({ trailing: 0, append: 1 });
      nBest.mockReturnValue(packed(32, extraRecordLength));
      expect(() => convertWithContext("入力")).toThrow("invalid n-best record");

      writeHeader(1, 1);
      const validLength = writeCandidate();
      nBest.mockReturnValue(packed(32, validLength));
      expect(convertWithContext("入力", undefined, { rcid: 5, mid: 7 })).toMatchObject({
        text: "候補",
        status: 1,
        trailing: { rcid: 61, mid: 67 },
      });
      nBest.mockReturnValue(0n);
      expect(() => convertWithContext("入力")).toThrow("n-best conversion allocation failed");
      expect(dealloc).toHaveBeenCalled();
    } finally {
      instance.mockRestore();
    }
  });

  it("rejects a Wasm module whose ABI version mismatches even without a dictionary", () => {
    const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const memory = new WebAssembly.Memory({ initial: 1 });
    const instance = vi.spyOn(WebAssembly, "Instance");
    try {
      instance.mockImplementation(
        () =>
          ({
            exports: {
              memory,
              azookey_alloc: vi.fn(() => 8),
              azookey_dealloc: vi.fn(),
              azookey_convert: vi.fn(() => 1n),
              azookey_convert_n_best: vi.fn(() => 1n),
              azookey_abi_version: vi.fn(() => 99),
            },
          }) as unknown as WebAssembly.Instance,
      );
      expect(() => createWasmConverter(emptyModule)).toThrow("ABI version mismatch");
    } finally {
      instance.mockRestore();
    }
  });

  it("authenticates browser frames and keeps malformed frames on the socket", async () => {
    const socket = new FakeSocket();
    attachAzookeySocket(socket as unknown as WebSocket, {
      timeoutMs: 250,
      expectedToken: "secret",
      converter: (text) => `converted:${text}`,
    });
    socket.emit(JSON.stringify({ ...valid, auth: { scheme: "bearer", token: "wrong" } }));
    await Promise.resolve();
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.error",
      requestId: "req-1",
      error: { code: "unauthorized" },
    });

    socket.emit(JSON.stringify({ ...valid, requestId: "req-2" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.result",
      requestId: "req-2",
      convertedText: "converted:きょうははいしんです",
    });

    socket.emit(JSON.stringify({ ...valid, requestId: "req-3", auth: undefined }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.result",
      requestId: "req-3",
      convertedText: "converted:きょうははいしんです",
    });

    socket.emit(JSON.stringify({ type: "azookey.convert", requestId: "bad" }));
    await Promise.resolve();
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.error",
      requestId: "bad",
      error: { code: "invalid_contract" },
    });
  });

  it("keeps context per WebSocket and clears it when the connection closes", async () => {
    const precedingCalls: Array<AzookeyConnectionState["preceding"]> = [];
    const converter = ((
      text: string,
      _signal: AbortSignal | undefined,
      preceding: AzookeyConnectionState["preceding"],
    ) => {
      precedingCalls.push(preceding);
      return {
        text,
        status: 0,
        trailing: { rcid: 11, mid: 13 },
        dictionaryRevision: "rev-a",
      };
    }) as unknown as AzookeyConverter;
    converter.dictionaryRevision = "rev-a";
    const firstSocket = new FakeSocket();
    attachAzookeySocket(firstSocket as unknown as WebSocket, { timeoutMs: 250, converter });
    firstSocket.emit(JSON.stringify({ ...valid, utteranceId: "capture-1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstSocket.emit(JSON.stringify({ ...valid, requestId: "req-2", utteranceId: "capture-1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(precedingCalls).toEqual([undefined, { rcid: 11, mid: 13 }]);

    firstSocket.emitClose();
    const sentBeforeClosedFrame = firstSocket.sent.length;
    firstSocket.emit(JSON.stringify({ ...valid, requestId: "ignored-after-close" }));
    expect(firstSocket.sent).toHaveLength(sentBeforeClosedFrame);
    const secondSocket = new FakeSocket();
    attachAzookeySocket(secondSocket as unknown as WebSocket, { timeoutMs: 250, converter });
    secondSocket.emit(JSON.stringify({ ...valid, requestId: "req-3", utteranceId: "capture-1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(precedingCalls).toEqual([undefined, { rcid: 11, mid: 13 }, undefined]);
  });

  it("clears state after a conversion finishes on a closed socket", async () => {
    let resolveConversion:
      | ((value: { text: string; status: number; trailing: { rcid: number; mid: number } }) => void)
      | undefined;
    const socket = new FakeSocket();
    const converter = (() =>
      new Promise((resolve) => {
        resolveConversion = resolve;
      })) as unknown as AzookeyConverter;
    attachAzookeySocket(socket as unknown as WebSocket, { timeoutMs: 250, converter });
    socket.emit(JSON.stringify({ ...valid, utteranceId: "capture-1" }));
    await Promise.resolve();
    socket.emitClose();
    resolveConversion?.({ text: "完了", status: 0, trailing: { rcid: 79, mid: 83 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.sent.some((value) => value.includes('"convertedText":"完了"'))).toBe(true);
  });

  it("maps an unexpected response-send failure to a protocol error", async () => {
    class FlakySocket extends FakeSocket {
      private sendCount = 0;

      override send(value: string): void {
        this.sendCount += 1;
        if (this.sendCount === 1) {
          throw new Error("send failed");
        }
        super.send(value);
      }
    }
    const socket = new FlakySocket();
    attachAzookeySocket(socket as unknown as WebSocket, {
      timeoutMs: 250,
      converter: (text) => `converted:${text}`,
    });
    socket.emit(JSON.stringify(valid));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.error",
      requestId: "req-1",
      error: { code: "conversion_failed", message: "AzooKey conversion failed" },
    });
  });

  it("forwards a converter protocol error through the socket error envelope", async () => {
    const socket = new FakeSocket();
    attachAzookeySocket(socket as unknown as WebSocket, {
      timeoutMs: 250,
      converter: () => {
        throw new Error("converter exploded");
      },
    });
    socket.emit(JSON.stringify(valid));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.error",
      requestId: "req-1",
      error: { code: "conversion_failed" },
    });
  });

  it("rejects binary and oversized frames, and returns busy while a conversion is pending", async () => {
    let resolveConversion: ((value: string) => void) | undefined;
    const socket = new FakeSocket();
    attachAzookeySocket(socket as unknown as WebSocket, {
      timeoutMs: 250,
      converter: () =>
        new Promise((resolve) => {
          resolveConversion = resolve;
        }),
    });
    socket.emit(new Uint8Array([1, 2]));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      error: { code: "binary_message_not_supported" },
    });
    socket.emit("x".repeat(AZOOKEY_MAX_MESSAGE_BYTES + 1));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      error: { code: "message_too_large" },
    });
    socket.emit(JSON.stringify(valid));
    await Promise.resolve();
    socket.emit(JSON.stringify({ ...valid, requestId: "busy" }));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      requestId: "busy",
      error: { code: "busy" },
    });
    if (resolveConversion === undefined) {
      throw new Error("converter was not invoked");
    }
    resolveConversion("変換結果");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      requestId: "req-1",
      convertedText: "変換結果",
    });
  });

  it("answers azookey.ping with azookey.pong without converting or holding the lock", async () => {
    let resolveConversion: ((value: string) => void) | undefined;
    let convertCalls = 0;
    const socket = new FakeSocket();
    attachAzookeySocket(socket as unknown as WebSocket, {
      timeoutMs: 250,
      converter: () => {
        convertCalls += 1;
        return new Promise((resolve) => {
          resolveConversion = resolve;
        });
      },
    });
    socket.emit('{"type":"azookey.ping"}');
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toStrictEqual({ type: "azookey.pong" });
    expect(convertCalls).toBe(0);

    socket.emit(JSON.stringify({ ...valid, requestId: "req-lock" }));
    await Promise.resolve();
    expect(convertCalls).toBe(1);

    socket.emit(JSON.stringify({ type: "azookey.ping", requestId: "pin-1" }));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toStrictEqual({
      type: "azookey.pong",
      requestId: "pin-1",
    });
    expect(convertCalls).toBe(1);

    socket.emit(JSON.stringify({ type: "azookey.ping", requestId: 7 }));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toStrictEqual({ type: "azookey.pong" });

    socket.emit(JSON.stringify({ ...valid, requestId: "req-busy" }));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      requestId: "req-busy",
      error: { code: "busy" },
    });

    if (resolveConversion === undefined) {
      throw new Error("converter was not invoked");
    }
    resolveConversion("変換結果");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      requestId: "req-lock",
      convertedText: "変換結果",
    });
  });

  it("maps a slow converter to a bounded timeout error", async () => {
    const runtime: AzookeyRuntime = {
      timeoutMs: 25,
      converter: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "late";
      },
    };
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), runtime),
    ).rejects.toMatchObject({ code: "conversion_timeout", requestId: "req-1" });
  });

  it("trusts service-binding upgrades without bearer and rejects a wrong Authorization", async () => {
    expect(
      isPublicInferenceRequest(
        new Request(`https://${INFERENCE_PUBLIC_HOST}/ws/azookey`, {
          headers: { upgrade: "websocket" },
        }),
      ),
    ).toBe(true);
    expect(
      isPublicInferenceRequest(
        new Request("https://azookey-compare.kaoru.workers.dev/ws/azookey", {
          headers: { upgrade: "websocket" },
        }),
      ),
    ).toBe(false);
    const brokenUrl = {
      get url() {
        throw new Error("unreadable url");
      },
    } as unknown as Request;
    expect(isPublicInferenceRequest(brokenUrl)).toBe(false);
    expect(
      resolveAzookeyHandshakeAuthorization({
        expectedToken: "secret",
        hasAuthorizationHeader: false,
        tokenMatches: false,
        publicInferenceHost: false,
      }),
    ).toEqual({ handshakeAuthorized: true, unauthorized: false });
    expect(
      resolveAzookeyHandshakeAuthorization({
        expectedToken: "secret",
        hasAuthorizationHeader: false,
        tokenMatches: false,
        publicInferenceHost: true,
      }),
    ).toEqual({ handshakeAuthorized: false, unauthorized: false });
    expect(
      resolveAzookeyHandshakeAuthorization({
        expectedToken: "secret",
        hasAuthorizationHeader: true,
        tokenMatches: false,
        publicInferenceHost: false,
      }),
    ).toEqual({ handshakeAuthorized: false, unauthorized: true });
    expect(
      resolveAzookeyHandshakeAuthorization({
        expectedToken: undefined,
        hasAuthorizationHeader: false,
        tokenMatches: false,
        publicInferenceHost: true,
      }),
    ).toEqual({ handshakeAuthorized: false, unauthorized: false });
    expect(
      resolveAzookeyHandshakeAuthorization({
        expectedToken: "secret",
        hasAuthorizationHeader: true,
        tokenMatches: true,
        publicInferenceHost: true,
      }),
    ).toEqual({ handshakeAuthorized: true, unauthorized: false });

    const bindingUnauthorized = await openAzookeySocket(
      new Request("https://azookey-compare.kaoru.workers.dev/ws/azookey", {
        headers: { upgrade: "websocket", authorization: "Bearer wrong" },
      }),
      { AZOOKEY_API_TOKEN: "secret" },
    );
    expect(bindingUnauthorized.status).toBe(401);
    const publicUnauthorized = await openAzookeySocket(
      new Request(`https://${INFERENCE_PUBLIC_HOST}/ws/azookey`, {
        headers: { upgrade: "websocket", authorization: "Bearer wrong" },
      }),
      { AZOOKEY_API_TOKEN: "secret" },
    );
    expect(publicUnauthorized.status).toBe(401);

    const bindingServer = new FakeSocket();
    const bindingUpgrade = await openAzookeySocket(
      new Request("https://azookey-compare.kaoru.workers.dev/ws/azookey", {
        headers: { upgrade: "websocket" },
      }),
      { AZOOKEY_API_TOKEN: "secret" },
      {
        converter: (text) => `converted:${text}`,
        socketPair: () =>
          ({ client: {} as WebSocket, server: bindingServer }) as unknown as {
            client: WebSocket;
            server: WebSocket;
          },
      },
    );
    expect(bindingUpgrade.status).toBe(101);
    bindingServer.emit(JSON.stringify({ ...valid, auth: undefined, requestId: "bind-1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(bindingServer.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.result",
      requestId: "bind-1",
      convertedText: "converted:きょうははいしんです",
    });

    const publicServer = new FakeSocket();
    const publicUpgrade = await openAzookeySocket(
      new Request(`https://${INFERENCE_PUBLIC_HOST}/ws/azookey`, {
        headers: { upgrade: "websocket" },
      }),
      { AZOOKEY_API_TOKEN: "secret" },
      {
        converter: (text) => `converted:${text}`,
        socketPair: () =>
          ({ client: {} as WebSocket, server: publicServer }) as unknown as {
            client: WebSocket;
            server: WebSocket;
          },
      },
    );
    expect(publicUpgrade.status).toBe(101);
    publicServer.emit(JSON.stringify({ ...valid, auth: undefined, requestId: "pub-1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(publicServer.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.error",
      requestId: "pub-1",
      error: { code: "unauthorized" },
    });
  });

  it("allows an unauthenticated local socket when no secret is configured", async () => {
    const server = new FakeSocket();
    const client = {} as WebSocket;
    const response = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", {
        headers: { upgrade: "websocket" },
      }),
      {},
      {
        converter: (text) => `converted:${text}`,
        socketPair: () =>
          ({ client, server }) as unknown as {
            client: WebSocket;
            server: WebSocket;
          },
      },
    );
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(client);
    expect(server.accepted).toBe(true);
    expect(JSON.parse(server.sent[0] ?? "{}")).toMatchObject({
      type: "azookey.ready",
      protocol: "azookey.text.v1",
    });

    server.emit(JSON.stringify({ ...valid, auth: undefined }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(server.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.result",
      requestId: "req-1",
      convertedText: "converted:きょうははいしんです",
    });
  });

  it("advertises Zenzai from ready only when MODEL_ROUTES has a GGUF baseUrl", async () => {
    const configuredServer = new FakeSocket();
    const configuredResponse = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", {
        headers: { upgrade: "websocket" },
      }),
      {
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.example" },
        }),
      },
      {
        converter: (text) => `converted:${text}`,
        fetcher: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
        socketPair: () =>
          ({
            client: {},
            server: configuredServer,
          }) as unknown as {
            client: WebSocket;
            server: WebSocket;
          },
      },
    );
    expect(configuredResponse.status).toBe(101);
    expect(JSON.parse(configuredServer.sent[0] ?? "{}")).toMatchObject({
      type: "azookey.ready",
      models: ["azookey-rust-wasm", "zenz-v3.2-small-gguf"],
    });

    const emptyServer = new FakeSocket();
    const emptyResponse = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", {
        headers: { upgrade: "websocket" },
      }),
      {
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-small-gguf": { baseUrl: "   " },
        }),
      },
      {
        converter: (text) => `converted:${text}`,
        socketPair: () =>
          ({
            client: {},
            server: emptyServer,
          }) as unknown as {
            client: WebSocket;
            server: WebSocket;
          },
      },
    );
    expect(emptyResponse.status).toBe(101);
    expect(JSON.parse(emptyServer.sent[0] ?? "{}")).toMatchObject({
      type: "azookey.ready",
      models: ["azookey-rust-wasm"],
    });
  });

  it("starts a Zenz /health warmup on WebSocket upgrade without blocking ready", async () => {
    const server = new FakeSocket();
    const healthUrls: string[] = [];
    const fetcher = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      healthUrls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    };
    const response = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", {
        headers: { upgrade: "websocket" },
      }),
      {
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.example" },
        }),
      },
      {
        converter: (text) => `converted:${text}`,
        fetcher,
        socketPair: () =>
          ({
            client: {},
            server,
          }) as unknown as {
            client: WebSocket;
            server: WebSocket;
          },
      },
    );
    expect(response.status).toBe(101);
    expect(JSON.parse(server.sent[0] ?? "{}")).toMatchObject({
      type: "azookey.ready",
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(healthUrls).toStrictEqual(["https://zenz.example/health"]);
  });

  it("validates WebSocket upgrades, native bearer headers, and converter availability", async () => {
    expect(isWebSocketUpgrade(new Request("https://worker.example"))).toBe(false);
    expect(
      isWebSocketUpgrade(
        new Request("https://worker.example", { headers: { upgrade: "WebSocket" } }),
      ),
    ).toBe(true);
    await expect(bearerTokenMatches(new Request("https://worker.example"), "secret")).resolves.toBe(
      false,
    );
    await expect(
      bearerTokenMatches(
        new Request("https://worker.example", { headers: { authorization: "Basic secret" } }),
        "secret",
      ),
    ).resolves.toBe(false);
    await expect(
      bearerTokenMatches(
        new Request("https://worker.example", { headers: { authorization: "Bearer secret" } }),
        "secret",
      ),
    ).resolves.toBe(true);
    await expect(
      bearerTokenMatches(
        new Request("https://worker.example", { headers: { authorization: "Bearer wrong" } }),
        "secret",
      ),
    ).resolves.toBe(false);
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        subtle: {
          digest: vi
            .fn()
            .mockResolvedValueOnce(new Uint8Array([1]).buffer)
            .mockResolvedValueOnce(new Uint8Array([1, 2]).buffer),
        },
      },
    });
    await expect(
      bearerTokenMatches(
        new Request("https://worker.example", { headers: { authorization: "Bearer secret" } }),
        "secret",
      ),
    ).resolves.toBe(false);
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });

    const notUpgrade = await openAzookeySocket(new Request("https://worker.example"), {});
    expect(notUpgrade.status).toBe(426);
    const wrongMethod = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", {
        method: "POST",
        headers: { upgrade: "websocket" },
      }),
      {},
    );
    expect(wrongMethod.status).toBe(405);
    const unauthorized = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", {
        headers: { upgrade: "websocket", authorization: "Bearer wrong" },
      }),
      { AZOOKEY_API_TOKEN: "secret" },
    );
    expect(unauthorized.status).toBe(401);
    const unavailable = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      {},
    );
    expect(unavailable.status).toBe(503);

    class FakeWebSocketPair {
      readonly 0 = {} as WebSocket;
      readonly 1 = new FakeSocket() as unknown as WebSocket;
    }
    Object.defineProperty(globalThis, "WebSocketPair", {
      configurable: true,
      value: FakeWebSocketPair,
    });
    const pairResponse = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      {},
      { converter: (text) => text },
    );
    expect(pairResponse.status).toBe(101);
    const wasmBytes = readFileSync(new URL("../wasm/azookey.wasm", import.meta.url));
    const wasmPairResponse = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      {},
      {
        wasmModule: new WebAssembly.Module(wasmBytes),
        socketPair: () =>
          ({ client: {} as WebSocket, server: new FakeSocket() as unknown as WebSocket }) as {
            client: WebSocket;
            server: WebSocket;
          },
      },
    );
    expect(wasmPairResponse.status).toBe(101);
    vi.unstubAllGlobals();
  });

  it("still upgrades when an injected socket close throws during warmup failure", async () => {
    const throwingClose = {
      close: () => {
        throw new Error("close rejected");
      },
    } as unknown as WebSocket;
    const response = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      { AZOOKEY_DICTIONARY_URL: "/azookey/system.azkdict.gz" },
      {
        converter: Object.assign((text: string) => text, {
          warmup: () => Promise.reject(new Error("dictionary unavailable")),
        }) as AzookeyConverter,
        socketPair: () => ({ client: throwingClose, server: throwingClose }),
      },
    );
    expect(response.status).toBe(503);
  });
});

/**
 * Approach D: when clients request zenz-v3.2-xsmall-gguf but MODEL_ROUTES is
 * empty or the upstream fails, the Worker falls back to portable WASM and
 * advertises model=azookey-rust-wasm + modelFallback. These cases assert both
 * the routing metadata and the conversion surfaces for the reported xsmall
 * regressions (precipitation-percent garble and dual あつい homophones).
 *
 * Real zenz GGUF is not exercised here — local llama-server is optional and
 * transport failures must remain visible as modelFallback, never as a
 * silent "model output".
 */
describe("xsmall request fallback quality regressions", () => {
  const portableWasmBytes = readFileSync(new URL("../wasm/azookey.wasm", import.meta.url));
  const portableDictionaryGzip = readFileSync(
    new URL("../public/azookey/system.azkdict.gz", import.meta.url),
  );
  const responseBody = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit;

  const loadPortableConverter = async () => {
    const module = new WebAssembly.Module(portableWasmBytes);
    const fetcher = vi.fn(
      async () =>
        new Response(responseBody(portableDictionaryGzip), {
          status: 200,
          headers: { "content-length": String(portableDictionaryGzip.byteLength) },
        }),
    );
    const converter = createWasmConverter(module, "/azookey/system.azkdict.gz", fetcher);
    await converter.warmup?.();
    return converter;
  };

  it("forwards openLattice through the lazy dictionary wrapper", async () => {
    const converter = await loadPortableConverter();
    const lattice = converter.openLattice?.("かんじ");
    expect(lattice).toBeDefined();
    const unconstrained = lattice?.searchOutputPrefix(new Uint8Array());
    expect(typeof unconstrained).toBe("string");
    expect((unconstrained ?? "").length).toBeGreaterThan(0);
    lattice?.close();
    lattice?.close();
    expect(lattice?.searchOutputPrefix(new Uint8Array())).toBeUndefined();
  });

  const convertXsmall = (
    vibratoInput: string,
    runtime: Pick<AzookeyRuntime, "converter" | "modelRoutes" | "fetcher" | "timeoutMs">,
  ) => {
    const message = parseAzookeyMessage(
      JSON.stringify({
        type: "azookey.convert",
        requestId: "xsmall-quality",
        source: "web-speech",
        language: "ja",
        sourceText: vibratoInput,
        vibratoInput,
        mode: "worker-vibrato",
        model: AZOOKEY_ZENZ_XSMALL_MODEL,
      }),
    );
    return convertAzookeyMessage(message, {
      timeoutMs: runtime.timeoutMs ?? 5_000,
      converter: runtime.converter,
      ...(runtime.modelRoutes ? { modelRoutes: runtime.modelRoutes } : {}),
      ...(runtime.fetcher ? { fetcher: runtime.fetcher } : {}),
    });
  };

  it("falls back unconfigured-route and keeps dual-あつい weather/food ranking", async () => {
    const converter = await loadPortableConverter();
    const input = "あついひはあついたべものをたべたくない";
    const result = await convertXsmall(input, {
      converter,
      modelRoutes: {},
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      type: "azookey.result",
      model: AZOOKEY_MODEL,
      requestedModel: AZOOKEY_ZENZ_XSMALL_MODEL,
      modelFallback: AZOOKEY_MODEL_FALLBACK_UNCONFIGURED_ROUTE,
      convertedText: "暑い日は熱い食べ物を食べたくない",
    });
    // Homophone regression: weather 暑い then food 熱い — never both 暑い.
    expect(result.convertedText).not.toBe("暑い日は暑い食べ物を食べたくない");
    expect(result.convertedText).not.toMatch(/暑い食べ物/);
  }, 30_000);

  it("falls back unconfigured-route and maps precipitation percent without 蕨/° garble", async () => {
    const converter = await loadPortableConverter();
    // Reported xsmall garble was 6０°蕨 on neural output; portable fallback must
    // map ASR わらび / spoken ぱーせんと after arabic numerals to % without that
    // surface. Full-kana number readings (ろくじゅう…) are azookey-rust numeric
    // segmentation ownership — not asserted here (current portable yields
    // 降水確率張ろ90% for こうすいかくりつはろくじゅうぱーせんと).
    const cases: Array<{ input: string; expected: string }> = [
      {
        input: "こうすいかくりつは60わらび",
        expected: "降水確率は60%",
      },
      {
        input: "こうすいかくりつは60ぱーせんとです",
        expected: "降水確率は60%です",
      },
    ];

    for (const { input, expected } of cases) {
      const result = await convertXsmall(input, {
        converter,
        modelRoutes: {},
        timeoutMs: 5_000,
      });
      expect(result).toMatchObject({
        model: AZOOKEY_MODEL,
        requestedModel: AZOOKEY_ZENZ_XSMALL_MODEL,
        modelFallback: AZOOKEY_MODEL_FALLBACK_UNCONFIGURED_ROUTE,
        convertedText: expected,
      });
      expect(result.convertedText).not.toContain("蕨");
      expect(result.convertedText).not.toMatch(/[°℃]/);
      expect(result.convertedText).not.toMatch(/6０/);
    }
  }, 30_000);

  it("falls back upstream-failed with the same quality surfaces as unconfigured-route", async () => {
    const converter = await loadPortableConverter();
    const fetcher = vi.fn(async () => new Response("upstream offline", { status: 503 }));
    const dual = await convertXsmall("あついひはあついたべものをたべたくない", {
      converter,
      modelRoutes: {
        [AZOOKEY_ZENZ_XSMALL_MODEL]: { baseUrl: "http://127.0.0.1:8081" },
      },
      fetcher,
      timeoutMs: 5_000,
    });
    expect(dual).toMatchObject({
      model: AZOOKEY_ZENZ_XSMALL_MODEL,
      convertedText: "暑い日は熱い食べ物を食べたくない",
    });
    expect(dual.modelFallback).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();

    const percent = await convertXsmall("こうすいかくりつは60わらび", {
      converter,
      modelRoutes: {
        [AZOOKEY_ZENZ_XSMALL_MODEL]: { baseUrl: "http://127.0.0.1:8081" },
      },
      fetcher,
      timeoutMs: 5_000,
    });
    expect(percent).toMatchObject({
      model: AZOOKEY_ZENZ_XSMALL_MODEL,
      convertedText: "降水確率は60%",
    });
    expect(percent.modelFallback).toBeUndefined();
    expect(percent.convertedText).not.toContain("蕨");
    expect(fetcher).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps the dictionary baseline when a configured xsmall request has no left context", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ content: "降水確率は6０°蕨" }), { status: 200 }),
    );
    const result = await convertXsmall("こうすいかくりつは60わらび", {
      converter: (text) => `dict:${text}`,
      modelRoutes: {
        [AZOOKEY_ZENZ_XSMALL_MODEL]: { baseUrl: "https://zenz.example" },
      },
      fetcher,
      timeoutMs: 250,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      model: AZOOKEY_ZENZ_XSMALL_MODEL,
      convertedText: "dict:こうすいかくりつは60わらび",
    });
    expect(result.modelFallback).toBeUndefined();
  });
});
