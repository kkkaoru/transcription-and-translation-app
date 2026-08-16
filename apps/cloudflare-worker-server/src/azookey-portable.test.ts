import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES,
  AZOOKEY_MAX_DICTIONARY_BYTES,
  AZOOKEY_MODE,
  AZOOKEY_MODEL,
  AZOOKEY_MODEL_FALLBACK_UNCONFIGURED_ROUTE,
  AZOOKEY_ZENZ_XSMALL_MODEL,
  type AzookeyWasmExports,
  convertAzookeyMessage,
  createWasmConverter,
  openAzookeySocket,
  parseAzookeyMessage,
} from "./azookey.js";

const wasmBytes = readFileSync(new URL("../wasm/azookey.wasm", import.meta.url));
const dictionaryGzip = readFileSync(
  new URL("../public/azookey/system.azkdict.gz", import.meta.url),
);
const emptyModule = (): WebAssembly.Module =>
  new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const responseBody = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit;
const gzipResponse = (bytes: Uint8Array, headers?: HeadersInit): Response =>
  new Response(responseBody(gzipSync(bytes)), {
    status: 200,
    ...(headers ? { headers } : {}),
  });

const wasmExports = (overrides: Partial<AzookeyWasmExports> = {}): AzookeyWasmExports => ({
  memory: new WebAssembly.Memory({ initial: 2 }),
  azookey_alloc: vi.fn(() => 8),
  azookey_dealloc: vi.fn(),
  azookey_convert: vi.fn(() => 1n),
  azookey_convert_n_best: vi.fn(() => 1n),
  azookey_abi_version: vi.fn(() => 2),
  azookey_dictionary_init_owned: vi.fn(() => 0),
  ...overrides,
});

const mockInstance = (exports: Partial<AzookeyWasmExports>) =>
  vi
    .spyOn(WebAssembly, "Instance")
    .mockImplementation(() => ({ exports }) as unknown as WebAssembly.Instance);

class ReadySocket {
  readonly sent: string[] = [];
  readonly accept = vi.fn();
  readonly addEventListener = vi.fn();

