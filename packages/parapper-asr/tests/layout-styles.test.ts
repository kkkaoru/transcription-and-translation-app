import { describe, expect, it } from "vitest";

import {
  fullSizeZeroMin,
  zeroMinHeight,
  zeroMinSize,
  zeroMinWidth,
} from "../src/lib/layout-styles";

describe("layout style constants", () => {
  it("exposes the zero-size building blocks", () => {
    expect(zeroMinSize).toEqual({ minWidth: 0, minHeight: 0 });
    expect(zeroMinWidth).toEqual({ minWidth: 0 });
    expect(zeroMinHeight).toEqual({ minHeight: 0 });
  });

  it("composes a full-size style that keeps the zero minimums", () => {
    expect(fullSizeZeroMin).toEqual({
      height: "100%",
      width: "100%",
      minWidth: 0,
      minHeight: 0,
    });
  });
});
