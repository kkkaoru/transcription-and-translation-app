import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import type { AppConfig, CaptionPayload } from "../core/types";
import { createPreviewCaption } from "./captions";
import {
  beginNativePublish,
  completeNativePublishSuccess,
  createNativePublishGate,
  framePaintKey,
  renderNativeFrame,
} from "./NativeFramePublisher";

const withBudget = (source: number, translation: number): AppConfig => {
  const config = createDefaultConfig();
  config.overlay.captionMaxChars = { source, translation };
  return config;
};

interface FillCall {
  text: string;
  y: number;
}

/**
 * Wide canvas whose per-glyph width never forces a pixel wrap, so any line
 * break the native/Syphon path paints came from the configured character
 * budget rather than from measured width. Bounds, legacy fallback, and the DOM
 * re-split are covered by captions-preview and CaptionOverlay.maxChars tests;
 * this file pins the native canvas path specifically.
 */
const createWideCanvasHarness = () => {
  const canvas = document.createElement("canvas");
  const fillCalls: FillCall[] = [];
  const context = {
    clearRect: () => undefined,
    fill: () => undefined,
    fillRect: () => undefined,
    fillText: (text: string, _x: number, y: number) => fillCalls.push({ text, y }),
    getImageData: () =>
      ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }) as ImageData,
    measureText: (text: string): TextMetrics => ({ width: Array.from(text).length }) as TextMetrics,
    restore: () => undefined,
    save: () => undefined,
    setTransform: () => undefined,
    strokeText: () => undefined,
    set globalCompositeOperation(_value: string) {
      /* no-op */
    },
  } as unknown as CanvasRenderingContext2D;
  Object.defineProperty(canvas, "getContext", { configurable: true, value: () => context });
  return { canvas, fillCalls };
};

