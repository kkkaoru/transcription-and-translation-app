import { describe, expect, it } from "vitest";
import {
  nextOutputPrefix,
  orchestrateOneCompletion,
  trimZenzLeftContext,
  ZENZ_CONTEXT_MAX_GRAPHEMES,
  ZENZ_INPUT_TAG,
  ZENZ_LEFT_CONTEXT_TAG,
  ZENZ_OUTPUT_TAG,
  zenzCandidatePrompt,
} from "./zenz-one-completion.js";

describe("one-completion Zenz orchestration", () => {
  it("trims left context to the last 40 graphemes", () => {
    expect(trimZenzLeftContext("短い")).toBe("短い");
    expect(trimZenzLeftContext("あ".repeat(41))).toBe("あ".repeat(ZENZ_CONTEXT_MAX_GRAPHEMES));
    expect(trimZenzLeftContext("👨‍👩‍👧‍👦x".repeat(21)).length).toBeGreaterThan(0);
  });

  it("omits the left-context tag when context is empty", () => {
    expect(zenzCandidatePrompt("かんじ", "")).toBe(`${ZENZ_INPUT_TAG}カンジ${ZENZ_OUTPUT_TAG}`);
    expect(zenzCandidatePrompt("かんじ")).toBe(`${ZENZ_INPUT_TAG}カンジ${ZENZ_OUTPUT_TAG}`);
  });

  it("prefixes converted left context with EE02 and keeps the input as katakana", () => {
    expect(zenzCandidatePrompt("かんじ", "子供がお菓子を食べています。")).toBe(
      `${ZENZ_LEFT_CONTEXT_TAG}子供がお菓子を食べています。${ZENZ_INPUT_TAG}カンジ${ZENZ_OUTPUT_TAG}`,
    );
  });

  it("asks for the next completion scalar when the candidate diverges", () => {
    expect(nextOutputPrefix("漢字", "感じ")).toStrictEqual(new TextEncoder().encode("感"));
    expect(nextOutputPrefix("感じ", "感じ")).toBe("verified");
    expect(nextOutputPrefix("高精度な測定が必要ですx", "高精度な測定が必要です")).toBe("fallback");
  });

  it("keeps the dictionary baseline when left context is empty", () => {
    const result = orchestrateOneCompletion({
      input: "かんじ",
      leftContext: "   ",
      baseline: "漢字",
      completion: "感じ",
      search: { searchOutputPrefix: () => "感じ" },
    });
    expect(result).toStrictEqual({ text: "漢字", iterations: 0, usedCompletion: false });
  });

  it("constrains the lattice with the next completion scalar", () => {
    const prefixes: string[] = [];
    const result = orchestrateOneCompletion({
      input: "かんじ",
      leftContext: "子供がお菓子を食べています。",
      baseline: "漢字",
      completion: "感じ",
      search: {
        searchOutputPrefix: (prefix) => {
          prefixes.push(new TextDecoder().decode(prefix));
          return "感じ";
        },
      },
    });
    expect(prefixes).toStrictEqual(["感"]);
    expect(result).toStrictEqual({ text: "感じ", iterations: 2, usedCompletion: true });
  });

  it("fails open to the baseline when constrained search is empty", () => {
    const result = orchestrateOneCompletion({
      input: "かんじ",
      leftContext: "子供がお菓子を食べています。",
      baseline: "漢字",
      completion: "感じ",
      search: { searchOutputPrefix: () => undefined },
    });
    expect(result).toStrictEqual({ text: "漢字", iterations: 1, usedCompletion: false });
  });

  it("fails open to the baseline when the deadline expires", () => {
    const result = orchestrateOneCompletion({
      input: "かんじ",
      leftContext: "子供がお菓子を食べています。",
      baseline: "漢字",
      completion: "感じ",
      remainingMs: () => 0,
      search: { searchOutputPrefix: () => "感じ" },
    });
    expect(result).toStrictEqual({ text: "漢字", iterations: 0, usedCompletion: false });
  });

  it("fails open to the baseline when search throws", () => {
    const result = orchestrateOneCompletion({
      input: "かんじ",
      leftContext: "子供がお菓子を食べています。",
      baseline: "漢字",
      completion: "感じ",
      search: {
        searchOutputPrefix: () => {
          throw new Error("wasm trap");
        },
      },
    });
    expect(result).toStrictEqual({ text: "漢字", iterations: 1, usedCompletion: false });
  });

  it("fails open to the baseline after the iteration cap", () => {
    let searches = 0;
    const result = orchestrateOneCompletion({
      input: "かんじ",
      leftContext: "子供がお菓子を食べています。",
      baseline: "漢字",
      completion: "感じました",
      maxIterations: 2,
      search: {
        searchOutputPrefix: () => {
          searches += 1;
          return searches === 1 ? "感" : "感じ";
        },
      },
    });
    expect(searches).toBe(2);
    expect(result).toStrictEqual({ text: "漢字", iterations: 2, usedCompletion: false });
  });

  it("fails open to the baseline when constrained search returns empty text", () => {
    const result = orchestrateOneCompletion({
      input: "かんじ",
      leftContext: "子供がお菓子を食べています。",
      baseline: "漢字",
      completion: "感じ",
      search: { searchOutputPrefix: () => "" },
    });
    expect(result).toStrictEqual({ text: "漢字", iterations: 1, usedCompletion: false });
  });
});
