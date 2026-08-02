import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES,
  AZOOKEY_MAX_DICTIONARY_BYTES,
  AZOOKEY_MODE,
  type AzookeyWasmExports,
  createWasmConverter,
  openAzookeySocket,
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
    });
  }, 20_000);

  it("normalizes non-Error loader failures", async () => {
    const converter = createWasmConverter(new WebAssembly.Module(wasmBytes), "/unknown-error", () =>
      Promise.reject("offline"),
    );
    await expect(converter.warmup?.()).rejects.toThrow("dictionary initialization failed");
  });
});
