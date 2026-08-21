import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assertNotTauriDestination,
  BUNDLE_ID,
  copyNativeBundleResources,
  copySidecarsIntoBundle,
  DEFAULT_INSTALL_APP,
  hostSidecarSuffix,
  installBuiltNativeApp,
  missingRuntimeMessage,
  missingSidecarMessage,
  NATIVE_SIDECAR_NAMES,
  NATIVE_SIDECAR_RELATIVE_DIR,
  nativeInfoPlist,
  PRODUCT_NAME,
  requireSidecarSources,
  resolveNativeInstallApp,
  resolveSidecarSource,
  SIDECAR_BUILD_COMMAND,
  sidecarDestination,
  TAURI_INSTALL_APP,
} from "./install-macos-native-app.mjs";

describe("macOS Native app install", () => {
  it("defaults to the user Applications Native bundle", () => {
    assert.equal(DEFAULT_INSTALL_APP, join(homedir(), "Applications", "Kotoba Beacon Native.app"));
    assert.equal(resolveNativeInstallApp({}), DEFAULT_INSTALL_APP);
  });

  it("honors KOTOBA_BEACON_NATIVE_INSTALL_APP", () => {
    assert.equal(
      resolveNativeInstallApp({
        KOTOBA_BEACON_NATIVE_INSTALL_APP: "/tmp/Kotoba Beacon Native.app",
      }),
      "/tmp/Kotoba Beacon Native.app",
    );
  });

  it("never defaults to the Tauri install path", () => {
    assert.equal(TAURI_INSTALL_APP, "/Applications/Kotoba Beacon.app");
    assert.notEqual(DEFAULT_INSTALL_APP, TAURI_INSTALL_APP);
  });

  it("refuses to install over /Applications/Kotoba Beacon.app", () => {
    assert.throws(
      () => assertNotTauriDestination("/Applications/Kotoba Beacon.app"),
      /refusing to overwrite the Tauri app at \/Applications\/Kotoba Beacon\.app/u,
    );
  });

  it("does not install an existing stale binary after the release build fails", () => {
    let findCalled = false;
    let assembleCalled = false;
    assert.throws(
      () =>
        installBuiltNativeApp({
          installApp: "/tmp/Kotoba Beacon Native.app",
          build: () => {
            throw new Error("native GPUI build failed");
          },
          findBinary: () => {
            findCalled = true;
            return { binary: "/tmp/stale/kotoba-beacon-native", profile: "release" };
          },
          assemble: () => {
            assembleCalled = true;
            return {};
          },
        }),
      /native GPUI build failed/u,
    );
    assert.equal(findCalled, false);
    assert.equal(assembleCalled, false);
  });

  it("writes Native identity into Info.plist", () => {
    const plist = nativeInfoPlist();
    assert.match(plist, /<string>Kotoba Beacon Native<\/string>/u);
    assert.match(plist, /<string>com.kotobabeacon.native<\/string>/u);
    assert.match(plist, /<string>kotoba-beacon-native<\/string>/u);
    assert.match(plist, /<string>APPL<\/string>/u);
    assert.match(plist, /<string>12.0<\/string>/u);
    assert.match(plist, /NSHighResolutionCapable/u);
    assert.match(plist, /Kotoba Beacon Native needs microphone access/u);
    assert.doesNotMatch(plist, /Kotoba Beacon needs microphone access/u);
    assert.equal(PRODUCT_NAME, "Kotoba Beacon Native");
    assert.equal(BUNDLE_ID, "com.kotobabeacon.native");
  });

  it("places sidecar filenames under Contents/Resources/sidecars", () => {
    assert.equal(NATIVE_SIDECAR_RELATIVE_DIR, "Contents/Resources/sidecars");
    assert.deepStrictEqual(NATIVE_SIDECAR_NAMES, [
      "kotoba-parapper",
      "kotoba-inference-gateway",
      "kotoba-zenz-server",
      "kotoba-llama-server",
    ]);
    assert.equal(
      sidecarDestination("/tmp/Kotoba Beacon Native.app", "kotoba-parapper"),
      "/tmp/Kotoba Beacon Native.app/Contents/Resources/sidecars/kotoba-parapper",
    );
    assert.equal(
      sidecarDestination("/tmp/Kotoba Beacon Native.app", "kotoba-inference-gateway"),
      "/tmp/Kotoba Beacon Native.app/Contents/Resources/sidecars/kotoba-inference-gateway",
    );
    assert.equal(
      sidecarDestination("/tmp/Kotoba Beacon Native.app", "kotoba-zenz-server"),
      "/tmp/Kotoba Beacon Native.app/Contents/Resources/sidecars/kotoba-zenz-server",
    );
    assert.equal(
      sidecarDestination("/tmp/Kotoba Beacon Native.app", "kotoba-llama-server"),
      "/tmp/Kotoba Beacon Native.app/Contents/Resources/sidecars/kotoba-llama-server",
    );
  });

  it("resolves suffixed sidecar binaries produced by bun run sidecar:build", () => {
    assert.equal(hostSidecarSuffix("darwin", "arm64"), "aarch64-apple-darwin");
    assert.equal(hostSidecarSuffix("darwin", "x64"), "x86_64-apple-darwin");
    assert.equal(
      resolveSidecarSource("/tmp/binaries", "kotoba-parapper", {
        platform: "darwin",
        arch: "arm64",
      }),
      "/tmp/binaries/kotoba-parapper-aarch64-apple-darwin",
    );
  });

  it("treats a missing sidecar as a hard error that names bun run sidecar:build", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "native-empty-sidecars-"));
    const expected = join(emptyDir, "kotoba-parapper-aarch64-apple-darwin");
    assert.equal(
      missingSidecarMessage(expected),
      `missing sidecar ${expected}; build it with \`bun run sidecar:build\``,
    );
    assert.throws(
      () => requireSidecarSources(emptyDir, { platform: "darwin", arch: "arm64" }),
      /missing sidecar .*kotoba-parapper-aarch64-apple-darwin; build it with `bun run sidecar:build`/u,
    );
    assert.equal(SIDECAR_BUILD_COMMAND, "bun run sidecar:build");
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("copies sidecar filenames into Contents/Resources/sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "native-copy-sidecars-"));
    const binariesDir = join(root, "binaries");
    const installApp = join(root, "Kotoba Beacon Native.app");
    mkdirSync(binariesDir, { recursive: true });
    writeFileSync(join(binariesDir, "kotoba-parapper-aarch64-apple-darwin"), "parapper");
    writeFileSync(join(binariesDir, "kotoba-inference-gateway-aarch64-apple-darwin"), "gateway");
    writeFileSync(join(binariesDir, "kotoba-zenz-server-aarch64-apple-darwin"), "zenz");
    writeFileSync(join(binariesDir, "kotoba-llama-server-aarch64-apple-darwin"), "llama");
    chmodSync(join(binariesDir, "kotoba-parapper-aarch64-apple-darwin"), 0o644);
    chmodSync(join(binariesDir, "kotoba-inference-gateway-aarch64-apple-darwin"), 0o644);
    chmodSync(join(binariesDir, "kotoba-zenz-server-aarch64-apple-darwin"), 0o644);
    chmodSync(join(binariesDir, "kotoba-llama-server-aarch64-apple-darwin"), 0o644);

    const copied = copySidecarsIntoBundle({
      installApp,
      binariesDir,
      platform: "darwin",
      arch: "arm64",
    });

    assert.deepStrictEqual(copied, [
      join(installApp, "Contents", "Resources", "sidecars", "kotoba-parapper"),
      join(installApp, "Contents", "Resources", "sidecars", "kotoba-inference-gateway"),
      join(installApp, "Contents", "Resources", "sidecars", "kotoba-zenz-server"),
      join(installApp, "Contents", "Resources", "sidecars", "kotoba-llama-server"),
    ]);
    assert.equal(
      readFileSync(
        join(installApp, "Contents", "Resources", "sidecars", "kotoba-parapper"),
        "utf8",
      ),
      "parapper",
    );
    assert.equal(
      (lstatSync(join(installApp, "Contents", "Resources", "sidecars", "kotoba-parapper")).mode &
        0o111) !==
        0,
      true,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to an unsuffixed sidecar when the host suffix is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "native-unsuffixed-sidecars-"));
    writeFileSync(join(root, "kotoba-parapper"), "plain");
    assert.equal(
      resolveSidecarSource(root, "kotoba-parapper", { platform: "darwin", arch: "arm64" }),
      join(root, "kotoba-parapper"),
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("treats a missing required runtime as a hard error that names bun run sidecar:build", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "native-empty-runtime-"));
    const expected = join(emptyDir, "macos-runtime");
    assert.equal(
      missingRuntimeMessage(expected),
      `missing sidecar runtime ${expected}; build it with \`bun run sidecar:build\``,
    );
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("copies runtimes, vibrato, tokenizer, and sidecar runtime links", () => {
    const root = mkdtempSync(join(tmpdir(), "native-copy-resources-"));
    const binariesDir = join(root, "binaries");
    const resourcesDir = join(root, "resources");
    const vibratoDir = join(root, "vibrato");
    const tokenizerDir = join(root, "tokenizer");
    const installApp = join(root, "Kotoba Beacon Native.app");
    mkdirSync(binariesDir, { recursive: true });
    mkdirSync(join(resourcesDir, "macos-runtime"), { recursive: true });
    mkdirSync(join(resourcesDir, "zenz-runtime"), { recursive: true });
    mkdirSync(join(resourcesDir, "llama-runtime"), { recursive: true });
    mkdirSync(join(resourcesDir, "parapper-runtime"), { recursive: true });
    mkdirSync(vibratoDir, { recursive: true });
    mkdirSync(tokenizerDir, { recursive: true });
    writeFileSync(join(binariesDir, "kotoba-parapper-aarch64-apple-darwin"), "parapper");
    writeFileSync(join(binariesDir, "kotoba-inference-gateway-aarch64-apple-darwin"), "gateway");
    writeFileSync(join(binariesDir, "kotoba-zenz-server-aarch64-apple-darwin"), "zenz");
    writeFileSync(join(binariesDir, "kotoba-llama-server-aarch64-apple-darwin"), "llama");
    writeFileSync(join(resourcesDir, "macos-runtime", "libonnxruntime.dylib"), "onnx");
    writeFileSync(join(resourcesDir, "zenz-runtime", "libllama.dylib"), "zenz-lib");
    writeFileSync(join(resourcesDir, "llama-runtime", "libllama.dylib"), "llama-lib");
    writeFileSync(join(resourcesDir, "parapper-runtime", "marker"), "parapper-runtime");
    writeFileSync(join(vibratoDir, "system.dic.zst"), "dic");
    writeFileSync(join(vibratoDir, "COPYING"), "copying");
    writeFileSync(join(vibratoDir, "NOTICE"), "notice");
    writeFileSync(join(tokenizerDir, "vocab.json"), "{}");

    const copied = copyNativeBundleResources({
      installApp,
      binariesDir,
      resourcesDir,
      vibratoDir,
      tokenizerDir,
      platform: "darwin",
      arch: "arm64",
    });

    assert.equal(
      existsSync(
        join(installApp, "Contents", "Resources", "macos-runtime", "libonnxruntime.dylib"),
      ),
      true,
    );
    assert.equal(
      existsSync(join(installApp, "Contents", "Resources", "zenz-runtime", "libllama.dylib")),
      true,
    );
    assert.equal(
      existsSync(join(installApp, "Contents", "Resources", "llama-runtime", "libllama.dylib")),
      true,
    );
    assert.equal(
      existsSync(join(installApp, "Contents", "Resources", "parapper-runtime", "marker")),
      true,
    );
    assert.equal(
      existsSync(join(installApp, "Contents", "Resources", "vibrato", "system.dic.zst")),
      true,
    );
    assert.equal(existsSync(join(installApp, "Contents", "Resources", "vibrato", "COPYING")), true);
    assert.equal(existsSync(join(installApp, "Contents", "Resources", "vibrato", "NOTICE")), true);
    assert.equal(
      existsSync(join(installApp, "Contents", "Resources", "input-lm-tokenizer", "vocab.json")),
      true,
    );
    assert.equal(
      readlinkSync(join(installApp, "Contents", "Resources", "sidecars", "macos-runtime")),
      "../macos-runtime",
    );
    assert.equal(
      readlinkSync(join(installApp, "Contents", "Resources", "sidecars", "zenz-runtime")),
      "../zenz-runtime",
    );
    assert.equal(
      readlinkSync(join(installApp, "Contents", "Resources", "sidecars", "llama-runtime")),
      "../llama-runtime",
    );
    assert.equal(
      existsSync(join(installApp, "Contents", "Resources", "sidecars", "kotoba-parapper")),
      true,
    );
    assert.equal(copied.sidecarPaths.length, 4);
    rmSync(root, { recursive: true, force: true });
  });

  it("skips parapper-runtime when the source directory is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "native-optional-runtime-"));
    const binariesDir = join(root, "binaries");
    const resourcesDir = join(root, "resources");
    const vibratoDir = join(root, "vibrato");
    const tokenizerDir = join(root, "tokenizer");
    const installApp = join(root, "Kotoba Beacon Native.app");
    mkdirSync(binariesDir, { recursive: true });
    mkdirSync(join(resourcesDir, "macos-runtime"), { recursive: true });
    mkdirSync(join(resourcesDir, "zenz-runtime"), { recursive: true });
    mkdirSync(join(resourcesDir, "llama-runtime"), { recursive: true });
    mkdirSync(vibratoDir, { recursive: true });
    mkdirSync(tokenizerDir, { recursive: true });
    writeFileSync(join(binariesDir, "kotoba-parapper-aarch64-apple-darwin"), "parapper");
    writeFileSync(join(binariesDir, "kotoba-inference-gateway-aarch64-apple-darwin"), "gateway");
    writeFileSync(join(binariesDir, "kotoba-zenz-server-aarch64-apple-darwin"), "zenz");
    writeFileSync(join(binariesDir, "kotoba-llama-server-aarch64-apple-darwin"), "llama");
    writeFileSync(join(resourcesDir, "macos-runtime", "libonnxruntime.dylib"), "onnx");
    writeFileSync(join(resourcesDir, "zenz-runtime", "libllama.dylib"), "zenz-lib");
    writeFileSync(join(resourcesDir, "llama-runtime", "libllama.dylib"), "llama-lib");
    writeFileSync(join(vibratoDir, "system.dic.zst"), "dic");
    writeFileSync(join(vibratoDir, "COPYING"), "copying");
    writeFileSync(join(vibratoDir, "NOTICE"), "notice");
    writeFileSync(join(tokenizerDir, "vocab.json"), "{}");

    copyNativeBundleResources({
      installApp,
      binariesDir,
      resourcesDir,
      vibratoDir,
      tokenizerDir,
      platform: "darwin",
      arch: "arm64",
    });

    assert.equal(existsSync(join(installApp, "Contents", "Resources", "parapper-runtime")), false);
    assert.equal(
      existsSync(join(installApp, "Contents", "Resources", "sidecars", "kotoba-llama-server")),
      true,
    );
    rmSync(root, { recursive: true, force: true });
  });
});
