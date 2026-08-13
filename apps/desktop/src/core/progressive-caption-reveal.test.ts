import { selectVisibleCaptionSentence } from "@caption-bridge/sentence-boundary";
import { describe, expect, it } from "vitest";
import { buildCaptionAbMatrix } from "../overlay/caption-surface-ab.matrix";
import { captionGraphemes } from "../overlay/captions";
import {
  advanceProgressiveReveal,
  alignCaptionOffsetsToPaintedSource,
  immediateProgressiveRevealStart,
  isSingleGraphemeCaptionSurface,
  progressiveRevealStepMs,
  resolveProgressiveRevealSourceTarget,
  shouldHoldSingleGraphemeFirstPaint,
  shouldProgressivelyReveal,
  shouldSnapProgressiveFirstPaint,
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

  it("snaps an empty plate to the full first hypothesis in one step", () => {
    expect(advanceProgressiveReveal("", "こんにちは")).toBe("こんにちは");
    expect(advanceProgressiveReveal("   ", "明日は雨です")).toBe("明日は雨です");
  });

  it("advances one grapheme at a time after the first hypothesis is on the plate", () => {
    let displayed = "こ";
    const target = "こんにちは";
    const steps: string[] = [];
    while (displayed !== target) {
      displayed = advanceProgressiveReveal(displayed, target);
      steps.push(displayed);
    }
    expect(steps).toEqual(["こん", "こんに", "こんにち", "こんにちは"]);
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

  it("paints the full first hypothesis immediately when the plate is empty", () => {
    expect(immediateProgressiveRevealStart("", "こんにちは")).toBe("こんにちは");
    expect(immediateProgressiveRevealStart("   ", "こんにちは")).toBe("こんにちは");
    // Already painted text must not jump ahead of the timer-driven steps.
    expect(immediateProgressiveRevealStart("こ", "こんにちは")).toBe("こ");
    expect(immediateProgressiveRevealStart("", "あ")).toBe("あ");
    expect(immediateProgressiveRevealStart("", "明日は")).toBe("明日は");
  });

  it("snaps the first visible paint to a longer surface that is already available", () => {
    expect(shouldSnapProgressiveFirstPaint("こ", "こんにちは", true)).toBe(true);
    expect(shouldSnapProgressiveFirstPaint("こ", "こんにちは", false)).toBe(false);
    expect(shouldSnapProgressiveFirstPaint("こんにちは", "こんにちは", true)).toBe(false);
    expect(shouldSnapProgressiveFirstPaint("", "こんにちは", true)).toBe(true);
  });

  it("holds a one-grapheme first hypothesis until the first frame commits", () => {
    expect(shouldHoldSingleGraphemeFirstPaint("", "こ", true)).toBe(true);
    expect(shouldHoldSingleGraphemeFirstPaint("", "あ", true)).toBe(true);
    expect(shouldHoldSingleGraphemeFirstPaint("", "こんにちは", true)).toBe(false);
    expect(shouldHoldSingleGraphemeFirstPaint("", "こ", false)).toBe(false);
    expect(shouldHoldSingleGraphemeFirstPaint("こ", "こ", true)).toBe(false);
    expect(isSingleGraphemeCaptionSurface("こ")).toBe(true);
    expect(isSingleGraphemeCaptionSurface("こんにちは")).toBe(false);
  });

  it("still grows a committed lead into the concatenated line after the 16ms first frame", () => {
    for (const row of buildCaptionAbMatrix()) {
      if (!row.tail) {
        continue;
      }
      const target = resolveProgressiveRevealSourceTarget(caption({ sourceText: row.full }));
      expect(shouldSnapProgressiveFirstPaint(row.lead, target, false), row.id).toBe(false);
      expect(shouldProgressivelyReveal(row.lead, target), row.id).toBe(true);
      let displayed = row.lead;
      while (displayed !== target) {
        const next = advanceProgressiveReveal(displayed, target);
        expect(next, row.id).not.toBe(displayed);
        displayed = next;
      }
      expect(displayed, row.id).toContain(row.lead);
      expect(displayed, row.id).toContain(row.tail);
    }
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
    let rawDisplayed = captionGraphemes(fullSource)[0] ?? "";
    rawSteps.push(rawDisplayed);
    while (rawDisplayed !== fullSource) {
      rawDisplayed = advanceProgressiveReveal(rawDisplayed, fullSource);
      rawSteps.push(rawDisplayed);
    }
    const collapsedRawSteps = rawSteps
      .map((step) => selectVisibleCaptionSentence(step))
      .filter((visible, index) => visible.length === 1 && rawSteps[index]?.includes("。"));
    expect(collapsedRawSteps.length).toBeGreaterThan(0);
    expect(collapsedRawSteps[0]).toBe("明");

    // Empty plate snaps to the already-paged sentence in one step, so pager
    // collapse cannot fire mid-animation.
    let displayed = "";
    const steps: string[] = [];
    while (displayed !== revealTarget) {
      displayed = advanceProgressiveReveal(displayed, revealTarget);
      steps.push(displayed);
    }
    expect(steps).toEqual(["明日は雨です"]);
    expect(steps.some((step) => step.includes("今日は晴れです"))).toBe(false);
    expect(
      steps
        .map((step) => selectVisibleCaptionSentence(step))
        .every((visible, index) => visible === steps[index]),
    ).toBe(true);
  });

  it("keeps the lead sentence as the reveal target unless punctuation or a 2x tail pages", () => {
    const text = "今日は晴れです明日は雨";
    expect(
      resolveProgressiveRevealSourceTarget(
        caption({ sourceText: text, provisional: true, isFinal: false }),
      ),
    ).toBe(text);
    expect(
      resolveProgressiveRevealSourceTarget(caption({ sourceText: text, isFinal: false })),
    ).toBe(text);
    expect(
      resolveProgressiveRevealSourceTarget(
        caption({
          sourceText: "今日は晴れです。明日は雨",
          provisional: true,
          isFinal: false,
        }),
      ),
    ).toBe("明日は雨");
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

  it("drops full-text sentenceEndOffsets on progressive partial paints", () => {
    const full = "今日は寒い明日は";
    const payload = caption({
      sourceText: full,
      sentenceEndOffsets: [5],
      softBreakOffsets: [3],
    });

    // Full-surface copula offsets keep the longer lead when the tail is shorter.
    expect(alignCaptionOffsetsToPaintedSource(payload, full)).toBe(payload);
    expect(selectVisibleCaptionSentence(full, { sentenceEndOffsets: [5] })).toBe(full);

    // Mid-reveal prefixes with a stale full-text end also keep the longer lead.
    const partial = "今日は寒い明";
    expect(selectVisibleCaptionSentence(partial, { sentenceEndOffsets: [5] })).toBe(partial);

    const aligned = alignCaptionOffsetsToPaintedSource(payload, partial);
    expect(aligned.sourceText).toBe(partial);
    expect(aligned.sentenceEndOffsets).toBeUndefined();
    expect(aligned.softBreakOffsets).toBeUndefined();
    expect(
      selectVisibleCaptionSentence(aligned.sourceText, {
        sentenceEndOffsets: aligned.sentenceEndOffsets,
      }),
    ).toBe(partial);
  });

  it("keeps greeting continuation prefixes intact when Vibrato ends would page mid-reveal", () => {
    const spoken = "こんにちはーきこえますか";
    const payload = caption({
      sourceText: spoken,
      sentenceEndOffsets: [5],
    });
    expect(resolveProgressiveRevealSourceTarget(payload)).toBe(spoken);

    const mid = "こんにちはー";
    const aligned = alignCaptionOffsetsToPaintedSource(payload, mid);
    expect(aligned.sentenceEndOffsets).toBeUndefined();
    expect(
      selectVisibleCaptionSentence(aligned.sourceText, {
        sentenceEndOffsets: aligned.sentenceEndOffsets,
      }),
    ).toBe(mid);
  });

  it("does not paint a lone ー when a longer greeting continuation is already available", () => {
    const spoken = "こんにちはーきこえますか";
    const payload = caption({
      sourceText: spoken,
      sentenceEndOffsets: [5],
    });
    expect(resolveProgressiveRevealSourceTarget(payload)).toBe(spoken);
    expect(alignCaptionOffsetsToPaintedSource(payload, "ー").sourceText).toBe(spoken);
    expect(alignCaptionOffsetsToPaintedSource(payload, "ーきこえますか").sourceText).toBe(spoken);
  });

  it("does not page a greeting to a hearing-check tail after bang/question punct", () => {
    const spoken = "こんにちは！きこえますか";
    const payload = caption({ sourceText: spoken });
    expect(resolveProgressiveRevealSourceTarget(payload)).toBe("こんにちは！きこえますか");
    expect(alignCaptionOffsetsToPaintedSource(payload, "きこえますか").sourceText).toBe(
      "こんにちは！きこえますか",
    );
    expect(
      resolveProgressiveRevealSourceTarget(caption({ sourceText: "こんにちは。終えますか" })),
    ).toBe("聞こえますか");
  });

  it("drops full-text ends so last-sentence prefixes are not clipped mid-reveal", () => {
    // Reveal already targets the newest clause. Full-text offset 4 still sits
    // inside a 5-grapheme prefix of that clause and would page to 「て」.
    const full = "短いです今日はとても良い天気です";
    const payload = caption({
      sourceText: full,
      sentenceEndOffsets: [4],
    });
    const revealTarget = resolveProgressiveRevealSourceTarget(payload);
    expect(revealTarget).toBe("今日はとても良い天気です");

    const mid = "今日はとて";
    expect(selectVisibleCaptionSentence(mid, { sentenceEndOffsets: [4] })).toBe(mid);

    const aligned = alignCaptionOffsetsToPaintedSource(payload, mid);
    expect(aligned.sentenceEndOffsets).toBeUndefined();
    expect(
      selectVisibleCaptionSentence(aligned.sourceText, {
        sentenceEndOffsets: aligned.sentenceEndOffsets,
      }),
    ).toBe(mid);

    let displayed = "";
    const visibleSteps: string[] = [];
    while (displayed !== revealTarget) {
      displayed = advanceProgressiveReveal(displayed, revealTarget);
      const paint = alignCaptionOffsetsToPaintedSource(payload, displayed);
      visibleSteps.push(
        selectVisibleCaptionSentence(paint.sourceText, {
          sentenceEndOffsets: paint.sentenceEndOffsets,
        }),
      );
    }
    expect(visibleSteps).not.toContain("て");
    expect(visibleSteps.at(-1)).toBe(revealTarget);
    expect(visibleSteps.some((step) => step.startsWith("今日はとて"))).toBe(true);
  });
});
