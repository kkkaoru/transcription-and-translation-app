#!/usr/bin/env node

/** Build signed Tauri updater artifacts without ever accepting a missing key. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const macosPreflight = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("./check-macos-signing.mjs", import.meta.url))],
  { stdio: "inherit", env: process.env },
);
if (macosPreflight.error || macosPreflight.status !== 0) {
  process.exit(macosPreflight.status || 1);
}

if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
  console.error(
    "TAURI_SIGNING_PRIVATE_KEY is required for updater artifacts; use `bun run build:app` for an unsigned local bundle.",
  );
  process.exit(2);
}

const result = spawnSync(
  "bun",
  ["--filter=@caption-bridge/desktop", "run", "tauri:build:release"],
  { stdio: "inherit", env: process.env },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
