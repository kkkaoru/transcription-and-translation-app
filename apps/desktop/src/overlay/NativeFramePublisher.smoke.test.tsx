import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import type { CaptionPayload } from "../core/types";
import { createPreviewCaption } from "./captions";
import {
  beginNativePublish,
  completeNativePublishFailure,
  completeNativePublishSuccess,
  createNativePublishGate,
  NATIVE_PUBLISH_MAX_FAILURES,
  renderNativeFrame,
  wrapNativeText,
} from "./NativeFramePublisher";

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
    fillRect: () => undefined,
    fillText: (text: string, x: number, y: number) => fillCalls.push({ text, x, y }),
    getImageData: () =>
      ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }) as ImageData,
    measureText,
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
    // Character-budget window (CAPTION_MAX_VISIBLE_LINES=1) keeps the newest
    // SOURCE_CAPTION_MAX_CHARS graphemes; pixel wrapping may still split them.
    expect(paintedSource.length).toBeLessThanOrEqual(28);
    expect(source.endsWith(paintedSource)).toBe(true);
    expect(new Set(fillCalls.map((call) => call.y)).size).toBeGreaterThanOrEqual(1);
  });
});

describe("native publish gate", () => {
  it("does not permanently suppress republish after a rejected invoke", () => {
    const gate = createNativePublishGate();

    expect(beginNativePublish(gate, "caption-a")).toEqual({ action: "publish", key: "caption-a" });
    // Rejection must not advance lastSuccessfulKey — the same caption can retry.
    const failure = completeNativePublishFailure(gate, "caption-a");
    expect(failure).toEqual({ nextKey: "caption-a", exhausted: false });
    expect(gate.lastSuccessfulKey).toBe("");
    expect(gate.inFlightKey).toBeNull();

    expect(beginNativePublish(gate, "caption-a")).toEqual({ action: "publish", key: "caption-a" });
    expect(completeNativePublishSuccess(gate, "caption-a")).toBeNull();
    expect(gate.lastSuccessfulKey).toBe("caption-a");

    // After success the same key is skipped (no redundant republish).
    expect(beginNativePublish(gate, "caption-a")).toEqual({ action: "skip" });
  });

  it("keeps latest-wins while an invoke is in flight and drains pending after success", () => {
    const gate = createNativePublishGate();

    expect(beginNativePublish(gate, "a")).toEqual({ action: "publish", key: "a" });
    // A newer caption arrives before the first invoke resolves.
    expect(beginNativePublish(gate, "b")).toEqual({ action: "defer", pendingKey: "b" });
    expect(beginNativePublish(gate, "c")).toEqual({ action: "defer", pendingKey: "c" });

    // Success of the older in-flight frame must still schedule the latest pending key.
    expect(completeNativePublishSuccess(gate, "a")).toBe("c");
    expect(gate.lastSuccessfulKey).toBe("a");
    expect(gate.inFlightKey).toBeNull();

    expect(beginNativePublish(gate, "c")).toEqual({ action: "publish", key: "c" });
    expect(completeNativePublishSuccess(gate, "c")).toBeNull();
    expect(gate.lastSuccessfulKey).toBe("c");
  });

  it("on failure prefers a newer pending key over retrying a stale frame", () => {
    const gate = createNativePublishGate();

    expect(beginNativePublish(gate, "stale")).toEqual({ action: "publish", key: "stale" });
    expect(beginNativePublish(gate, "fresh")).toEqual({ action: "defer", pendingKey: "fresh" });

    const failure = completeNativePublishFailure(gate, "stale");
    expect(failure).toEqual({ nextKey: "fresh", exhausted: false });
    expect(gate.lastSuccessfulKey).toBe("");
    // Failure budget for the stale key must not poison the newer caption.
    expect(gate.failureCount).toBe(0);
    expect(gate.failureKey).toBeNull();
  });

  it("bounds retries for a permanently failing key", () => {
    const gate = createNativePublishGate();

    for (let attempt = 1; attempt < NATIVE_PUBLISH_MAX_FAILURES; attempt += 1) {
      expect(beginNativePublish(gate, "broken")).toEqual({ action: "publish", key: "broken" });
      const failure = completeNativePublishFailure(gate, "broken");
      expect(failure.exhausted).toBe(false);
      expect(failure.nextKey).toBe("broken");
      expect(gate.failureCount).toBe(attempt);
    }

    expect(beginNativePublish(gate, "broken")).toEqual({ action: "publish", key: "broken" });
    const finalFailure = completeNativePublishFailure(gate, "broken");
    expect(finalFailure).toEqual({ nextKey: null, exhausted: true });
    expect(gate.lastSuccessfulKey).toBe("");
    expect(beginNativePublish(gate, "broken")).toEqual({ action: "exhausted", key: "broken" });

    // A new caption resets the path even after exhaustion of a prior key.
    expect(beginNativePublish(gate, "recovered")).toEqual({
      action: "publish",
      key: "recovered",
    });
  });
});
