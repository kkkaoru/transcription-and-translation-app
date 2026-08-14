#!/usr/bin/env node
/**
 * Replays a real PCM fixture into Parapper at microphone cadence, and reports
 * the PartialWindow acceptance metrics without retaining recognised text.
 *
 * Examples:
 *   node scripts/partial-window-cpu-benchmark.mjs replay --input /tmp/30s.wav --out-dir /tmp/pw-run --cpu-pid 12345
 *   node scripts/partial-window-cpu-benchmark.mjs report --metrics /tmp/pw-run/parapper.jsonl --cpu /tmp/pw-run/cpu.top.txt --cpu-pid 12345
 *
 * `replay` accepts only 16 kHz, mono, signed-16-bit little-endian PCM. WAV
 * input is validated rather than resampled so the test fixture is explicit.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const FRAME_MILLIS = 32;
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MILLIS * CHANNELS * BYTES_PER_SAMPLE) / 1_000;
const DEFAULT_STOP_WAIT_MS = 1_500;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_DONE_TIMEOUT_MS = 30_000;

export const percentile = (values, quantile) => {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!(quantile >= 0 && quantile <= 1)) throw new Error("quantile must be between 0 and 1");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
};

const asFiniteNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** Parse `top -stats pid,cpu,...` output for one process. */
export const parseTopTextCpuSamples = (text, expectedPid) => {
  const pid = String(expectedPid);
  const samples = [];
  for (const line of String(text).split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[0] !== pid) continue;
    const cpuToken = fields[1]?.replace(/%$/u, "");
    const cpu = asFiniteNumber(cpuToken);
    if (cpu !== null) samples.push(cpu);
  }
  return samples;
};

const collectJsonCpuValues = (value, expectedPid, output) => {
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonCpuValues(entry, expectedPid, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const pid = value.pid ?? value.process_id ?? value.processId;
  const cpu = value.cpu_percent ?? value.cpuPercent ?? value.cpu ?? value.pcpu;
  if (String(pid) === String(expectedPid)) {
    const parsed = asFiniteNumber(cpu);
    if (parsed !== null) output.push(parsed);
  }
  for (const child of Object.values(value)) collectJsonCpuValues(child, expectedPid, output);
};

/** Accepts a JSON document or one JSON object per line. */
export const parseTopJsonCpuSamples = (text, expectedPid) => {
  const samples = [];
  const trimmed = String(text).trim();
  if (!trimmed) return samples;
  try {
    collectJsonCpuValues(JSON.parse(trimmed), expectedPid, samples);
    return samples;
  } catch {
    for (const line of trimmed.split(/\r?\n/u)) {
      try {
        collectJsonCpuValues(JSON.parse(line), expectedPid, samples);
      } catch {
        // Non-JSON banner lines are normal for mixed collectors.
      }
    }
  }
  return samples;
};

export const parseCpuSamples = (text, expectedPid, format = "auto") => {
  if (format === "text") return parseTopTextCpuSamples(text, expectedPid);
  if (format === "json") return parseTopJsonCpuSamples(text, expectedPid);
  const json = parseTopJsonCpuSamples(text, expectedPid);
  return json.length > 0 ? json : parseTopTextCpuSamples(text, expectedPid);
};

const parseJsonLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
};

const jsonObjects = (jsonl) =>
  String(jsonl)
    .split(/\r?\n/u)
    .map(parseJsonLine)
    .filter((value) => value && typeof value === "object");

/**
 * Reads the production PartialWindow structured events. `decode_ms` is the
 * pure recognizer interval; `worker_ms` is deliberately not used for p95.
 */
