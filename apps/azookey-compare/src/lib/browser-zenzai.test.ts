import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBrowserAzookeyCache } from "./browser-azookey";
import {
  assertBrowserZenzaiDictModel,
  BROWSER_ZENZAI_DICT_EXECUTION,
  BROWSER_ZENZAI_DICT_LABEL,
  BROWSER_ZENZAI_DICT_NOTICE,
  browserZenzaiDictionaryUrl,
  isBrowserZenzaiDictModel,
  resetBrowserZenzaiDictCache,
  runBrowserZenzaiDict,
  warmupBrowserZenzaiDict,
} from "./browser-zenzai";

const wasmBytes = readFileSync(
  new URL("../../../cloudflare-worker-server/wasm/azookey.wasm", import.meta.url),
);
const dictionaryGzip = readFileSync(
  new URL("../../../cloudflare-worker-server/public/azookey/system.azkdict.gz", import.meta.url),
);
const dictionaryBytes = new Uint8Array(gunzipSync(dictionaryGzip));

afterEach(() => {
  resetBrowserZenzaiDictCache();
  vi.restoreAllMocks();
});

describe("browser Zenzai dictionary loader", () => {
  it("converts with the portable LOUDS dictionary and labels dict-only execution", async () => {
    const module = await WebAssembly.compile(wasmBytes);
    const result = await runBrowserZenzaiDict("きょうはいいてんき", {
      model: "zenz-v3.2-xsmall-gguf",
      wasmModule: module,
      dictionaryBytes,
    });
    expect(result.text).toBe("今日はいい天気");
    expect(result.execution).toBe(BROWSER_ZENZAI_DICT_EXECUTION);
    expect(result.model).toBe("zenz-v3.2-xsmall-gguf");
    expect(result.label).toBe(BROWSER_ZENZAI_DICT_LABEL);
    expect(result.dictionaryUrl).toBe("/azookey/system.azkdict.gz");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  }, 20_000);

  it("reuses the shared AzooKey cache for warmup and convert", async () => {
    const module = await WebAssembly.compile(wasmBytes);
    const fetcher = vi.fn();
    await warmupBrowserZenzaiDict({
      model: "zenz-v3.2-small-gguf",
      wasmModule: module,
      dictionaryBytes,
      fetcher,
    });
    await runBrowserZenzaiDict("とても", {
      model: "zenz-v3.2-small-gguf",
      wasmModule: module,
      dictionaryBytes,
      fetcher,
    });
    expect(fetcher).not.toHaveBeenCalled();
  }, 20_000);

  it("fetches system.azkdict.gz from the default browser URL", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("azookey.wasm")) {
        return Promise.resolve(new Response(wasmBytes, { status: 200 }));
      }
      if (url.endsWith("system.azkdict.gz")) {
        return Promise.resolve(
          new Response(dictionaryGzip, {
            status: 200,
            headers: { "content-length": String(dictionaryGzip.byteLength) },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const result = await runBrowserZenzaiDict("すーぷは", {
      model: "zenz-v3.2-xsmall-gguf",
      fetcher,
    });
    expect(result.text).toBe("スープは");
    expect(result.dictionaryUrl).toBe(browserZenzaiDictionaryUrl());
    expect(fetcher).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("rejects non-Zenzai models and unsafe dictionary URLs", async () => {
    expect(isBrowserZenzaiDictModel("zenz-v3.2-xsmall-gguf")).toBe(true);
    expect(isBrowserZenzaiDictModel("azookey-rust-wasm")).toBe(false);
    expect(() => assertBrowserZenzaiDictModel("azookey-rust-wasm")).toThrow(/Zenzai model id/);
    await expect(
      runBrowserZenzaiDict("あ", {
        model: "azookey-rust-wasm",
        wasmModule: await WebAssembly.compile(wasmBytes),
        dictionaryBytes,
      }),
    ).rejects.toThrow(/Zenzai model id/);
    await expect(
      runBrowserZenzaiDict("あ", {
        model: "zenz-v3.2-xsmall-gguf",
        wasmModule: await WebAssembly.compile(wasmBytes),
        dictionaryUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow(/javascript/);
  }, 20_000);

  it("documents the dict-only notice for UI copy", () => {
    expect(BROWSER_ZENZAI_DICT_NOTICE).toContain("LOUDS");
    expect(BROWSER_ZENZAI_DICT_NOTICE).toContain("GGUF");
    expect(BROWSER_ZENZAI_DICT_NOTICE).toContain("Cloudflare Worker");
  });

  it("warms up with an explicit dictionary URL override", async () => {
    const module = await WebAssembly.compile(wasmBytes);
    await warmupBrowserZenzaiDict({
      model: "zenz-v3.2-xsmall-gguf",
      wasmModule: module,
      dictionaryBytes,
      dictionaryUrl: "/azookey/system.azkdict.gz",
    });
    const result = await runBrowserZenzaiDict("とても", {
      model: "zenz-v3.2-xsmall-gguf",
      wasmModule: module,
      dictionaryBytes,
    });
    expect(result.text).toBe("とても");
  }, 20_000);

  it("clears cache through the Zenzai alias", async () => {
    const module = await WebAssembly.compile(wasmBytes);
    await runBrowserZenzaiDict("とても", {
      model: "zenz-v3.2-xsmall-gguf",
      wasmModule: module,
      dictionaryBytes,
    });
    resetBrowserZenzaiDictCache();
    resetBrowserAzookeyCache();
    const fetcher = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
    await expect(
      runBrowserZenzaiDict("とても", {
        model: "zenz-v3.2-xsmall-gguf",
        fetcher,
      }),
    ).rejects.toThrow(/404/);
    expect(fetcher).toHaveBeenCalled();
  }, 20_000);
});
