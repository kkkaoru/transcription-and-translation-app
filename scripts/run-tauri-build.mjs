#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DESKTOP_FILTER = "--filter=@caption-bridge/desktop";

/**
 * Tauri uses different bundle target names on each desktop platform. Keep the
 * platform decision in Node so the same root build command works in PowerShell
 * and POSIX shells.
 */
export const bundleArgsForPlatform = (platform, mode = "app") => {
  if (platform === "darwin") {
    return ["--bundles", mode === "dmg" ? "app,dmg" : "app"];
  }
  if (platform === "win32") {
    return ["--bundles", "msi,nsis"];
  }
  return [];
};

export const tauriBuildArgs = (platform, mode = "app") => [
  DESKTOP_FILTER,
  "run",
  "tauri:build",
  "--",
  ...bundleArgsForPlatform(platform, mode),
];

const main = () => {
  const mode = process.argv.includes("--dmg") ? "dmg" : "app";
  const result = spawnSync("bun", tauriBuildArgs(process.platform, mode), {
    env: process.env,
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
