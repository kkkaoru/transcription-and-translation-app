import { describe, expect, it } from "vitest";
import {
  advanceProgressiveReveal,
  immediateProgressiveRevealStart,
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

  it("is a no-op when displayed already matches the target", () => {
    expect(advanceProgressiveReveal("こんにちは", "こんにちは")).toBe("こんにちは");
  });

  it("snaps when displayed already has at least as many graphemes as the target", () => {
    // Defensive branch: longer displayed with non-prefix target is a snap;
    // equal grapheme count with progressive false also snaps via rewrite path.
    expect(advanceProgressiveReveal("こんに", "こん")).toBe("こん");
  });

  it("paints the first grapheme immediately when the plate is empty", () => {
    expect(immediateProgressiveRevealStart("", "こんにちは")).toBe("こ");
    expect(immediateProgressiveRevealStart("   ", "こんにちは")).toBe("こ");
    // Already painted text must not jump ahead of the timer-driven steps.
    expect(immediateProgressiveRevealStart("こ", "こんにちは")).toBe("こ");
    // Single-grapheme targets are not progressive and snap fully.
    expect(immediateProgressiveRevealStart("", "あ")).toBe("あ");
    // Multi-grapheme still only seeds the first character (rest is timed).
    expect(immediateProgressiveRevealStart("", "明日は")).toBe("明");
  });

  it("keeps per-grapheme delay bounded for long jumps", () => {
    expect(progressiveRevealStepMs(1)).toBeGreaterThan(0);
    expect(progressiveRevealStepMs(100)).toBeLessThanOrEqual(160);
    expect(progressiveRevealStepMs(0)).toBe(0);
  });
});