export const summarizePartialWindowMetrics = (jsonl) => {
  const events = jsonObjects(jsonl);
  const decodes = events.filter(
    (event) => event.event === "partial_window_asr_decode" && event.status === "ok",
  );
  const decodeMs = decodes
    .map((event) => asFiniteNumber(event.decode_ms))
    .filter((value) => value !== null);
  const completed = events.filter((event) => event.event === "partial_window_asr_completed");
  const skips = events.filter((event) => event.event === "partial_window_asr_skip");
  const latestCompletedWithRate = [...completed].reverse().find((event) => {
    const rate = asFiniteNumber(event.throttle_rate);
    return rate !== null && rate >= 0 && rate <= 1;
  });
  const completedWithThrottleFlag = completed.filter(
    (event) => typeof event.throttle_applied === "boolean",
  );
  const cumulativeCompleted = asFiniteNumber(latestCompletedWithRate?.completed);
  const fallbackThrottled = completedWithThrottleFlag.filter(
    (event) => event.throttle_applied === true,
  ).length;
  const throttleRate = latestCompletedWithRate
    ? asFiniteNumber(latestCompletedWithRate.throttle_rate)
    : completedWithThrottleFlag.length
      ? fallbackThrottled / completedWithThrottleFlag.length
      : null;
  const throttleDenominator = latestCompletedWithRate
    ? (cumulativeCompleted ?? completed.length)
    : completedWithThrottleFlag.length;
  const cumulative = (field) =>
    events.reduce((maximum, event) => {
      const value = asFiniteNumber(event[field]);
      return value === null ? maximum : Math.max(maximum, value);
    }, 0);
  const dispatched = cumulative("dispatched");
  const skippedCapped = cumulative("skipped_capped");
  const skippedInFlight = cumulative("skipped_busy");
  const opportunities = dispatched + skippedCapped + skippedInFlight;
  return {
    partialEventCount: decodes.length + completed.length + skips.length,
    decodeSamples: decodeMs.length,
    decodeP50Ms: percentile(decodeMs, 0.5),
    decodeP95Ms: percentile(decodeMs, 0.95),
    completedEvents: completed.length,
    throttleDenominator,
    throttledCompletions: latestCompletedWithRate
      ? Math.round(throttleRate * throttleDenominator)
      : fallbackThrottled,
    throttleRate,
    dispatched,
    completed: cumulative("completed"),
    skippedCapped,
    skippedInFlight,
    opportunities,
    capSkipRate: opportunities ? skippedCapped / opportunities : null,
    inFlightSkipRate: opportunities ? skippedInFlight / opportunities : null,
    skipReasons: Object.fromEntries(
      skips
        .map((event) => event.skip_reason ?? event.reason)
        .filter((reason) => typeof reason === "string")
        .reduce((counts, reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1), new Map()),
    ),
  };
};