describe("configurable budget changes the native/Syphon line split", () => {
  it("paints more baselines as the budget shrinks even when pixels would fit one line", () => {
    const sourceText = "あ".repeat(40);
    const caption: CaptionPayload = { ...createPreviewCaption(), sourceText, translationText: "" };

    const renderRows = (budget: number): FillCall[] => {
      const config = withBudget(budget, 48);
      // A very wide block with no padding keeps pixel wrapping from firing, so
      // the character budget alone decides the line count.
      config.overlay.width = 6_000;
      config.overlay.height = 400;
      config.overlay.safeAreaPx = 0;
      config.overlay.source.fontSizePx = 20;
      config.overlay.source.maxWidthPercent = 100;
      config.overlay.source.paddingX = 0;
      const { canvas, fillCalls } = createWideCanvasHarness();
      expect(renderNativeFrame(canvas, config, caption)).not.toBeNull();
      return fillCalls;
    };

    const wide = renderRows(40);
    const narrow = renderRows(10);
    const wideBaselines = new Set(wide.map((call) => call.y)).size;
    const narrowBaselines = new Set(narrow.map((call) => call.y)).size;

    expect(wideBaselines).toBe(1);
    // CAPTION_MAX_VISIBLE_LINES=2: a tighter budget paints up to two lines of
    // the newest window.
    expect(narrowBaselines).toBe(2);
    expect(narrow.map((call) => call.text).join("")).toBe("あ".repeat(20));
  });

  it("repaints on a budget-only change (framePaintKey and publish gate invalidate)", () => {
    const base = createDefaultConfig();
    base.overlay.captionMaxChars = { source: 40, translation: 48 };
    const caption = createPreviewCaption();

    const keyWide = framePaintKey(base, caption);

    // Same display inputs except the caption budget: this must change the key
    // so the native publish gate schedules a repaint instead of skipping.
    const narrowed: AppConfig = { ...base, overlay: { ...base.overlay } };
    narrowed.overlay.captionMaxChars = { source: 10, translation: 48 };
    const keyNarrowed = framePaintKey(narrowed, caption);
    expect(keyNarrowed).not.toBe(keyWide);

    const gate = createNativePublishGate();
    expect(beginNativePublish(gate, keyWide)).toEqual({ action: "publish", key: keyWide });
    // A successful publish records the wide key…
    expect(completeNativePublishSuccess(gate, keyWide)).toBeNull();
    expect(beginNativePublish(gate, keyWide)).toEqual({ action: "skip" });
    // …so a budget-only change must be treated as a new frame and republished.
    expect(beginNativePublish(gate, keyNarrowed)).toEqual({ action: "publish", key: keyNarrowed });
  });

  it("keeps the budget out of the key when it is absent (undefined legacy config)", () => {
    const base = createDefaultConfig();
    base.overlay.captionMaxChars = undefined;
    const caption = createPreviewCaption();

    expect(framePaintKey(base, caption)).toBe(framePaintKey({ ...base }, caption));
  });

  it("applies the DOM gap floor and frontend fallbacks so the native frame matches", () => {
    // The DOM overlay and OBS page render `gap: max(10, gapPx)`; the native
    // canvas must use the same floor so a user setting gapPx < 10 does not
    // collapse spacing in one renderer only. It must also fall back to the
    // canonical frontend values (gap 14, y 88) for non-finite input like the
    // DOM reference instead of an internal stale default.
    const harness = createWideCanvasHarness();
    const config = withBudget(48, 48);
    config.overlay.width = 6_000;
    config.overlay.height = 400;
    config.overlay.safeAreaPx = 0;
    config.overlay.source.fontSizePx = 20;
    config.overlay.translation.fontSizePx = 20;
    config.overlay.source.maxWidthPercent = 100;
    config.overlay.translation.maxWidthPercent = 100;
    config.overlay.source.paddingX = 0;
    config.overlay.source.paddingY = 0;
    config.overlay.translation.paddingX = 0;
    config.overlay.translation.paddingY = 0;
    config.overlay.source.lineHeight = 1;
    config.overlay.translation.lineHeight = 1;
    config.overlay.gapPx = 4; // below the DOM floor
    config.overlay.captionYPercent = 88;
    const caption: CaptionPayload = {
      ...createPreviewCaption(),
      sourceText: "ああああ",
      translationText: "b",
    };

    expect(renderNativeFrame(harness.canvas, config, caption)).not.toBeNull();
    const rowsY = [...new Set(harness.fillCalls.map((call) => call.y))].sort((a, b) => a - b);
    // Two single-line rows with zero padding: each row is one lineHeight (20px)
    // and the baseline delta includes that line-height plus the gap floored to
    // 10px -> 30px apart, proving max(10, gapPx).
    expect(rowsY).toHaveLength(2);
    expect((rowsY[1] ?? 0) - (rowsY[0] ?? 0)).toBe(30);

    // Non-finite gap and y must fall back to the frontend canonical values.
    const fallbackHarness = createWideCanvasHarness();
    const fallbackConfig = withBudget(48, 48);
    fallbackConfig.overlay.width = 6_000;
    fallbackConfig.overlay.height = 400;
    fallbackConfig.overlay.safeAreaPx = 0;
    fallbackConfig.overlay.source.fontSizePx = 20;
    fallbackConfig.overlay.translation.fontSizePx = 20;
    fallbackConfig.overlay.source.maxWidthPercent = 100;
    fallbackConfig.overlay.translation.maxWidthPercent = 100;
    fallbackConfig.overlay.source.paddingX = 0;
    fallbackConfig.overlay.source.paddingY = 0;
    fallbackConfig.overlay.translation.paddingX = 0;
    fallbackConfig.overlay.translation.paddingY = 0;
    fallbackConfig.overlay.source.lineHeight = 1;
    fallbackConfig.overlay.translation.lineHeight = 1;
    // Poison the values the native canvas must fold back from.
    fallbackConfig.overlay.gapPx = Number.NaN;
    fallbackConfig.overlay.captionYPercent = Number.NaN;
    const fallbackCaption: CaptionPayload = {
      ...createPreviewCaption(),
      sourceText: "ああああ",
      translationText: "b",
    };
    expect(
      renderNativeFrame(fallbackHarness.canvas, fallbackConfig, fallbackCaption),
    ).not.toBeNull();

    // With NaN gap the fallback is 14 (>= floor), and the baseline delta is
    // lineHeight + max(10, 14) = 20 + 14 = 34.
    const fallbackRowsY = [...new Set(fallbackHarness.fillCalls.map((call) => call.y))].sort(
      (a, b) => a - b,
    );
    expect((fallbackRowsY[1] ?? 0) - (fallbackRowsY[0] ?? 0)).toBe(34);
    const maxY = Math.max(...fallbackHarness.fillCalls.map((call) => call.y));
    expect(maxY).toBeGreaterThan(340);
    expect(maxY).toBeLessThan(370);
  });

  it("counts the budget in grapheme clusters, not code points, on the native canvas", () => {
    // Mirrors the DOM grapheme test: a ZWJ family emoji is one grapheme and a
    // dakuten combining mark shares a grapheme with its base kana. The budget
    // must count clusters, so the native/Syphon canvas never paints a dangling
    // ZWJ or combining mark at the start of a line. The shared segmenter
    // guarantees this; this pins it through the native render path.
    const family = "👨‍👩‍👧"; // one grapheme, multiple code points
    const combining = "か\u3099"; // kana + combining dakuten, one grapheme
    const text = family + combining + family + combining;
    const graphemesOf = (input: string): string[] =>
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(input)].map(
        (part) => part.segment,
      );

    const config = withBudget(2, 2);
    config.overlay.width = 6_000;
    config.overlay.height = 400;
    config.overlay.safeAreaPx = 0;
    config.overlay.source.fontSizePx = 20;
    config.overlay.source.maxWidthPercent = 100;
    config.overlay.source.paddingX = 0;
    const caption: CaptionPayload = {
      ...createPreviewCaption(),
      sourceText: text,
      translationText: "",
    };
    const { canvas, fillCalls } = createWideCanvasHarness();

    expect(renderNativeFrame(canvas, config, caption)).not.toBeNull();

    const painted = fillCalls.map((call) => call.text).join("");
    const paintedGraphemes = graphemesOf(painted);
    expect(painted).toBe(text);
    expect(fillCalls.some((call) => call.text.startsWith("\u200D"))).toBe(false);
    expect(paintedGraphemes.some((cluster) => cluster.startsWith("\u3099"))).toBe(false);
    expect(paintedGraphemes.length).toBe(4);
  });

  it("reserves translation row height when translation text is empty", () => {
    const withTranslation = withBudget(48, 48);
    withTranslation.overlay.width = 6_000;
    withTranslation.overlay.height = 400;
    withTranslation.overlay.safeAreaPx = 0;
    withTranslation.overlay.source.fontSizePx = 20;
    withTranslation.overlay.translation.fontSizePx = 20;
    withTranslation.overlay.source.lineHeight = 1;
    withTranslation.overlay.translation.lineHeight = 1;
    withTranslation.overlay.source.paddingY = 0;
    withTranslation.overlay.translation.paddingY = 0;
    withTranslation.overlay.gapPx = 10;
    withTranslation.overlay.captionYPercent = 50;

    const both = createWideCanvasHarness();
    expect(
      renderNativeFrame(both.canvas, withTranslation, {
        ...createPreviewCaption(),
        sourceText: "あ",
        translationText: "b",
      }),
    ).not.toBeNull();
    const bothYs = [...new Set(both.fillCalls.map((call) => call.y))].sort((a, b) => a - b);

    const sourceOnly = createWideCanvasHarness();
    expect(
      renderNativeFrame(sourceOnly.canvas, withTranslation, {
        ...createPreviewCaption(),
        sourceText: "あ",
        translationText: "",
      }),
    ).not.toBeNull();
    const sourceYs = [...new Set(sourceOnly.fillCalls.map((call) => call.y))].sort((a, b) => a - b);

    // Source baseline stays put when translation is absent (reserved empty row).
    expect(sourceYs[0]).toBe(bothYs[0]);
  });
});
