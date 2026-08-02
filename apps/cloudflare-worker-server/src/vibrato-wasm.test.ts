import { describe, expect, it, vi } from "vitest";

const vibratoMocks = vi.hoisted(() => ({
  initSync: vi.fn(),
  Tokenizer: vi.fn(),
}));

vi.mock("./vibrato_wasm.js", () => ({
  initSync: vibratoMocks.initSync,
  VibratoTokenizer: vibratoMocks.Tokenizer,
}));

import { createVibratoWasmConverter } from "./azookey.js";

const wasmModule = {} as WebAssembly.Module;

describe("Worker Vibrato WASM dictionary adapter", () => {
  it("loads a dictionary lazily once and converts with the IPADIC feature index", async () => {
    const tokenizer = { toHiragana: vi.fn(() => "ひらがな") };
    vibratoMocks.Tokenizer.mockImplementation(() => tokenizer);
    const fetcher = vi.fn(() => new Response(new Uint8Array([1, 2, 3])));
    const converter = createVibratoWasmConverter(
      wasmModule,
      " https://dict.example.test/system.dic.zst ",
      fetcher,
    );
    if (!converter) {
      throw new Error("converter was not created");
    }

    await expect(converter("入力", "ja")).resolves.toBe("ひらがな");
    await expect(converter("二つ目", "ja")).resolves.toBe("ひらがな");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vibratoMocks.initSync).toHaveBeenCalledWith({ module: wasmModule });
    expect(vibratoMocks.Tokenizer).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(tokenizer.toHiragana).toHaveBeenNthCalledWith(1, "入力", 7);
    expect(tokenizer.toHiragana).toHaveBeenNthCalledWith(2, "二つ目", 7);
  });

  it("rejects missing, malformed, empty, and oversized dictionaries", async () => {
    expect(createVibratoWasmConverter(undefined, "https://dict.example.test/system.dic.zst")).toBe(
      undefined,
    );
    expect(createVibratoWasmConverter(wasmModule, " ")).toBeUndefined();
    expect(() => createVibratoWasmConverter(wasmModule, "file:///tmp/system.dic.zst")).toThrow(
      "http:// or https://",
    );

    const failedResponse = createVibratoWasmConverter(
      wasmModule,
      "https://dict.example.test/system.dic.zst",
      () => new Response("missing", { status: 404 }),
    );
    await expect(failedResponse?.("入力", "ja")).rejects.toThrow("returned 404");

    const empty = createVibratoWasmConverter(
      wasmModule,
      "https://dict.example.test/system.dic.zst",
      () => new Response(new Uint8Array()),
    );
    await expect(empty?.("入力", "ja")).rejects.toThrow("dictionary is empty");

    const tooLarge = createVibratoWasmConverter(
      wasmModule,
      "https://dict.example.test/system.dic.zst",
      () => new Response(new Uint8Array(12 * 1024 * 1024 + 1)),
    );
    await expect(tooLarge?.("入力", "ja")).rejects.toThrow("exceeds the byte limit");
  });

  it("resets a failed lazy load so a later request can retry", async () => {
    const tokenizer = { toHiragana: vi.fn(() => "再試行") };
    vibratoMocks.Tokenizer.mockImplementation(() => tokenizer);
    let attempts = 0;
    const fetcher = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("dictionary offline");
      }
      return new Response(new Uint8Array([9]));
    });
    const converter = createVibratoWasmConverter(
      wasmModule,
      "https://dict.example.test/system.dic.zst",
      fetcher,
    );
    if (!converter) {
      throw new Error("converter was not created");
    }
    await expect(converter("一回目", "ja")).rejects.toThrow("dictionary offline");
    await expect(converter("二回目", "ja")).resolves.toBe("再試行");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("normalizes non-Error initialization failures", async () => {
    const fetcher = vi.fn(() => new Response(new Uint8Array([7])));
    const converter = createVibratoWasmConverter(
      wasmModule,
      "https://dict.example.test/system.dic.zst",
      fetcher,
    );
    if (!converter) {
      throw new Error("converter was not created");
    }
    vibratoMocks.initSync.mockImplementationOnce(() => {
      throw "init failed";
    });
    await expect(converter("入力", "ja")).rejects.toThrow(
      "Vibrato dictionary initialization failed",
    );
  });
});