export const summarizeFinalCaptionMetrics = (receivedJsonl, sessionId) => {
  const finals = jsonObjects(receivedJsonl).filter(
    (event) =>
      event.event === "server_message" &&
      event.payload?.type === "turn.final" &&
      event.payload?.session_id === sessionId,
  );
  const seen = new Set();
  const e2eSamplesMs = [];
  let missingLatencyCount = 0;
  for (const { payload } of finals) {
    const key = [
      payload.session_id,
      payload.turn_session_id,
      payload.turn_id,
      payload.revision,
      payload.output_sequence,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    const speechStart = asFiniteNumber(payload.speech_start_at);
    const asrFinal = asFiniteNumber(payload.asr_final_at);
    if (speechStart === null || asrFinal === null || asrFinal < speechStart) {
      missingLatencyCount += 1;
    } else {
      e2eSamplesMs.push(asrFinal - speechStart);
    }
  }
  return {
    finalCount: seen.size,
    missingLatencyCount,
    e2eSamplesMs,
    e2eP50Ms: percentile(e2eSamplesMs, 0.5),
    e2eP95Ms: percentile(e2eSamplesMs, 0.95),
  };
};

export const acceptance = (metrics, cpu, thresholds = {}, finalCaption = null) => {
  const decodeP95LimitMs = thresholds.decodeP95LimitMs ?? 400;
  const throttleLimit = thresholds.throttleLimit ?? 0.1;
  const partialWindowEnabled = thresholds.partialWindowEnabled ?? true;
  const scenario = thresholds.scenario ?? "normal_conversation";
  const capSkipRateLimit =
    thresholds.capSkipRateLimit ?? (scenario === "continuous_speech" ? 0.3 : 0);
  const inFlightSkipRateLimit = thresholds.inFlightSkipRateLimit ?? 0.05;
  const inFlightSkipCountLimit = thresholds.inFlightSkipCountLimit ?? 2;
  const finalCaptionAvailable =
    finalCaption !== null &&
    finalCaption.finalCount > 0 &&
    finalCaption.missingLatencyCount === 0 &&
    finalCaption.e2eP95Ms !== null;
  const partialAvailable = metrics.decodeP95Ms !== null && metrics.throttleRate !== null;
  const partialDisabledClean = metrics.partialEventCount === 0;
  const failedChecks = [];
  if (!finalCaptionAvailable) failedChecks.push("final_caption_latency_unavailable");
  if (partialWindowEnabled) {
    if (!partialAvailable) failedChecks.push("partial_window_metrics_unavailable");
    if (metrics.decodeP95Ms !== null && metrics.decodeP95Ms >= decodeP95LimitMs)
      failedChecks.push("decode_p95_limit");
    if (metrics.throttleRate !== null && metrics.throttleRate >= throttleLimit)
      failedChecks.push("throttle_rate_limit");
    if (metrics.capSkipRate !== null && metrics.capSkipRate > capSkipRateLimit)
      failedChecks.push("cap_skip_rate_limit");
    if (metrics.inFlightSkipRate !== null && metrics.inFlightSkipRate > inFlightSkipRateLimit)
      failedChecks.push("in_flight_skip_rate_limit");
    if (metrics.skippedInFlight > inFlightSkipCountLimit)
      failedChecks.push("in_flight_skip_count_limit");
  } else if (!partialDisabledClean) {
    failedChecks.push("partial_window_activity_while_disabled");
  }
  return {
    decodeP95LimitMs,
    throttleLimit,
    capSkipRateLimit,
    inFlightSkipRateLimit,
    inFlightSkipCountLimit,
    partialWindowEnabled,
    scenario,
    cpuSamples: cpu.length,
    cpuMeanPercent: cpu.length ? cpu.reduce((sum, value) => sum + value, 0) / cpu.length : null,
    cpuP95Percent: percentile(cpu, 0.95),
    decodeAvailable: partialWindowEnabled && metrics.decodeP95Ms !== null,
    throttleAvailable: partialWindowEnabled && metrics.throttleRate !== null,
    finalCaptionAvailable,
    observabilityAvailable:
      finalCaptionAvailable && (partialWindowEnabled ? partialAvailable : partialDisabledClean),
    failedChecks,
    accepted: failedChecks.length === 0,
  };
};

export const reportPartialWindowMetrics = (metrics, partialWindowEnabled) => {
  if (partialWindowEnabled) return metrics;
  return {
    partialEventCount: metrics.partialEventCount,
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
  };
};

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export const validateReportManifest = (manifest, options) => {
  const expectedReceived = resolve(manifest.artifacts?.receivedJsonl ?? "");
  const expectedMetrics = resolve(manifest.artifacts?.sidecarJsonl ?? "");
  if (manifest.schemaVersion !== 1 || !manifest.fixture?.sha256)
    throw new Error("manifest is missing the benchmark schema or fixture hash");
  if (manifest.sessionId !== options.sessionId)
    throw new Error("--session-id does not match the replay manifest");
  if (manifest.partialWindowEnabled !== options.partialWindowEnabled)
    throw new Error("PartialWindow mode does not match the replay manifest");
  if (expectedReceived !== resolve(options.received))
    throw new Error("--received must be the replay manifest received.jsonl artifact");
  if (expectedMetrics !== resolve(options.metrics))
    throw new Error("--metrics must be the replay manifest isolated sidecar artifact");
  if (manifest.replay?.status !== "passed") throw new Error("replay manifest is not successful");
  const received = jsonObjects(readFileSync(options.received, "utf8"));
  const started = received.find(
    (event) =>
      event.event === "client_session_start" &&
      event.session_id === manifest.sessionId &&
      event.partial_window_asr_enabled === manifest.partialWindowEnabled &&
      event.input_name === manifest.fixture.name &&
      event.input_duration_ms === manifest.fixture.durationMs,
  );
  if (!started) throw new Error("received JSONL does not belong to the replay manifest run");
  if (statSync(options.metrics).mtimeMs < Date.parse(manifest.run.startedAt))
    throw new Error("sidecar metrics predate the replay manifest run boundary");
};

export const compareResults = (baseline, candidate, thresholds = {}) => {
  const baselineCpu = baseline.cpu ?? {};
  const candidateCpu = candidate.cpu ?? {};
  const baselineFinal = baseline.finalCaption ?? {};
  const candidateFinal = candidate.finalCaption ?? {};
  const baselinePartial = baseline.partialWindow ?? {};
  const candidatePartial = candidate.partialWindow ?? {};
  const finalP95DeltaLimitMs = thresholds.finalP95DeltaLimitMs ?? 50;
  const baselineFinalP95 = asFiniteNumber(baselineFinal.e2eP95Ms);
  const candidateFinalP95 = asFiniteNumber(candidateFinal.e2eP95Ms);
  const finalP95DeltaMs =
    baselineFinalP95 === null || candidateFinalP95 === null
      ? null
      : candidateFinalP95 - baselineFinalP95;
  const failedChecks = [];
  if (finalP95DeltaMs === null) failedChecks.push("final_caption_p95_delta_unavailable");
  else if (finalP95DeltaMs > finalP95DeltaLimitMs)
    failedChecks.push("final_caption_p95_delta_limit");
  const delta = (left, right) =>
    asFiniteNumber(left) === null || asFiniteNumber(right) === null ? null : right - left;
  return {
    finalP95DeltaLimitMs,
    cpu: {
      meanPercentDelta: delta(baselineCpu.meanPercent, candidateCpu.meanPercent),
      p95PercentDelta: delta(baselineCpu.p95Percent, candidateCpu.p95Percent),
      candidateP95RedCandidate: asFiniteNumber(candidateCpu.p95Percent) >= 100,
    },
    finalCaption: { p95DeltaMs: finalP95DeltaMs },
    partialWindow: {
      capSkipCountDelta: delta(baselinePartial.skippedCapped, candidatePartial.skippedCapped),
      inFlightSkipCountDelta: delta(
        baselinePartial.skippedInFlight,
        candidatePartial.skippedInFlight,
      ),
      capSkipRateDelta: delta(baselinePartial.capSkipRate, candidatePartial.capSkipRate),
      inFlightSkipRateDelta: delta(
        baselinePartial.inFlightSkipRate,
        candidatePartial.inFlightSkipRate,
      ),
    },
    observabilityAvailable: finalP95DeltaMs !== null,
    failedChecks,
    accepted: failedChecks.length === 0,
  };
};

const readU32 = (buffer, offset) => buffer.readUInt32LE(offset);
const readU16 = (buffer, offset) => buffer.readUInt16LE(offset);

export const loadPcmFixture = (inputPath, format = "auto") => {
  if (!inputPath) throw new Error("--input is required");
  const path = resolve(inputPath);
  if (!existsSync(path)) throw new Error(`input fixture does not exist: ${path}`);
  const bytes = readFileSync(path);
  const inferred =
    format === "auto" ? (extname(path).toLowerCase() === ".wav" ? "wav" : "pcm-s16le") : format;
  if (inferred === "pcm-s16le") {
    if (bytes.length === 0 || bytes.length % FRAME_BYTES !== 0) {
      throw new Error(
        `PCM fixture must be non-empty and a multiple of ${FRAME_BYTES} bytes (32 ms): ${path}`,
      );
    }
    return {
      bytes,
      inputFormat: inferred,
      inputName: basename(path),
      durationMs: (bytes.length / 2 / SAMPLE_RATE) * 1_000,
    };
  }
  if (inferred !== "wav") throw new Error(`--input-format must be wav or pcm-s16le, got ${format}`);
  if (
    bytes.length < 44 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error(`WAV fixture has no RIFF/WAVE header: ${path}`);
  }
  let offset = 12;
  let formatChunk;
  let dataChunk;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("ascii");
    const length = readU32(bytes, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) throw new Error(`WAV chunk exceeds file length: ${path}`);
    if (id === "fmt ") formatChunk = bytes.subarray(start, end);
    if (id === "data") dataChunk = bytes.subarray(start, end);
    offset = end + (length % 2);
  }
  if (!formatChunk || !dataChunk || formatChunk.length < 16)
    throw new Error(`WAV fixture requires fmt and data chunks: ${path}`);
  const audioFormat = readU16(formatChunk, 0);
  const channels = readU16(formatChunk, 2);
  const sampleRate = readU32(formatChunk, 4);
  const bitsPerSample = readU16(formatChunk, 14);
  if (
    audioFormat !== 1 ||
    channels !== CHANNELS ||
    sampleRate !== SAMPLE_RATE ||
    bitsPerSample !== 16
  ) {
    throw new Error(
      `WAV fixture must be PCM s16le, mono, 16000 Hz; got format=${audioFormat}, channels=${channels}, rate=${sampleRate}, bits=${bitsPerSample}`,
    );
  }
  if (dataChunk.length === 0 || dataChunk.length % FRAME_BYTES !== 0) {
    throw new Error(`WAV data must be non-empty and a multiple of ${FRAME_BYTES} bytes (32 ms)`);
  }
  return {
    bytes: dataChunk,
    inputFormat: inferred,
    inputName: basename(path),
    durationMs: (dataChunk.length / 2 / SAMPLE_RATE) * 1_000,
  };
};

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const parseArgs = (argv) => {
  const [command = "help", ...rest] = argv;
  const options = {
    command,
    inputFormat: "auto",
    url: "ws://127.0.0.1:18082/ws/recognition",
    stopWaitMs: DEFAULT_STOP_WAIT_MS,
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    doneTimeoutMs: DEFAULT_DONE_TIMEOUT_MS,
    cpuFormat: "auto",
    decodeP95LimitMs: 400,
    throttleLimit: 0.1,
    partialWindowEnabled: true,
    scenario: "normal_conversation",
    finalP95DeltaLimitMs: 50,
  };
  const optionKeys = {
    "--input": "input",
    "--input-format": "inputFormat",
    "--out-dir": "outDir",
    "--url": "url",
    "--cpu-pid": "cpuPid",
    "--metrics": "metrics",
    "--cpu": "cpu",
    "--cpu-format": "cpuFormat",
    "--decode-p95-limit-ms": "decodeP95LimitMs",
    "--throttle-limit": "throttleLimit",
    "--stop-wait-ms": "stopWaitMs",
    "--ready-timeout-ms": "readyTimeoutMs",
    "--done-timeout-ms": "doneTimeoutMs",
    "--partial-window-enabled": "partialWindowEnabled",
    "--scenario": "scenario",
    "--received": "received",
    "--session-id": "sessionId",
    "--out": "out",
    "--manifest": "manifest",
    "--sidecar-jsonl": "sidecarJsonl",
    "--baseline": "baseline",
    "--candidate": "candidate",
    "--cap-skip-rate-limit": "capSkipRateLimit",
    "--in-flight-skip-rate-limit": "inFlightSkipRateLimit",
    "--in-flight-skip-count-limit": "inFlightSkipCountLimit",
    "--final-p95-delta-limit-ms": "finalP95DeltaLimitMs",
  };
  const numericKeys = new Set([
    "decodeP95LimitMs",
    "throttleLimit",
    "stopWaitMs",
    "readyTimeoutMs",
    "doneTimeoutMs",
    "cpuPid",
    "capSkipRateLimit",
    "inFlightSkipRateLimit",
    "inFlightSkipCountLimit",
    "finalP95DeltaLimitMs",
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--help" || flag === "-h") options.command = "help";
    else if (flag in optionKeys) {
      const value = rest[++index];
      if (!value) throw new Error(`${flag} requires a value`);
      const key = optionKeys[flag];
      if (key === "partialWindowEnabled") {
        if (value !== "true" && value !== "false") throw new Error(`${flag} must be true or false`);
        options[key] = value === "true";
      } else {
        options[key] = numericKeys.has(key) ? Number(value) : value;
        if (numericKeys.has(key) && !Number.isFinite(options[key]))
          throw new Error(`${flag} must be finite`);
      }
    } else throw new Error(`unknown option: ${flag}`);
  }
  if (!["normal_conversation", "continuous_speech"].includes(options.scenario))
    throw new Error("--scenario must be normal_conversation or continuous_speech");
  if (!["auto", "text", "json"].includes(options.cpuFormat))
    throw new Error("--cpu-format must be auto, text, or json");
  return options;
};

const usage = () => `Usage:
  node scripts/partial-window-cpu-benchmark.mjs replay --input PATH (--out-dir DIR) [--sidecar-jsonl SIDECAR.jsonl] [--url WS_URL] [--cpu-pid PID] [--partial-window-enabled true|false]
  node scripts/partial-window-cpu-benchmark.mjs report --metrics SIDECAR.jsonl --cpu TOP.txt --cpu-pid PID --received RECEIVED.jsonl --session-id ID --out RESULT.json [--manifest MANIFEST.json] [--partial-window-enabled true|false]
  node scripts/partial-window-cpu-benchmark.mjs compare --baseline BASELINE.json --candidate CANDIDATE.json --out DIFF.json [--final-p95-delta-limit-ms 50]

Input is WAV PCM s16le/16kHz/mono or raw PCM s16le/16kHz/mono. Its byte length must be a 32ms frame multiple (${FRAME_BYTES} bytes). Replay defaults audio.partial_window_asr_enabled to true, writes manifest.json and received.jsonl without transcript text.`;

const loadWebSocket = async () => {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  const candidates = [
    resolve("node_modules/ws/index.js"),
    resolve("apps/inference-gateway/node_modules/ws/index.js"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const imported = await import(pathToFileURL(candidate).href);
    return imported.default ?? imported.WebSocket;
  }
  throw new Error("WebSocket implementation unavailable; install workspace dependencies first");
};

const attachSocketListener = (socket, event, listener, once = false) => {
  if (typeof socket.on === "function") {
    if (once && typeof socket.once === "function") socket.once(event, listener);
    else socket.on(event, listener);
    return;
  }
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(
      event,
      (message) => listener(event === "message" ? message.data : message),
      { once },
    );
    return;
  }
  throw new Error("WebSocket implementation does not support event listeners");
};

const socketMessageText = (raw) => {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  if (raw && typeof raw.text === "function") return raw.text();
  return String(raw);
};

const redactMessage = (value, key = "") => {
  if (/text|transcript|token|message|api.?key|secret/i.test(key)) return undefined;
  if (Array.isArray(value))
    return value.map((entry) => redactMessage(entry)).filter((entry) => entry !== undefined);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).flatMap(([entryKey, entryValue]) => {
        const redacted = redactMessage(entryValue, entryKey);
        return redacted === undefined ? [] : [[entryKey, redacted]];
      }),
    );
  return value;
};

