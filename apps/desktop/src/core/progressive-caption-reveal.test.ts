import { describe, expect, it } from "vitest";
import {
  advanceProgressiveReveal,
  progressiveRevealStepMs,
  shouldProgressivelyReveal,
} from "./progressive-caption-reveal";

describe("progressive caption reveal", () => {
  it("treats prefix growth as progressive recognition steps", () => {
    expect(shouldProgressivelyReveal("", "こんにちは")).toBe(true);
    expect(shouldProgressivelyReveal("こん", "こんにちは")).toBe(true);
    expect(shouldProgressivelyReveal("こんにちは", "こんにちは")).toBe(false);
    expect(shouldProgressivelyReveal("あしたは", "明日は")).toBe(false);
  });

  it("advances one grapheme at a time toward こんにちは", () => {
    let displayed = "";
    const target = "こんにちは";
    const steps: string[] = [];
    while (displayed !== target) {
      displayed = advanceProgressiveReveal(displayed, target);
      steps.push(displayed);
    }
    expect(steps).toEqual(["こ", "こん", "こんに", "こんにち", "こんにちは"]);
  });

  it("snaps immediately on kana-to-kanji rewrites", () => {
    expect(advanceProgressiveReveal("あしたは", "明日は")).toBe("明日は");
  });

  it("keeps per-grapheme delay bounded for long jumps", () => {
    expect(progressiveRevealStepMs(1)).toBeGreaterThan(0);
    expect(progressiveRevealStepMs(100)).toBeLessThanOrEqual(420);
    expect(progressiveRevealStepMs(0)).toBe(0);
  });
});
