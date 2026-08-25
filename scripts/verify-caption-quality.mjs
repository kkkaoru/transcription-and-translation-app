#!/usr/bin/env node
/**
 * Automated caption quality gate — no human OBS/Live eyeballing required.
 *
 * Runs the focused contract + regression suites that encode:
 * - readable hold after final / no blanking mid-speech
 * - finished-clause paging (punctuation + POS/Vibrato offsets)
 * - truncated-final must not erase longer painted conversion surfaces
 * - translation on/off must not vertically shift the source plate
 * - greeting live-caption fixtures (こんにちは / きこえますか, no live audio)
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(repositoryRoot, "apps/desktop");

export const GREETING_HARNESS_VITEST_PATH = "src/overlay/greeting-live-caption.harness.test.ts";

export const CAPTION_QUALITY_SUITES = [
  {
    cwd: path.join(repositoryRoot, "packages/sentence-boundary"),
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
      GREETING_HARNESS_VITEST_PATH,
    ],
    label: "desktop-caption-quality",
  },
];

export const assertCaptionQualityGateWired = (root = repositoryRoot) => {
  const desktopSuite = CAPTION_QUALITY_SUITES.find(
    (suite) => suite.label === "desktop-caption-quality",
  );
  if (!desktopSuite?.args.includes(GREETING_HARNESS_VITEST_PATH)) {
    throw new Error("caption-quality desktop suite must run the greeting harness");
  }
  if (!CAPTION_QUALITY_SUITES.some((suite) => suite.label === "sentence-boundary")) {
    throw new Error("caption-quality gate must run sentence-boundary tests");
  }
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (pkg.scripts?.["verify:caption-quality"] !== "node scripts/verify-caption-quality.mjs") {
    throw new Error("package.json must wire verify:caption-quality");
  }
  if (!/verify-caption-quality\.test\.mjs/.test(pkg.scripts?.["test:build-cleanup"] ?? "")) {
    throw new Error("test:build-cleanup must run verify-caption-quality.test.mjs");
  }
  return {
    script: pkg.scripts["verify:caption-quality"],
    desktopFiles: desktopSuite.args.filter((arg) => arg.startsWith("src/")),
  };
};

export const runCaptionQualityGate = ({ spawnSuites = true } = {}) => {
  const wired = assertCaptionQualityGateWired();
  if (!spawnSuites) {
    return { wired, suites: "skipped" };
  }
  let failed = false;
  for (const suite of CAPTION_QUALITY_SUITES) {
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
    throw new Error("caption quality contracts failed");
  }
  return { wired, suites: "ok" };
};

export const main = () => {
  try {
    runCaptionQualityGate({ spawnSuites: true });
    console.log(
      "\n[verify:caption-quality] OK — caption quality contracts passed without human review",
    );
    process.exitCode = 0;
    return 0;
  } catch (error) {
    console.error(`[verify:caption-quality] FAILED: ${error.message}`);
    process.exitCode = 1;
    return 1;
  }
};

const isMainModule =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
