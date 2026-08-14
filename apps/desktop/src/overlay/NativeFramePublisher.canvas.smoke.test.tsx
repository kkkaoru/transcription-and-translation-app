import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import type { CaptionPayload } from "../core/types";
import { createPreviewCaption } from "./captions";
import {
  beginNativePublish,
  completeNativePublishFailure,
  completeNativePublishSuccess,
  createNativePublishGate,
  framePaintKey,
  type NativePublishGate,
  renderNativeFrame,
  wrapNativeText,
} from "./NativeFramePublisher";

interface FillCall {
  text: string;
  x: number;
  y: number;
}

interface CanvasHarness {
  canvas: HTMLCanvasElement;
  fillCalls: FillCall[];
  fillStyleValues: string[];
  globalAlphaValues: number[];
}

const createCanvasHarness = (): CanvasHarness => {
  const canvas = document.createElement("canvas");
  const fillCalls: FillCall[] = [];
  const fillStyleValues: string[] = [];
  const globalAlphaValues: number[] = [];
  const measureText = (text: string): TextMetrics =>
    ({ width: Array.from(text).length * 10 }) as TextMetrics;
  const context = {
    beginPath: () => undefined,
    clearRect: () => undefined,
    closePath: () => undefined,
    fill: () => undefined,
    fillRect: () => undefined,
    fillText: (text: string, x: number, y: number) => fillCalls.push({ text, x, y }),
    getImageData: () =>
      ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }) as ImageData,
    lineTo: () => undefined,
    measureText,
    moveTo: () => undefined,
    quadraticCurveTo: () => undefined,
    restore: () => undefined,
    save: () => undefined,
    setTransform: () => undefined,
    strokeText: () => undefined,
    set textBaseline(_value: string) {
      /* no-op */
    },
    set lineJoin(_value: string) {
      /* no-op */
    },
    set fillStyle(value: string) {
      fillStyleValues.push(value);
    },
    set font(_value: string) {
      /* no-op */
    },
    set globalAlpha(value: number) {
      globalAlphaValues.push(value);
    },
    set globalCompositeOperation(_value: string) {
      /* no-op */
    },
    set lineWidth(_value: number) {
      /* no-op */
    },
    set shadowColor(_value: string) {
      /* no-op */
    },
    set shadowBlur(_value: number) {
      /* no-op */
    },
    set shadowOffsetX(_value: number) {
      /* no-op */
    },
    set shadowOffsetY(_value: number) {
      /* no-op */
    },
    set strokeStyle(_value: string) {
      /* no-op */
    },
  } as unknown as CanvasRenderingContext2D;
  Object.defineProperty(canvas, "getContext", {
    configurable: true,
    value: (_type: string, options?: CanvasRenderingContext2DSettings) => {
      // Pin the native path to an alpha-capable context; opaque canvases are
      // what produced solid black Syphon/Spout plates in OBS.
      expect(options?.alpha).toBe(true);
      return context;
    },
  });
  return { canvas, fillCalls, fillStyleValues, globalAlphaValues };
};

const captionWith = (sourceText: string): CaptionPayload => ({
  ...createPreviewCaption(),
  sourceText,
  translationText: "",
});

