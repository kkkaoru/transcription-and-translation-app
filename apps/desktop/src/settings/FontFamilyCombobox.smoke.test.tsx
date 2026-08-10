// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectAvailableFontFamilies, queryLocalFontFamilies } from "./FontFamilyCombobox";

const listSystemFontsMock = vi.fn(async () => [] as string[]);
const isDesktopMock = vi.fn(() => false);

vi.mock("../core/bridge", () => ({
  bridge: {
    isDesktop: () => isDesktopMock(),
    listSystemFonts: () => listSystemFontsMock(),
  },
}));

describe("collectAvailableFontFamilies", () => {
  beforeEach(() => {
    listSystemFontsMock.mockReset();
    listSystemFontsMock.mockResolvedValue([]);
    isDesktopMock.mockReset();
    isDesktopMock.mockReturnValue(false);
    Reflect.deleteProperty(globalThis, "queryLocalFonts");
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "queryLocalFonts");
  });

  it("uses native fonts on desktop and skips queryLocalFonts", async () => {
    const queryLocalFonts = vi.fn(async () => [{ family: "Browser Only" }]);
    Object.assign(globalThis, { queryLocalFonts });
    isDesktopMock.mockReturnValue(true);
    listSystemFontsMock.mockResolvedValueOnce(["Hiragino Sans", "Arial"]);

    await expect(collectAvailableFontFamilies()).resolves.toEqual(["Arial", "Hiragino Sans"]);
    expect(listSystemFontsMock).toHaveBeenCalledTimes(1);
    expect(queryLocalFonts).not.toHaveBeenCalled();
  });

  it("falls back to Local Font Access outside desktop", async () => {
    const queryLocalFonts = vi.fn(async () => [{ family: "Browser Font" }, { family: "Browser Font" }]);
    Object.assign(globalThis, { queryLocalFonts });
    isDesktopMock.mockReturnValue(false);

    await expect(collectAvailableFontFamilies()).resolves.toEqual(["Browser Font"]);
    expect(listSystemFontsMock).not.toHaveBeenCalled();
    expect(queryLocalFonts).toHaveBeenCalledTimes(1);
  });

  it("returns empty when desktop native enumeration fails", async () => {
    const queryLocalFonts = vi.fn(async () => [{ family: "Browser Only" }]);
    Object.assign(globalThis, { queryLocalFonts });
    isDesktopMock.mockReturnValue(true);
    listSystemFontsMock.mockRejectedValueOnce(new Error("enumeration failed"));

    await expect(collectAvailableFontFamilies()).resolves.toEqual([]);
    expect(queryLocalFonts).not.toHaveBeenCalled();
  });
});

describe("queryLocalFontFamilies", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "queryLocalFonts");
  });

  it("returns empty when queryLocalFonts is unavailable", async () => {
    Reflect.deleteProperty(globalThis, "queryLocalFonts");
    await expect(queryLocalFontFamilies()).resolves.toEqual([]);
  });
});
