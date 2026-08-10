import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASR_CONFUSION_RULES,
  DEFAULT_INPUT_N5_LM_RESCORE_ENABLED,
  INPUT_N5_LM_MODEL_ID,
  INPUT_N5_LM_RECOMMENDED_OVERCORRECTION_MARGIN,
  applyInputN5LmRescore,
  createDefaultInputN5LmRescorer,
  createInputN5LmRescorer,
  generateAsrConfusionCandidates,
  isSaneInputN5LmOutput,
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

  it("generates voicing, semi-voicing, gemination, and long-vowel deletion candidates", () => {
    expect(generateAsrConfusionCandidates("かいとう").some((c) => c.text === "がいとう")).toBe(true);
    expect(generateAsrConfusionCandidates("はな").some((c) => c.text === "ぱな")).toBe(true);
    expect(generateAsrConfusionCandidates("きて").some((c) => c.text === "きって")).toBe(true);
    expect(generateAsrConfusionCandidates("きって").some((c) => c.text === "きて")).toBe(true);
    expect(generateAsrConfusionCandidates("おはよう").some((c) => c.text === "おはよ")).toBe(true);
    expect(generateAsrConfusionCandidates("しち").some((c) => c.text === "いち")).toBe(true);
    expect(generateAsrConfusionCandidates("か").some((c) => c.text === "が")).toBe(true);
    expect(generateAsrConfusionCandidates("い").some((c) => c.text === "し")).toBe(true);
    expect(generateAsrConfusionCandidates("ん").some((c) => c.text === "む")).toBe(true);
  });

  it("includes the empty hypothesis and expands edit-2 when maxEdits is 2", () => {
    const empty = generateAsrConfusionCandidates("");
    expect(empty).toEqual([{ text: "", confusionCost: 0 }]);

    const edit2 = generateAsrConfusionCandidates("か", {
      ...DEFAULT_ASR_CONFUSION_RULES,
      maxEdits: 2,
    });
    expect(edit2.some((c) => c.text === "か")).toBe(true);
    expect(edit2.length).toBeGreaterThan(generateAsrConfusionCandidates("か").length);
  });

  it("repairs the measured long-vowel rescue with recommended weights", () => {
    const rescorer = createDefaultInputN5LmRescorer();
    expect(rescorer.best("おはよございます")).toBe("おはようございます");
    const ranked = rescorer.rescore("おはよございます");
    expect(ranked[0]?.text).toBe("おはようございます");
  });

  it("holds correct geminated forms under the recommended overcorrection margin", () => {
    const rescorer = createDefaultInputN5LmRescorer();
    expect(rescorer.best("きってください")).toBe("きってください");
    expect(INPUT_N5_LM_RECOMMENDED_OVERCORRECTION_MARGIN).toBe(2);
  });

  it("keeps unknown readings unchanged when LM scores cannot discriminate", () => {
    const rescorer = createDefaultInputN5LmRescorer();
    expect(rescorer.best("きょうのてんき")).toBe("きょうのてんき");
  });

  it("applyInputN5LmRescore returns timing and marks changed when enabled", () => {
    const result = applyInputN5LmRescore("おはよございます", true);
    expect(result.text).toBe("おはようございます");
    expect(result.changed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.model).toBe("input-n5-lm-v1");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("respects a high overcorrection margin and NaN-safe ranking", () => {
    const scores: Record<string, number> = {
      おはよございます: -20,
      おはようございます: -10,
    };
    const gated = createInputN5LmRescorer((text) => scores[text] ?? -30, DEFAULT_ASR_CONFUSION_RULES, {
      lmWeight: 1,
      confusionWeight: 1,
      overcorrectionMargin: 100,
    });
    expect(gated.best("おはよございます")).toBe("おはよございます");

    const nanScorer = createInputN5LmRescorer(
      (text) => (text === "おはようございます" ? Number.NaN : -10),
      DEFAULT_ASR_CONFUSION_RULES,
      { lmWeight: 1, confusionWeight: 0, overcorrectionMargin: 0 },
    );
    expect(nanScorer.best("おはよございます")).toBe("おはよございます");
  });

  it("rejects insane replacements via the output sanity guard", () => {
    const rescorer = createInputN5LmRescorer(
      (text) => {
        if (text === "") {
          return 0;
        }
        if (text === "おはよございます") {
          return -100;
        }
        return -50;
      },
      { ...DEFAULT_ASR_CONFUSION_RULES, maxEdits: 1 },
      { lmWeight: 1, confusionWeight: 0, overcorrectionMargin: 0 },
    );
    // Empty candidate is never preferred over a non-empty original.
    expect(rescorer.best("おはよございます")).not.toBe("");

    const blank = createInputN5LmRescorer(() => -1);
    expect(blank.best("")).toBe("");
    expect(blank.best("   ")).toBe("   ");
  });

  it("covers mora substitution and vowel rows used by AsrConfusionRules", () => {
    expect(generateAsrConfusionCandidates("む").some((c) => c.text === "ん")).toBe(true);
    expect(generateAsrConfusionCandidates("る").some((c) => c.text === "う")).toBe(true);
    expect(generateAsrConfusionCandidates("な").some((c) => c.text === "ら")).toBe(true);
    expect(generateAsrConfusionCandidates("ら").some((c) => c.text === "な")).toBe(true);
    expect(generateAsrConfusionCandidates("お").some((c) => c.text === "う")).toBe(true);
    expect(generateAsrConfusionCandidates("ち").some((c) => c.text === "し")).toBe(true);
    expect(generateAsrConfusionCandidates("ぱ").some((c) => c.text === "は")).toBe(true);
    expect(generateAsrConfusionCandidates("や").some((c) => c.text === "やあ")).toBe(true);
    expect(generateAsrConfusionCandidates("せ").some((c) => c.text === "せい")).toBe(true);
    expect(generateAsrConfusionCandidates("あ").some((c) => c.text === "ああ")).toBe(true);
    expect(generateAsrConfusionCandidates("い").some((c) => c.text === "いい")).toBe(true);
    expect(generateAsrConfusionCandidates("う").some((c) => c.text === "うう")).toBe(true);
    expect(generateAsrConfusionCandidates("わ").some((c) => c.text === "わあ")).toBe(true);
    expect(generateAsrConfusionCandidates("を").some((c) => c.text === "をう")).toBe(true);
    expect(generateAsrConfusionCandidates("んあ").some((c) => c.confusionCost >= 0)).toBe(true);
  });

  it("ranks equal combined scores stably and keeps holds for measured pairs", () => {
    const equal = createInputN5LmRescorer(() => -10, DEFAULT_ASR_CONFUSION_RULES, {
      lmWeight: 0,
      confusionWeight: 0,
      overcorrectionMargin: 0,
    });
    expect(equal.best("ありがとう")).toBe("ありがとう");
    expect(equal.rescore("あ").length).toBeGreaterThan(0);

    const bothNan = createInputN5LmRescorer(() => Number.NaN, DEFAULT_ASR_CONFUSION_RULES, {
      lmWeight: 1,
      confusionWeight: 1,
      overcorrectionMargin: 0,
    });
    expect(bothNan.best("あ")).toBe("あ");
  });

  it("exposes the Rust-equivalent output sanity guard", () => {
    expect(isSaneInputN5LmOutput("", "")).toBe(true);
    expect(isSaneInputN5LmOutput("", "あ")).toBe(false);
    expect(isSaneInputN5LmOutput("   ", "  ")).toBe(true);
    expect(isSaneInputN5LmOutput("   ", "あ")).toBe(false);
    expect(isSaneInputN5LmOutput("あ", "")).toBe(false);
    expect(isSaneInputN5LmOutput("あ", "あ")).toBe(true);
    expect(isSaneInputN5LmOutput("あ", "a")).toBe(false);
    expect(isSaneInputN5LmOutput("a1", "a1")).toBe(true);
    expect(isSaneInputN5LmOutput("あ", "あああああああああああああああああああああ")).toBe(false);
    expect(isSaneInputN5LmOutput("あいうえおかきくけこ", "あ")).toBe(false);
  });
});
