// Runs with Bun during test.
import { describe, expect, it } from "vitest";
import {
  frameForElapsed,
  HARNESS_SCENARIOS,
  type HarnessScenario,
  languageLabel,
  posteriorData,
  scenarioById,
} from "./scenarios";

const EMPTY_SCENARIO: HarnessScenario = {
  id: "empty",
  label: "Empty",
  description: "No frames",
  expected: "Unknown",
  frames: [],
};

describe("language harness scenarios", () => {
  it("keeps Japanese stable after short ambiguous borrowed terms", () => {
    const scenario = scenarioById("ja-ambiguous");
    const frame = frameForElapsed(scenario, 3_200);

    expect(frame.stableLanguage).toBe("ja");
    expect(frame.candidateLanguage).toBe("en");
    expect(frame.candidateEvidence).toBe(0.7);
    expect(frame.transcript).toBe("OK、次は AI の結果を確認します。");
  });

  it("represents deliberate bidirectional switching", () => {
    const scenario = scenarioById("ja-en-ja");

    expect(frameForElapsed(scenario, 0).stableLanguage).toBe("ja");
    expect(frameForElapsed(scenario, 3_100).stableLanguage).toBe("en");
    expect(frameForElapsed(scenario, 6_100).stableLanguage).toBe("ja");
  });

  it("does not force unsupported evidence into Japanese or English", () => {
    const scenario = scenarioById("unsupported");
    const frame = frameForElapsed(scenario, 3_100);

    expect(frame.stableLanguage).toBe("unsupported");
    expect(frame.acoustic).toStrictEqual({
      ja: 0.01,
      en: 0.01,
      unknown: 0.02,
      unsupported: 0.96,
    });
  });

  it("clamps completed scenarios and falls back for unknown identifiers", () => {
    expect(frameForElapsed(scenarioById("unsupported"), 4_600).stableLanguage).toBe("unsupported");
    expect(frameForElapsed(scenarioById("unsupported"), -1).stableLanguage).toBe("unknown");
    expect(frameForElapsed(EMPTY_SCENARIO, 0).stableLanguage).toBe("unknown");
    expect(scenarioById("missing").id).toBe("ja-ambiguous");
    expect(HARNESS_SCENARIOS.length).toBe(3);
  });

  it("exposes posterior data and readable labels in stable order", () => {
    expect(posteriorData({ ja: 0.7, en: 0.2, unknown: 0.08, unsupported: 0.02 })).toStrictEqual([
      { language: "ja", probability: 0.7 },
      { language: "en", probability: 0.2 },
      { language: "unknown", probability: 0.08 },
      { language: "unsupported", probability: 0.02 },
    ]);
    expect(languageLabel("ja")).toBe("Japanese");
    expect(languageLabel("en")).toBe("English");
    expect(languageLabel("unknown")).toBe("Unknown");
    expect(languageLabel("unsupported")).toBe("Unsupported");
  });
});
