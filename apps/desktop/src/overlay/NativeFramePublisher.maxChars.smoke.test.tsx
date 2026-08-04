import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import type { AppConfig, CaptionPayload } from "../core/types";
import { createPreviewCaption } from "./captions";
import { renderNativeFrame } from "./NativeFramePublisher";

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
    fillText: (text: string, _x: number, y: number) => fillCalls.push({ text, y }),
    getImageData: () =>
      ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }) as ImageData,
    measureText: (text: string): TextMetrics => ({ width: Array.from(text).length }) as TextMetrics,
    restore: () => undefined,
    save: () => undefined,
    strokeText: () => undefined,
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
    expect(narrowBaselines).toBeGreaterThan(wideBaselines);
    // Segmentation only inserts breaks; no source graphemes are dropped.
    expect(narrow.map((call) => call.text).join("")).toBe(sourceText);
  });
});
