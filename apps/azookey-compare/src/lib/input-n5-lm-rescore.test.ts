import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_N5_LM_RESCORE_ENABLED,
  INPUT_N5_LM_MODEL_ID,
  applyInputN5LmRescore,
  createDefaultInputN5LmRescorer,
  generateAsrConfusionCandidates,
} from "./input-n5-lm-rescore";

describe("input_n5_lm_v1 rescore (compare)", () => {
  it("defaults off so existing conversion behavior is unchanged", () => {
    expect(DEFAULT_INPUT_N5_LM_RESCORE_ENABLED).toBe(false);
    expect(INPUT_N5_LM_MODEL_ID).toBe("input-n5-lm-v1");
    expect(applyInputN5LmRescore("おはよございます", false)).toEqual({
      text: "おはよございます",
      changed: false,
      skipped: true,
    });
  });

  it("generates long-vowel insertion candidates from AsrConfusionRules", () => {
    const texts = generateAsrConfusionCandidates("おはよございます").map((c) => c.text);
    expect(texts).toContain("おはようございます");
    expect(texts).toContain("おはよございます");
  });

  it("repairs the measured long-vowel rescue with recommended weights", () => {
    const rescorer = createDefaultInputN5LmRescorer();
    expect(rescorer.best("おはよございます")).toBe("おはようございます");
  });

  it("holds correct geminated forms under the recommended overcorrection margin", () => {
    const rescorer = createDefaultInputN5LmRescorer();
    expect(rescorer.best("きってください")).toBe("きってください");
  });

  it("applyInputN5LmRescore returns timing and marks changed when enabled", () => {
    const result = applyInputN5LmRescore("おはよございます", true);
    expect(result.text).toBe("おはようございます");
    expect(result.changed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.model).toBe("input-n5-lm-v1");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