describe("native caption canvas edge rendering", () => {
  it("draws an OPEN-segment result on an independent dim row for every body alignment", () => {
    for (const textAlign of ["left", "center", "right"] as const) {
      const config = createDefaultConfig();
      config.overlay.width = 320;
      config.overlay.height = 240;
      config.overlay.safeAreaPx = 0;
      config.overlay.source.textAlign = textAlign;
      config.overlay.translation.backgroundEnabled = false;
      const caption = {
        ...captionWith("確定本文"),
        translationText: "Confirmed translation",
      };
      const { canvas, fillCalls, globalAlphaValues } = createCanvasHarness();

      expect(renderNativeFrame(canvas, config, caption, "部分候補")).not.toBeNull();
      expect(fillCalls.map((call) => call.text).join("")).toBe(
        "確定本文Confirmed translation部分候補",
      );
      expect(new Set(fillCalls.map((call) => call.y)).size).toBeGreaterThanOrEqual(2);
      expect(globalAlphaValues).toContain(config.overlay.source.opacity * 0.42);
      expect(framePaintKey(config, caption, "部分候補")).not.toBe(framePaintKey(config, caption));
    }
  });

  it("renders a background plate for an invalid hex color using the white fallback", () => {
    const config = createDefaultConfig();
    config.overlay.width = 320;
    config.overlay.height = 240;
    config.overlay.safeAreaPx = 0;
    config.overlay.source.backgroundEnabled = true;
    config.overlay.source.backgroundColor = "#notahex";
    config.overlay.source.backgroundOpacity = 0.5;
    config.overlay.source.borderRadius = 12;
    config.overlay.source.paddingX = 10;
    config.overlay.source.paddingY = 6;
    config.overlay.translation.backgroundEnabled = false;

    const { canvas, fillCalls, fillStyleValues } = createCanvasHarness();
    expect(renderNativeFrame(canvas, config, captionWith("背景つきの字幕"))).not.toBeNull();

    expect(fillStyleValues.some((value) => value.startsWith("rgba(255, 255, 255"))).toBe(true);
    expect(fillCalls.map((call) => call.text).join("")).toBe("背景つきの字幕");
  });

  it("renders left- and right-aligned plates and text without dropping graphemes", () => {
    for (const align of ["left", "right"] as const) {
      const config = createDefaultConfig();
      config.overlay.width = 320;
      config.overlay.height = 240;
      config.overlay.safeAreaPx = 0;
      config.overlay.source.textAlign = align;
      config.overlay.source.backgroundEnabled = true;
      config.overlay.source.backgroundColor = "#123456";
      config.overlay.source.paddingX = 8;
      config.overlay.source.paddingY = 4;
      config.overlay.translation.textAlign = align;
      config.overlay.translation.backgroundEnabled = false;

      const { canvas, fillCalls } = createCanvasHarness();
      const caption = captionWith("配置のテスト");
      expect(renderNativeFrame(canvas, config, caption)).not.toBeNull();
      expect(fillCalls.map((call) => call.text).join("")).toBe("配置のテスト");
    }
  });

  it("scales an over-wide single glyph down rather than clipping it", () => {
    const config = createDefaultConfig();
    config.overlay.width = 200;
    config.overlay.height = 100;
    config.overlay.safeAreaPx = 0;
    config.overlay.source.fontSizePx = 100;
    config.overlay.source.maxWidthPercent = 10;

    const { canvas, fillCalls } = createCanvasHarness();
    expect(renderNativeFrame(canvas, config, captionWith("あ"))).not.toBeNull();
    expect(fillCalls.map((call) => call.text)).toEqual(["あ"]);
  });

  it("folds non-finite sizes and out-of-range align/opacity back to fallbacks", () => {
    const config = createDefaultConfig();
    config.overlay.width = Number.NaN;
    config.overlay.height = Number.NaN;
    config.overlay.safeAreaPx = Number.NaN;
    config.overlay.captionXPercent = 999;
    config.overlay.captionYPercent = -4;
    config.overlay.source.fontSizePx = Number.NaN;
    config.overlay.source.fontWeight = 5_000;
    config.overlay.source.lineHeight = 0;
    config.overlay.source.maxWidthPercent = 0;
    config.overlay.source.backgroundEnabled = true;
    config.overlay.translation.backgroundEnabled = false;

    const { canvas, fillCalls } = createCanvasHarness();
    // NaN/out-of-range values must not throw; fallbacks keep the frame renderable.
    expect(renderNativeFrame(canvas, config, captionWith("フォールバック"))).not.toBeNull();
    expect(fillCalls.map((call) => call.text).join("")).toBe("フォールバック");
  });

  it("parses a valid six-digit hex background color", () => {
    const config = createDefaultConfig();
    config.overlay.width = 320;
    config.overlay.height = 240;
    config.overlay.safeAreaPx = 0;
    config.overlay.source.backgroundEnabled = true;
    config.overlay.source.backgroundColor = "#1a2b3c";
    config.overlay.source.backgroundOpacity = 0.8;
    config.overlay.source.paddingX = 6;
    config.overlay.source.paddingY = 3;
    config.overlay.translation.backgroundEnabled = false;

    const { canvas, fillStyleValues } = createCanvasHarness();
    expect(renderNativeFrame(canvas, config, captionWith("色付き"))).not.toBeNull();
    // The valid hex maps to explicit rgba components, not the white fallback.
    expect(fillStyleValues.some((value) => value.startsWith("rgba(26, 43, 60"))).toBe(true);
  });

  it("paints culling strokes and handles an empty caption frame", () => {
    const config = createDefaultConfig();
    config.overlay.width = 320;
    config.overlay.height = 240;
    config.overlay.safeAreaPx = 0;
    config.overlay.source.cullingEnabled = true;
    config.overlay.source.cullingWidthPx = 3;
    config.overlay.source.cullingOpacity = 0.9;
    config.overlay.source.lineHeight = 1.5;
    config.overlay.translation.backgroundEnabled = false;

    let strokeCount = 0;
    const canvas = document.createElement("canvas");
    const measureText = (text: string): TextMetrics =>
      ({ width: Array.from(text).length * 10 }) as TextMetrics;
    const context = {
      beginPath: () => undefined,
      clearRect: () => undefined,
      closePath: () => undefined,
      fill: () => undefined,
      fillRect: () => undefined,
      fillText: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray(320 * 240 * 4) }) as ImageData,
      lineTo: () => undefined,
      measureText,
      moveTo: () => undefined,
      quadraticCurveTo: () => undefined,
      restore: () => undefined,
      save: () => undefined,
      setTransform: () => undefined,
      strokeText: () => {
        strokeCount += 1;
      },
      set textBaseline(_v: string) {
        /* no-op */
      },
      set lineJoin(_v: string) {
        /* no-op */
      },
      set fillStyle(_v: string) {
        /* no-op */
      },
      set font(_v: string) {
        /* no-op */
      },
      set globalAlpha(_v: number) {
        /* no-op */
      },
      set globalCompositeOperation(_v: string) {
        /* no-op */
      },
      set lineWidth(_v: number) {
        /* no-op */
      },
      set shadowColor(_v: string) {
        /* no-op */
      },
      set shadowBlur(_v: number) {
        /* no-op */
      },
      set shadowOffsetX(_v: number) {
        /* no-op */
      },
      set shadowOffsetY(_v: number) {
        /* no-op */
      },
      set strokeStyle(_v: string) {
        /* no-op */
      },
    } as unknown as CanvasRenderingContext2D;
    Object.defineProperty(canvas, "getContext", { configurable: true, value: () => context });

    expect(renderNativeFrame(canvas, config, captionWith("縁取り"))).not.toBeNull();
    expect(strokeCount).toBeGreaterThan(0);

    // An empty caption paints nothing but still returns a non-null frame.
    expect(renderNativeFrame(canvas, config, captionWith(" "))).not.toBeNull();
  });
});

