// Runs with Bun.
import { afterEach, expect, it, vi } from "vitest";
import {
  buildEnvironmentText,
  buildMemoryMetrics,
  measurePageMemory,
  readHeapBytes,
  readPageMemorySnapshot,
} from "./environment";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reports heap growth and peak memory", () => {
  expect(
    buildMemoryMetrics({
      startBytes: 100,
      endBytes: 175,
      peakBytes: 220,
      method: "measureUserAgentSpecificMemory",
      sampleCount: 4,
      startBreakdownJson: "[]",
      endBreakdownJson: "[]",
      workerAttributedBytes: 600,
      wasmAttributedBytes: 500,
      workerWasmAttributedBytes: 400,
    }),
  ).toStrictEqual({
    supported: true,
    method: "measureUserAgentSpecificMemory",
    scope: "page",
    sampleCount: 4,
    startBreakdownJson: "[]",
    endBreakdownJson: "[]",
    startBytes: 100,
    endBytes: 175,
    peakBytes: 220,
    deltaBytes: 75,
    workerAttributedBytes: 600,
    wasmAttributedBytes: 500,
    workerWasmAttributedBytes: 400,
  });
});

it("marks memory metrics unavailable when the browser omits heap data", () => {
  expect(
    buildMemoryMetrics({
      startBytes: null,
      endBytes: null,
      peakBytes: null,
      method: "unavailable",
      sampleCount: 0,
      startBreakdownJson: "[]",
      endBreakdownJson: "[]",
      workerAttributedBytes: null,
      wasmAttributedBytes: null,
      workerWasmAttributedBytes: null,
    }),
  ).toStrictEqual({
    supported: false,
    method: "unavailable",
    scope: "page",
    sampleCount: 0,
    startBreakdownJson: "[]",
    endBreakdownJson: "[]",
    startBytes: null,
    endBytes: null,
    peakBytes: null,
    deltaBytes: null,
    workerAttributedBytes: null,
    wasmAttributedBytes: null,
    workerWasmAttributedBytes: null,
  });
});

it("reads Chromium heap memory when available", () => {
  vi.stubGlobal("performance", { memory: { usedJSHeapSize: 4096 } });

  expect(readHeapBytes()).toBe(4096);
});

it("takes a synchronous heap snapshot without waiting for a detailed measurement", () => {
  vi.stubGlobal("performance", { memory: { usedJSHeapSize: 5120 } });

  expect(readPageMemorySnapshot()).toStrictEqual({
    bytes: 5120,
    method: "performance.memory.usedJSHeapSize",
    breakdownJson: "[]",
    workerAttributedBytes: null,
    wasmAttributedBytes: null,
    workerWasmAttributedBytes: null,
  });
});

it("takes an unavailable synchronous snapshot when no heap counter exists", () => {
  vi.stubGlobal("performance", {});

  expect(readPageMemorySnapshot()).toStrictEqual({
    bytes: null,
    method: "unavailable",
    breakdownJson: "[]",
    workerAttributedBytes: null,
    wasmAttributedBytes: null,
    workerWasmAttributedBytes: null,
  });
});

it("uses the measured user-agent-specific memory API when available", async () => {
  vi.stubGlobal("performance", {
    measureUserAgentSpecificMemory: () => Promise.resolve({ bytes: 8192 }),
  });

  await expect(measurePageMemory()).resolves.toStrictEqual({
    bytes: 8192,
    method: "measureUserAgentSpecificMemory",
    breakdownJson: "[]",
    workerAttributedBytes: 0,
    wasmAttributedBytes: 0,
    workerWasmAttributedBytes: 0,
  });
});

it("falls back when detailed memory measurement does not settle", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("performance", {
    memory: { usedJSHeapSize: 7168 },
    measureUserAgentSpecificMemory: () => new Promise(() => undefined),
  });
  const measurement = measurePageMemory();
  await vi.advanceTimersByTimeAsync(1_500);

  await expect(measurement).resolves.toStrictEqual({
    bytes: 7168,
    method: "performance.memory.usedJSHeapSize",
    breakdownJson: "[]",
    workerAttributedBytes: null,
    wasmAttributedBytes: null,
    workerWasmAttributedBytes: null,
  });
});

