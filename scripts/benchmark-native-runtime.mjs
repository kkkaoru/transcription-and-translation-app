#!/usr/bin/env bun
// This file runs with bun.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";

const MANIFEST = "apps/native/Cargo.toml";
const EXAMPLE_BINARY = resolve(
  `apps/native/target/release/examples/native_runtime_metrics${platform() === "win32" ? ".exe" : ""}`,
);
const DEFAULT_ITERATIONS = 5_000_000;
const DEFAULT_RUNS = 3;
const DEFAULT_SAMPLE_SECONDS = 10;
const SAMPLE_INTERVAL_MS = 250;

const percentile = (values, fraction) => {
  const sorted = values.toSorted((left, right) => left - right);
  const rank = (sorted.length - 1) * fraction;
  const lower = sorted[Math.floor(rank)] ?? 0;
  const upper = sorted[Math.ceil(rank)] ?? lower;
  return lower + (upper - lower) * (rank - Math.floor(rank));
};

const summary = (values) => ({
  average: values.reduce((total, value) => total + value, 0) / values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Math.max(...values),
});

export const parseDarwinTime = (stderr) => {
  const cpu = stderr.match(/([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/);
  const rss = stderr.match(/(\d+)\s+maximum resident set size/);
  return {
    wallSeconds: cpu ? Number(cpu[1]) : null,
    cpuSeconds: cpu ? Number(cpu[2]) + Number(cpu[3]) : null,
    maxRssBytes: rss ? Number(rss[1]) : null,
  };
};

export const parseGnuTime = (stderr) => {
  const user = stderr.match(/User time \(seconds\):\s*([\d.]+)/);
  const system = stderr.match(/System time \(seconds\):\s*([\d.]+)/);
  const wall = stderr.match(/Elapsed \(wall clock\) time.*\):\s*([\d:.]+)/);
  const rss = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  const wallParts = wall?.[1].split(":").map(Number) ?? [];
  const wallSeconds =
    wallParts.length === 3
      ? wallParts[0] * 3_600 + wallParts[1] * 60 + wallParts[2]
      : wallParts.length === 2
        ? wallParts[0] * 60 + wallParts[1]
        : null;
  return {
    wallSeconds,
    cpuSeconds: user && system ? Number((Number(user[1]) + Number(system[1])).toFixed(6)) : null,
    maxRssBytes: rss ? Number(rss[1]) * 1_024 : null,
  };
};

const parseArguments = (arguments_) => {
  const command = arguments_[0] ?? "fixture";
  const options = {};
  for (let index = 1; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${key ?? "end of command"}`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
};

const positiveInteger = (value, fallback, label) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
};

const buildFixture = () => {
  const result = spawnSync(
    "cargo",
    ["build", "--release", "--manifest-path", MANIFEST, "--example", "native_runtime_metrics"],
    { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || !existsSync(EXAMPLE_BINARY)) {
    throw new Error("could not build the Native runtime metrics fixture");
  }
};

const runTimedFixture = (mode, iterations) => {
  if (platform() === "win32") {
    const result = spawnSync(EXAMPLE_BINARY, [mode, String(iterations)], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `${mode} fixture failed`);
    const workload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    return {
      workload,
      process: { wallSeconds: workload.elapsedMs / 1_000, cpuSeconds: null, maxRssBytes: null },
    };
  }
  const timeArguments =
    platform() === "darwin"
      ? ["-l", EXAMPLE_BINARY, mode, String(iterations)]
      : ["-v", EXAMPLE_BINARY, mode, String(iterations)];
  const result = spawnSync("/usr/bin/time", timeArguments, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${mode} fixture failed`);
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  const workload = JSON.parse(line);
  const processMetrics =
    platform() === "darwin" ? parseDarwinTime(result.stderr) : parseGnuTime(result.stderr);
  return { workload, process: processMetrics };
};

const runFixture = (options) => {
  const iterations = positiveInteger(options.iterations, DEFAULT_ITERATIONS, "iterations");
  const runs = positiveInteger(options.runs, DEFAULT_RUNS, "runs");
  buildFixture();
  const baseline = Array.from({ length: runs }, () => runTimedFixture("baseline", iterations));
  const optimized = Array.from({ length: runs }, () => runTimedFixture("optimized", iterations));
  const optionalSummary = (values) => {
    const available = values.filter((value) => Number.isFinite(value));
    return available.length === 0 ? null : summary(available);
  };
  const summarizeRuns = (values) => ({
    workload: values[0].workload,
    elapsedMs: summary(values.map((value) => value.workload.elapsedMs)),
    cpuSeconds: optionalSummary(values.map((value) => value.process.cpuSeconds)),
    maxRssBytes: optionalSummary(values.map((value) => value.process.maxRssBytes)),
  });
  const baselineSummary = summarizeRuns(baseline);
  const optimizedSummary = summarizeRuns(optimized);
  const percentSaved = (before, after) =>
    before === null || after === null || before === 0 ? null : ((before - after) / before) * 100;
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        benchmark: "native-hot-path",
        iterations,
        runs,
        baseline: baselineSummary,
        optimized: optimizedSummary,
        improvement: {
          elapsedPercent: percentSaved(
            baselineSummary.elapsedMs.p50,
            optimizedSummary.elapsedMs.p50,
          ),
          cpuPercent: percentSaved(
            baselineSummary.cpuSeconds?.p50 ?? null,
            optimizedSummary.cpuSeconds?.p50 ?? null,
          ),
          rssPercent: percentSaved(
            baselineSummary.maxRssBytes?.p50 ?? null,
            optimizedSummary.maxRssBytes?.p50 ?? null,
          ),
          pcmAllocations:
            baselineSummary.workload.pcmAllocations - optimizedSummary.workload.pcmAllocations,
          captionCloneOperations:
            baselineSummary.workload.captionCloneOperations -
            optimizedSummary.workload.captionCloneOperations,
          outputWindowChecks:
            baselineSummary.workload.outputWindowChecks -
            optimizedSummary.workload.outputWindowChecks,
        },
      },
      null,
      2,
    ),
  );
};

