#!/usr/bin/env node
/**
 * Automated caption quality gate — no human OBS/Live eyeballing required.
 *
 * Runs the focused contract + regression suites that encode:
 * - readable hold after final / no blanking mid-speech
 * - finished-clause paging (punctuation + POS/Vibrato offsets)
 * - truncated-final must not erase longer painted conversion surfaces
 * - translation on/off must not vertically shift the source plate
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop");

const suites = [
  {
    cwd: path.join(root, "packages/sentence-boundary"),
    args: ["run", "test"],
    label: "sentence-boundary",
    bin: "bun",
  },
  {
    cwd: desktop,
    bin: "bunx",
    args: [
      "vitest",
      "run",
      "src/overlay/caption-quality.contract.smoke.test.tsx",
      "src/core/caption-hold-clear.test.ts",
      "src/core/caption-updates.test.ts",
      "src/overlay/captions.segment.smoke.test.tsx",
      "src/overlay/CaptionOverlay.maxChars.smoke.test.tsx",
      "src/overlay/NativeFramePublisher.maxChars.smoke.test.tsx",
    ],
    label: "desktop-caption-quality",
  },
];

let failed = false;
for (const suite of suites) {
  console.log(`\n[verify:caption-quality] ${suite.label}`);
  const result = spawnSync(suite.bin, suite.args, {
    cwd: suite.cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    failed = true;
    console.error(`[verify:caption-quality] FAILED: ${suite.label}`);
  }
}

if (failed) {
  process.exit(1);
}
console.log("\n[verify:caption-quality] OK — caption quality contracts passed without human review");
