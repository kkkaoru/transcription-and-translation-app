// This file runs with node.

import assert from "node:assert/strict";
import test from "node:test";

import { parseDarwinTime, parseGnuTime } from "./benchmark-native-runtime.mjs";
import {
  compareResults,
  percentSaved,
  positiveIterations,
} from "./benchmark-native-translation.mjs";
import { parseProcessSample } from "./measure-native-translation-toggle.mjs";

test("parses macOS process CPU and RSS metrics", () => {
  assert.deepEqual(
    parseDarwinTime(`
        1.25 real         0.80 user         0.20 sys
          12582912  maximum resident set size
`),
    { wallSeconds: 1.25, cpuSeconds: 1, maxRssBytes: 12_582_912 },
  );
});

test("parses GNU process CPU and RSS metrics", () => {
  assert.deepEqual(
    parseGnuTime(`
User time (seconds): 0.70
System time (seconds): 0.10
Elapsed (wall clock) time (h:mm:ss or m:ss): 0:01.20
Maximum resident set size (kbytes): 16384
`),
    { wallSeconds: 1.2, cpuSeconds: 0.8, maxRssBytes: 16_777_216 },
  );
});

test("parses current Native translation RSS and CPU samples", () => {
  assert.deepEqual(parseProcessSample("  123456   17.5\n"), {
    rssBytes: 126_418_944,
    cpuPercent: 17.5,
  });
  assert.throws(() => parseProcessSample("unavailable"), /could not parse process RSS/);
});

test("validates translation comparison iterations", () => {
  assert.equal(positiveIterations(undefined), 3);
  assert.equal(positiveIterations("5"), 5);
  assert.throws(() => positiveIterations("0"), /iterations must be a positive integer/);
  assert.throws(() => positiveIterations("1.5"), /iterations must be a positive integer/);
});

test("reports unavailable translation process metrics without inventing values", () => {
  assert.equal(percentSaved(null, 100), null);
  assert.equal(percentSaved(100, null), null);
  assert.equal(percentSaved(0, 0), null);
});

test("compares RSS latency and quality with LFM2 as the baseline", () => {
  const lfm2 = {
    workload: {
      loadMs: 2_000,
      latencyMs: { p50: 200, p95: 400 },
      quality: { score: 70 },
    },
    process: { maxRssBytes: 800_000_000 },
  };
  const quickmt = {
    workload: {
      loadMs: 1_000,
      latencyMs: { p50: 100, p95: 300 },
      quality: { score: 75 },
    },
    process: { maxRssBytes: 500_000_000 },
  };

  assert.deepEqual(compareResults(lfm2, quickmt), {
    maxRssPercentSaved: 37.5,
    loadPercentSaved: 50,
    latencyP50PercentSaved: 50,
    latencyP95PercentSaved: 25,
    chrf2Delta: 5,
  });
});
