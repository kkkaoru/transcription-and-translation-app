#!/usr/bin/env node

/**
 * Install Kotoba Beacon Native as `$HOME/Applications/Kotoba Beacon Native.app`.
 *
 * This is intentionally separate from `install-macos-app.mjs`, which installs the
 * Tauri app to `/Applications/Kotoba Beacon.app`. Never write that destination.
 *
 * Locked bundle layout:
 *   Contents/MacOS/kotoba-beacon-native
 *   Contents/Frameworks/Syphon.framework
 *   Contents/Resources/sidecars/kotoba-parapper
 *   Contents/Resources/sidecars/kotoba-inference-gateway
 *   Contents/Resources/sidecars/kotoba-zenz-server
 *   Contents/Resources/sidecars/kotoba-llama-server
 *   Contents/Resources/macos-runtime
 *   Contents/Resources/zenz-runtime
 *   Contents/Resources/llama-runtime
 *   Contents/Resources/parapper-runtime   (copied when present)
 *   Contents/Resources/vibrato/...
 *   Contents/Resources/input-lm-tokenizer/...
 *
 * Sidecar dylib rpaths use `@executable_path/<runtime>`. The installer also
 * places relative symlinks under Contents/Resources/sidecars/ so those rpaths
 * resolve without rewriting the binaries.
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
export const SIDECAR_BUILD_COMMAND = "bun run sidecar:build";
export const NATIVE_SIDECAR_RELATIVE_DIR = join("Contents", "Resources", "sidecars");
export const NATIVE_SIDECAR_NAMES = [
  "kotoba-parapper",
  "kotoba-inference-gateway",
  "kotoba-zenz-server",
  "kotoba-llama-server",
];
export const REQUIRED_RUNTIME_DIR_NAMES = ["macos-runtime", "zenz-runtime", "llama-runtime"];
export const OPTIONAL_RUNTIME_DIR_NAMES = ["parapper-runtime"];
export const VIBRATO_FILE_NAMES = ["system.dic.zst", "COPYING", "NOTICE"];

const NATIVE_MANIFEST = join(repoRoot, "apps", "native", "Cargo.toml");
const TAURI_DIR = join(repoRoot, "apps", "desktop", "src-tauri");
const TAURI_BINARIES_DIR = join(TAURI_DIR, "binaries");
const TAURI_RESOURCES_DIR = join(TAURI_DIR, "resources");
const VIBRATO_SOURCE_DIR = join(repoRoot, "assets", "vibrato", "ipadic-mecab-2_7_0");
const TOKENIZER_SOURCE_DIR = join(TAURI_RESOURCES_DIR, "input-lm-tokenizer");
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

export const hostSidecarSuffix = (platform = process.platform, arch = process.arch) => {
  const architecture = arch === "arm64" ? "arm64" : "x64";
  if (platform !== "darwin") {
    throw new Error(`Native macOS installer does not support ${platform}/${arch}`);
  }
  return architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
};

export const sidecarDestination = (installApp, name) =>
  join(installApp, NATIVE_SIDECAR_RELATIVE_DIR, name);

export const missingSidecarMessage = (sourcePath) =>
  `missing sidecar ${sourcePath}; build it with \`${SIDECAR_BUILD_COMMAND}\``;

export const missingRuntimeMessage = (sourcePath) =>
  `missing sidecar runtime ${sourcePath}; build it with \`${SIDECAR_BUILD_COMMAND}\``;

export const resolveSidecarSource = (
  binariesDir,
  name,
  { platform = process.platform, arch = process.arch } = {},
) => {
  const suffixed = join(binariesDir, `${name}-${hostSidecarSuffix(platform, arch)}`);
  if (existsSync(suffixed)) {
    return suffixed;
  }
  const unsuffixed = join(binariesDir, name);
  if (existsSync(unsuffixed)) {
    return unsuffixed;
  }
  return suffixed;
};

export const requireSidecarSources = (
  binariesDir = TAURI_BINARIES_DIR,
  { platform = process.platform, arch = process.arch } = {},
) =>
  NATIVE_SIDECAR_NAMES.map((name) => {
    const source = resolveSidecarSource(binariesDir, name, { platform, arch });
    if (!existsSync(source)) {
      throw new Error(missingSidecarMessage(source));
    }
    return { name, source };
  });

const requireRuntimeDir = (resourcesDir, name) => {
  const source = join(resourcesDir, name);
  if (!existsSync(source)) {
    throw new Error(missingRuntimeMessage(source));
  }
  return source;
};

const requireVibratoFiles = (vibratoDir) =>
  VIBRATO_FILE_NAMES.map((name) => {
    const source = join(vibratoDir, name);
    if (!existsSync(source)) {
      throw new Error(`missing vibrato resource ${source}`);
    }
    return { name, source };
  });

const requireTokenizerDir = (tokenizerDir) => {
  if (!existsSync(tokenizerDir)) {
    throw new Error(`missing tokenizer resource ${tokenizerDir}`);
  }
  return tokenizerDir;
};

export const copySidecarsIntoBundle = ({
  installApp,
  binariesDir = TAURI_BINARIES_DIR,
  platform = process.platform,
  arch = process.arch,
} = {}) => {
  const sidecarsDir = join(installApp, NATIVE_SIDECAR_RELATIVE_DIR);
  mkdirSync(sidecarsDir, { recursive: true });
  return requireSidecarSources(binariesDir, { platform, arch }).map(({ name, source }) => {
    const destination = join(sidecarsDir, name);
    runChecked("/bin/cp", [source, destination]);
    runChecked("/bin/chmod", ["755", destination]);
    return destination;
  });
};

const copyRuntimeDirectory = (source, destination) => {
  mkdirSync(dirname(destination), { recursive: true });
  runChecked("/usr/bin/ditto", [source, destination]);
};

const linkSidecarRuntime = (sidecarsDir, name) => {
  runChecked("/bin/ln", ["-s", join("..", name), join(sidecarsDir, name)]);
};

export const copyNativeBundleResources = ({
  installApp,
  binariesDir = TAURI_BINARIES_DIR,
  resourcesDir = TAURI_RESOURCES_DIR,
  vibratoDir = VIBRATO_SOURCE_DIR,
  tokenizerDir = TOKENIZER_SOURCE_DIR,
  platform = process.platform,
  arch = process.arch,
} = {}) => {
  const resources = join(installApp, "Contents", "Resources");
  const sidecarsDir = join(resources, "sidecars");
  mkdirSync(resources, { recursive: true });

  const sidecarPaths = copySidecarsIntoBundle({ installApp, binariesDir, platform, arch });

  REQUIRED_RUNTIME_DIR_NAMES.map((name) => {
    copyRuntimeDirectory(requireRuntimeDir(resourcesDir, name), join(resources, name));
    linkSidecarRuntime(sidecarsDir, name);
    return name;
  });

  OPTIONAL_RUNTIME_DIR_NAMES.map((name) => {
    const source = join(resourcesDir, name);
    if (!existsSync(source)) {
      return name;
    }
    copyRuntimeDirectory(source, join(resources, name));
    return name;
  });

  const vibratoDest = join(resources, "vibrato");
  mkdirSync(vibratoDest, { recursive: true });
  requireVibratoFiles(vibratoDir).map(({ name, source }) => {
    runChecked("/bin/cp", [source, join(vibratoDest, name)]);
    return name;
  });

  copyRuntimeDirectory(requireTokenizerDir(tokenizerDir), join(resources, "input-lm-tokenizer"));
  return { sidecarPaths, resourcesDir: resources };
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
  binariesDir = TAURI_BINARIES_DIR,
  resourcesDir = TAURI_RESOURCES_DIR,
  vibratoDir = VIBRATO_SOURCE_DIR,
  tokenizerDir = TOKENIZER_SOURCE_DIR,
} = {}) => {
  if (!sourceBinary || !existsSync(sourceBinary)) {
    throw new Error(`native binary was not found: ${sourceBinary || "(none)"}`);
  }
  if (!existsSync(syphonFramework)) {
    throw new Error(`Syphon.framework was not found: ${syphonFramework}`);
  }
  assertNotTauriDestination(installApp);
  requireSidecarSources(binariesDir);

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
  copyNativeBundleResources({
    installApp: staging,
    binariesDir,
    resourcesDir,
    vibratoDir,
    tokenizerDir,
  });
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
