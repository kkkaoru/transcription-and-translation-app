#!/usr/bin/env node
/**
 * Greeting live-caption regression harness.
 *
 * Check-in gate (no microphone):
 *   bun run verify:greeting-caption
 *
 * Applies `apps/desktop/src/overlay/greeting-live-caption-fixtures.json`
 * through the desktop overlay sanitizer + caption merge tests. Live audio
 * is not required.
 *
 * Optional local playback of the checked-in wav:
 *   KOTOBA_BEACON_GREETING_WAV=apps/desktop/src/overlay/fixtures/greeting-kikoemasu.wav bun run verify:tauri:ui
 * Play 「こんにちは、きこえますか」 and confirm the overlay matches
 * `concat-hearing-*` / `append-kikoemasu`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const GREETING_FIXTURES_RELATIVE_PATH =
  "apps/desktop/src/overlay/greeting-live-caption-fixtures.json";
export const GREETING_HARNESS_RELATIVE_PATH =
  "apps/desktop/src/overlay/greeting-live-caption.harness.test.ts";
export const GREETING_WAV_RELATIVE_PATH =
  "apps/desktop/src/overlay/fixtures/greeting-kikoemasu.wav";

const REQUIRED_SANITIZE_IDS = [
  "hearing-ae",
  "hearing-oe",
  "hearing-ae-kanji",
  "concat-hearing-kana",
  "strip-zenz-period",
  "morning-hearing",
  "ohayou-gozaimasu-hearing-kanji",
  "sayonara-hearing",
  "strip-zenz-period-kana",
];
const REQUIRED_MERGE_IDS = [
  "append-kikoemasu",
  "keep-greeting-over-ack",
  "keep-longer-hearing-final",
  "second-utterance-after-greeting",
  "append-kikoemasu-after-ohayou",
];
const REQUIRED_PHRASES = [
  "こんにちは",
  "きこえますか",
  "あえますか",
  "会えますか",
  "こんにちは。聞こえますか。",
  "おはよう",
  "おはようございます",
  "さようなら",
];

export const loadGreetingLiveCaptionFixtures = (root = repositoryRoot) => {
  const fixturesPath = path.join(root, GREETING_FIXTURES_RELATIVE_PATH);
  if (!existsSync(fixturesPath)) {
    throw new Error(`missing fixtures: ${GREETING_FIXTURES_RELATIVE_PATH}`);
  }
  return JSON.parse(readFileSync(fixturesPath, "utf8"));
};

export const assertGreetingFixtureInventory = (root = repositoryRoot) => {
  const fixtures = loadGreetingLiveCaptionFixtures(root);
  const sanitizeIds = (fixtures.sanitize ?? []).map((row) => row.id);
  const mergeIds = (fixtures.merge ?? []).map((row) => row.id);
  for (const id of REQUIRED_SANITIZE_IDS) {
    if (!sanitizeIds.includes(id)) {
      throw new Error(`missing sanitize fixture: ${id}`);
    }
  }
  for (const id of REQUIRED_MERGE_IDS) {
    if (!mergeIds.includes(id)) {
      throw new Error(`missing merge fixture: ${id}`);
    }
  }
  if ((fixtures.sanitize ?? []).length < 8) {
    throw new Error(`sanitize fixture table too small: ${fixtures.sanitize?.length ?? 0}`);
  }
  if ((fixtures.merge ?? []).length < 4) {
    throw new Error(`merge fixture table too small: ${fixtures.merge?.length ?? 0}`);
  }
  if ((fixtures.paging ?? []).length < 3) {
    throw new Error(`paging fixture table too small: ${fixtures.paging?.length ?? 0}`);
  }
  const blob = JSON.stringify(fixtures);
  for (const phrase of REQUIRED_PHRASES) {
    if (!blob.includes(phrase)) {
      throw new Error(`fixture table missing required phrase: ${phrase}`);
    }
  }
  if (fixtures.playback?.env !== "KOTOBA_BEACON_GREETING_WAV") {
    throw new Error(`unexpected playback env: ${fixtures.playback?.env}`);
  }
  if (fixtures.playback?.wav !== GREETING_WAV_RELATIVE_PATH) {
    throw new Error(`playback.wav must be ${GREETING_WAV_RELATIVE_PATH}`);
  }
  if (fixtures.playback?.expectedOverlay !== "こんにちはきこえますか") {
    throw new Error("playback.expectedOverlay must be こんにちはきこえますか");
  }
  if (!/verify:tauri:ui/.test(fixtures.playback?.command ?? "")) {
    throw new Error("playback command must document verify:tauri:ui");
  }
  if (!fixtures.playback?.command?.includes(GREETING_WAV_RELATIVE_PATH)) {
    throw new Error("playback command must point at the checked-in wav");
  }
  return {
    sanitizeCount: fixtures.sanitize.length,
    mergeCount: fixtures.merge.length,
    pagingCount: fixtures.paging.length,
    playbackEnv: fixtures.playback.env,
    playbackCommand: fixtures.playback.command,
    playbackWav: fixtures.playback.wav,
  };
};

export const assertGreetingWavFixture = (root = repositoryRoot) => {
  const wavPath = path.join(root, GREETING_WAV_RELATIVE_PATH);
  if (!existsSync(wavPath)) {
    throw new Error(`missing greeting wav: ${GREETING_WAV_RELATIVE_PATH}`);
  }
  const bytes = readFileSync(wavPath);
  if (bytes.byteLength < 1024 || bytes.byteLength > 200_000) {
    throw new Error(`greeting wav size out of bounds: ${bytes.byteLength}`);
  }
  const ascii = bytes.subarray(0, 12).toString("ascii");
  if (!ascii.startsWith("RIFF") || ascii.slice(8, 12) !== "WAVE") {
    throw new Error("greeting wav must be RIFF/WAVE PCM");
  }
  return { wavPath, bytes: bytes.byteLength };
};

export const assertGreetingHarnessWired = (root = repositoryRoot) => {
  const harnessPath = path.join(root, GREETING_HARNESS_RELATIVE_PATH);
  if (!existsSync(harnessPath)) {
    throw new Error(`missing harness test: ${GREETING_HARNESS_RELATIVE_PATH}`);
  }
  const harnessSource = readFileSync(harnessPath, "utf8");
  if (!harnessSource.includes("greeting-live-caption-fixtures.json")) {
    throw new Error("harness test must import greeting-live-caption-fixtures.json");
  }
  if (!harnessSource.includes("sanitizeCaptionDisplayText")) {
    throw new Error("harness test must apply sanitizeCaptionDisplayText");
  }
  if (!harnessSource.includes("mergeCaptionPayload")) {
    throw new Error("harness test must apply mergeCaptionPayload");
  }
  if (!harnessSource.includes("selectVisibleCaptionSentence")) {
    throw new Error("harness test must apply selectVisibleCaptionSentence");
  }
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (
    pkg.scripts?.["verify:greeting-caption"] !== "node scripts/verify-greeting-live-caption.mjs"
  ) {
    throw new Error("package.json must wire verify:greeting-caption");
  }
  const qualityGate = readFileSync(path.join(root, "scripts/verify-caption-quality.mjs"), "utf8");
  if (!qualityGate.includes("greeting-live-caption.harness.test.ts")) {
    throw new Error("verify-caption-quality.mjs must run the greeting harness");
  }
  const singleApp = readFileSync(path.join(root, "scripts/check-single-app.mjs"), "utf8");
  if (!singleApp.includes("verify:greeting-caption")) {
    throw new Error("check-single-app.mjs must require verify:greeting-caption");
  }
  return { harnessPath, script: pkg.scripts["verify:greeting-caption"] };
};

export const runGreetingLiveCaptionGate = ({ spawnVitest = true } = {}) => {
  const inventory = assertGreetingFixtureInventory();
  const wav = assertGreetingWavFixture();
  const wired = assertGreetingHarnessWired();
  if (!spawnVitest) {
    return { inventory, wav, wired, vitest: "skipped" };
  }
  const desktop = path.join(repositoryRoot, "apps/desktop");
  console.log("\n[verify:greeting-caption] desktop-greeting-harness");
  const result = spawnSync(
    "bunx",
    ["vitest", "run", GREETING_HARNESS_RELATIVE_PATH.replace("apps/desktop/", "")],
    {
      cwd: desktop,
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.status !== 0) {
    throw new Error("greeting live-caption harness vitest failed");
  }
  return { inventory, wav, wired, vitest: "ok" };
};

export const main = () => {
  try {
    const inventory = assertGreetingFixtureInventory();
    const wav = assertGreetingWavFixture();
    console.log("[verify:greeting-caption] fixture table (no live audio required)");
    console.log(
      `[verify:greeting-caption] checked-in wav: ${inventory.playbackWav} (${wav.bytes} bytes)`,
    );
    console.log(`[verify:greeting-caption] optional playback: ${inventory.playbackCommand}`);
    runGreetingLiveCaptionGate({ spawnVitest: true });
    console.log("\n[verify:greeting-caption] OK — greeting live-caption fixtures passed");
    process.exitCode = 0;
    return 0;
  } catch (error) {
    console.error(`[verify:greeting-caption] FAILED: ${error.message}`);
    process.exitCode = 1;
    return 1;
  }
};

const isMainModule =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