const startTopSampler = (pid, outputPath, durationMs) => {
  if (!pid) return null;
  const samples = Math.max(3, Math.ceil(durationMs / 1_000) + 3);
  const child = spawn(
    "top",
    [
      "-l",
      String(samples),
      "-s",
      "1",
      "-pid",
      String(pid),
      "-stats",
      "pid,cpu,mem,threads,command",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const finished = new Promise((resolveFinished) =>
    child.once("close", () => {
      writeFileSync(outputPath, output);
      resolveFinished();
    }),
  );
  return { child, finished };
};

const replay = async (options) => {
  if (!options.outDir) throw new Error("replay requires --out-dir");
  const fixture = loadPcmFixture(options.input, options.inputFormat);
  mkdirSync(options.outDir, { recursive: true });
  const receivedPath = resolve(options.outDir, "received.jsonl");
  const topPath = resolve(options.outDir, "cpu.top.txt");
  const manifestPath = resolve(options.outDir, "manifest.json");
  const sessionId = `partial-window-benchmark-${Date.now().toString(36)}`;
  const manifest = {
    schemaVersion: 1,
    sessionId,
    partialWindowEnabled: options.partialWindowEnabled,
    scenario: options.scenario,
    fixture: {
      name: fixture.inputName,
      format: fixture.inputFormat,
      durationMs: fixture.durationMs,
      frames: fixture.bytes.length / FRAME_BYTES,
      sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
    },
    cpuPid: options.cpuPid ?? null,
    artifacts: {
      receivedJsonl: receivedPath,
      cpuTop: options.cpuPid ? topPath : null,
      sidecarJsonl: resolve(options.sidecarJsonl ?? resolve(options.outDir, "parapper.jsonl")),
    },
    run: { startedAt: new Date().toISOString() },
    replay: { status: "running", exitCode: null },
  };
  const writeManifest = () => writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeManifest();
  writeFileSync(receivedPath, "");
  const startedAt = performance.now();
  const appendReceived = (event, payload = {}) => {
    appendFileSync(
      receivedPath,
      `${JSON.stringify({
        event,
        monotonic_ms: Number((performance.now() - startedAt).toFixed(3)),
        ...payload,
      })}\n`,
    );
  };
  const sampler = startTopSampler(
    options.cpuPid,
    topPath,
    fixture.durationMs + options.stopWaitMs + options.doneTimeoutMs,
  );
  try {
    const WebSocket = await loadWebSocket();
    const socket = new WebSocket(options.url);
    let done = false;
    let ready = false;
    let closed = false;
    let failure;
    attachSocketListener(socket, "message", async (raw) => {
      try {
        const parsed = JSON.parse(await socketMessageText(raw));
        appendReceived("server_message", { payload: redactMessage(parsed) });
        ready ||= parsed.type === "session.ready";
        done ||= parsed.type === "session.done";
        if (parsed.type === "error" && parsed.fatal)
          failure = `fatal server error: ${parsed.code ?? "unknown"}`;
      } catch {
        appendReceived("server_message_invalid_json");
      }
    });
    attachSocketListener(socket, "close", () => {
      closed = true;
    });
    attachSocketListener(socket, "error", (error) => {
      failure = error instanceof Error ? error.message : String(error);
    });
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(
        () => rejectOpen(new Error(`WebSocket open timeout after ${options.readyTimeoutMs}ms`)),
        options.readyTimeoutMs,
      );
      attachSocketListener(
        socket,
        "open",
        () => {
          clearTimeout(timer);
          resolveOpen();
        },
        true,
      );
      attachSocketListener(
        socket,
        "error",
        (error) => {
          clearTimeout(timer);
          rejectOpen(error);
        },
        true,
      );
    });
    socket.send(
      JSON.stringify({
        version: 1,
        type: "session.start",
        session_id: sessionId,
        audio: {
          encoding: "pcm_s16le",
          sample_rate: SAMPLE_RATE,
          channels: CHANNELS,
          partial_window_asr_enabled: options.partialWindowEnabled,
        },
      }),
    );
    appendReceived("client_session_start", {
      session_id: sessionId,
      input_name: fixture.inputName,
      input_format: fixture.inputFormat,
      input_duration_ms: fixture.durationMs,
      partial_window_asr_enabled: options.partialWindowEnabled,
    });
    const readyDeadline = performance.now() + options.readyTimeoutMs;
    while (!ready && !failure && performance.now() < readyDeadline) await delay(10);
    if (!ready)
      throw new Error(failure ?? `session.ready timeout after ${options.readyTimeoutMs}ms`);
    let nextFrameAt = performance.now();
    let lateFrames = 0;
    for (let offset = 0; offset < fixture.bytes.length; offset += FRAME_BYTES) {
      const wait = nextFrameAt - performance.now();
      if (wait > 0) await delay(wait);
      else if (wait < -FRAME_MILLIS) {
        lateFrames += 1;
        nextFrameAt = performance.now();
      }
      socket.send(fixture.bytes.subarray(offset, offset + FRAME_BYTES));
      nextFrameAt += FRAME_MILLIS;
    }
    appendReceived("client_audio_complete", {
      frames: fixture.bytes.length / FRAME_BYTES,
      late_frames: lateFrames,
    });
    await delay(options.stopWaitMs);
    socket.send(JSON.stringify({ version: 1, type: "session.stop", session_id: sessionId }));
    appendReceived("client_session_stop", { wait_before_stop_ms: options.stopWaitMs });
    const doneDeadline = performance.now() + options.doneTimeoutMs;
    while (!done && !failure && !closed && performance.now() < doneDeadline) await delay(10);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    if (sampler) await sampler.finished;
    if (!done) throw new Error(failure ?? `session.done timeout after ${options.doneTimeoutMs}ms`);
    const output = {
      manifest: manifestPath,
      sessionId,
      receivedJsonl: receivedPath,
      cpuTop: sampler ? topPath : null,
      inputDurationMs: fixture.durationMs,
      frames: fixture.bytes.length / FRAME_BYTES,
    };
    manifest.replay = { status: "passed", exitCode: 0 };
    writeManifest();
    console.log(JSON.stringify(output));
  } catch (error) {
    manifest.replay = { status: "harness_error", exitCode: 2 };
    writeManifest();
    throw error;
  } finally {
    if (sampler && sampler.child.exitCode === null) {
      sampler.child.kill("SIGTERM");
      await sampler.finished;
    }
  }
};

