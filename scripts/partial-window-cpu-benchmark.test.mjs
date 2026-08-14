import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acceptance,
  compareResults,
  parseCpuSamples,
  parseTopJsonCpuSamples,
  parseTopTextCpuSamples,
  percentile,
  reportPartialWindowMetrics,
  summarizeFinalCaptionMetrics,
  summarizePartialWindowMetrics,
  validateReportManifest,
} from "./partial-window-cpu-benchmark.mjs";

test("percentile uses nearest-rank values deterministically", () => {
  assert.equal(percentile([400, 100, 300, 200, 500], 0.5), 300);
  assert.equal(percentile([400, 100, 300, 200, 500], 0.95), 500);
  assert.equal(percentile([], 0.95), null);
});

test("top text parser keeps only the requested process samples", () => {
  const top =
    "Processes: 100 total\n123 3.1 20M 4 parapper\n999 87.0 30M 2 other\n123 5.9% 20M 4 parapper\n";
  assert.deepEqual(parseTopTextCpuSamples(top, 123), [3.1, 5.9]);
});

test("top JSON parser accepts document and JSONL collector output", () => {
  assert.deepEqual(
    parseTopJsonCpuSamples('{"samples":[{"pid":42,"cpu_percent":4.5},{"pid":8,"cpu":90}]}', 42),
    [4.5],
  );
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
    partialEventCount: 6,
    decodeP50Ms: 100,
    decodeP95Ms: 390,
    completedEvents: 1,
    throttleDenominator: 2,
    throttledCompletions: 1,
    throttleRate: 0.5,
    dispatched: 0,
    completed: 2,
    skippedCapped: 0,
    skippedInFlight: 0,
    opportunities: 0,
    capSkipRate: null,
    inFlightSkipRate: null,
    skipReasons: { disabled: 1, nemotron: 1, busy: 1 },
  });
  assert.equal(acceptance(metrics, [10, 20, 30]).accepted, false);
});

test("partial metrics use latest cumulative counters for cap and in-flight skip rates", () => {
  const metrics = summarizePartialWindowMetrics(
    [
      '{"event":"partial_window_asr_completed","dispatched":2,"completed":1,"skipped_busy":0,"skipped_capped":0,"throttle_rate":0}',
      '{"event":"partial_window_asr_skip","skip_reason":"in_flight","dispatched":3,"skipped_busy":1,"skipped_capped":0}',
      '{"event":"partial_window_asr_skip","skip_reason":"cap","dispatched":4,"skipped_busy":1,"skipped_capped":2}',
    ].join("\n"),
  );
  assert.deepEqual(
    {
      dispatched: metrics.dispatched,
      completed: metrics.completed,
      skippedCapped: metrics.skippedCapped,
      skippedInFlight: metrics.skippedInFlight,
      opportunities: metrics.opportunities,
      capSkipRate: metrics.capSkipRate,
      inFlightSkipRate: metrics.inFlightSkipRate,
    },
    {
      dispatched: 4,
      completed: 1,
      skippedCapped: 2,
      skippedInFlight: 1,
      opportunities: 7,
      capSkipRate: 2 / 7,
      inFlightSkipRate: 1 / 7,
    },
  );
});

test("final caption E2E uses sidecar timestamps and deduplicates revisions", () => {
  const received = [
    '{"event":"server_message","payload":{"type":"turn.final","session_id":"session-a","turn_session_id":1,"turn_id":2,"revision":1,"output_sequence":3,"speech_start_at":100,"asr_final_at":240}}',
    '{"event":"server_message","payload":{"type":"turn.final","session_id":"session-a","turn_session_id":1,"turn_id":2,"revision":1,"output_sequence":3,"speech_start_at":100,"asr_final_at":999}}',
    '{"event":"server_message","payload":{"type":"turn.final","session_id":"session-a","turn_session_id":1,"turn_id":3,"revision":1,"output_sequence":4,"speech_start_at":300}}',
    '{"event":"server_message","payload":{"type":"turn.final","session_id":"other","turn_session_id":1,"turn_id":4,"revision":1,"output_sequence":5,"speech_start_at":1,"asr_final_at":2}}',
  ].join("\n");
  assert.deepEqual(summarizeFinalCaptionMetrics(received, "session-a"), {
    finalCount: 2,
    missingLatencyCount: 1,
    e2eSamplesMs: [140],
    e2eP50Ms: 140,
    e2eP95Ms: 140,
  });
});

