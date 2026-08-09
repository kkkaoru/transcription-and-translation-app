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
  });
});
