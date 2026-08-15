import { describe, expect, it } from "vitest";
import {
  CONVERTER_MODELS,
  converterModelOptions,
  DEFAULT_CONVERTER_MODEL,
  isConverterModel,
  isZenzConverterModel,
} from "./converter-models";

describe("converter model catalog", () => {
  it("exposes wasm plus Zenzai xsmall/small for UI selection", () => {
    expect(CONVERTER_MODELS).toEqual([
      "azookey-rust-wasm",
      "zenz-v3.2-xsmall-gguf",
      "zenz-v3.2-small-gguf",
    ]);
    expect(DEFAULT_CONVERTER_MODEL).toBe("azookey-rust-wasm");
    expect(converterModelOptions).toHaveLength(3);
    expect(isConverterModel("zenz-v3.2-xsmall-gguf")).toBe(true);
    expect(isConverterModel("zenz-v3.2-small-gguf")).toBe(true);
    expect(isConverterModel("unknown")).toBe(false);
    expect(isZenzConverterModel("azookey-rust-wasm")).toBe(false);
    expect(isZenzConverterModel("zenz-v3.2-small-gguf")).toBe(true);
    expect(converterModelOptions[0]?.description).toContain("ブラウザ完結");
    expect(converterModelOptions[0]?.description).not.toContain("ブラウザ簡潔");
    expect(converterModelOptions[1]?.description).toContain("browser-complete ではありません");
    expect(converterModelOptions[1]?.description).toContain(
      "MODEL_ROUTES が空なら品質は辞書のまま",
    );
    expect(converterModelOptions[2]?.description).toContain("入力と左文脈を remote へ送ります");
  });

  it("keeps the remote-not-browser-complete label on the selectable Zenz options", () => {
    const values = converterModelOptions.map((option) => option.value);
    expect(values).toStrictEqual([
      "azookey-rust-wasm",
      "zenz-v3.2-xsmall-gguf",
      "zenz-v3.2-small-gguf",
    ]);
    expect(converterModelOptions[1]?.description).toContain("入力と左文脈を remote へ送ります");
    expect(converterModelOptions[1]?.description).toContain("browser-complete ではありません");
    expect(converterModelOptions[2]?.description).toContain("browser-complete ではありません");
  });
});
