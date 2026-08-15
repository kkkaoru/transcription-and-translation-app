import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "./defaults";
import { clearStructuredLogs, getStructuredLogs } from "./structuredLog";
import {
  clampNumber,
  computePreviewFitScale,
  isMeasurableCaptionOverflow,
  logCaptionOverflow,
  measureCaptionOverflow,
  normalizeHexColor,
  overlayCaptionCss,
  readCaptionOverflow,
  shouldLogCaptionOverflow,
  toCaptionCss,
} from "./style";

describe("caption styles", () => {
  it("clamps invalid numeric values", () => {
    expect(clampNumber(Number.NaN, 0, 1)).toBe(0);
    expect(clampNumber(3, 0, 1)).toBe(1);
    expect(clampNumber(-1, 0, 1)).toBe(0);
  });

  it("generates dynamic CSS for outline, shadow and background", () => {
    const style = { ...createDefaultConfig().overlay.source, backgroundEnabled: true };
    const css = toCaptionCss(style);
    expect(css.fontFamily).toContain("Noto Sans JP");
    expect(css.WebkitTextStroke).toBe("3px color-mix(in srgb, #061018 92%, transparent)");
    expect(css.textShadow).toContain("#000000");
    expect(css.backgroundColor).toContain("color-mix");
    expect(css.boxSizing).toBe("border-box");
  });

  it("generates a layout style and validates colors", () => {
    const layout = overlayCaptionCss(createDefaultConfig().overlay);
    expect(layout.gap).toBe("14px");
    expect(layout.left).toBe("50%");
    expect(layout.top).toBe("88%");
    expect(layout.display).toBe("flex");
    expect(layout.flexDirection).toBe("column");
    expect(layout.transform).toBe("translate(-50%, -100%)");
    expect(normalizeHexColor("#123456", "#ffffff")).toBe("#123456");
    expect(normalizeHexColor("red", "#ffffff")).toBe("#ffffff");
  });

  it("supports an outline-free, shadow-free transparent style", () => {
    const style = {
      ...createDefaultConfig().overlay.source,
      cullingEnabled: false,
      shadowEnabled: false,
      backgroundEnabled: false,
      opacity: 2,
      fontWeight: 1_000,
      maxWidthPercent: 0,
      fontSizePx: 0,
    };
    const css = toCaptionCss(style);
    expect(css.WebkitTextStroke).toBe("0 transparent");
    expect(css.textShadow).toBe("none");
    expect(css.backgroundColor).toBe("transparent");
    expect(css.opacity).toBe(1);
    expect(css.fontSize).toBe("1px");
    expect(css.maxWidth).toBe("1%");
  });

  it("fits the overlay canvas into the in-app preview stage without OBS", () => {
    expect(computePreviewFitScale(640, 360, 1_280, 720)).toBeCloseTo(0.5, 5);
    expect(computePreviewFitScale(1_280, 360, 1_280, 720)).toBeCloseTo(0.5, 5);
    expect(computePreviewFitScale(640, 720, 1_280, 720)).toBeCloseTo(0.5, 5);
    expect(computePreviewFitScale(1_280, 720, 1_280, 720)).toBe(1);
    // Do not upscale past the designed overlay canvas size.
    expect(computePreviewFitScale(2_560, 1_440, 1_280, 720)).toBe(1);
    // Unknown / zero stage → fill-mode fallback scale.
    expect(computePreviewFitScale(0, 0, 1_280, 720)).toBe(1);
    expect(computePreviewFitScale(Number.NaN, 100, 1_280, 720)).toBe(1);
    // Tiny stage still returns a positive floor so captions remain paintable.
    expect(computePreviewFitScale(2, 2, 1_280, 720)).toBe(0.05);
  });
});

describe("caption overflow measurement", () => {
  it("computes overflow state and rounds widths", () => {
    const fitting = measureCaptionOverflow({
      contentWidth: 500.4,
      containerWidth: 600.1,
      lineCount: 1,
    });
    expect(fitting).toStrictEqual({
      contentWidth: 500,
      containerWidth: 600,
      overflowed: false,
      lineCount: 1,
    });

    const overflowing = measureCaptionOverflow({
      contentWidth: 650.2,
      containerWidth: 600,
      lineCount: 2,
    });
    expect(overflowing).toStrictEqual({
      contentWidth: 650,
      containerWidth: 600,
      overflowed: true,
      lineCount: 2,
    });
  });

  it("filters unmeasurable zero-size states", () => {
    expect(
      isMeasurableCaptionOverflow({
        contentWidth: 0,
        containerWidth: 0,
        overflowed: false,
        lineCount: 0,
      }),
    ).toBe(false);
    expect(
      isMeasurableCaptionOverflow({
        contentWidth: 10,
        containerWidth: 0,
        overflowed: true,
        lineCount: 1,
      }),
    ).toBe(true);
    expect(
      isMeasurableCaptionOverflow({
        contentWidth: 0,
        containerWidth: 10,
        overflowed: false,
        lineCount: 0,
      }),
    ).toBe(true);
  });

  it("logs only when overflow boolean state changes", () => {
    const fitting = { contentWidth: 400, containerWidth: 500, overflowed: false, lineCount: 1 };
    const stillFitting = {
      contentWidth: 450,
      containerWidth: 500,
      overflowed: false,
      lineCount: 1,
    };
    const overflowing = { contentWidth: 550, containerWidth: 500, overflowed: true, lineCount: 2 };

    expect(shouldLogCaptionOverflow(null, fitting)).toBe(true);
    expect(shouldLogCaptionOverflow(false, stillFitting)).toBe(false);
    expect(shouldLogCaptionOverflow(false, overflowing)).toBe(true);
    expect(shouldLogCaptionOverflow(true, overflowing)).toBe(false);
    expect(shouldLogCaptionOverflow(true, fitting)).toBe(true);
  });

  it("reads overflow from DOM container and lines", () => {
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 600, configurable: true });

    const emptyLine = document.createElement("div");
    emptyLine.className = "caption-line caption-line-empty";
    emptyLine.dataset["empty"] = "true";
    Object.defineProperty(emptyLine, "scrollWidth", { value: 0, configurable: true });
    Object.defineProperty(emptyLine, "clientWidth", { value: 600, configurable: true });
    host.appendChild(emptyLine);

    const sourceLine = document.createElement("div");
    sourceLine.className = "caption-line caption-line-source";
    Object.defineProperty(sourceLine, "scrollWidth", { value: 720, configurable: true });
    Object.defineProperty(sourceLine, "clientWidth", { value: 600, configurable: true });
    const span1 = document.createElement("span");
    const span2 = document.createElement("span");
    sourceLine.appendChild(span1);
    sourceLine.appendChild(span2);
    host.appendChild(sourceLine);

    const measurement = readCaptionOverflow(host);
    expect(measurement).toStrictEqual({
      contentWidth: 720,
      containerWidth: 600,
      overflowed: true,
      lineCount: 2,
    });
  });

  it("logs overflow to structured log without caption text", () => {
    clearStructuredLogs();
    logCaptionOverflow(
      {
        contentWidth: 800,
        containerWidth: 600,
        overflowed: true,
        lineCount: 2,
      },
      5_000,
    );

    const row = getStructuredLogs({ limit: 1 })[0];
    expect(row?.message).toBe(
      "caption overflow content_width=800 container_width=600 overflowed=true line_count=2",
    );
    expect(row?.fields).toMatchObject({
      contentWidth: 800,
      containerWidth: 600,
      overflowed: true,
      lineCount: 2,
    });
    expect(row?.epochMs).toBe(5_000);
  });
});
