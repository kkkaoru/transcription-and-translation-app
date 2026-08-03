#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const desktopManifest = "apps/desktop/src-tauri/Cargo.toml";

export const TAURI_DESKTOP_TEST_CONFIG = JSON.stringify({
  bundle: {
    externalBin: null,
    resources: null,
  },
});

export const desktopRustTestArgs = () => [
  "test",
  "--manifest-path",
  desktopManifest,
  "--lib",
  "--locked",
];

export const desktopRustTestEnv = (env = process.env) => ({
  ...env,
  // Tauri's build script validates bundled files even for cargo test. The
  // desktop test must stay hermetic when release sidecars are not built.
  TAURI_CONFIG: TAURI_DESKTOP_TEST_CONFIG,
});

export const runDesktopRustTest = () => {
  const result = spawnSync("cargo", desktopRustTestArgs(), {
    env: desktopRustTestEnv(),
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Unable to start desktop cargo tests: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runDesktopRustTest();
}