describe("wrapNativeText edge cases", () => {
  it("handles an empty string and honours letter spacing", () => {
    const measure = (text: string): number => Array.from(text).length * 10;
    // The final flush always emits the last logical line, so an empty input
    // yields a single empty line rather than an empty list.
    expect(wrapNativeText("", 100, measure)).toEqual([""]);
    expect(wrapNativeText("   ", 100, measure, 4)).toEqual(["   "]);
  });

  it("keeps a trailing whitespace token on the previous line for exact reconstruction", () => {
    const measure = (text: string): number => Array.from(text).length * 10;
    const text = "aa bbb cccc";
    const lines = wrapNativeText(text, 40, measure);
    expect(lines.join("")).toBe(text);
    expect(lines.length).toBeGreaterThan(1);
  });

  it("falls back to a grapheme break when an overflowing token has no whitespace", () => {
    const measure = (text: string): number => Array.from(text).length * 10;
    // `aaaaaa` (60px) exceeds the 30px width with no space to break on, so the
    // wrapper splits mid-token at the grapheme boundary without dropping text.
    const lines = wrapNativeText("aaaaaa", 30, measure);
    expect(lines.join("")).toBe("aaaaaa");
    expect(lines.length).toBeGreaterThan(1);
  });

  it("does not split a ZWJ emoji sequence when wrapping by width", () => {
    const family = "👨‍👩‍👧";
    const measure = (text: string): number =>
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length * 10;
    // Two family emoji are 20px; a 15px width must wrap between clusters, never
    // inside the ZWJ sequence.
    const lines = wrapNativeText(family.repeat(2), 15, measure);
    expect(lines.join("")).toBe(family.repeat(2));
    expect(lines).toEqual([family, family]);
    expect(lines.some((line) => line.startsWith("\u200D"))).toBe(false);
  });
});

