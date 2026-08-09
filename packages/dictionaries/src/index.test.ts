import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS,
  AZOOKEY_DICTIONARY_CONFIG_KEY_LIST,
  AZOOKEY_DICTIONARY_CONFIG_KEYS,
  AZOOKEY_DICTIONARY_KIND,
  AZOOKEY_MAX_DICTIONARY_TIMEOUT_MS,
  AZOOKEY_MIN_DICTIONARY_TIMEOUT_MS,
  clampDictionaryTimeoutMs,
  classifyDictionaryLocator,
  configKeyForDictionaryKind,
  DEFAULT_AZOOKEY_SYSTEM_ASSET_PATH,
  DEFAULT_VIBRATO_IPADIC_ASSET_PATH,
  DESKTOP_DICTIONARY_DOWNLOAD_TIMEOUT_MS,
  DESKTOP_MAX_DOWNLOAD_BYTES,
  DICTIONARY_WARM_MOMENT,
  dictionaryKindFromConfigKey,
  isAllowedDictionaryLocator,
  isHttpsDictionaryUrl,
  isNonTlsHttpDictionaryUrl,
  resolvedPathKey,
  VIBRATO_IPADIC_FEATURE_INDEX,
} from "./index.js";

describe("Tauri-matching dictionary contract", () => {
  it("keeps desktop config keys and kind names aligned", () => {
    expect(AZOOKEY_DICTIONARY_CONFIG_KEY_LIST).toEqual([
      "azookey-rust",
      "azookey-user-dictionary",
      "azookey-learning-memory",
    ]);
    expect(dictionaryKindFromConfigKey(AZOOKEY_DICTIONARY_CONFIG_KEYS.system)).toBe(
      AZOOKEY_DICTIONARY_KIND.system,
    );
    expect(dictionaryKindFromConfigKey("azookey-user-dictionary")).toBe("user");
    expect(dictionaryKindFromConfigKey("azookey-learning-memory")).toBe("learning-memory");
    expect(dictionaryKindFromConfigKey("vibrato-ipadic")).toBeUndefined();
    expect(dictionaryKindFromConfigKey("")).toBeUndefined();
    expect(configKeyForDictionaryKind("system")).toBe("azookey-rust");
    expect(configKeyForDictionaryKind("user")).toBe("azookey-user-dictionary");
    expect(configKeyForDictionaryKind("learning-memory")).toBe("azookey-learning-memory");
    expect(resolvedPathKey("azookey-rust")).toBe("azookey-rust-resolved");
    expect(VIBRATO_IPADIC_FEATURE_INDEX).toBe(7);
    expect(DEFAULT_AZOOKEY_SYSTEM_ASSET_PATH).toBe("/azookey/system.azkdict.gz");
    expect(DEFAULT_VIBRATO_IPADIC_ASSET_PATH).toBe("/vibrato/system.dic.zst");
    expect(DICTIONARY_WARM_MOMENT.desktopCaptureStart).toBe("capture-start");
    expect(DICTIONARY_WARM_MOMENT.workerWebSocketUpgrade).toBe("websocket-upgrade");
    expect(DICTIONARY_WARM_MOMENT.browserConnectOrListen).toBe("connect-or-listen-start");
  });

  it("stays aligned with Tauri dictionary_resolve.rs keys, kinds, and download bounds", () => {
    const rustPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../apps/desktop/src-tauri/src/dictionary_resolve.rs",
    );
    const rust = readFileSync(rustPath, "utf8");
    const keysBlock = rust.match(
      /pub const DICTIONARY_CONFIG_KEYS: &\[&str\]\s*=\s*&\[([\s\S]*?)\]/,
    );
    expect(keysBlock).not.toBeNull();
    const rustKeys = [...(keysBlock?.[1]?.matchAll(/"([^"]+)"/g) ?? [])].map((match) => match[1]);
    expect(rustKeys).toEqual([...AZOOKEY_DICTIONARY_CONFIG_KEY_LIST]);
    expect(rust).toContain('Self::System => "system"');
    expect(rust).toContain('Self::User => "user"');
    expect(rust).toContain('Self::Learning => "learning-memory"');
    expect(DESKTOP_MAX_DOWNLOAD_BYTES).toBe(64 * 1024 * 1024);
    expect(rust).toContain("const MAX_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024");
    expect(rust).toContain(
      `const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(${DESKTOP_DICTIONARY_DOWNLOAD_TIMEOUT_MS / 1000})`,
    );
  });

  it("classifies locators the same way desktop rejects plain HTTP", () => {
    expect(classifyDictionaryLocator(" https://dict.example/system.azkdict.gz ")).toEqual({
      type: "https",
      href: "https://dict.example/system.azkdict.gz",
    });
    expect(classifyDictionaryLocator("http://127.0.0.1:8787/azookey/system.azkdict.gz")).toEqual({
      type: "http",
      href: "http://127.0.0.1:8787/azookey/system.azkdict.gz",
    });
    expect(classifyDictionaryLocator("/azookey/system.azkdict.gz")).toEqual({
      type: "absolute-path",
      path: "/azookey/system.azkdict.gz",
    });
    expect(classifyDictionaryLocator("vibrato/system.dic.zst")).toEqual({
      type: "relative",
      path: "vibrato/system.dic.zst",
    });
    expect(classifyDictionaryLocator("")).toEqual({ type: "invalid", reason: "empty" });
    expect(classifyDictionaryLocator("javascript:alert(1)")).toEqual({
      type: "invalid",
      reason: "javascript-url",
    });
    expect(classifyDictionaryLocator("file:///tmp/system.dic.zst")).toEqual({
      type: "invalid",
      reason: "unsupported-scheme",
    });
    expect(classifyDictionaryLocator("https://[")).toEqual({
      type: "invalid",
      reason: "malformed-url",
    });
    expect(isHttpsDictionaryUrl("https://dict.example/a")).toBe(true);
    expect(isHttpsDictionaryUrl("http://dict.example/a")).toBe(false);
    expect(isNonTlsHttpDictionaryUrl("http://dict.example/a")).toBe(true);
    expect(isNonTlsHttpDictionaryUrl("https://dict.example/a")).toBe(false);
  });

  it("allows locators per runtime the way Tauri / Worker / browser fetch them", () => {
    expect(isAllowedDictionaryLocator("https://dict.example/a", "desktop")).toBe(true);
    expect(isAllowedDictionaryLocator("http://dict.example/a", "desktop")).toBe(false);
    expect(isAllowedDictionaryLocator("/Users/me/azookey", "desktop")).toBe(true);
    expect(isAllowedDictionaryLocator("./cache/system", "desktop")).toBe(true);
    expect(isAllowedDictionaryLocator("file:///tmp/dict", "desktop")).toBe(false);

    expect(isAllowedDictionaryLocator("https://dict.example/a", "worker")).toBe(true);
    expect(isAllowedDictionaryLocator("http://127.0.0.1:8787/a", "worker")).toBe(true);
    expect(isAllowedDictionaryLocator("/azookey/system.azkdict.gz", "worker")).toBe(true);
    expect(isAllowedDictionaryLocator("./local.azkdict.gz", "worker")).toBe(false);
    expect(isAllowedDictionaryLocator("javascript:alert(1)", "worker")).toBe(false);

    expect(isAllowedDictionaryLocator("/vibrato/system.dic.zst", "browser")).toBe(true);
    expect(isAllowedDictionaryLocator("vibrato/system.dic.zst", "browser")).toBe(true);
    expect(isAllowedDictionaryLocator("https://cdn.example/system.dic.zst", "browser")).toBe(true);
    expect(
      isAllowedDictionaryLocator("http://127.0.0.1:3000/vibrato/system.dic.zst", "browser"),
    ).toBe(true);
    expect(isAllowedDictionaryLocator("file:///tmp/system.dic.zst", "browser")).toBe(false);
  });

  it("clamps dictionary fetch timeouts separately from conversion latency", () => {
    expect(clampDictionaryTimeoutMs(undefined)).toBe(AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS);
    expect(clampDictionaryTimeoutMs("")).toBe(AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS);
    expect(clampDictionaryTimeoutMs("not-a-number")).toBe(AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS);
    expect(clampDictionaryTimeoutMs("500")).toBe(AZOOKEY_MIN_DICTIONARY_TIMEOUT_MS);
    expect(clampDictionaryTimeoutMs("1100")).toBe(1_100);
    expect(clampDictionaryTimeoutMs("120000")).toBe(AZOOKEY_MAX_DICTIONARY_TIMEOUT_MS);
  });
});
