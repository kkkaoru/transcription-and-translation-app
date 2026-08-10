import { describe, expect, it } from "vitest";
import { buildNormalizeStep, normalizeSourceText } from "./conversion-trace";
import { normalizeAsrSourceText } from "./normalize-asr-source-text";

/**
 * Cloudflare Workers AI ASR / Web Speech が日本語トークン間に挟む空白を除去する。
 * Vibrato / AzooKey はスペース区切りを別語として壊すため、sourceText 正規化が必須。
 */
describe("Japanese ASR sourceText spacing normalization", () => {
  it.each([
    {
      label: "compound nouns and verb stem split",
      raw: "暑い 日は暑い 食べ 物を 食べた くない。",
      expected: "暑い日は暑い食べ物を食べたくない。",
    },
    {
      label: "kanji and particle spacing (降水 / 六十)",
      raw: "降 水 確率 は 六 十 パーセント です。",
      expected: "降水確率は六十パーセントです。",
    },
    {
      label: "mid-word splits around の / 晴れ",
      raw: "明日 の天 気は 晴 れ です。",
      expected: "明日の天気は晴れです。",
    },
  ])("removes Japanese token spaces: $label", ({ raw, expected }) => {
    expect(normalizeAsrSourceText(raw)).toBe(expected);
    expect(normalizeSourceText(raw)).toBe(expected);
  });

  it("strips full-width spaces between Japanese characters", () => {
    expect(normalizeAsrSourceText("明日　の　天気")).toBe("明日の天気");
    expect(normalizeSourceText("明日　の　天気")).toBe("明日の天気");
  });

  it("keeps Latin word spaces while still trimming edges", () => {
    expect(normalizeAsrSourceText("  hello world  ")).toBe("hello world");
    expect(normalizeSourceText("  hello world  ")).toBe("hello world");
  });

  it("marks the normalize step as changed when mid-token spaces are removed", () => {
    const raw = "降 水 確率 は 六 十 パーセント です。";
    const normalized = normalizeSourceText(raw);
    expect(normalized).not.toBe(raw.trim());
    expect(buildNormalizeStep(raw, normalized).detail).not.toContain("変更なし");
    expect(buildNormalizeStep(raw, normalized).detail).toMatch(/空白/);
  });
});