describe("native publish gate edge branches", () => {
  it("ignores a stale success that would rewind past a newer in-flight key", () => {
    const gate = createNativePublishGate();
    expect(beginNativePublish(gate, "older")).toEqual({ action: "publish", key: "older" });
    expect(beginNativePublish(gate, "newer")).toEqual({ action: "defer", pendingKey: "newer" });
    expect(beginNativePublish(gate, "newest")).toEqual({ action: "defer", pendingKey: "newest" });

    expect(completeNativePublishSuccess(gate, "older")).toBe("newest");
    expect(gate.lastSuccessfulKey).toBe("older");
  });

  it("does not retry a failed key that already matches the last successful key", () => {
    const gate = createNativePublishGate();
    expect(beginNativePublish(gate, "same")).toEqual({ action: "publish", key: "same" });
    expect(completeNativePublishSuccess(gate, "same")).toBeNull();

    const failure = completeNativePublishFailure(gate, "same");
    expect(failure).toEqual({ nextKey: null, exhausted: false });
  });

  it("clears a matching in-flight claim and returns null when pending equals the published key", () => {
    const gate: NativePublishGate = {
      inFlightKey: "a",
      pendingKey: "a",
      lastSuccessfulKey: "",
      failureCount: 0,
      failureKey: null,
    };
    expect(completeNativePublishSuccess(gate, "a")).toBeNull();
    expect(gate.inFlightKey).toBeNull();
    expect(gate.lastSuccessfulKey).toBe("a");
  });

  it("returns null for a stale success while a different key is in flight", () => {
    const gate: NativePublishGate = {
      inFlightKey: "a",
      pendingKey: "b",
      lastSuccessfulKey: "",
      failureCount: 0,
      failureKey: null,
    };
    expect(completeNativePublishSuccess(gate, "stale-different")).toBeNull();
    expect(gate.inFlightKey).toBe("a");
  });

  it("resets the failure budget when the published key matches the failing key", () => {
    const gate: NativePublishGate = {
      inFlightKey: "a",
      pendingKey: "b",
      lastSuccessfulKey: "",
      failureCount: 3,
      failureKey: "a",
    };
    expect(completeNativePublishSuccess(gate, "a")).toBe("b");
    expect(gate.failureCount).toBe(0);
    expect(gate.failureKey).toBeNull();
  });

  it("drains a pending key that differs from the last successful key", () => {
    const gate: NativePublishGate = {
      inFlightKey: "a",
      pendingKey: "b",
      lastSuccessfulKey: "x",
      failureCount: 0,
      failureKey: null,
    };
    // Published "a" becomes lastSuccessfulKey; pending "b" differs, so it drains.
    expect(completeNativePublishSuccess(gate, "a")).toBe("b");
    expect(gate.lastSuccessfulKey).toBe("a");
  });

  it("increments the failure budget for a repeated failing key", () => {
    const gate = createNativePublishGate();
    expect(beginNativePublish(gate, "broken")).toEqual({ action: "publish", key: "broken" });
    expect(completeNativePublishFailure(gate, "broken")).toEqual({
      nextKey: "broken",
      exhausted: false,
    });
    expect(gate.failureCount).toBe(1);
    expect(gate.failureKey).toBe("broken");

    expect(beginNativePublish(gate, "broken")).toEqual({ action: "publish", key: "broken" });
    expect(completeNativePublishFailure(gate, "broken")).toEqual({
      nextKey: "broken",
      exhausted: false,
    });
    expect(gate.failureCount).toBe(2);
  });

  it("does not drain a pending key equal to the just-published success", () => {
    const gate: NativePublishGate = {
      inFlightKey: "a",
      pendingKey: "a",
      lastSuccessfulKey: "",
      failureCount: 0,
      failureKey: null,
    };
    expect(completeNativePublishSuccess(gate, "a")).toBeNull();
    expect(gate.lastSuccessfulKey).toBe("a");
  });

  it("keeps the last successful key when a stale success arrives for a cleared gate", () => {
    const gate: NativePublishGate = {
      inFlightKey: null,
      pendingKey: null,
      lastSuccessfulKey: "known",
      failureCount: 0,
      failureKey: null,
    };
    expect(completeNativePublishSuccess(gate, "known")).toBeNull();
    expect(gate.lastSuccessfulKey).toBe("known");
  });
});

describe("premultiplyStraightRgba for Syphon/Spout transparency", () => {
  it("forces zero-alpha pixels to transparent black and premultiplies partial alpha", async () => {
    const { premultiplyStraightRgba } = await import("./NativeFramePublisher");
    const pixels = Uint8ClampedArray.from([
      10,
      20,
      30,
      0, // must become fully transparent, not opaque black
      255,
      128,
      64,
      128, // half alpha → half RGB
      200,
      200,
      200,
      255, // opaque unchanged
    ]);
    const out = premultiplyStraightRgba(pixels);
    expect([...out.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...out.slice(4, 8)]).toEqual([128, 64, 32, 128]);
    expect([...out.slice(8, 12)]).toEqual([200, 200, 200, 255]);
  });
});
