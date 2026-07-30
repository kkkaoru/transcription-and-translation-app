import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "./defaults";
import { clampNumber, normalizeHexColor, overlayCaptionCss, toCaptionCss } from "./style";

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
    expect(css.WebkitTextStroke).toContain("#061018");
    expect(css.WebkitTextStroke).toContain("92");
    expect(css.textShadow).toContain("#000000");
    expect(css.backgroundColor).toContain("color-mix");
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
});
