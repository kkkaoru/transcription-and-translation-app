import { afterEach, describe, expect, it, vi } from "vitest";

import { isMacOs } from "../src/lib/platform";

describe("isMacOs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when navigator is unavailable", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isMacOs()).toBe(false);
  });

  it("returns true when the platform is a Mac", () => {
    vi.stubGlobal("navigator", {
      platform: "MacIntel",
      userAgent: "Mozilla/5.0",
    });
    expect(isMacOs()).toBe(true);
  });

  it("returns true when the user agent mentions mac os x", () => {
    vi.stubGlobal("navigator", {
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Mac OS X 10_15_7)",
    });
    expect(isMacOs()).toBe(true);
  });

  it("returns false for a non-Mac platform", () => {
    vi.stubGlobal("navigator", {
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0)",
    });
    expect(isMacOs()).toBe(false);
  });
});