  send(payload: string): void {
    this.sent.push(payload);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("portable official AzooKey dictionary", () => {
  it("loads the real gzip asset once and converts context-sensitive captions", async () => {
    const module = new WebAssembly.Module(wasmBytes);
    const fetcher = vi.fn(
      async () =>
        new Response(responseBody(dictionaryGzip), {
          status: 200,
          headers: { "content-length": String(dictionaryGzip.byteLength) },
        }),
    );
    const first = createWasmConverter(module, "/azookey/system.azkdict.gz", fetcher);
    const second = createWasmConverter(module, "/azookey/system.azkdict.gz", fetcher);

    await Promise.all([first.warmup?.(), second.warmup?.()]);
    for (const [input, expected] of [
      ["きょうのてんきはあつい", "今日の天気は暑い"],
      ["すーぷがあつい", "スープが熱い"],
      ["そとのてんきがあついから", "外の天気が暑いから"],
      ["あついりょうりはおいしい", "熱い料理は美味しい"],
    ] as const) {
      await expect(second(input)).resolves.toBe(expected);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("regresses the established はし lattice on the Worker portable WASM default path", async () => {
    const module = new WebAssembly.Module(wasmBytes);
    const fetcher = vi.fn(
      async () =>
        new Response(responseBody(dictionaryGzip), {
          status: 200,
          headers: { "content-length": String(dictionaryGzip.byteLength) },
        }),
    );
    const convert = createWasmConverter(module, "/azookey/system.azkdict.gz", fetcher);
    await convert.warmup?.();
    await expect(convert("はしのはじからものがおちてます")).resolves.toBe(
      "橋の端から物が落ちてます",
    );
  }, 20_000);

  it("regresses the established あついひなので lattice on the Worker portable WASM default path", async () => {
    const module = new WebAssembly.Module(wasmBytes);
    const fetcher = vi.fn(
      async () =>
        new Response(responseBody(dictionaryGzip), {
          status: 200,
          headers: { "content-length": String(dictionaryGzip.byteLength) },
        }),
    );
    const convert = createWasmConverter(module, "/azookey/system.azkdict.gz", fetcher);
    await convert.warmup?.();
    await expect(convert("あついひなのであついすーぷをのみたくない")).resolves.toBe(
      "暑い日なので熱いスープを飲みたくない",
    );
  }, 20_000);

  it("regresses the established あついひなのに lattice on the Worker portable WASM default path", async () => {
    const module = new WebAssembly.Module(wasmBytes);
    const fetcher = vi.fn(
      async () =>
        new Response(responseBody(dictionaryGzip), {
          status: 200,
          headers: { "content-length": String(dictionaryGzip.byteLength) },
        }),
    );
    const convert = createWasmConverter(module, "/azookey/system.azkdict.gz", fetcher);
    await convert.warmup?.();
    await expect(convert("あついひなのに")).resolves.toBe("暑い日なのに");
  }, 20_000);

  it("converts official-dictionary fixtures through the shipped Worker converter", async () => {
    const module = new WebAssembly.Module(wasmBytes);
    const fetcher = vi.fn(
      async () =>
        new Response(responseBody(dictionaryGzip), {
          status: 200,
          headers: { "content-length": String(dictionaryGzip.byteLength) },
        }),
    );
    const convert = createWasmConverter(module, "/azookey/system.azkdict.gz", fetcher);
    await convert.warmup?.();
    await expect(convert("きょうはいいてんき")).resolves.toBe("今日はいい天気");
    await expect(convert("おつかれさまでした")).resolves.toBe("お疲れ様でした");
    await expect(convert("とても")).resolves.toBe("とても");
    await expect(convert("すーぷは")).resolves.toBe("スープは");
    await expect(convert("きょうのてんきはあつい")).resolves.toBe("今日の天気は暑い");
    await expect(convert("すーぷがあつい")).resolves.toBe("スープが熱い");
    await expect(convert("きょうははいしんです")).resolves.toBe("今日は配信です");
    await expect(convert("あしたのてんきははれ")).resolves.toBe("明日の天気は晴れ");
    await expect(convert("あさってのてんきはあめです")).resolves.toBe("明後日の天気は雨です");
    await expect(convert("しへい、こうか、じゅうえん")).resolves.toBe("紙幣、硬貨、10円");
    await expect(convert("いっとうしょう、けんしょう、おうぼ")).resolves.toBe("一等賞、懸賞、応募");
    await expect(convert("こうぎょう、きかく、とういつ")).resolves.toBe("工業、規格、統一");
  }, 20_000);

  it("normalizes spaced ASR kana then converts きょうはいいてんき on the WS path", async () => {
    const module = new WebAssembly.Module(wasmBytes);
    const fetcher = vi.fn(
      async () =>
        new Response(responseBody(dictionaryGzip), {
          status: 200,
          headers: { "content-length": String(dictionaryGzip.byteLength) },
        }),
    );
    const converter = createWasmConverter(module, "/azookey/system.azkdict.gz", fetcher);
    await converter.warmup?.();
    const result = await convertAzookeyMessage(
      parseAzookeyMessage(
        JSON.stringify({
          type: "azookey.convert",
          requestId: "spaced-kyou",
          source: "web-speech",
          language: "ja",
          sourceText: "きょう は いい てんき",
          vibratoInput: "きょう は いい てんき",
          mode: "worker-vibrato",
        }),
      ),
      { timeoutMs: 15_000, converter },
    );
    expect(result.convertedText).toBe("今日はいい天気");
    expect(result.vibratoInput).toBe("きょうはいいてんき");
  }, 20_000);

  it("retries failed loads and rejects invalid or oversized dictionary responses", async () => {
    const module = new WebAssembly.Module(wasmBytes);
    const retryFetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(responseBody(dictionaryGzip), { status: 200 }));
    const retrying = createWasmConverter(module, "/retry.azkdict.gz", retryFetcher);
    await expect(retrying.warmup?.()).rejects.toThrow("returned 503");
    await expect(retrying.warmup?.()).resolves.toBeUndefined();
    expect(retryFetcher).toHaveBeenCalledTimes(2);

    expect(() => createWasmConverter(module, "file:///dictionary")).toThrow(
      "AZOOKEY_DICTIONARY_URL",
    );
    const tooLargeHeader = createWasmConverter(
      module,
      "/large-header",
      async () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": String(AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES + 1) },
        }),
    );
    await expect(tooLargeHeader.warmup?.()).rejects.toThrow("compressed dictionary exceeds");

    const missingBody = createWasmConverter(
      module,
      "/missing-body",
      async () => new Response(null, { status: 200 }),
    );
    await expect(missingBody.warmup?.()).rejects.toThrow("response has no body");
  }, 20_000);

  it("bounds compressed and expanded streams and rejects malformed gzip", async () => {
    const module = new WebAssembly.Module(wasmBytes);
    const oversizedCompressed = createWasmConverter(
      module,
      "/compressed-limit",
      async () =>
        new Response(responseBody(new Uint8Array(AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES + 1)), {
          status: 200,
        }),
    );
    await expect(oversizedCompressed.warmup?.()).rejects.toThrow("compressed dictionary exceeds");

    const oversizedExpanded = createWasmConverter(module, "/expanded-limit", async () =>
      gzipResponse(new Uint8Array(AZOOKEY_MAX_DICTIONARY_BYTES + 1)),
    );
    await expect(oversizedExpanded.warmup?.()).rejects.toThrow("dictionary exceeds");

    const empty = createWasmConverter(module, "/empty", async () => gzipResponse(new Uint8Array()));
    await expect(empty.warmup?.()).rejects.toThrow("dictionary is empty");
    const malformed = createWasmConverter(
      module,
      "/malformed",
      async () => new Response("not gzip", { status: 200 }),
    );
    await expect(malformed.warmup?.()).rejects.toBeDefined();
  }, 20_000);

  it("validates the owned initialization ABI without double-freeing transferred memory", async () => {
    const module = emptyModule();
    const missingInit = wasmExports();
    delete (missingInit as Partial<AzookeyWasmExports>).azookey_dictionary_init_owned;
    mockInstance(missingInit);
    const unsupported = createWasmConverter(module, "/missing-init", async () =>
      gzipResponse(new Uint8Array([1])),
    );
    await expect(unsupported.warmup?.()).rejects.toThrow("does not support portable");
    vi.restoreAllMocks();

    const allocationFailure = wasmExports({ azookey_alloc: vi.fn(() => 0) });
    mockInstance(allocationFailure);
    const noMemory = createWasmConverter(emptyModule(), "/allocation", async () =>
      gzipResponse(new Uint8Array([1])),
    );
    await expect(noMemory.warmup?.()).rejects.toThrow("dictionary allocation failed");
    vi.restoreAllMocks();

    const rejected = wasmExports({ azookey_dictionary_init_owned: vi.fn(() => 1) });
    mockInstance(rejected);
    const invalid = createWasmConverter(emptyModule(), "/invalid", async () =>
      gzipResponse(new Uint8Array([1])),
    );
    await expect(invalid.warmup?.()).rejects.toThrow("initialization failed (1)");
    expect(rejected.azookey_dealloc).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    const trapped = wasmExports({
      azookey_dictionary_init_owned: vi.fn(() => {
        throw new Error("trap");
      }),
    });
    mockInstance(trapped);
    const trap = createWasmConverter(emptyModule(), "/trap", async () =>
      gzipResponse(new Uint8Array([1])),
    );
    await expect(trap.warmup?.()).rejects.toThrow("trap");
    expect(trapped.azookey_dealloc).not.toHaveBeenCalled();
  });

  it("warms the portable converter before upgrade and reports mixed-input passthrough", async () => {
    const module = new WebAssembly.Module(wasmBytes);
    const server = new ReadySocket();
    const fetcher = vi.fn(async () => new Response(responseBody(dictionaryGzip), { status: 200 }));
    const response = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      { AZOOKEY_DICTIONARY_URL: "/azookey/system.azkdict.gz" },
      {
        wasmModule: module,
        azookeyDictionaryFetcher: fetcher,
        socketPair: () => ({ client: {} as WebSocket, server: server as unknown as WebSocket }),
      },
    );
    expect(response.status).toBe(101);
    expect(server.accept).toHaveBeenCalledOnce();
    expect(JSON.parse(server.sent[0] ?? "{}")).toMatchObject({
      type: "azookey.ready",
      mode: AZOOKEY_MODE,
      vibrato: { workerStage: "passthrough" },
      dictionary: { transport: "portable-wasm", configured: true },
    });
  }, 20_000);

  it("converts Zenzai requests through the portable dictionary when MODEL_ROUTES is empty", async () => {
    const module = new WebAssembly.Module(wasmBytes);
    const fetcher = vi.fn(
      async () =>
        new Response(responseBody(dictionaryGzip), {
          status: 200,
          headers: { "content-length": String(dictionaryGzip.byteLength) },
        }),
    );
    const converter = createWasmConverter(module, "/azookey/system.azkdict.gz", fetcher);
    await converter.warmup?.();
    const message = parseAzookeyMessage(
      JSON.stringify({
        type: "azookey.convert",
        requestId: "zenz-dict-fallback",
        source: "web-speech",
        language: "ja",
        sourceText: "きょうはいいてんき",
        vibratoInput: "きょうはいいてんき",
        mode: "worker-vibrato",
        model: AZOOKEY_ZENZ_XSMALL_MODEL,
      }),
    );
    const result = await convertAzookeyMessage(message, {
      // Coverage instrumentation can make the first real-WASM conversion much
      // slower on shared CI runners. This test covers fallback correctness,
      // not the production timeout boundary.
      timeoutMs: 15_000,
      converter,
      modelRoutes: {},
    });
    expect(result).toMatchObject({
      convertedText: "今日はいい天気",
      model: AZOOKEY_MODEL,
      requestedModel: AZOOKEY_ZENZ_XSMALL_MODEL,
      modelFallback: AZOOKEY_MODEL_FALLBACK_UNCONFIGURED_ROUTE,
    });
    expect(result.elapsedMs).toBeGreaterThan(0);
  }, 20_000);

  it("normalizes non-Error loader failures", async () => {
    const converter = createWasmConverter(new WebAssembly.Module(wasmBytes), "/unknown-error", () =>
      Promise.reject("offline"),
    );
    await expect(converter.warmup?.()).rejects.toThrow("dictionary initialization failed");
  });
});
