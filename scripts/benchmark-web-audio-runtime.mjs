#!/usr/bin/env bun
// Runs with Bun. Measures allocation behavior in the browser Silero audio hot path.

import {
  createSileroReusableBuffers,
  probabilityFromOrtOutput,
  writeNextSileroContext,
  writeSileroModelWindow,
} from "../apps/azookey-compare/src/lib/workers-ai-asr-silero.ts";
import {
  SILERO_CHUNK_SAMPLES,
  SILERO_CONTEXT_SAMPLES,
  SILERO_INPUT_SAMPLES,
  SILERO_SAMPLE_RATE,
  SILERO_STATE_LEN,
} from "../apps/azookey-compare/src/lib/workers-ai-asr-vad.ts";

const DEFAULT_ITERATIONS = 1_000_000;
const DEFAULT_RUNS = 5;
const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;
const BIGINT_BYTES = BigInt64Array.BYTES_PER_ELEMENT;
const BASELINE_ALLOCATIONS_PER_CHUNK = 5;
const BASELINE_BYTES_PER_CHUNK =
  (SILERO_CHUNK_SAMPLES + SILERO_INPUT_SAMPLES + SILERO_CONTEXT_SAMPLES + SILERO_STATE_LEN) *
    FLOAT_BYTES +
  BIGINT_BYTES;
const REUSABLE_ALLOCATIONS = 5;
const REUSABLE_BYTES = BASELINE_BYTES_PER_CHUNK;
const samples = Float32Array.from(
  { length: SILERO_CHUNK_SAMPLES },
  (_, index) => Math.sin((2 * Math.PI * 220 * index) / SILERO_SAMPLE_RATE) * 0.25,
);
const ortState = new Float32Array(SILERO_STATE_LEN).fill(0.125);
const outputs = {
  output: { data: new Float32Array([0.75]) },
  stateN: { data: ortState },
};

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

const runBaseline = (iterations) => {
  const startedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  let currentContext = new Float32Array(SILERO_CONTEXT_SAMPLES);
  let checksum = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const chunk = new Float32Array(SILERO_CHUNK_SAMPLES);
    chunk.set(samples);
    const input = new Float32Array(SILERO_INPUT_SAMPLES);
    input.set(currentContext);
    input.set(chunk, SILERO_CONTEXT_SAMPLES);
    const context = new Float32Array(SILERO_CONTEXT_SAMPLES);
    context.set(chunk.subarray(SILERO_CHUNK_SAMPLES - SILERO_CONTEXT_SAMPLES));
    currentContext = context;
    const state = new Float32Array(SILERO_STATE_LEN);
    state.set(ortState);
    const sampleRate = BigInt64Array.from([BigInt(SILERO_SAMPLE_RATE)]);
    checksum += input[iteration % SILERO_INPUT_SAMPLES] ?? 0;
    checksum += context[iteration % SILERO_CONTEXT_SAMPLES] ?? 0;
    checksum += state[iteration % SILERO_STATE_LEN] ?? 0;
    checksum += Number(sampleRate[0] ?? BigInt(0));
  }
  const cpu = process.cpuUsage(cpuStartedAt);
  return {
    elapsedMs: performance.now() - startedAt,
    cpuMs: (cpu.user + cpu.system) / 1_000,
    typedArrayAllocations: iterations * BASELINE_ALLOCATIONS_PER_CHUNK,
    typedArrayAllocatedBytes: iterations * BASELINE_BYTES_PER_CHUNK,
    checksum,
  };
};

const runOptimized = (iterations) => {
  const buffers = createSileroReusableBuffers();
  const startedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  let checksum = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const copyLen = writeSileroModelWindow(buffers, samples);
    probabilityFromOrtOutput(outputs, buffers.state);
    writeNextSileroContext(buffers.context, buffers.chunk, copyLen);
    checksum += buffers.input[iteration % SILERO_INPUT_SAMPLES] ?? 0;
    checksum += buffers.context[iteration % SILERO_CONTEXT_SAMPLES] ?? 0;
    checksum += buffers.state[iteration % SILERO_STATE_LEN] ?? 0;
    checksum += Number(buffers.sampleRate[0] ?? BigInt(0));
  }
  const cpu = process.cpuUsage(cpuStartedAt);
  return {
    elapsedMs: performance.now() - startedAt,
    cpuMs: (cpu.user + cpu.system) / 1_000,
    typedArrayAllocations: REUSABLE_ALLOCATIONS,
    typedArrayAllocatedBytes: REUSABLE_BYTES,
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
if (!baseline || !optimized || baseline.checksum !== optimized.checksum) {
  throw new Error("Web audio benchmark checksum mismatch");
}
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      benchmark: "web-silero-buffer-reuse",
      iterations,
      runs,
      baseline: { ...baseline, elapsedMs: baselineElapsed, cpuMs: baselineCpu },
      optimized: { ...optimized, elapsedMs: optimizedElapsed, cpuMs: optimizedCpu },
      improvement: {
        elapsedPercent: ((baselineElapsed.p50 - optimizedElapsed.p50) / baselineElapsed.p50) * 100,
        cpuPercent: ((baselineCpu.p50 - optimizedCpu.p50) / baselineCpu.p50) * 100,
        typedArrayAllocations: baseline.typedArrayAllocations - optimized.typedArrayAllocations,
        typedArrayAllocatedBytes:
          baseline.typedArrayAllocatedBytes - optimized.typedArrayAllocatedBytes,
      },
    },
    null,
    2,
  ),
);
