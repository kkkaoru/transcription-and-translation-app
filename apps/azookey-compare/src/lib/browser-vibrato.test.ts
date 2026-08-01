import { afterEach, describe, expect, it, vi } from "vitest";
import { runBrowserVibrato } from "./browser-vibrato";

const clearConverter = (name = "__AZOOKEY_VIBRATO_WASM__"): void => {
  Reflect.deleteProperty(globalThis, name);
};

afterEach(() => {
  clearConverter();
  vi.unstubAllGlobals();
});

describe("browser Vibrato bridge", () => {
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
    vi.stubGlobal("__AZOOKEY_VIBRATO_WASM__", (text: string) => `default:${text}`);
    vi.stubGlobal("__CUSTOM__", (text: string) => `custom:${text}`);
    clearConverter();
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
      "convert/transform 関数がありません",
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
      "convert/transform 関数がありません",
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
