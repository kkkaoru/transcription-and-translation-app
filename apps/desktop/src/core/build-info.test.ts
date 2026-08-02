import { describe, expect, it, vi } from "vitest";
import { BUILD_INFO, isReleaseBuildId } from "./buildInfo";

describe("build metadata", () => {
  it("always exposes a non-empty app version and build id", () => {
    expect(BUILD_INFO.appVersion.trim()).not.toBe("");
    expect(BUILD_INFO.buildId.trim()).not.toBe("");
  });

  it("recognizes the generated release id shape without accepting arbitrary text", () => {
    expect(isReleaseBuildId("b20260801174000123-abcdef1-0123abcd")).toBe(true);
    expect(isReleaseBuildId("dev")).toBe(false);
    expect(isReleaseBuildId("b20260801174000123-ABCDEF1-0123abcd")).toBe(false);
  });

  it("uses non-empty compile-time metadata when a release build provides it", async () => {
    vi.resetModules();
    vi.stubGlobal("__KOTOBA_APP_VERSION__", "1.2.3");
    vi.stubGlobal("__KOTOBA_BUILD_ID__", "b20260801174000123-abcdef1-0123abcd");
    try {
      const configured = await import("./buildInfo");
      expect(configured.BUILD_INFO).toEqual({
        appVersion: "1.2.3",
        buildId: "b20260801174000123-abcdef1-0123abcd",
      });
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("falls back when compile-time metadata is blank or not a string", async () => {
    vi.resetModules();
    vi.stubGlobal("__KOTOBA_APP_VERSION__", "");
    vi.stubGlobal("__KOTOBA_BUILD_ID__", 42);
    try {
      const configured = await import("./buildInfo");
      expect(configured.BUILD_INFO).toEqual({ appVersion: "0.1.1", buildId: "dev" });
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
