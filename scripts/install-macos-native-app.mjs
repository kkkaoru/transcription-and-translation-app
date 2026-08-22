#!/usr/bin/env node

/**
 * Install Kotoba Beacon Native as `$HOME/Applications/Kotoba Beacon Native.app`.
 *
 * This is intentionally separate from `install-macos-app.mjs`, which installs the
 * Tauri app to `/Applications/Kotoba Beacon.app`. Never write that destination.
 *
 * The bundle contains the Native executable, Syphon.framework, sherpa-onnx,
 * and ONNX Runtime. Recognition runs in-process; no sidecars are packaged.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PRODUCT_NAME = "Kotoba Beacon Native";
export const BUNDLE_ID = "com.kotobabeacon.native";
export const BINARY_NAME = "kotoba-beacon-native";
export const DEFAULT_INSTALL_APP = join(homedir(), "Applications", `${PRODUCT_NAME}.app`);
export const TAURI_INSTALL_APP = "/Applications/Kotoba Beacon.app";
export const NATIVE_RUNTIME_LIBRARY_NAMES = [
  "libsherpa-onnx-c-api.dylib",
  "libonnxruntime.dylib",
  "libonnxruntime.1.24.4.dylib",
];

const NATIVE_MANIFEST = join(repoRoot, "apps", "native", "Cargo.toml");
const TAURI_DIR = join(repoRoot, "apps", "desktop", "src-tauri");
const SYPHON_SOURCE = join(TAURI_DIR, "frameworks", "Syphon.framework");
const BUNDLE_RPATH = "@executable_path/../Frameworks";
const MIC_USAGE =
  "Kotoba Beacon Native needs microphone access to generate Japanese and English live captions.";
const AUDIO_CAPTURE_USAGE =
  "Kotoba Beacon Native captures system audio when the selected recognition source uses loopback input.";
const SPEECH_USAGE =
  "Kotoba Beacon Native uses speech recognition to generate live captions when Web Speech mode is selected.";

export const resolveNativeInstallApp = (env = process.env) =>
  env.KOTOBA_BEACON_NATIVE_INSTALL_APP?.trim() || DEFAULT_INSTALL_APP;

export const defaultNativeBinary = (
  nativeTargetDir = join(repoRoot, "apps", "native", "target"),
) => {
  const releaseBinary = join(nativeTargetDir, "release", BINARY_NAME);
  if (existsSync(releaseBinary)) {
    return { binary: releaseBinary, profile: "release" };
  }
  const debugBinary = join(nativeTargetDir, "debug", BINARY_NAME);
  if (existsSync(debugBinary)) {
    return { binary: debugBinary, profile: "debug" };
  }
  return { binary: null, profile: null };
};

const runChecked = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail || `exit ${result.status}`}`);
  }
  return result.stdout || "";
};

export const nativeInfoPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${PRODUCT_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${BINARY_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${PRODUCT_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSAudioCaptureUsageDescription</key>
  <string>${AUDIO_CAPTURE_USAGE}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>${MIC_USAGE}</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>${SPEECH_USAGE}</string>
</dict>
</plist>
`;

export const assertNotTauriDestination = (installApp) => {
  if (resolve(installApp) === resolve(TAURI_INSTALL_APP)) {
    throw new Error(`refusing to overwrite the Tauri app at ${TAURI_INSTALL_APP}`);
  }
};

const existingRpaths = (binary) => {
  const output = runChecked("/usr/bin/otool", ["-l", binary]);
  return output
    .split("\n")
    .map((line) => line.match(/^\s*path\s+(\S+)\s+\(offset/u)?.[1])
    .filter(Boolean);
};

export const rewriteBundleRpath = (binary) => {
  for (const rpath of existingRpaths(binary)) {
    if (rpath !== BUNDLE_RPATH) {
      runChecked("/usr/bin/install_name_tool", ["-delete_rpath", rpath, binary]);
    }
  }
  if (!existingRpaths(binary).includes(BUNDLE_RPATH)) {
    runChecked("/usr/bin/install_name_tool", ["-add_rpath", BUNDLE_RPATH, binary]);
  }
};

const adhocSign = (installApp) => {
  try {
    runChecked("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", installApp]);
  } catch (error) {
    console.warn(
      `adhoc codesign failed; Gatekeeper may block a local launch: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const registerLaunchServices = (installApp) => {
  try {
    runChecked(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", installApp],
    );
  } catch {
    // LaunchServices refresh is best-effort.
  }
};

export const assembleNativeApp = ({
  sourceBinary,
  installApp = resolveNativeInstallApp(),
  syphonFramework = SYPHON_SOURCE,
} = {}) => {
  if (!sourceBinary || !existsSync(sourceBinary)) {
    throw new Error(`native binary was not found: ${sourceBinary || "(none)"}`);
  }
  if (!existsSync(syphonFramework)) {
    throw new Error(`Syphon.framework was not found: ${syphonFramework}`);
  }
  assertNotTauriDestination(installApp);

  const parent = dirname(installApp);
  mkdirSync(parent, { recursive: true });
  const staging = join(
    parent === "/" ? tmpdir() : parent,
    `${basename(installApp)}.${process.pid}.new`,
  );
  rmSync(staging, { recursive: true, force: true });

  const contents = join(staging, "Contents");
  const macos = join(contents, "MacOS");
  const frameworks = join(contents, "Frameworks");
  mkdirSync(macos, { recursive: true });
  mkdirSync(frameworks, { recursive: true });
  writeFileSync(join(contents, "Info.plist"), nativeInfoPlist());
  runChecked("/bin/cp", [sourceBinary, join(macos, BINARY_NAME)]);
  runChecked("/bin/chmod", ["755", join(macos, BINARY_NAME)]);
  runChecked("/usr/bin/ditto", [syphonFramework, join(frameworks, "Syphon.framework")]);
  for (const library of NATIVE_RUNTIME_LIBRARY_NAMES) {
    const source = join(dirname(sourceBinary), library);
    if (!existsSync(source)) {
      throw new Error(`missing in-process recognition runtime library ${source}`);
    }
    runChecked("/bin/cp", ["-L", source, join(frameworks, library)]);
  }
  rewriteBundleRpath(join(macos, BINARY_NAME));

  rmSync(installApp, { recursive: true, force: true });
  runChecked("/bin/mv", [staging, installApp]);
  adhocSign(installApp);
  registerLaunchServices(installApp);
  return { sourceBinary, installApp, replaced: true };
};

export const buildNativeRelease = () => {
  runChecked("cargo", ["build", "--manifest-path", NATIVE_MANIFEST, "--release"]);
};

export const installBuiltNativeApp = ({
  installApp = resolveNativeInstallApp(),
  build = buildNativeRelease,
  findBinary = defaultNativeBinary,
  assemble = assembleNativeApp,
} = {}) => {
  assertNotTauriDestination(installApp);
  build();
  const found = findBinary();
  if (!found.binary || found.profile !== "release") {
    throw new Error(
      "successful release build did not produce apps/native/target/release/kotoba-beacon-native",
    );
  }
  const result = assemble({ sourceBinary: found.binary, installApp });
  return { ...result, profile: found.profile };
};

const main = () => {
  try {
    const result = installBuiltNativeApp();
    console.log(`Installed ${result.installApp} from ${result.sourceBinary} (${result.profile})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
