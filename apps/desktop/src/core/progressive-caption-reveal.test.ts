import { selectVisibleCaptionSentence } from "@caption-bridge/sentence-boundary";
import { describe, expect, it } from "vitest";
import {
  advanceProgressiveReveal,
  immediateProgressiveRevealStart,
  progressiveRevealStepMs,
  resolveProgressiveRevealSourceTarget,
  shouldProgressivelyReveal,
} from "./progressive-caption-reveal";
import type { CaptionPayload } from "./types";

const caption = (partial: Partial<CaptionPayload> = {}): CaptionPayload => ({
  id: "parapper:session:turn:1",
  sourceText: "",
  translationText: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 1,
  receivedAt: 1,
  stage: "source",
  sequence: 0,
  isFinal: false,
  ...partial,
});

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

  it("targets the newest paged sentence so multi-clause reveal does not pass through one-grapheme fragments", () => {
    const fullSource = "今日は晴れです。明日は雨です";
    const multiClause = caption({
      sourceText: fullSource,
      isFinal: true,
    });
    const revealTarget = resolveProgressiveRevealSourceTarget(multiClause);
    expect(revealTarget).toBe("明日は雨です");

    // Bug without targeting: progressive growth of the raw full sourceText recreates
    // finished-clause prefixes; overlay sentence paging then collapses mid-animation
    // to a one-grapheme fragment (e.g. 「今日は晴れです。明」 → 「明」).
    const rawSteps: string[] = [];
    let rawDisplayed = "";
    while (rawDisplayed !== fullSource) {
      rawDisplayed = advanceProgressiveReveal(rawDisplayed, fullSource);
      rawSteps.push(rawDisplayed);
    }
    const collapsedRawSteps = rawSteps
      .map((step) => selectVisibleCaptionSentence(step))
      .filter((visible, index) => visible.length === 1 && rawSteps[index]!.includes("。"));
    expect(collapsedRawSteps.length).toBeGreaterThan(0);
    expect(collapsedRawSteps[0]).toBe("明");

    // Revealing toward the already-paged sentence never recreates prior clauses,
    // so pager collapse cannot fire mid-animation.
    let displayed = "";
    const steps: string[] = [];
    while (displayed !== revealTarget) {
      displayed = advanceProgressiveReveal(displayed, revealTarget);
      steps.push(displayed);
    }
    expect(steps[0]).toBe("明");
    expect(steps.at(-1)).toBe("明日は雨です");
    expect(steps.some((step) => step.includes("今日は晴れです"))).toBe(false);
    expect(
      steps
        .map((step) => selectVisibleCaptionSentence(step))
        .every((visible, index) => visible === steps[index]),
    ).toBe(true);
  });

  it("keeps a single-clause or greeting continuation as the reveal target", () => {
    expect(resolveProgressiveRevealSourceTarget(caption({ sourceText: "こんにちは" }))).toBe(
      "こんにちは",
    );
    expect(
      resolveProgressiveRevealSourceTarget(
        caption({
          sourceText: "こんにちはーきこえますか",
          sentenceEndOffsets: [5],
        }),
      ),
    ).toBe("こんにちはーきこえますか");
  });
});
