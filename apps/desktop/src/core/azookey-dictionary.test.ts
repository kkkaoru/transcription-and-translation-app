import { describe, expect, it } from "vitest";
import {
  OFFICIAL_AZOOKEY_DICTIONARY_URL,
  pathForAzooKeySystemDictionarySource,
  resolveAzooKeySystemDictionarySource,
} from "./azookey-dictionary";

describe("azookey system dictionary source helpers", () => {
  it("treats empty / whitespace as builtin", () => {
    expect(resolveAzooKeySystemDictionarySource(undefined)).toBe("builtin");
    expect(resolveAzooKeySystemDictionarySource(null)).toBe("builtin");
    expect(resolveAzooKeySystemDictionarySource("")).toBe("builtin");
    expect(resolveAzooKeySystemDictionarySource("   ")).toBe("builtin");
  });

  it("detects the pinned official archive URL", () => {
    expect(resolveAzooKeySystemDictionarySource(OFFICIAL_AZOOKEY_DICTIONARY_URL)).toBe("official");
  });

  it("treats any other path or URL as custom", () => {
    expect(resolveAzooKeySystemDictionarySource("/models/azookey-dict")).toBe("custom");
    expect(resolveAzooKeySystemDictionarySource("https://example.com/dict.tar.gz")).toBe("custom");
  });

  it("maps sources back to configured path values", () => {
    expect(pathForAzooKeySystemDictionarySource("builtin")).toBe("");
    expect(pathForAzooKeySystemDictionarySource("official")).toBe(OFFICIAL_AZOOKEY_DICTIONARY_URL);
    expect(pathForAzooKeySystemDictionarySource("custom", "/tmp/dict")).toBe("/tmp/dict");
  });

  it("clears the custom draft when switching from the official URL", () => {
    expect(pathForAzooKeySystemDictionarySource("custom", OFFICIAL_AZOOKEY_DICTIONARY_URL)).toBe(
      "",
    );
  });
});
