#!/usr/bin/env bun
// Runs with Bun. Measures Worker energy-VAD allocation behavior without audio or text logs.

import {
  probabilityFromRmsDb,
  rmsDbFromRms,
  WORKER_ASR_VAD_DEFAULTS,
  WorkerEnergyVadEngine,
} from "../apps/cloudflare-worker-server/src/asr-vad.ts";

const DEFAULT_ITERATIONS = 1_000_000;
const DEFAULT_RUNS = 5;
const BASELINE_ARRAY_ALLOCATIONS_PER_CHUNK = 2;
const samples = Float32Array.from(
  { length: WORKER_ASR_VAD_DEFAULTS.chunkSamples },
  (_, index) => Math.sin((2 * Math.PI * 220 * index) / 16_000) * 0.25,
);

const positiveInteger = (raw, fallback, name) => {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
};

const percentile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

const summary = (values) => ({
  average: values.reduce((total, value) => total + value, 0) / values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Math.max(...values),
});

const baselineProcess = (input) => {
  const chunks = Array.from(
    { length: Math.ceil(input.length / WORKER_ASR_VAD_DEFAULTS.chunkSamples) },
    (_, index) =>
      input.subarray(
        index * WORKER_ASR_VAD_DEFAULTS.chunkSamples,
        (index + 1) * WORKER_ASR_VAD_DEFAULTS.chunkSamples,
      ),
  );
  return chunks.reduce(
    (best, chunk) => {
      const copied = Array.from(chunk);
      const rms = Math.sqrt(
        copied.reduce((total, sample) => total + sample * sample, 0) / copied.length,
      );
      const rmsDb = rmsDbFromRms(rms);
      const next = {
        probability: probabilityFromRmsDb(rmsDb),
        isSpeech:
          Number.isFinite(rmsDb) &&
          (rmsDb >= WORKER_ASR_VAD_DEFAULTS.silenceGateDb ||
            probabilityFromRmsDb(rmsDb) > WORKER_ASR_VAD_DEFAULTS.vadThreshold),
      };
      return {
        probability: Math.max(best.probability, next.probability),
        isSpeech: best.isSpeech || next.isSpeech,
      };
    },
    { probability: 0, isSpeech: false },
  );
};

const runBaseline = (iterations) => {
  const startedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  let checksum = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const result = baselineProcess(samples);
    checksum += result.probability + Number(result.isSpeech);
  }
  const cpu = process.cpuUsage(cpuStartedAt);
  return {
    elapsedMs: performance.now() - startedAt,
    cpuMs: (cpu.user + cpu.system) / 1_000,
    regularArrayAllocations: iterations * BASELINE_ARRAY_ALLOCATIONS_PER_CHUNK,
    copiedSampleValues: iterations * samples.length,
    checksum,
  };
};

const runOptimized = (iterations) => {
  const engine = new WorkerEnergyVadEngine();
  const startedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  let checksum = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const result = engine.process(samples);
    checksum += result.probability + Number(result.isSpeech);
  }
  const cpu = process.cpuUsage(cpuStartedAt);
  return {
    elapsedMs: performance.now() - startedAt,
    cpuMs: (cpu.user + cpu.system) / 1_000,
    regularArrayAllocations: 0,
    copiedSampleValues: 0,
    checksum,
  };
};

const argumentsByName = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [name, value] = argument.split("=", 2);
    return [name?.replace(/^--/, ""), value];
  }),
);
const iterations = positiveInteger(argumentsByName.iterations, DEFAULT_ITERATIONS, "iterations");
const runs = positiveInteger(argumentsByName.runs, DEFAULT_RUNS, "runs");
runBaseline(Math.min(iterations, 10_000));
runOptimized(Math.min(iterations, 10_000));
const baselineRuns = Array.from({ length: runs }, () => runBaseline(iterations));
const optimizedRuns = Array.from({ length: runs }, () => runOptimized(iterations));
const baselineElapsed = summary(baselineRuns.map((run) => run.elapsedMs));
const optimizedElapsed = summary(optimizedRuns.map((run) => run.elapsedMs));
const baselineCpu = summary(baselineRuns.map((run) => run.cpuMs));
const optimizedCpu = summary(optimizedRuns.map((run) => run.cpuMs));
const baseline = baselineRuns[0];
const optimized = optimizedRuns[0];
if (!baseline || !optimized || Math.abs(baseline.checksum - optimized.checksum) > 0.000_001) {
  throw new Error("Worker audio benchmark checksum mismatch");
}
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      benchmark: "worker-energy-vad-buffer-reuse",
      iterations,
      runs,
      baseline: { ...baseline, elapsedMs: baselineElapsed, cpuMs: baselineCpu },
      optimized: { ...optimized, elapsedMs: optimizedElapsed, cpuMs: optimizedCpu },
      improvement: {
        elapsedPercent: ((baselineElapsed.p50 - optimizedElapsed.p50) / baselineElapsed.p50) * 100,
        cpuPercent: ((baselineCpu.p50 - optimizedCpu.p50) / baselineCpu.p50) * 100,
        regularArrayAllocations:
          baseline.regularArrayAllocations - optimized.regularArrayAllocations,
        copiedSampleValues: baseline.copiedSampleValues - optimized.copiedSampleValues,
      },
    },
    null,
    2,
  ),
);
