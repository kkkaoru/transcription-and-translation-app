import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bundleArgsForPlatform, tauriBuildArgs } from "./run-tauri-build.mjs";

describe("platform-specific Tauri bundle arguments", () => {
  it("selects the macOS app bundle", () => {
    assert.deepEqual(bundleArgsForPlatform("darwin"), ["--bundles", "app"]);
  });

  it("selects both supported Windows installers", () => {
    assert.deepEqual(bundleArgsForPlatform("win32"), ["--bundles", "msi,nsis"]);
  });

  it("keeps the Linux build on Tauri's configured default targets", () => {
    assert.deepEqual(bundleArgsForPlatform("linux"), []);
  });

  it("adds the DMG target only for macOS", () => {
    assert.deepEqual(bundleArgsForPlatform("darwin", "dmg"), ["--bundles", "app,dmg"]);
    assert.deepEqual(bundleArgsForPlatform("win32", "dmg"), ["--bundles", "msi,nsis"]);
  });

  it("builds the desktop package through the workspace filter", () => {
    assert.deepEqual(tauriBuildArgs("win32"), [
      "--filter=@caption-bridge/desktop",
      "run",
      "tauri:build",
      "--",
      "--bundles",
      "msi,nsis",
    ]);
  });
});
