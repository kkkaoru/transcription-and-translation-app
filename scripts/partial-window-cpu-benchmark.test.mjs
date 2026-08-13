import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptance,
  parseCpuSamples,
  parseTopJsonCpuSamples,
  parseTopTextCpuSamples,
  percentile,
  summarizePartialWindowMetrics,
} from "./partial-window-cpu-benchmark.mjs";

test("percentile uses nearest-rank values deterministically", () => {
  assert.equal(percentile([400, 100, 300, 200, 500], 0.5), 300);
  assert.equal(percentile([400, 100, 300, 200, 500], 0.95), 500);
  assert.equal(percentile([], 0.95), null);
});

test("top text parser keeps only the requested process samples", () => {
  const top = "Processes: 100 total\n123 3.1 20M 4 parapper\n999 87.0 30M 2 other\n123 5.9% 20M 4 parapper\n";
  assert.deepEqual(parseTopTextCpuSamples(top, 123), [3.1, 5.9]);
});

test("top JSON parser accepts document and JSONL collector output", () => {
  assert.deepEqual(parseTopJsonCpuSamples('{"samples":[{"pid":42,"cpu_percent":4.5},{"pid":8,"cpu":90}]}', 42), [4.5]);
  assert.deepEqual(parseCpuSamples('{"pid":42,"cpu":6}\n{"pid":42,"pcpu":"7.5"}', 42), [6, 7.5]);
});

test("metric summary uses the latest cumulative completed throttle rate", () => {
  const jsonl = [
    '{"event":"partial_window_asr_decode","status":"ok","decode_ms":100}',
    '{"event":"partial_window_asr_decode","status":"ok","decode_ms":390}',
    '{"event":"partial_window_asr_completed","completed":2,"decode_p95_ms":390,"throttle_applied":true,"throttle_rate":0.5}',
    '{"event":"partial_window_asr_skip","skip_reason":"disabled"}',
    '{"event":"partial_window_asr_skip","skip_reason":"nemotron"}',
    '{"event":"partial_window_asr_skip","skip_reason":"busy"}',
  ].join("\n");
  const metrics = summarizePartialWindowMetrics(jsonl);
  assert.deepEqual(metrics, {
    decodeSamples: 2,
    decodeP50Ms: 100,
    decodeP95Ms: 390,
    completedEvents: 1,
    throttleDenominator: 2,
    throttledCompletions: 1,
    throttleRate: 0.5,
    skipReasons: { disabled: 1, nemotron: 1, busy: 1 },
  });
  assert.equal(acceptance(metrics, [10, 20, 30]).accepted, false);
});

test("acceptance requires observable decode and throttle data", () => {
  const metrics = summarizePartialWindowMetrics(
    '{"event":"partial_window_asr_completed","completed":1,"throttle_rate":0}',
  );
  assert.equal(acceptance(metrics, []).accepted, false);
  assert.equal(acceptance(metrics, []).decodeAvailable, false);
});