test("OFF mode accepts zero PartialWindow events while requiring final caption latency", () => {
  const metrics = summarizePartialWindowMetrics("");
  const finalCaption = {
    finalCount: 1,
    missingLatencyCount: 0,
    e2eSamplesMs: [120],
    e2eP50Ms: 120,
    e2eP95Ms: 120,
  };
  const decision = acceptance(metrics, [10, 20], { partialWindowEnabled: false }, finalCaption);
  assert.equal(decision.accepted, true);
  assert.equal(decision.decodeAvailable, false);
  assert.equal(decision.throttleAvailable, false);
  assert.deepEqual(reportPartialWindowMetrics(metrics, false), {
    partialEventCount: 0,
    decodeSamples: null,
    decodeP50Ms: null,
    decodeP95Ms: null,
    completedEvents: null,
    throttleDenominator: null,
    throttledCompletions: null,
    throttleRate: null,
    dispatched: 0,
    completed: 0,
    skippedCapped: 0,
    skippedInFlight: 0,
    opportunities: 0,
    capSkipRate: null,
    inFlightSkipRate: null,
    skipReasons: {},
  });
  assert.equal(
    acceptance(
      summarizePartialWindowMetrics('{"event":"partial_window_asr_skip","skip_reason":"cap"}'),
      [10],
      { partialWindowEnabled: false },
      finalCaption,
    ).accepted,
    false,
  );
});

test("report manifest rejects mismatched session and non-isolated metrics paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "partial-window-benchmark-"));
  const received = join(directory, "received.jsonl");
  const metrics = join(directory, "parapper.jsonl");
  writeFileSync(
    received,
    '{"event":"client_session_start","session_id":"session-a","partial_window_asr_enabled":true,"input_name":"fixture.wav","input_duration_ms":1000}\n',
  );
  writeFileSync(metrics, "");
  const manifest = {
    schemaVersion: 1,
    sessionId: "session-a",
    partialWindowEnabled: true,
    fixture: { name: "fixture.wav", durationMs: 1000, sha256: "fixture-sha" },
    artifacts: { receivedJsonl: received, sidecarJsonl: metrics },
    replay: { status: "passed" },
    run: { startedAt: new Date(0).toISOString() },
  };
  assert.doesNotThrow(() =>
    validateReportManifest(manifest, {
      received,
      metrics,
      sessionId: "session-a",
      partialWindowEnabled: true,
    }),
  );
  assert.throws(
    () =>
      validateReportManifest(manifest, {
        received,
        metrics,
        sessionId: "other",
        partialWindowEnabled: true,
      }),
    /session-id/,
  );
  assert.throws(
    () =>
      validateReportManifest(manifest, {
        received,
        metrics: join(directory, "mixed.jsonl"),
        sessionId: "session-a",
        partialWindowEnabled: true,
      }),
    /isolated sidecar artifact/,
  );
});

test("comparison records signed CPU, final p95, and skip deltas", () => {
  const comparison = compareResults(
    {
      cpu: { meanPercent: 10, p95Percent: 20 },
      finalCaption: { e2eP95Ms: 100 },
      partialWindow: {
        skippedCapped: 0,
        skippedInFlight: 1,
        capSkipRate: 0,
        inFlightSkipRate: 0.1,
      },
    },
    {
      cpu: { meanPercent: 13, p95Percent: 120 },
      finalCaption: { e2eP95Ms: 145 },
      partialWindow: {
        skippedCapped: 2,
        skippedInFlight: 3,
        capSkipRate: 0.2,
        inFlightSkipRate: 0.3,
      },
    },
  );
  assert.equal(comparison.accepted, true);
  assert.deepEqual(comparison.cpu, {
    meanPercentDelta: 3,
    p95PercentDelta: 100,
    candidateP95RedCandidate: true,
  });
  assert.equal(comparison.finalCaption.p95DeltaMs, 45);
  assert.equal(comparison.partialWindow.capSkipCountDelta, 2);
  assert.equal(comparison.partialWindow.inFlightSkipRateDelta, 0.19999999999999998);
});

test("acceptance requires observable decode and throttle data", () => {
  const metrics = summarizePartialWindowMetrics(
    '{"event":"partial_window_asr_completed","completed":1,"throttle_rate":0}',
  );
  assert.equal(acceptance(metrics, []).accepted, false);
  assert.equal(acceptance(metrics, []).decodeAvailable, false);
});
