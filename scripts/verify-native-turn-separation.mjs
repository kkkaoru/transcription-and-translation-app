#!/usr/bin/env bun
// Real-time, in-process regression check for two utterances separated by a genuine pause.

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
const fixtures = join("apps", "desktop", "src", "overlay", "fixtures");
const result = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--manifest-path",
    "crates/parapper-engine/Cargo.toml",
    "--example",
    "verify_separated_fixtures",
    "--",
    models,
    join(fixtures, "greeting-konbanwa.wav"),
    join(fixtures, "greeting-ohayou.wav"),
  ],
  { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`turn separation verifier exited with ${result.status}`);
const output = result.stdout.trim().split("\n").at(-1);
const report = JSON.parse(output);
if (report.result !== "PASS" || report.finalTurns !== 2) {
  throw new Error(`two-second pause did not produce two turns: ${output}`);
}
console.log(output);
