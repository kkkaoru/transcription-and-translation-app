#!/usr/bin/env bun
// Black-box verifies the portable in-process engine with real models and PCM.

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
const fixture =
  process.env.KOTOBA_NATIVE_AUDIO_FIXTURE ??
  join("apps", "desktop", "src", "overlay", "fixtures", "greeting-kikoemasu.wav");

const result = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--manifest-path",
    "crates/parapper-engine/Cargo.toml",
    "--example",
    "verify_fixture",
    "--",
    models,
    fixture,
  ],
  { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`in-process ASR verifier exited with ${result.status}`);
const output = result.stdout.trim().split("\n").at(-1);
const report = JSON.parse(output);
if (report.result !== "PASS" || !report.caption) {
  throw new Error(`in-process ASR did not produce a final caption: ${output}`);
}
console.log(
  JSON.stringify({ ...report, processArchitecture: "in-process", childProcessRequired: false }),
);