const readProcessSample = (pid) => {
  if (platform() === "win32") {
    const command = `(Get-Process -Id ${pid} | Select-Object CPU,WorkingSet64 | ConvertTo-Json -Compress)`;
    const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || !result.stdout.trim()) return null;
    const value = JSON.parse(result.stdout);
    return Number.isFinite(value.CPU) && Number.isFinite(value.WorkingSet64)
      ? { cpuSeconds: value.CPU, rssBytes: value.WorkingSet64 }
      : null;
  }
  const result = spawnSync("ps", ["-o", "%cpu=,rss=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const [cpu, rssKiB] = result.stdout.trim().split(/\s+/).map(Number);
  return Number.isFinite(cpu) && Number.isFinite(rssKiB)
    ? { cpuPercent: cpu, rssBytes: rssKiB * 1_024 }
    : null;
};

const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const sampleProcess = async (options) => {
  const pid = positiveInteger(options.pid, 0, "pid");
  const seconds = positiveInteger(options.seconds, DEFAULT_SAMPLE_SECONDS, "seconds");
  const samples = [];
  const deadline = performance.now() + seconds * 1_000;
  let previousSample = null;
  let previousSampleAt = performance.now();
  while (performance.now() < deadline) {
    const sampledAt = performance.now();
    const sample = readProcessSample(pid);
    if (!sample) break;
    const elapsedSeconds = (sampledAt - previousSampleAt) / 1_000;
    const cpuPercent =
      sample.cpuPercent ??
      (previousSample && elapsedSeconds > 0
        ? ((sample.cpuSeconds - previousSample.cpuSeconds) / elapsedSeconds) * 100
        : 0);
    samples.push({ cpuPercent: Math.max(0, cpuPercent), rssBytes: sample.rssBytes });
    previousSample = sample;
    previousSampleAt = sampledAt;
    await delay(SAMPLE_INTERVAL_MS);
  }
  if (samples.length === 0) throw new Error(`process ${pid} was not available for sampling`);
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        benchmark: "native-live-process",
        pid,
        durationSeconds: seconds,
        samples: samples.length,
        cpuPercent: summary(samples.map((sample) => sample.cpuPercent)),
        rssBytes: summary(samples.map((sample) => sample.rssBytes)),
      },
      null,
      2,
    ),
  );
};

const main = async () => {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "fixture") {
    runFixture(options);
    return;
  }
  if (command === "sample") {
    await sampleProcess(options);
    return;
  }
  throw new Error("command must be fixture or sample");
};

if (import.meta.main) {
  await main();
}
