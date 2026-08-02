#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
  const selectedTarget =
    targetTriple ||
    env.TAURI_ENV_TARGET_TRIPLE ||
    env.TAURI_TARGET_TRIPLE ||
    env.CARGO_BUILD_TARGET ||
    "";
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
  return [
    command,
    ...(config ? ["--config", config] : []),
    ...extraArgs.filter((arg) => arg !== RELEASE_FLAG && arg !== DEV_FLAG),
  ];
};

const main = () => {
  const release = process.argv.includes(RELEASE_FLAG);
  const dev = process.argv.includes(DEV_FLAG);
  const args = tauriArgsForBuild({
    release,
    command: dev ? "dev" : "build",
    extraArgs: process.argv.slice(2),
  });
  const env = { ...process.env };
  delete env.RUSTUP_TOOLCHAIN;
  const result = spawnSync("tauri", args, {
    cwd: desktopRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
