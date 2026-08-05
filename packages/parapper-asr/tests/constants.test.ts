import { describe, expect, it } from "vitest";

import {
  asrModelOption,
  completionAsrModelOptions,
  interimOnlyAsrModelOptions,
} from "../src/lib/constants";
import type { AsrModel } from "../src/lib/types";

describe("asr model option helpers", () => {
  it("finds a known model", () => {
    expect(asrModelOption("reazonspeech_k2_v2")?.value).toBe(
      "reazonspeech_k2_v2",
    );
  });

  it("falls back to the first option for an unknown model", () => {
    const result = asrModelOption("not_a_real_model" as AsrModel);
    expect(result?.value).toBe("reazonspeech_k2_v2");
  });

  it("splits completion and interim-only model lists", () => {
    expect(completionAsrModelOptions.length).toBeGreaterThan(0);
    expect(interimOnlyAsrModelOptions.length).toBeGreaterThan(0);
    expect(
      completionAsrModelOptions.every(
        (option) => option.capability === "completion_and_interim",
      ),
    ).toBe(true);
    expect(
      interimOnlyAsrModelOptions.every(
        (option) => option.capability === "interim_only",
      ),
    ).toBe(true);
  });
});
