import { afterEach, describe, expect, it, vi } from "vitest";

import {
  languageOptions,
  localTranslationModelOptions,
  makeId,
  modelOptionsWithAny,
  translationLanguageOptions,
} from "../src/lib/mapping-options";
import type { AsrModel } from "../src/lib/types";

describe("mapping option lists", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes the translatable language list", () => {
    expect(languageOptions.length).toBeGreaterThan(0);
    expect(languageOptions[0]).toEqual({ value: "ja_JP", label: "ja_JP" });
  });

  it("exposes the translation target languages", () => {
    expect(translationLanguageOptions).toEqual([
      { value: "ja", label: "ja" },
      { value: "en", label: "en" },
    ]);
  });

  it("exposes the local translation model options", () => {
    expect(localTranslationModelOptions).toEqual([
      {
        value: "lfm2_q4",
        label: "LFM2-350M-ENJP-MT-ONNX / ONNX Community Q4",
      },
    ]);
  });

  it("builds prefixed ids", () => {
    expect(makeId("row").startsWith("row-")).toBe(true);
  });

  it("falls back to a timestamp when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    const id = makeId("row");
    expect(id.startsWith("row-")).toBe(true);
    expect(id.length).toBeGreaterThan("row-".length);
  });

  it("prepends the any option ahead of the model select options", () => {
    const options = [{ value: "reazonspeech_k2_v2" as AsrModel, label: "K2" }];
    expect(modelOptionsWithAny("Any ASR", options)).toEqual([
      { value: "any", label: "Any ASR" },
      { value: "reazonspeech_k2_v2", label: "K2" },
    ]);
  });
});