const report = (options) => {
  if (
    !options.metrics ||
    !options.cpu ||
    !options.cpuPid ||
    !options.received ||
    !options.sessionId ||
    !options.out
  )
    throw new Error(
      "report requires --metrics, --cpu, --cpu-pid, --received, --session-id, and --out",
    );
  if (!existsSync(options.metrics))
    throw new Error(`metrics JSONL does not exist: ${resolve(options.metrics)}`);
  if (!existsSync(options.cpu))
    throw new Error(`CPU input does not exist: ${resolve(options.cpu)}`);
  if (!existsSync(options.received))
    throw new Error(`received JSONL does not exist: ${resolve(options.received)}`);
  const manifestPath = resolve(
    options.manifest ?? resolve(dirname(options.received), "manifest.json"),
  );
  if (!existsSync(manifestPath)) throw new Error(`replay manifest does not exist: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateReportManifest(manifest, options);
  const metrics = summarizePartialWindowMetrics(readFileSync(options.metrics, "utf8"));
  const cpu = parseCpuSamples(readFileSync(options.cpu, "utf8"), options.cpuPid, options.cpuFormat);
  const finalCaption = summarizeFinalCaptionMetrics(
    readFileSync(options.received, "utf8"),
    options.sessionId,
  );
  const decision = acceptance(metrics, cpu, options, finalCaption);
  const output = {
    schemaVersion: 1,
    sessionId: options.sessionId,
    partialWindowEnabled: options.partialWindowEnabled,
    scenario: options.scenario,
    rawMetrics: { cpuSamplesPercent: cpu, finalCaptionE2eMs: finalCaption.e2eSamplesMs },
    cpu: {
      samples: cpu.length,
      meanPercent: decision.cpuMeanPercent,
      p95Percent: decision.cpuP95Percent,
    },
    finalCaption,
    partialWindow: reportPartialWindowMetrics(metrics, options.partialWindowEnabled),
    provenance: {
      manifestPath,
      manifestSha256: sha256File(manifestPath),
      metricsPath: resolve(options.metrics),
      metricsSha256: sha256File(options.metrics),
      receivedPath: resolve(options.received),
      receivedSha256: sha256File(options.received),
      runStartedAt: manifest.run.startedAt,
    },
    thresholds: {
      decodeP95LimitMs: decision.decodeP95LimitMs,
      throttleLimit: decision.throttleLimit,
      capSkipRateLimit: decision.capSkipRateLimit,
      inFlightSkipRateLimit: decision.inFlightSkipRateLimit,
      inFlightSkipCountLimit: decision.inFlightSkipCountLimit,
    },
    acceptance: decision,
  };
  writeFileSync(resolve(options.out), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  if (!decision.observabilityAvailable) {
    throw new Error(
      "required benchmark telemetry is unavailable for the selected PartialWindow mode",
    );
  }
  if (!decision.accepted) process.exitCode = 1;
};

const compare = (options) => {
  if (!options.baseline || !options.candidate || !options.out)
    throw new Error("compare requires --baseline, --candidate, and --out");
  if (!existsSync(options.baseline) || !existsSync(options.candidate))
    throw new Error("compare inputs must exist");
  const baseline = JSON.parse(readFileSync(options.baseline, "utf8"));
  const candidate = JSON.parse(readFileSync(options.candidate, "utf8"));
  const output = {
    schemaVersion: 1,
    baseline: resolve(options.baseline),
    candidate: resolve(options.candidate),
    comparison: compareResults(baseline, candidate, options),
  };
  writeFileSync(resolve(options.out), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  if (!output.comparison.observabilityAvailable)
    throw new Error("comparison requires final caption p95 from both result artifacts");
  if (!output.comparison.accepted) process.exitCode = 1;
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") return console.log(usage());
  if (options.command === "replay") return replay(options);
  if (options.command === "report") return report(options);
  if (options.command === "compare") return compare(options);
  throw new Error(`unknown command: ${options.command}\n${usage()}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve()
    .then(main)
    .catch((error) => {
      console.error(
        `partial-window CPU benchmark: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 2;
    });
}
