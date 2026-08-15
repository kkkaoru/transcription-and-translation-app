#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUALITY_GATE_STEPS } from "./quality-gate-steps.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TIMING_ARTIFACT_EXIT_CODE = 74;

const formatDuration = (ms) => `${(ms / 1000).toFixed(1)}s`;

const semanticStepIdentities = new Map([
  [
    "assets:verify#1",
    {
      id: "assets:verify:checkout-baseline",
      label: "assets:verify (checkout baseline)",
    },
  ],
  [
    "assets:verify#2",
    {
      id: "assets:verify:post-worker-build",
      label: "assets:verify (post worker:typecheck)",
    },
  ],
]);

export const describeQualitySteps = (steps) => {
  const occurrences = new Map();
  const ids = new Set();
  return steps.map((script, offset) => {
    const occurrence = (occurrences.get(script) ?? 0) + 1;
    occurrences.set(script, occurrence);
    const semanticIdentity = semanticStepIdentities.get(`${script}#${occurrence}`);
    const id = semanticIdentity?.id ?? script;
    if (ids.has(id)) throw new Error(`duplicate quality-step id: ${id}`);
    ids.add(id);
    return {
      id,
      script,
      label: semanticIdentity?.label ?? script,
      index: offset + 1,
      occurrence,
    };
  });
};

export const runTimedQualitySteps = ({
  steps = QUALITY_GATE_STEPS,
  cwd = repositoryRoot,
  env = process.env,
  runSync = spawnSync,
  now = () => performance.now(),
  stdout = console.log,
  stderr = console.error,
} = {}) => {
  const plannedSteps = describeQualitySteps(steps);
  const startedAt = now();
  let lastDoneAt = startedAt;
  let exitCode = 0;
  const records = [];
  for (const step of plannedSteps) {
    const outputLabel = `${String(step.index).padStart(2, "0")}/${plannedSteps.length} ${step.label}`;
    stdout(`[quality-gate] start ${outputLabel}`);
    const stepStarted = now();
    const result = runSync("bun", ["run", step.script], { cwd, env, stdio: "inherit" });
    const durationMs = Math.max(0, now() - stepStarted);
    records.push({
      ...step,
      durationMs,
      status: result.status,
      signal: result.signal,
    });
    stdout(
      `[quality-gate] done  ${outputLabel} ${formatDuration(durationMs)} exit=${result.status ?? "null"}`,
    );
    lastDoneAt = now();
    if (result.error) {
      stderr(`[quality-gate] unable to start ${step.script}: ${result.error.message}`);
      exitCode = 1;
      break;
    }
    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }
  }
  const totalMs = Math.max(0, lastDoneAt - startedAt);
  const stepsTotalMs = records.reduce((sum, record) => sum + record.durationMs, 0);
  const overheadMs = Math.max(0, totalMs - stepsTotalMs);
  if (exitCode === 0) {
    stdout("[quality-gate] timing summary");
    for (const record of records) {
      stdout(`  ${record.label} ${formatDuration(record.durationMs)}`);
    }
    stdout(`[quality-gate] total ${formatDuration(totalMs)}`);
  }
  return { exitCode, records, totalMs, stepsTotalMs, overheadMs };
};

export const writeTimingSummary = (
  result,
  {
    destination = resolve(repositoryRoot, "tmp", "check-all-timing.json"),
    makeDirectory = mkdirSync,
    writeFile = writeFileSync,
    renameFile = renameSync,
    removeFile = rmSync,
    createTemporaryPath = (path) => `${path}.${process.pid}.${randomUUID()}.tmp`,
    getRecordedAt = () => new Date().toISOString(),
  } = {},
) => {
  makeDirectory(dirname(destination), { recursive: true });
  const temporaryPath = createTemporaryPath(destination);
  const payload = `${JSON.stringify(
    {
      recordedAt: getRecordedAt(),
      totalMs: result.totalMs,
      stepsTotalMs: result.stepsTotalMs,
      overheadMs: result.overheadMs,
      steps: result.records,
    },
    null,
    2,
  )}\n`;
  try {
    writeFile(temporaryPath, payload);
    renameFile(temporaryPath, destination);
  } catch (error) {
    try {
      removeFile(temporaryPath, { force: true });
    } catch {
      // Preserve the primary write or rename error.
    }
    throw error;
  }
  return destination;
};

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

export const runTimedQualityStepsMain = ({
  runSteps = runTimedQualitySteps,
  writeSummary = writeTimingSummary,
  stdout = console.log,
  stderr = console.error,
} = {}) => {
  const result = runSteps();
  try {
    const destination = writeSummary(result);
    stdout(`[quality-gate] wrote ${destination}`);
  } catch (error) {
    stderr(`[quality-gate] unable to write timing summary: ${error.message}`);
    return result.exitCode === 0 ? TIMING_ARTIFACT_EXIT_CODE : result.exitCode;
  }
  return result.exitCode;
};

if (isMainModule) process.exitCode = runTimedQualityStepsMain();
