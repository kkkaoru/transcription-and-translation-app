import { describe, expect, it } from "vitest";
import {
  browserWasmConfigurationStatus,
  buildVibratoWebSocketUrl,
  COMPARISON_CONFIG_SCHEMA_VERSION,
  COMPARISON_MODES,
  comparisonConfigFieldDescriptions,
  comparisonConfigSchema,
  comparisonModeOptions,
  DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL,
  DEFAULT_BROWSER_WASM_GLOBAL_NAME,
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
    for (const option of comparisonModeOptions) {
      expect(option.label.toLowerCase()).not.toContain("vibrato");
      expect(option.description.toLowerCase()).toContain("azookey");
      expect(option.description.toLowerCase()).toMatch(/vibrato|unidic/);
      expect(option.description).toMatch(/使いません/);
    }
    expect(comparisonModeOptions[0]?.description).toContain("AzooKey WASM");
    expect(comparisonModeOptions[1]?.description).toContain("プリパス");
    expect(comparisonModeOptions[1]?.description).toContain("サイレント");
    expect(comparisonConfigFieldDescriptions.mode.toLowerCase()).not.toMatch(
      /vibrato runs|run vibrato/i,
    );
    expect(comparisonConfigFieldDescriptions.websocketUrl).toContain("8787");
    expect(comparisonConfigFieldDescriptions.language).toContain("BCP-47");
    expect(comparisonConfigSchema.required).toEqual(["mode", "websocketUrl", "auth", "language"]);
    expect(DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL).toBe("ws://127.0.0.1:8787/ws/azookey");
    expect(DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL).toBe(DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL);
    expect(DEFAULT_COMPARISON_CONFIG).toEqual({
      schemaVersion: 1,
      mode: "worker-vibrato",
      websocketUrl: DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL,
      auth: { scheme: "none" },
      language: DEFAULT_COMPARISON_LANGUAGE,
    });
    expect(DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL).toMatch(/^ws:/);
  });

  it("describes browser WASM pre-pass configuration without implying silent worker-only fallback", () => {
    expect(hasBrowserWasmConfiguration({})).toBe(false);
    expect(hasBrowserWasmConfiguration({ browserWasmModuleUrl: "  " })).toBe(false);
    expect(hasBrowserWasmConfiguration({ browserWasmModuleUrl: "/wasm/mod.js" })).toBe(true);
    expect(hasBrowserWasmConfiguration({ browserWasmGlobalName: "__CUSTOM__" })).toBe(true);
    expect(browserWasmConfigurationStatus({})).toContain("未設定");
    expect(browserWasmConfigurationStatus({})).toContain("失敗");
    expect(browserWasmConfigurationStatus({ browserWasmModuleUrl: "  /wasm/mod.js  " })).toContain(
      "/wasm/mod.js",
    );
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
        browserWasmGlobalName: "  __CUSTOM_VIBRATO__  ",
      }),
    ).toMatchObject({
      browserWasmModuleUrl: "/wasm/azookey.js",
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
    expect(() =>
      validateComparisonConfig({ ...base, browserWasmModuleUrl: "javascript:alert(1)" }),
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
      websocketUrl: DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL,
      auth: { scheme: "bearer", token: "secret" },
      language: "en-US",
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
      browserWasmGlobalName: 4,
    });
    expect(malformedOptional).toMatchObject({
      mode: "worker-vibrato",
      websocketUrl: "ws://custom.example",
    });
    expect(malformedOptional.browserWasmModuleUrl).toBeUndefined();
    expect(malformedOptional.browserWasmGlobalName).toBeUndefined();
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
