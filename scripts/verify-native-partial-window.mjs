#!/usr/bin/env bun
// Verifies that real in-process ASR emits a preview before the 8-second segment boundary.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const models =
  process.env.KOTOBA_NATIVE_MODELS ??
  join(
    homedir(),
    "Library",
    "Application Support",
    "com.kotobabeacon.native",
    "parapper",
    "models",
  );
const fixture = join("apps", "desktop", "src", "overlay", "fixtures", "greeting-kikoemasu.wav");
const result = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--manifest-path",
    "crates/parapper-engine/Cargo.toml",
    "--example",
    "verify_partial_window",
    "--",
    models,
    fixture,
  ],
  { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`partial-window verifier exited with ${result.status}`);
const output = result.stdout.trim().split("\n").at(-1);
const report = JSON.parse(output);
if (report.result !== "PASS" || report.partialCount < 1 || report.firstPartialMillis >= 8_000) {
  throw new Error(`partial-window ASR did not become visible before segment close: ${output}`);
}
console.log(output);
