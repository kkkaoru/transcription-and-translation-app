import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import type { CaptionPayload } from "../core/types";
import { createPreviewCaption } from "./captions";
import { renderNativeFrame, wrapNativeText } from "./NativeFramePublisher";

interface FillCall {
  text: string;
  x: number;
  y: number;
}

const createCanvasHarness = () => {
  const canvas = document.createElement("canvas");
  const fillCalls: FillCall[] = [];
  const measureText = (text: string): TextMetrics =>
    ({ width: Array.from(text).length * 10 }) as TextMetrics;
  const context = {
    clearRect: () => undefined,
    fill: () => undefined,
    fillText: (text: string, x: number, y: number) => fillCalls.push({ text, x, y }),
    getImageData: () =>
      ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }) as ImageData,
    measureText,
    restore: () => undefined,
    save: () => undefined,
    strokeText: () => undefined,
  } as unknown as CanvasRenderingContext2D;
  Object.defineProperty(canvas, "getContext", { configurable: true, value: () => context });
  return { canvas, fillCalls };
};

describe("native caption canvas wrapping", () => {
  it("wraps long Japanese and Latin captions without dropping graphemes", () => {
    const source = "これは長い日本語字幕です。自然な折り返しで読みやすさを保ちます。";
    const translation =
      "A deliberately long English caption should wrap at whitespace when possible.";
    const measure = (text: string) => Array.from(text).length * 10;

    const sourceLines = wrapNativeText(source, 80, measure);
    const translationLines = wrapNativeText(translation, 100, measure);

    expect(sourceLines.length).toBeGreaterThan(1);
    expect(sourceLines.join("")).toBe(source);
    expect(translationLines.length).toBeGreaterThan(1);
    expect(translationLines.join("")).toBe(translation);
    expect(translationLines.slice(0, -1).some((line) => /\s$/u.test(line))).toBe(true);

    const explicitBreaks = "first\n\n最後";
    expect(wrapNativeText(explicitBreaks, 200, measure).join("\n")).toBe(explicitBreaks);
  });

  it("paints wrapped lines at separate baselines instead of shrinking one long line", () => {
    const config = createDefaultConfig();
    config.overlay.width = 320;
    config.overlay.height = 240;
    config.overlay.safeAreaPx = 20;
    config.overlay.source.fontSizePx = 20;
    config.overlay.source.maxWidthPercent = 45;
    config.overlay.translation.maxWidthPercent = 45;
    const source = "これは非常に長い字幕で、一行に押し込めず複数行で表示されるべきです。";
    const caption: CaptionPayload = {
      ...createPreviewCaption(),
      sourceText: source,
      translationText: "",
    };
    const { canvas, fillCalls } = createCanvasHarness();

    expect(renderNativeFrame(canvas, config, caption)).not.toBeNull();

    const paintedSource = fillCalls.map((call) => call.text).join("");
    expect(paintedSource).toBe(source);
    expect(new Set(fillCalls.map((call) => call.y)).size).toBeGreaterThan(1);
  });
});
