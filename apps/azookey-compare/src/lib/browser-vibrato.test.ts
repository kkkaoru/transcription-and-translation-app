import { afterEach, describe, expect, it, vi } from "vitest";
import { runBrowserVibrato } from "./browser-vibrato";

const clearConverter = (name = "__AZOOKEY_VIBRATO_WASM__"): void => {
  Reflect.deleteProperty(globalThis, name);
};

const dataModule = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;

const bytesResponse = (bytes = new Uint8Array([1, 2, 3])) => new Response(bytes, { status: 200 });

afterEach(() => {
  clearConverter();
  vi.unstubAllGlobals();
});

describe("browser Vibrato bridge", () => {
  it("initializes the bundled-style tokenizer from a global and caches dictionary bytes", async () => {
    const init = vi.fn(async () => undefined);
    const tokenizer = vi.fn(function (this: {
      toHiragana: (text: string, index: number) => string;
    }) {
      this.toHiragana = (text, index) => `${text}:${index}`;
    });
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", { default: init, VibratoTokenizer: tokenizer });
    const fetcher = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
    vi.stubGlobal("fetch", fetcher);

    await expect(
      runBrowserVibrato("入力", {
        moduleUrl: "",
        dictionaryUrl: "https://dict.example/system.dic.zst",
      }),
    ).resolves.toMatchObject({ text: "入力:7" });
    await expect(
      runBrowserVibrato("二つ目", {
        moduleUrl: "",
        dictionaryUrl: "https://dict.example/system.dic.zst",
      }),
    ).resolves.toMatchObject({ text: "二つ目:7" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(init).toHaveBeenCalledTimes(2);
    expect(tokenizer).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

  it("supports initSync globals, token reading fallback, and invalid tokenizer errors", async () => {
    const initSync = vi.fn();
    const tokenizer = vi.fn(function (this: { tokenize: (text: string) => unknown[] }) {
      this.tokenize = () => [
        { surface: "学校", feature: "*,*,*,*,*,*,*,ガッコウ" },
        { surface: "?", feature: "*" },
      ];
    });
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", { initSync, VibratoTokenizer: tokenizer });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(new Uint8Array([9])))),
    );
    await expect(
      runBrowserVibrato("入力", {
        moduleUrl: "",
        dictionaryUrl: "https://dict.example/dict",
        wasmBinaryUrl: "https://dict.example/vibrato.wasm",
      }),
    ).resolves.toMatchObject({ text: "がっこう?" });
    expect(initSync).toHaveBeenCalledWith(new Uint8Array([9]));

    clearConverter();
    const free = vi.fn();
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", {
      VibratoTokenizer: vi.fn(function (this: { free: () => void }) {
        this.free = free;
      }),
    });
    await expect(
      runBrowserVibrato("入力", {
        moduleUrl: "",
        dictionaryUrl: "https://dict.example/dict",
      }),
    ).rejects.toThrow("toHiragana/tokenize");
    expect(free).toHaveBeenCalledTimes(1);
  });

  it("loads generated module exports and rejects invalid dictionary/configuration paths", async () => {
    const moduleSource = `export const initSync = () => undefined; export class VibratoTokenizer { toHiragana(text, index) { return text + ':' + index; } }`;
    const moduleUrl = `data:text/javascript,${encodeURIComponent(moduleSource)}`;
    const fetcher = vi.fn(() => Promise.resolve(new Response(new Uint8Array([4]))));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      runBrowserVibrato("入力", {
        moduleUrl,
        dictionaryUrl: "https://dict.example/dict",
        wasmBinaryUrl: "https://dict.example/vibrato.wasm",
      }),
    ).resolves.toMatchObject({ text: "入力:7" });
    expect(fetcher).toHaveBeenCalledTimes(2);

    clearConverter();
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", { VibratoTokenizer: vi.fn() });
    await expect(runBrowserVibrato("入力", { moduleUrl: "", featureIndex: -1 })).rejects.toThrow(
      "feature index",
    );
    await expect(runBrowserVibrato("入力", { moduleUrl: "", featureIndex: 1.5 })).rejects.toThrow(
      "feature index",
    );
  });

  it("reports dictionary fetch, byte, and token-shape failures", async () => {
    const tokenizer = vi.fn(function (this: { toHiragana: () => string }) {
      this.toHiragana = () => "結果";
    });
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", { VibratoTokenizer: tokenizer });
    const responses: Array<Response | (() => Promise<never>)> = [
      new Response("missing", { status: 404 }),
      new Response(new Uint8Array()),
      () => Promise.reject(new Error("offline")),
    ];
    for (const response of responses) {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => (typeof response === "function" ? response() : Promise.resolve(response))),
      );
      await expect(
        runBrowserVibrato("入力", {
          moduleUrl: "",
          dictionaryUrl: `https://dict.example/${Math.random()}`,
        }),
      ).rejects.toThrow();
      clearConverter();
      vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", { VibratoTokenizer: tokenizer });
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(new Uint8Array([1])))),
    );
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", {
      VibratoTokenizer: vi.fn(function (this: { tokenize: () => unknown[] }) {
        this.tokenize = () => [null];
      }),
    });
    await expect(
      runBrowserVibrato("入力", { moduleUrl: "", dictionaryUrl: "https://dict.example/shape" }),
    ).rejects.toThrow("token 0");
  });

  it("rejects empty input before loading a converter", async () => {
    await expect(
      runBrowserVibrato("  ", { moduleUrl: "data:text/javascript,export default {}" }),
    ).rejects.toThrow("テキストがありません");
  });

  it("uses a globally exposed function and measures conversion time", async () => {
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", (text: string) => `変換:${text}`);
    vi.stubGlobal("performance", { now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(27) });
    await expect(runBrowserVibrato("  きょう  ", { moduleUrl: "" })).resolves.toEqual({
      text: "変換:きょう",
      elapsedMs: 17,
    });
  });

  it("ignores an inherited name that was never injected as a global", async () => {
    // `toString` resolves off Object.prototype and would satisfy a bare property
    // read, so the module URL would be skipped for a converter nobody supplied.
    await expect(
      runBrowserVibrato("入力", {
        moduleUrl: "data:text/javascript,export const convert = (t) => 'module:' + t",
        globalName: "toString",
      }),
    ).resolves.toMatchObject({ text: "module:入力" });
  });

  it("prefers an injected global over a configured module URL", async () => {
    // The loader checks globalThis first, so the configuration status text must
    // say so rather than promising the module URL is what runs.
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", (text: string) => `global:${text}`);
    await expect(
      runBrowserVibrato("入力", {
        moduleUrl: "data:text/javascript,export const convert = (t) => 'module:' + t",
      }),
    ).resolves.toMatchObject({ text: "global:入力" });
  });

  it("probes the configured global name, not the historical default, before the module URL", async () => {
    // With a custom name set, the loader probes that name and never looks at
    // the historical default. Injecting both proves which one the settings
    // panel has to name: the default is present and still loses.
    // Both globals stay injected for the whole call: clearing the default here
    // would leave only one candidate and the assertion would hold no matter
    // which name the loader prefers.
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", (text: string) => `default:${text}`);
    vi.stubGlobal("__CUSTOM__", (text: string) => `custom:${text}`);
    await expect(
      runBrowserVibrato("入力", {
        moduleUrl: "data:text/javascript,export const convert = (t) => 'module:' + t",
        globalName: "__CUSTOM__",
      }),
    ).resolves.toMatchObject({ text: "custom:入力" });
  });

  it("discovers object converter aliases and custom global names", async () => {
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", { convert: (text: string) => `convert:${text}` });
    await expect(runBrowserVibrato("入力", { moduleUrl: "" })).resolves.toMatchObject({
      text: "convert:入力",
    });

    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", { transform: (text: string) => `transform:${text}` });
    await expect(runBrowserVibrato("入力", { moduleUrl: "" })).resolves.toMatchObject({
      text: "transform:入力",
    });

    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", { tokenize: (text: string) => `tokenize:${text}` });
    await expect(runBrowserVibrato("入力", { moduleUrl: "" })).resolves.toMatchObject({
      text: "tokenize:入力",
    });

    vi.stubGlobal("custom-vibrato", {
      default: { transform: (text: string) => `default:${text}` },
    });
    clearConverter();
    await expect(
      runBrowserVibrato("入力", { moduleUrl: "", globalName: " custom-vibrato " }),
    ).resolves.toMatchObject({ text: "default:入力" });
  });

  it("loads a module once and reuses its cached converter", async () => {
    const moduleSource = "export const convert = (text) => 'module:' + text";
    const moduleUrl = `data:text/javascript,${encodeURIComponent(moduleSource)}`;
    const first = await runBrowserVibrato("一", { moduleUrl });
    const second = await runBrowserVibrato("二", { moduleUrl });
    expect(first.text).toBe("module:一");
    expect(second.text).toBe("module:二");
  });

  it("initializes generated VibratoTokenizer glue and reads IPADIC F[7]", async () => {
    const fetcher = vi.fn((url: string) => {
      expect(url).toBe("/dict/ipadic/system.dic.zst");
      return bytesResponse();
    });
    vi.stubGlobal("fetch", fetcher);
    const moduleUrl = dataModule(`
      export default async function init() {}
      export class VibratoTokenizer {
        constructor(bytes) { if (!bytes.length) throw new Error("missing dictionary"); }
        toHiragana(text, featureIndex) { return featureIndex + ":" + text; }
      }
    `);
    await expect(
      runBrowserVibrato("漢字混じり", {
        moduleUrl,
        dictionaryUrl: "/dict/ipadic/system.dic.zst",
      }),
    ).resolves.toMatchObject({ text: "7:漢字混じり" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("supports initSync glue and converts token readings when toHiragana is absent", async () => {
    const fetcher = vi.fn((url: string) => {
      expect(["/dict/ipadic/system.dic.zst", "/wasm/vibrato_wasm_bg.wasm"]).toContain(url);
      return bytesResponse();
    });
    vi.stubGlobal("fetch", fetcher);
    const moduleUrl = dataModule(`
      let initialized = false;
      export function initSync(bytes) { initialized = bytes.byteLength > 0; }
      export class VibratoTokenizer {
        constructor() {}
        tokenize(text) {
          if (!initialized) throw new Error("not initialized");
          return [{ surface: text, feature: "名詞,固有名詞,地名,一般,*,*,*,トウキョウ" }];
        }
      }
    `);
    await expect(
      runBrowserVibrato("東京", {
        moduleUrl,
        dictionaryUrl: "/dict/ipadic/system.dic.zst",
        wasmBinaryUrl: "/wasm/vibrato_wasm_bg.wasm",
      }),
    ).resolves.toMatchObject({ text: "とうきょう" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("caches generated dictionary initialization by module and dictionary settings", async () => {
    const fetcher = vi.fn(async () => bytesResponse());
    vi.stubGlobal("fetch", fetcher);
    const moduleUrl = dataModule(`
      export default async function init() {}
      export class VibratoTokenizer {
        constructor() {}
        toHiragana(text, index) { return index + ":" + text; }
      }
    `);
    await expect(
      runBrowserVibrato("一", { moduleUrl, dictionaryUrl: "/dict/cache.zst" }),
    ).resolves.toMatchObject({ text: "7:一" });
    await expect(
      runBrowserVibrato("二", { moduleUrl, dictionaryUrl: "/dict/cache.zst" }),
    ).resolves.toMatchObject({ text: "7:二" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails generated modules on unsafe or unavailable dictionary/WASM assets", async () => {
    const moduleUrl = dataModule(`
      export default async function init() {}
      export class VibratoTokenizer { constructor() {} toHiragana(text) { return text; } }
    `);
    await expect(
      runBrowserVibrato("入力", { moduleUrl, dictionaryUrl: "javascript:alert(1)" }),
    ).rejects.toThrow("javascript:");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(
      runBrowserVibrato("入力", { moduleUrl, dictionaryUrl: "/dict/missing.zst" }),
    ).rejects.toThrow("Vibrato辞書");

    const syncModule = dataModule(`
      export function initSync() {}
      export class VibratoTokenizer { constructor() {} toHiragana(text) { return text; } }
    `);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => bytesResponse()),
    );
    await expect(
      runBrowserVibrato("入力", {
        moduleUrl: syncModule,
        dictionaryUrl: "/dict/ok.zst",
      }),
    ).rejects.toThrow("initSync");
  });

  it("reports non-Error fetch failures, invalid byte bodies, and oversized dictionaries", async () => {
    const moduleUrl = dataModule(`
      export default async function init() {}
      export class VibratoTokenizer { constructor() {} toHiragana(text) { return text; } }
    `);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject("network down")),
    );
    await expect(
      runBrowserVibrato("入力", { moduleUrl, dictionaryUrl: "/dict/network.zst" }),
    ).rejects.toThrow("fetch failed");

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.reject("bad body") }),
      ),
    );
    await expect(
      runBrowserVibrato("入力", { moduleUrl, dictionaryUrl: "/dict/body.zst" }),
    ).rejects.toThrow("invalid bytes");

    const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(bytesResponse(oversized))),
    );
    await expect(
      runBrowserVibrato("入力", { moduleUrl, dictionaryUrl: "/dict/large.zst" }),
    ).rejects.toThrow("大きすぎます");
  });

  it("uses the bundled dictionary default and preserves non-katakana token readings", async () => {
    const fetcher = vi.fn(() => Promise.resolve(bytesResponse()));
    vi.stubGlobal("fetch", fetcher);
    const moduleUrl = dataModule(`
      export default async function init() {}
      export class VibratoTokenizer {
        constructor() {}
        tokenize(text) {
          return [
            { surface: text, feature: "名詞,固有名詞,地名,一般,*,*,*,トウキョウ" },
            { surface: "ABC", feature: "名詞,固有名詞,*,*,*,*,*,ABC" },
          ];
        }
      }
    `);
    await expect(runBrowserVibrato("東京", { moduleUrl })).resolves.toMatchObject({
      text: "とうきょうABC",
    });
    expect(fetcher).toHaveBeenCalledWith("/vibrato/system.dic.zst");
  });

  it("rejects a generated tokenizer that returns a non-array token result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(bytesResponse())),
    );
    const moduleUrl = dataModule(`
      export default async function init() {}
      export class VibratoTokenizer {
        constructor() {}
        tokenize() { return { surface: "not-an-array" }; }
      }
    `);
    await expect(
      runBrowserVibrato("入力", { moduleUrl, dictionaryUrl: "/dict/tokens.zst" }),
    ).rejects.toThrow("配列ではありません");
  });

  it("validates malformed generated token output and feature indexes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => bytesResponse()),
    );
    const malformed = dataModule(`
      export default async function init() {}
      export class VibratoTokenizer {
        constructor() {}
        tokenize() { return [{ surface: "入力", feature: 7 }]; }
      }
    `);
    await expect(
      runBrowserVibrato("入力", { moduleUrl: malformed, dictionaryUrl: "/dict/zst" }),
    ).rejects.toThrow("形式が不正");

    const valid = dataModule(`
      export default async function init() {}
      export class VibratoTokenizer {
        constructor() {}
        toHiragana(text, index) { return index + ":" + text; }
      }
    `);
    await expect(
      runBrowserVibrato("入力", {
        moduleUrl: valid,
        dictionaryUrl: "/dict/zst",
        featureIndex: -1,
      }),
    ).rejects.toThrow("feature index");
  });

  it("rejects missing, malformed, and non-string WASM results", async () => {
    await expect(runBrowserVibrato("入力", { moduleUrl: "" })).rejects.toThrow("WASMが未設定");
    await expect(
      runBrowserVibrato("入力", { moduleUrl: "javascript:globalThis.alert(1)" }),
    ).rejects.toThrow("javascript:");

    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", { convert: () => 42 });
    await expect(runBrowserVibrato("入力", { moduleUrl: "" })).rejects.toThrow(
      "変換結果が文字列ではありません",
    );
    clearConverter();

    const invalidModule = `data:text/javascript,${encodeURIComponent("export const value = 'not a converter'")}`;
    await expect(runBrowserVibrato("入力", { moduleUrl: invalidModule })).rejects.toThrow(
      "convert/transform/tokenize 関数がありません",
    );

    const selfDefault = {} as { default?: unknown };
    selfDefault.default = selfDefault;
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", selfDefault);
    await expect(runBrowserVibrato("入力", { moduleUrl: "" })).rejects.toThrow("WASMが未設定");
    clearConverter();

    const throwingModule = `data:text/javascript,${encodeURIComponent("throw 'module failed'")}`;
    await expect(runBrowserVibrato("入力", { moduleUrl: throwingModule })).rejects.toThrow(
      "読み込めません",
    );
    await expect(runBrowserVibrato("入力", { moduleUrl: invalidModule })).rejects.toThrow(
      "convert/transform/tokenize 関数がありません",
    );
  });

  it("uses Date.now when performance is unavailable and propagates converter failures", async () => {
    vi.stubGlobal("performance", undefined);
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", () => {
      throw new Error("converter failed");
    });
    await expect(runBrowserVibrato("入力", { moduleUrl: "" })).rejects.toThrow("converter failed");

    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", (text: string) => text);
    await expect(runBrowserVibrato("入力", { moduleUrl: "" })).resolves.toMatchObject({
      text: "入力",
    });
  });
});
