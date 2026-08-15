import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "./defaults";
import {
  clampNumber,
  computePreviewFitScale,
  normalizeHexColor,
  overlayCaptionCss,
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
