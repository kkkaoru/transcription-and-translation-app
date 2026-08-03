import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import {
  assertNativeMacTarget,
  configPathForBuild,
  isIntelMacBuild,
  resolveTauriCliEntry,
  tauriArgsForBuild,
} from "./run-desktop-tauri-build.mjs";

describe("architecture-specific desktop Tauri config", () => {
  it("uses the base macOS config (universal Syphon framework) on Apple Silicon", () => {
    assert.equal(configPathForBuild({ platform: "darwin", arch: "arm64" }), null);
    assert.equal(isIntelMacBuild({ platform: "darwin", arch: "arm64" }), false);
  });

  it("keeps the Intel config overlay for x64 macOS builds", () => {
    assert.equal(
      configPathForBuild({ platform: "darwin", arch: "x64" }),
      "src-tauri/tauri.macos-intel.conf.json",
    );
    assert.equal(isIntelMacBuild({ platform: "darwin", arch: "x64" }), true);
  });

  it("uses the release overlay while preserving the Intel framework choice", () => {
    assert.equal(
      configPathForBuild({ platform: "darwin", arch: "arm64", release: true }),
      "src-tauri/tauri.release.conf.json",
    );
    assert.equal(
      configPathForBuild({ platform: "darwin", arch: "x64", release: true }),
      "src-tauri/tauri.release.macos-intel.conf.json",
    );
  });

  it("honors an explicit target triple over the host architecture", () => {
    const env = { TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" };
    assert.equal(isIntelMacBuild({ platform: "darwin", arch: "arm64", env }), true);
    assert.equal(
      configPathForBuild({ platform: "darwin", arch: "arm64", env }),
      "src-tauri/tauri.macos-intel.conf.json",
    );
  });

  it("honors an explicit target CLI argument over the host and environment", () => {
    assert.equal(
      configPathForBuild({
        platform: "darwin",
        arch: "arm64",
        env: { CARGO_BUILD_TARGET: "aarch64-apple-darwin" },
        targetTriple: "x86_64-apple-darwin",
      }),
      "src-tauri/tauri.macos-intel.conf.json",
    );
    assert.deepEqual(
      tauriArgsForBuild({
        platform: "darwin",
        arch: "arm64",
        env: { CARGO_BUILD_TARGET: "aarch64-apple-darwin" },
        extraArgs: ["--target", "x86_64-apple-darwin"],
      }),
      [
        "build",
        "--config",
        "src-tauri/tauri.macos-intel.conf.json",
        "--target",
        "x86_64-apple-darwin",
      ],
    );
    assert.deepEqual(
      tauriArgsForBuild({
        platform: "darwin",
        arch: "arm64",
        extraArgs: ["--target=aarch64-apple-darwin"],
      }),
      ["build", "--target=aarch64-apple-darwin"],
    );
  });

  it("rejects cross-target macOS packaging before Tauri runs", () => {
    assert.throws(
      () =>
        assertNativeMacTarget({
          platform: "darwin",
          arch: "arm64",
          targetTriple: "x86_64-apple-darwin",
        }),
      /Cross-target macOS desktop builds are unsupported/,
    );
    assert.doesNotThrow(() =>
      assertNativeMacTarget({
        platform: "darwin",
        arch: "x64",
        targetTriple: "x86_64-apple-darwin",
      }),
    );
    assert.doesNotThrow(() =>
      assertNativeMacTarget({
        platform: "darwin",
        arch: "arm64",
        targetTriple: "aarch64-apple-darwin",
      }),
    );
  });

  it("resolves the tauri cli javascript entry instead of a platform bin shim", () => {
    const entry = resolveTauriCliEntry();
    assert.ok(entry.endsWith(`tauri.js`));
    assert.ok(existsSync(entry));
  });

  it("does not select a macOS framework config on Windows or Linux", () => {
    assert.equal(configPathForBuild({ platform: "win32", arch: "x64" }), null);
    assert.equal(
      configPathForBuild({ platform: "linux", arch: "x64", release: true }),
      "src-tauri/tauri.release.conf.json",
    );
  });

  it("uses the Intel overlay during a macOS Tauri dev launch", () => {
    assert.deepEqual(
      tauriArgsForBuild({
        platform: "darwin",
        arch: "x64",
        command: "dev",
        extraArgs: ["--dev"],
      }),
      ["dev", "--config", "src-tauri/tauri.macos-intel.conf.json"],
    );
  });

  it("places selected config before forwarded bundle arguments", () => {
    assert.deepEqual(
      tauriArgsForBuild({
        platform: "darwin",
        arch: "x64",
        extraArgs: ["--bundles", "app"],
      }),
      ["build", "--config", "src-tauri/tauri.macos-intel.conf.json", "--bundles", "app"],
    );
    assert.deepEqual(
      tauriArgsForBuild({
        platform: "darwin",
        arch: "arm64",
        release: true,
        extraArgs: ["--release", "--bundles", "app"],
      }),
      ["build", "--config", "src-tauri/tauri.release.conf.json", "--bundles", "app"],
    );
  });
});