it("falls back when user-agent-specific memory measurement is rejected", async () => {
  vi.stubGlobal("performance", {
    memory: { usedJSHeapSize: 6144 },
    measureUserAgentSpecificMemory: () => Promise.reject(new Error("not isolated")),
  });

  await expect(measurePageMemory()).resolves.toStrictEqual({
    bytes: 6144,
    method: "performance.memory.usedJSHeapSize",
    breakdownJson: "[]",
    workerAttributedBytes: null,
    wasmAttributedBytes: null,
    workerWasmAttributedBytes: null,
  });
});

it("records unavailable memory without fabricating bytes", async () => {
  vi.stubGlobal("performance", {});

  await expect(measurePageMemory()).resolves.toStrictEqual({
    bytes: null,
    method: "unavailable",
    breakdownJson: "[]",
    workerAttributedBytes: null,
    wasmAttributedBytes: null,
    workerWasmAttributedBytes: null,
  });
});

it("falls back to the measured Chromium JS heap counter", async () => {
  vi.stubGlobal("performance", { memory: { usedJSHeapSize: 4096 } });

  await expect(measurePageMemory()).resolves.toStrictEqual({
    bytes: 4096,
    method: "performance.memory.usedJSHeapSize",
    breakdownJson: "[]",
    workerAttributedBytes: null,
    wasmAttributedBytes: null,
    workerWasmAttributedBytes: null,
  });
});

it("records worker and WebAssembly-attributed memory breakdown", async () => {
  vi.stubGlobal("performance", {
    measureUserAgentSpecificMemory: () =>
      Promise.resolve({
        bytes: 9175,
        breakdown: [
          { bytes: 7000, types: ["JavaScript"] },
          {
            bytes: 2000,
            types: ["WebAssembly"],
            attribution: [{ scope: "DedicatedWorkerGlobalScope", url: "ort-wasm-worker.js" }],
          },
          { bytes: 100, attribution: [{ scope: "DedicatedWorkerGlobalScope" }] },
          { bytes: 50, attribution: [{ url: "model.wasm" }] },
          { bytes: 25, types: ["wasm"], attribution: [{ url: "ort-wasm-thread.js" }] },
        ],
      }),
  });

  const measurement = await measurePageMemory();
  expect(measurement.bytes).toBe(9175);
  expect(measurement.method).toBe("measureUserAgentSpecificMemory");
  expect(measurement.workerAttributedBytes).toBe(2100);
  expect(measurement.wasmAttributedBytes).toBe(2075);
  expect(measurement.workerWasmAttributedBytes).toBe(2000);
  expect(measurement.breakdownJson).toMatch(/DedicatedWorkerGlobalScope/u);
});

it("records unavailable optional environment values", () => {
  vi.stubGlobal("navigator", {
    userAgent: "test-agent",
    platform: "",
    hardwareConcurrency: 2,
    onLine: false,
  });
  const text = buildEnvironmentText({
    audioContextSampleRate: null,
    vadVersion: "Silero test",
    sttSupported: false,
  });

  expect(text).toMatch(/platform=unknown/u);
  expect(text).toMatch(/deviceMemoryGiB=unavailable/u);
  expect(text).toMatch(/audioContextSampleRateHz=unknown/u);
  expect(text).toMatch(/webSpeechApi=unsupported/u);
});

it("describes the execution environment as searchable text", () => {
  const text = buildEnvironmentText({
    audioContextSampleRate: 48000,
    vadVersion: "Silero test",
    sttSupported: true,
  });

  expect(text).toMatch(/audioContextSampleRateHz=48000/u);
  expect(text).toMatch(/vad=Silero test/u);
  expect(text).toMatch(/webSpeechApi=supported/u);
});
