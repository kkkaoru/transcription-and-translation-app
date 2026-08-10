import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES,
  AZOOKEY_MAX_DICTIONARY_BYTES,
} from "@caption-bridge/dictionaries";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AZOOKEY_WASM_ABI_VERSION,
  instantiateBrowserAzookeyConverter,
  resetBrowserAzookeyCache,
  runBrowserAzookey,
  warmupBrowserAzookey,
} from "./browser-azookey";

const wasmBytes = readFileSync(
  new URL("../../../cloudflare-worker-server/wasm/azookey.wasm", import.meta.url),
);
const dictionaryGzip = readFileSync(
  new URL("../../../cloudflare-worker-server/public/azookey/system.azkdict.gz", import.meta.url),
);
const dictionaryBytes = new Uint8Array(gunzipSync(dictionaryGzip));
const responseBody = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit;

afterEach(() => {
  resetBrowserAzookeyCache();
  vi.restoreAllMocks();
});

describe("browser AzooKey WASM loader", () => {
  it("converts real portable WASM locally without a Worker", async () => {
    const module = await WebAssembly.compile(wasmBytes);
    const weather = await runBrowserAzookey("きょうはいいてんき", {
      wasmModule: module,
      dictionaryBytes,
    });
    expect(weather.text).toBe("今日はいい天気");
    expect(weather.elapsedMs).toBeGreaterThanOrEqual(0);

    const fixture = await runBrowserAzookey("あしたのてんきははれ", {
      wasmModule: module,
      dictionaryBytes,
    });
    expect(fixture.text).toBe("明日の天気は晴れ");
  }, 20_000);

  it("regresses the established はし lattice on the browser portable default path", async () => {
    const module = await WebAssembly.compile(wasmBytes);
    const result = await runBrowserAzookey("はしのはじからものがおちてます", {
      wasmModule: module,
      dictionaryBytes,
    });
    expect(result.text).toBe("橋の端から物が落ちてます");
  }, 20_000);

  it("regresses the established あついひなので lattice on the browser portable default path", async () => {
    const module = await WebAssembly.compile(wasmBytes);
    const result = await runBrowserAzookey("あついひなのであついすーぷをのみたくない", {
      wasmModule: module,
      dictionaryBytes,
    });
    expect(result.text).toBe("暑い日なので熱いスープを飲みたくない");
  }, 20_000);

  it("regresses the established あついひなのに lattice on the browser portable default path", async () => {
    const module = await WebAssembly.compile(wasmBytes);
    const result = await runBrowserAzookey("あついひなのに", {
      wasmModule: module,
      dictionaryBytes,
    });
    expect(result.text).toBe("暑い日なのに");
  }, 20_000);

  it("reuses one loaded converter for warmup and convert", async () => {
    const module = await WebAssembly.compile(wasmBytes);
    const fetcher = vi.fn();
    await warmupBrowserAzookey({ wasmModule: module, dictionaryBytes, fetcher });
    const first = await runBrowserAzookey("とても", {
      wasmModule: module,
      dictionaryBytes,
      fetcher,
    });
    const second = await runBrowserAzookey("とても", {
      wasmModule: module,
      dictionaryBytes,
      fetcher,
    });
    expect(first.text).toBe("とても");
    expect(second.text).toBe("とても");
    expect(fetcher).not.toHaveBeenCalled();
  }, 20_000);

  it("fetches gzip dictionary bytes and compiles wasm from URLs", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("azookey.wasm")) {
        return Promise.resolve(
          new Response(responseBody(new Uint8Array(wasmBytes)), { status: 200 }),
        );
      }
      if (url.endsWith("system.azkdict.gz")) {
        return Promise.resolve(
          new Response(responseBody(new Uint8Array(dictionaryGzip)), {
            status: 200,
            headers: { "content-length": String(dictionaryGzip.byteLength) },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const result = await runBrowserAzookey("すーぷは", {
      wasmUrl: "/azookey/azookey.wasm",
      dictionaryUrl: "/azookey/system.azkdict.gz",
      fetcher,
    });
    expect(result.text).toBe("スープは");
    expect(fetcher).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("rejects unsafe locators, empty bodies, and oversized dictionaries", async () => {
    await expect(
      runBrowserAzookey("あ", { wasmUrl: "javascript:alert(1)", dictionaryBytes }),
    ).rejects.toThrow(/javascript/);
    await expect(
      runBrowserAzookey("あ", {
        wasmModule: await WebAssembly.compile(wasmBytes),
        dictionaryUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow(/javascript/);

    const emptyWasm = vi.fn(() => Promise.resolve(new Response(new Uint8Array(), { status: 200 })));
    await expect(
      runBrowserAzookey("あ", {
        wasmUrl: "/azookey/azookey.wasm",
        dictionaryBytes,
        fetcher: emptyWasm,
      }),
    ).rejects.toThrow(/empty/);

    resetBrowserAzookeyCache();
    const missingDict = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(".wasm")) {
        return Promise.resolve(
          new Response(responseBody(new Uint8Array(wasmBytes)), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    await expect(
      runBrowserAzookey("あ", {
        wasmUrl: "/azookey/azookey.wasm",
        dictionaryUrl: "/azookey/system.azkdict.gz",
        fetcher: missingDict,
      }),
    ).rejects.toThrow(/404/);

    const oversized = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(".wasm")) {
        return Promise.resolve(
          new Response(responseBody(new Uint8Array(wasmBytes)), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(responseBody(new Uint8Array([1, 2, 3])), {
          status: 200,
          headers: { "content-length": String(AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES + 1) },
        }),
      );
    });
    await expect(
      runBrowserAzookey("あ", {
        wasmUrl: "/azookey/azookey.wasm",
        dictionaryUrl: "/azookey/system.azkdict.gz",
        fetcher: oversized,
      }),
    ).rejects.toThrow(/byte limit/);
  });

  it("rejects modules missing the portable ABI", () => {
    const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(() => instantiateBrowserAzookeyConverter(emptyModule, dictionaryBytes)).toThrow(
      /required raw ABI/,
    );

    const memory = new WebAssembly.Memory({ initial: 1 });
    vi.spyOn(WebAssembly, "Instance").mockImplementation(
      () =>
        ({
          exports: {
            memory,
            azookey_alloc: () => 8,
            azookey_dealloc: () => undefined,
            azookey_convert: () => BigInt(1),
            azookey_abi_version: () => AZOOKEY_WASM_ABI_VERSION + 1,
            azookey_dictionary_init_owned: () => 0,
          },
        }) as unknown as WebAssembly.Instance,
    );
    const dummy = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(() => instantiateBrowserAzookeyConverter(dummy, dictionaryBytes)).toThrow(
      /ABI version mismatch/,
    );
  });

  it("rejects missing dictionary init and failed convert allocations", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const tinyDictionary = new Uint8Array([1, 2, 3, 4]);
    vi.spyOn(WebAssembly, "Instance").mockImplementation(
      () =>
        ({
          exports: {
            memory,
            azookey_alloc: () => 8,
            azookey_dealloc: () => undefined,
            azookey_convert: () => BigInt(1),
            azookey_abi_version: () => AZOOKEY_WASM_ABI_VERSION,
          },
        }) as unknown as WebAssembly.Instance,
    );
    const dummy = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(() => instantiateBrowserAzookeyConverter(dummy, tinyDictionary)).toThrow(
      /portable dictionaries/,
    );

    vi.mocked(WebAssembly.Instance).mockImplementation(
      () =>
        ({
          exports: {
            memory,
            azookey_alloc: () => 0,
            azookey_dealloc: () => undefined,
            azookey_convert: () => BigInt(0),
            azookey_abi_version: () => AZOOKEY_WASM_ABI_VERSION,
            azookey_dictionary_init_owned: () => 0,
          },
        }) as unknown as WebAssembly.Instance,
    );
    expect(() => instantiateBrowserAzookeyConverter(dummy, tinyDictionary)).toThrow(
      /dictionary allocation failed/,
    );

    vi.mocked(WebAssembly.Instance).mockImplementation(
      () =>
        ({
          exports: {
            memory,
            azookey_alloc: (size: number) => (size === tinyDictionary.byteLength ? 8 : 0),
            azookey_dealloc: () => undefined,
            azookey_convert: () => BigInt(1),
            azookey_abi_version: () => AZOOKEY_WASM_ABI_VERSION,
            azookey_dictionary_init_owned: () => 0,
          },
        }) as unknown as WebAssembly.Instance,
    );
    const converter = instantiateBrowserAzookeyConverter(dummy, tinyDictionary);
    expect(() => converter("あ")).toThrow(/input allocation failed/);

    vi.mocked(WebAssembly.Instance).mockImplementation(
      () =>
        ({
          exports: {
            memory,
            azookey_alloc: () => 8,
            azookey_dealloc: () => undefined,
            azookey_convert: () => BigInt(0),
            azookey_abi_version: () => AZOOKEY_WASM_ABI_VERSION,
            azookey_dictionary_init_owned: () => 0,
          },
        }) as unknown as WebAssembly.Instance,
    );
    const failingConverter = instantiateBrowserAzookeyConverter(dummy, tinyDictionary);
    expect(() => failingConverter("あ")).toThrow(/conversion allocation failed/);
  });

  it("deallocates dictionary memory when copying into Wasm fails", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const dealloc = vi.fn();
    vi.spyOn(WebAssembly, "Instance").mockImplementation(
      () =>
        ({
          exports: {
            memory,
            azookey_alloc: () => 8,
            azookey_dealloc: dealloc,
            azookey_convert: () => BigInt(1),
            azookey_abi_version: () => AZOOKEY_WASM_ABI_VERSION,
            azookey_dictionary_init_owned: () => 0,
          },
        }) as unknown as WebAssembly.Instance,
    );
    vi.spyOn(Uint8Array.prototype, "set").mockImplementationOnce(() => {
      throw new Error("copy failed");
    });
    const dummy = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(() =>
      instantiateBrowserAzookeyConverter(dummy, new Uint8Array([1, 2, 3, 4])),
    ).toThrow(/copy failed/);
    expect(dealloc).toHaveBeenCalledWith(8, 4);
  });

  it("retries after a failed load instead of caching the rejection", async () => {
    const failing = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    await expect(
      runBrowserAzookey("あ", {
        wasmUrl: "/azookey/azookey.wasm",
        dictionaryUrl: "/azookey/system.azkdict.gz",
        fetcher: failing,
      }),
    ).rejects.toThrow(/503/);

    const module = await WebAssembly.compile(wasmBytes);
    await expect(
      runBrowserAzookey("とても", { wasmModule: module, dictionaryBytes }),
    ).resolves.toMatchObject({ text: "とても" });
  }, 20_000);

  it("refuses an uncompressed dictionary that exceeds the byte limit", async () => {
    const huge = gzipSync(Buffer.alloc(AZOOKEY_MAX_DICTIONARY_BYTES + 1));
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(".wasm")) {
        return Promise.resolve(
          new Response(responseBody(new Uint8Array(wasmBytes)), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(responseBody(new Uint8Array(huge)), { status: 200 }));
    });
    await expect(
      runBrowserAzookey("あ", {
        wasmUrl: "/azookey/azookey.wasm",
        dictionaryUrl: "/azookey/system.azkdict.gz",
        fetcher,
      }),
    ).rejects.toThrow(/byte limit/);
  });
});
