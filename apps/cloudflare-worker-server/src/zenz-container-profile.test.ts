import { describe, expect, it } from "vitest";
import {
  parseConversionModel,
  parseZenzContainerProfile,
  zenzContainerBaseUrl,
  zenzModelSize,
} from "./zenz-container-profile";

describe("Zenz Container profiles", () => {
  it("parses conversion choices including disabled conversion", () => {
    expect(parseConversionModel("none")).toBe("none");
    expect(parseConversionModel("zenz-v3.2-xsmall-gguf")).toBe("zenz-v3.2-xsmall-gguf");
    expect(parseConversionModel("zenz-v3.2-small-gguf")).toBe("zenz-v3.2-small-gguf");
    expect(parseConversionModel("other")).toBeNull();
    expect(parseConversionModel(null)).toBeNull();
  });

  it("selects model size without forcing GGUF conversion", () => {
    expect(zenzModelSize("zenz-v3.2-small-gguf", null)).toBe("small");
    expect(zenzModelSize("zenz-v3.2-xsmall-gguf", "small")).toBe("xsmall");
    expect(zenzModelSize("none", "small")).toBe("small");
    expect(zenzModelSize("none", null)).toBe("xsmall");
  });

  it("requires explicit compute and N5 selections", () => {
    const form = new FormData();
    form.set("computeTier", "basic");
    form.set("n5Lm", "on");
    form.set("containerModel", "small");
    expect(parseZenzContainerProfile(form, "none")).toStrictEqual({
      computeTier: "basic",
      modelSize: "small",
      n5Mode: "on",
    });

    const missing = new FormData();
    expect(parseZenzContainerProfile(missing, "zenz-v3.2-xsmall-gguf")).toBeNull();
  });

  it("builds the private profile route", () => {
    expect(
      zenzContainerBaseUrl("https://zenz.internal/", {
        computeTier: "standard",
        modelSize: "xsmall",
        n5Mode: "off",
      }),
    ).toBe("https://zenz.internal/standard/xsmall/n5-off");
  });
});
