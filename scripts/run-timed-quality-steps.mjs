#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUALITY_GATE_STEPS } from "./quality-gate-steps.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const formatDuration = (ms) => `${(ms / 1000).toFixed(1)}s`;

export const runTimedQualitySteps = ({
  steps = QUALITY_GATE_STEPS,
  cwd = repositoryRoot,
  env = process.env,
  runSync = spawnSync,
  now = () => performance.now(),
  stdout = console.log,
  stderr = console.error,
} = {}) => {
  const startedAt = now();
  const records = [];
  for (const [index, script] of steps.entries()) {
    const label = `${String(index + 1).padStart(2, "0")}/${steps.length} ${script}`;
    stdout(`[quality-gate] start ${label}`);
    const stepStarted = now();
    const result = runSync("bun", ["run", script], { cwd, env, stdio: "inherit" });
    const durationMs = Math.max(0, now() - stepStarted);
    records.push({
      script,
      durationMs,
      status: result.status,
      signal: result.signal,
    });
    stdout(
      `[quality-gate] done  ${label} ${formatDuration(durationMs)} exit=${result.status ?? "null"}`,
    );
    if (result.error) {
      stderr(`[quality-gate] unable to start ${script}: ${result.error.message}`);
      return { exitCode: 1, records };
    }
    if (result.status !== 0) {
      return { exitCode: result.status ?? 1, records };
    }
  }
  const totalMs = Math.max(0, now() - startedAt);
  stdout("[quality-gate] timing summary");
  for (const record of records) {
    stdout(`  ${record.script} ${formatDuration(record.durationMs)}`);
  }
  stdout(`[quality-gate] total ${formatDuration(totalMs)}`);
  return { exitCode: 0, records, totalMs };
};

const writeTimingSummary = (result) => {
  const destination = resolve(repositoryRoot, "tmp", "check-all-timing.json");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(
    destination,
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        totalMs:
          result.totalMs ?? result.records.reduce((sum, record) => sum + record.durationMs, 0),
        steps: result.records,
      },
      null,
      2,
    )}\n`,
  );
  return destination;
};

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const result = runTimedQualitySteps();
  try {
    const destination = writeTimingSummary(result);
    console.log(`[quality-gate] wrote ${destination}`);
  } catch (error) {
    console.error(`[quality-gate] unable to write timing summary: ${error.message}`);
  }
  process.exitCode = result.exitCode;
}
