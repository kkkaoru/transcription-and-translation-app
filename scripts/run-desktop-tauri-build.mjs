#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { findMacosAppBundles, optimizeMacosAppBundle } from "./restore-bundle-runtime-symlinks.mjs";
import { bundleArgsForPlatform } from "./run-tauri-build.mjs";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "desktop",
);
const RELEASE_FLAG = "--release";
const DEV_FLAG = "--dev";

const targetTripleFromArgs = (args) => {
  const equalsForm = args.find((arg) => arg.startsWith("--target="));
  if (equalsForm) return equalsForm.slice("--target=".length);
  const index = args.indexOf("--target");
  return index >= 0 ? (args[index + 1] ?? "") : "";
};

const targetTripleFromEnvironment = (env) =>
  env.TAURI_ENV_TARGET_TRIPLE || env.TAURI_TARGET_TRIPLE || env.CARGO_BUILD_TARGET || "";

const targetArchitectureFromTriple = (targetTriple) => {
  if (/(?:^|-)x86_64-apple-darwin$/u.test(targetTriple)) return "x64";
  if (/(?:^|-)aarch64-apple-darwin$/u.test(targetTriple)) return "arm64";
  return null;
};

export const assertNativeMacTarget = ({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  targetTriple = "",
} = {}) => {
  if (platform !== "darwin") return;
  const selectedTarget = targetTriple || targetTripleFromEnvironment(env);
  const targetArchitecture = targetArchitectureFromTriple(selectedTarget);
  if (targetArchitecture && targetArchitecture !== arch) {
    throw new Error(
      `Cross-target macOS desktop builds are unsupported (host ${arch}, target ${targetArchitecture}).`,
    );
  }
};

/**
 * Resolve the Tauri CLI's JavaScript entry from the desktop package and run it
 * under the current Node executable. Bin shims are not portable launch
 * targets: Node refuses to spawn Windows `.cmd` shims without a shell
 * (EINVAL, the CVE-2024-27980 hardening) and Bun installs `.exe` shims that a
 * shell cannot find by the `.cmd` name either.
 */
export const resolveTauriCliEntry = (fromDir = desktopRoot) =>
  createRequire(path.join(fromDir, "package.json")).resolve("@tauri-apps/cli/tauri.js");

/**
 * Resolve the target architecture before invoking Tauri. Tauri's own target
 * environment is not available until after the CLI starts, so host architecture
 * is the fallback for ordinary builds; explicit target triples win when a
 * caller supplies one.
 */
export const isIntelMacBuild = ({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  targetTriple = "",
} = {}) => {
  if (platform !== "darwin") return false;
  const selectedTarget = targetTriple || targetTripleFromEnvironment(env);
  if (selectedTarget) return /(?:^|-)x86_64-apple-darwin$/u.test(selectedTarget);
  return arch === "x64";
};

export const configPathForBuild = ({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  release = false,
  targetTriple = "",
} = {}) => {
  if (platform !== "darwin") {
    return release ? "src-tauri/tauri.release.conf.json" : null;
  }
  if (isIntelMacBuild({ platform, arch, env, targetTriple })) {
    return release
      ? "src-tauri/tauri.release.macos-intel.conf.json"
      : "src-tauri/tauri.macos-intel.conf.json";
  }
  return release ? "src-tauri/tauri.release.conf.json" : null;
};

/**
 * Apply `[profile.dist]` knobs to Cargo's release profile. Tauri always looks
 * for `target/release/`, so `tauri build -- --profile dist` is unsafe; the env
 * overrides keep the output directory while enabling thin LTO for signed builds.
 */
export const distReleaseCargoEnv = (env = process.env) => ({
  ...env,
  CARGO_PROFILE_RELEASE_LTO: "thin",
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
  CARGO_PROFILE_RELEASE_INCREMENTAL: "false",
  CARGO_PROFILE_RELEASE_PANIC: "abort",
});

export const tauriArgsForBuild = ({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  release = false,
  command = "build",
  extraArgs = [],
} = {}) => {
  const config = configPathForBuild({
    platform,
    arch,
    env,
    release,
    targetTriple: targetTripleFromArgs(extraArgs),
  });
  const hasBundleSelection = extraArgs.some(
    (arg) => arg === "--bundles" || arg.startsWith("--bundles="),
  );
  const releaseBundleArgs =
    command !== "dev" && !hasBundleSelection ? bundleArgsForPlatform(platform) : [];
  return [
    command,
    ...(config ? ["--config", config] : []),
    ...releaseBundleArgs,
    ...extraArgs.filter((arg) => arg !== RELEASE_FLAG && arg !== DEV_FLAG),
  ];
};

const main = () => {
  const release = process.argv.includes(RELEASE_FLAG);
  const dev = process.argv.includes(DEV_FLAG);
  const extraArgs = process.argv.slice(2);
  try {
    assertNativeMacTarget({ targetTriple: targetTripleFromArgs(extraArgs) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const args = tauriArgsForBuild({
    release,
    command: dev ? "dev" : "build",
    extraArgs,
  });
  const env = { ...(release ? distReleaseCargoEnv() : process.env) };
  delete env.RUSTUP_TOOLCHAIN;
  const result = spawnSync(process.execPath, [resolveTauriCliEntry(), ...args], {
    cwd: desktopRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
  if (process.platform === "darwin" && !dev) {
    const tauriDir = path.join(desktopRoot, "src-tauri");
    const targetDir = env.CARGO_TARGET_DIR || path.join(tauriDir, "target");
    const templateResources = path.join(tauriDir, "resources");
    for (const appBundle of findMacosAppBundles(targetDir)) {
      const result = optimizeMacosAppBundle(appBundle, templateResources);
      if (
        result.restored ||
        result.collapsed ||
        result.removedDirs.length ||
        result.removedFiles ||
        result.compressed
      ) {
        console.log(
          `Optimized ${appBundle} (symlinks=${result.restored}, collapsed=${result.collapsed}, prunedDirs=${result.removedDirs.join(",") || "none"}, licenseGzip=${result.gzipBytes})`,
        );
      }
    }
  }
  process.exit(0);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
