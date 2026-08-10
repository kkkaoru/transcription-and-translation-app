import { describe, expect, it } from "vitest";
import {
  browserWasmConfigurationStatus,
  buildVibratoWebSocketUrl,
  COMPARISON_CONFIG_SCHEMA_VERSION,
  COMPARISON_MODES,
  comparisonConfigFieldDescriptions,
  comparisonConfigSchema,
  comparisonModeHelpSections,
  comparisonModeOptions,
  DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL,
  DEFAULT_BROWSER_WASM_DICTIONARY_URL,
  DEFAULT_BROWSER_WASM_FEATURE_INDEX,
  DEFAULT_BROWSER_WASM_GLOBAL_NAME,
  DEFAULT_BROWSER_WASM_MODULE_URL,
  DEFAULT_COMPARISON_CONFIG,
  DEFAULT_COMPARISON_LANGUAGE,
  DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL,
  hasBrowserWasmConfiguration,
  isComparisonMode,
  isVibratoWebSocketUrl,
  mergeComparisonConfig,
  parseComparisonConfig,
  validateComparisonConfig,
} from "./contract";

describe("comparison configuration contract", () => {
  it("publishes stable defaults, modes, descriptions, and schema metadata", () => {
    expect(COMPARISON_CONFIG_SCHEMA_VERSION).toBe(1);
    expect(COMPARISON_MODES).toEqual(["worker-vibrato", "browser-vibrato"]);
    expect(comparisonModeOptions).toHaveLength(2);
    expect(comparisonModeOptions.map((option) => option.value)).toEqual([
      "worker-vibrato",
      "browser-vibrato",
    ]);
    expect(comparisonModeOptions[0]?.label).toContain("Worker 依存");
    expect(comparisonModeOptions[1]?.label).toContain("ブラウザ完結");
    for (const option of comparisonModeOptions) {
      expect(option.description.toLowerCase()).toContain("azookey");
      expect(option.description.toLowerCase()).toMatch(/vibrato|unidic/);
      expect(option.description).not.toMatch(/使いません/);
    }
    expect(comparisonModeHelpSections.map((section) => section.title)).toEqual([
      "Worker 依存",
      "ブラウザ完結",
    ]);
    expect(comparisonModeOptions[0]?.description).toContain("AzooKey");
    expect(comparisonModeOptions[1]?.description).toContain("プリパス");
    expect(comparisonModeOptions[1]?.description).toContain("サイレント");
    expect(comparisonConfigFieldDescriptions.mode.toLowerCase()).toContain("vibrato");
    expect(comparisonConfigFieldDescriptions.websocketUrl).toContain("8787");
    expect(comparisonConfigFieldDescriptions.language).toContain("BCP-47");
    expect(comparisonConfigSchema.required).toEqual([
      "mode",
      "converterModel",
      "websocketUrl",
      "auth",
      "language",
    ]);
    expect(DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL).toBe("ws://127.0.0.1:8787/ws/azookey");
    expect(DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL).toBe(DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL);
    expect(DEFAULT_COMPARISON_CONFIG).toEqual({
      schemaVersion: 1,
      mode: "worker-vibrato",
      converterModel: "azookey-rust-wasm",
      websocketUrl: DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL,
      auth: { scheme: "none" },
      language: DEFAULT_COMPARISON_LANGUAGE,
      browserWasmModuleUrl: DEFAULT_BROWSER_WASM_MODULE_URL,
      browserWasmDictionaryUrl: DEFAULT_BROWSER_WASM_DICTIONARY_URL,
    });
    expect(DEFAULT_BROWSER_WASM_FEATURE_INDEX).toBe(7);
    expect(DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL).toMatch(/^ws:/);
  });

  it("describes browser WASM pre-pass configuration without implying silent worker-only fallback", () => {
    expect(hasBrowserWasmConfiguration({})).toBe(false);
    expect(hasBrowserWasmConfiguration({ browserWasmModuleUrl: "  " })).toBe(false);
    expect(hasBrowserWasmConfiguration({ browserWasmModuleUrl: "/wasm/mod.js" })).toBe(true);
    expect(hasBrowserWasmConfiguration({ browserWasmGlobalName: "__CUSTOM__" })).toBe(true);
    expect(comparisonModeOptions[1]?.description).toContain("必須");
    expect(comparisonModeOptions[1]?.description).not.toMatch(/任意|optional/i);
    expect(comparisonConfigFieldDescriptions.mode).toMatch(/Worker|browser/i);
    expect(comparisonConfigFieldDescriptions.mode).not.toMatch(/optional|任意/i);
    const unconfiguredStatus = browserWasmConfigurationStatus({});
    expect(unconfiguredStatus).toContain("未設定");
    expect(unconfiguredStatus).toContain("なければ変換は失敗");
    expect(unconfiguredStatus).not.toContain("未設定です。変換は失敗します");
    expect(browserWasmConfigurationStatus({ browserWasmModuleUrl: "  /wasm/mod.js  " })).toContain(
      "/wasm/mod.js",
    );
    expect(
      browserWasmConfigurationStatus({
        browserWasmModuleUrl: "/wasm/mod.js",
        browserWasmDictionaryUrl: "/dict/system.dic.zst",
      }),
    ).toContain("/dict/system.dic.zst");
    expect(browserWasmConfigurationStatus({ browserWasmGlobalName: "  __CUSTOM__  " })).toContain(
      "globalThis.__CUSTOM__",
    );
    expect(browserWasmConfigurationStatus({ browserWasmGlobalName: "__CUSTOM__" })).toContain(
      "Worker のみにはなりません",
    );
  });

  it("states the precedence and default global the loader actually applies", () => {
    // The loader reads globalThis before importing a module URL, and probes the
    // default global even with nothing configured. The status text must not
    // contradict either behaviour.
    expect(browserWasmConfigurationStatus({ browserWasmModuleUrl: "/wasm/mod.js" })).toContain(
      `globalThis.${DEFAULT_BROWSER_WASM_GLOBAL_NAME}`,
    );
    expect(browserWasmConfigurationStatus({ browserWasmModuleUrl: "/wasm/mod.js" })).toContain(
      "優先",
    );
    expect(browserWasmConfigurationStatus({})).toContain(
      `globalThis.${DEFAULT_BROWSER_WASM_GLOBAL_NAME}`,
    );
  });

  it("reports the explicit global name winning over a configured module URL", () => {
    // The loader probes the configured global name before the module URL, so
    // the status must say the global is tried first instead of promising the
    // module URL is what runs whenever it is set.
    const configuredGlobalName = "__CUSTOM__";
    const text = browserWasmConfigurationStatus({
      browserWasmModuleUrl: "/wasm/mod.js",
      browserWasmGlobalName: `  ${configuredGlobalName}  `,
    });
    expect(text).toContain(`globalThis.${configuredGlobalName}`);
    expect(text).not.toContain(`globalThis.${DEFAULT_BROWSER_WASM_GLOBAL_NAME}`);
    expect(text).toContain("/wasm/mod.js");
    expect(text.indexOf(`globalThis.${configuredGlobalName}`)).toBeLessThan(
      text.indexOf("/wasm/mod.js"),
    );
    expect(text).toContain("優先");
  });

  it("does not assert certain failure when nothing is configured", () => {
    // The runtime still probes the historical default global with no settings,
    // so the status may describe the conditional outcome but must not claim
    // the pre-pass is guaranteed to fail.
    const text = browserWasmConfigurationStatus({});
    expect(text).toContain("未設定");
    expect(text).toContain("注入されていれば");
  });

  it("recognizes modes and WebSocket URLs without accepting malformed values", () => {
    expect(isComparisonMode("worker-vibrato")).toBe(true);
    expect(isComparisonMode("browser-vibrato")).toBe(true);
    expect(isComparisonMode("other")).toBe(false);
    expect(isComparisonMode(1)).toBe(false);
    expect(isVibratoWebSocketUrl("ws://localhost:18082/ws")).toBe(true);
    expect(isVibratoWebSocketUrl("wss://example.com/recognition")).toBe(true);
    expect(isVibratoWebSocketUrl(" ws://example.com/ ")).toBe(true);
    expect(isVibratoWebSocketUrl("wss://user:pass@example.com/ws")).toBe(false);
    expect(isVibratoWebSocketUrl("http://example.com")).toBe(false);
    expect(isVibratoWebSocketUrl("ws://")).toBe(false);
    expect(isVibratoWebSocketUrl("not a URL")).toBe(false);
    expect(isVibratoWebSocketUrl(" ")).toBe(false);
    expect(isVibratoWebSocketUrl(null)).toBe(false);
  });

  it("validates and normalizes complete worker and browser configurations", () => {
    expect(
      validateComparisonConfig({
        mode: "worker-vibrato",
        websocketUrl: " wss://worker.example/ws/// ",
        auth: { scheme: "none" },
        language: " ja-JP ",
      }),
    ).toEqual({
      schemaVersion: 1,
      mode: "worker-vibrato",
      converterModel: "azookey-rust-wasm",
      websocketUrl: "wss://worker.example/ws",
      auth: { scheme: "none" },
      language: "ja-JP",
    });
    expect(
      validateComparisonConfig({
        schemaVersion: 1,
        mode: "browser-vibrato",
        websocketUrl: "ws://localhost:18082/ws",
        auth: { type: "bearer", token: " secret " },
        language: "en-US",
      }).auth,
    ).toEqual({ scheme: "bearer", token: "secret" });
    expect(
      validateComparisonConfig({
        mode: "worker-vibrato",
        websocketUrl: "wss://worker.example/ws",
        auth: { token: "secret" },
        language: "ja",
      }).auth,
    ).toEqual({ scheme: "bearer", token: "secret" });
    expect(
      validateComparisonConfig({
        mode: "worker-vibrato",
        websocketUrl: "wss://worker.example/ws",
        auth: " secret ",
        language: "ja",
      }).auth,
    ).toEqual({ scheme: "bearer", token: "secret" });
    expect(
      validateComparisonConfig({
        mode: "worker-vibrato",
        websocketUrl: "wss://worker.example/ws",
        auth: {},
        language: "ja",
      }).auth,
    ).toEqual({ scheme: "none" });
    expect(
      validateComparisonConfig({
        mode: "browser-vibrato",
        websocketUrl: "ws://localhost:18082/ws",
        auth: { scheme: "none" },
        language: "ja",
        browserWasmModuleUrl: "  /wasm/azookey.js  ",
        browserWasmDictionaryUrl: "  /dict/system.dic.zst  ",
        browserWasmGlobalName: "  __CUSTOM_VIBRATO__  ",
      }),
    ).toMatchObject({
      browserWasmModuleUrl: "/wasm/azookey.js",
      browserWasmDictionaryUrl: "/dict/system.dic.zst",
      browserWasmGlobalName: "__CUSTOM_VIBRATO__",
    });
  });

  it("rejects invalid configuration roots, versions, URLs, languages, and credentials", () => {
    expect(() => validateComparisonConfig(null)).toThrow("object");
    expect(() => validateComparisonConfig({})).toThrow("mode");
    const base = {
      mode: "worker-vibrato",
      websocketUrl: "ws://worker.example/ws",
      auth: { scheme: "none" },
      language: "ja",
    };
    expect(() => validateComparisonConfig({ ...base, schemaVersion: 2 })).toThrow("schemaVersion");
    expect(() =>
      validateComparisonConfig({ ...base, websocketUrl: "http://worker.example" }),
    ).toThrow("websocketUrl");
    expect(() => validateComparisonConfig({ ...base, language: " " })).toThrow("language");
    expect(() => validateComparisonConfig({ ...base, auth: null })).toThrow("auth");
    expect(() => validateComparisonConfig({ ...base, auth: { scheme: "invalid" } })).toThrow(
      "scheme",
    );
    expect(() =>
      validateComparisonConfig({ ...base, auth: { scheme: "none", token: "secret" } }),
    ).toThrow("cannot be supplied");
    expect(() => validateComparisonConfig({ ...base, auth: { scheme: "bearer" } })).toThrow(
      "required",
    );
    expect(() =>
      validateComparisonConfig({ ...base, auth: { scheme: "none", token: " " } }),
    ).toThrow("non-empty");
    expect(() => validateComparisonConfig({ ...base, auth: { token: 4 } })).toThrow("non-empty");
    expect(validateComparisonConfig({ ...base, auth: " " }).auth).toEqual({ scheme: "none" });
    expect(() => validateComparisonConfig({ ...base, browserWasmModuleUrl: 4 })).toThrow(
      "browserWasmModuleUrl",
    );
    expect(() => validateComparisonConfig({ ...base, browserWasmDictionaryUrl: 4 })).toThrow(
      "browserWasmDictionaryUrl",
    );
    expect(() =>
      validateComparisonConfig({ ...base, browserWasmModuleUrl: "javascript:alert(1)" }),
    ).toThrow("javascript");
    expect(() =>
      validateComparisonConfig({ ...base, browserWasmDictionaryUrl: "javascript:alert(1)" }),
    ).toThrow("javascript");
    expect(() => validateComparisonConfig({ ...base, browserWasmGlobalName: 4 })).toThrow(
      "browserWasmGlobalName",
    );
  });

  it("merges persisted values field-by-field and keeps safe defaults for malformed values", () => {
    expect(mergeComparisonConfig(undefined)).toEqual(DEFAULT_COMPARISON_CONFIG);
    expect(mergeComparisonConfig("invalid")).toEqual(DEFAULT_COMPARISON_CONFIG);
    expect(
      mergeComparisonConfig({
        mode: "browser-vibrato",
        language: " en-US ",
        auth: { token: " secret " },
      }),
    ).toEqual({
      schemaVersion: 1,
      mode: "browser-vibrato",
      converterModel: "azookey-rust-wasm",
      websocketUrl: DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL,
      auth: { scheme: "bearer", token: "secret" },
      language: "en-US",
      browserWasmModuleUrl: "/vibrato/vibrato_wasm.js",
      browserWasmDictionaryUrl: "/vibrato/system.dic.zst",
    });
    expect(
      mergeComparisonConfig({
        mode: "browser-vibrato",
        websocketUrl: "wss://custom.example/path///",
        auth: { scheme: "none" },
        language: "ja",
        browserWasmModuleUrl: "  /wasm/azookey.js  ",
        browserWasmGlobalName: "  __CUSTOM_VIBRATO__  ",
      }),
    ).toMatchObject({
      mode: "browser-vibrato",
      websocketUrl: "wss://custom.example/path",
      browserWasmModuleUrl: "/wasm/azookey.js",
      browserWasmGlobalName: "__CUSTOM_VIBRATO__",
    });
    expect(
      mergeComparisonConfig({
        mode: "worker-vibrato",
        websocketUrl: "not-valid",
        auth: { scheme: "bearer" },
        language: " ",
      }),
    ).toEqual(DEFAULT_COMPARISON_CONFIG);
    const malformedOptional = mergeComparisonConfig({
      mode: "unknown",
      websocketUrl: "ws://custom.example",
      auth: { scheme: "none" },
      language: "ja",
      browserWasmModuleUrl: "javascript:alert(1)",
      browserWasmDictionaryUrl: "javascript:alert(1)",
      browserWasmGlobalName: 4,
    });
    expect(malformedOptional).toMatchObject({
      mode: "worker-vibrato",
      websocketUrl: "ws://custom.example",
    });
    expect(malformedOptional.browserWasmModuleUrl).toBe("/vibrato/vibrato_wasm.js");
    expect(malformedOptional.browserWasmDictionaryUrl).toBe("/vibrato/system.dic.zst");
    expect(malformedOptional.browserWasmGlobalName).toBeUndefined();

    const explicitDictionary = mergeComparisonConfig({
      mode: "browser-vibrato",
      websocketUrl: "ws://custom.example",
      auth: { scheme: "none" },
      language: "ja",
      browserWasmModuleUrl: " /custom/vibrato.js ",
      browserWasmDictionaryUrl: " /custom/system.dic.zst ",
    });
    expect(explicitDictionary).toMatchObject({
      browserWasmModuleUrl: "/custom/vibrato.js",
      browserWasmDictionaryUrl: "/custom/system.dic.zst",
    });
    const clearedBrowserAssets = mergeComparisonConfig({
      mode: "browser-vibrato",
      websocketUrl: "ws://custom.example",
      auth: { scheme: "none" },
      language: "ja",
      browserWasmModuleUrl: " ",
      browserWasmDictionaryUrl: " ",
      browserWasmGlobalName: " ",
    });
    expect(clearedBrowserAssets.browserWasmModuleUrl).toBeUndefined();
    expect(clearedBrowserAssets.browserWasmDictionaryUrl).toBeUndefined();
  });

  it("parses serialized settings with a defensive fallback", () => {
    const json = JSON.stringify({
      mode: "browser-vibrato",
      websocketUrl: "ws://localhost:18082/ws",
      auth: { scheme: "none" },
      language: "ja",
    });
    expect(parseComparisonConfig(json).mode).toBe("browser-vibrato");
    expect(parseComparisonConfig("not-json")).toEqual(DEFAULT_COMPARISON_CONFIG);
    expect(parseComparisonConfig({ mode: "browser-vibrato" }).websocketUrl).toBe(
      DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL,
    );
  });

  it("builds validated endpoint URLs with only explicit non-secret query values", () => {
    expect(
      buildVibratoWebSocketUrl("wss://worker.example/ws///", {
        language: " ja ",
        retry: 2,
        enabled: false,
        token: "secret",
        empty: " ",
        omitted: undefined,
      }),
    ).toBe("wss://worker.example/ws?language=ja&retry=2&enabled=false");
    expect(
      buildVibratoWebSocketUrl({ websocketUrl: "ws://localhost:18082/ws" }, { query: "a b" }),
    ).toBe("ws://localhost:18082/ws?query=a+b");
    expect(() => buildVibratoWebSocketUrl("http://worker.example")).toThrow("websocketUrl");
    expect(() => buildVibratoWebSocketUrl({ websocketUrl: " " })).toThrow("websocketUrl");
    expect(
      buildVibratoWebSocketUrl("wss://worker.example/ws?existing=yes#fragment", {
        password: "secret",
        authorization: "Bearer nope",
        safe: "ok",
      }),
    ).toBe("wss://worker.example/ws?existing=yes&safe=ok#fragment");
  });
});
