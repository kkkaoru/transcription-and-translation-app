#!/usr/bin/env bun
/**
 * Syphon inspect helper for Kotoba Beacon.
 *
 * 1. Runs the self-test harness (publish → receive opaque pixels).
 * 2. If Kotoba Beacon is running, samples its Syphon server and writes
 *    `tmp/syphon-inspect-latest.ppm` (checkerboard composite of the plate).
 *
 * Usage:
 *   bun scripts/syphon-inspect.mjs
 *   bun scripts/syphon-inspect.mjs --skip-self-test
 *   bun scripts/syphon-inspect.mjs --seconds 8
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = resolve(root, "apps/desktop/src-tauri/Cargo.toml");
const outDir = resolve(root, "tmp");
mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const skipSelfTest = args.includes("--skip-self-test");
const secondsIdx = args.indexOf("--seconds");
const seconds = secondsIdx >= 0 ? args[secondsIdx + 1] : "5";

const run = (exampleArgs) => {
  const result = spawnSync(
    "cargo",
    ["run", "--manifest-path", manifest, "--example", "syphon_inspect", "--", ...exampleArgs],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  return result.status ?? 1;
};

if (!skipSelfTest) {
  console.log("== Syphon self-test ==");
  const code = run(["--self-test"]);
  if (code !== 0) {
    process.exit(code);
  }
}

console.log("== Live Kotoba Beacon inspect ==");
const liveOut = resolve(outDir, "syphon-inspect-latest.ppm");
const liveCode = run(["--seconds", String(seconds), "--out", liveOut, "--min-opaque", "64"]);
if (liveCode !== 0) {
  console.error(
    "Live inspect failed. Start Kotoba Beacon first, wait for the preview captions, then re-run.",
  );
  process.exit(liveCode);
}
console.log(`Preview written to ${liveOut}`);
