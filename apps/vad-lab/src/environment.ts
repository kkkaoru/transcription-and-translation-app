// Runs in the browser; built and tested with Bun.
import type { MemoryMeasurementMethod, VadMemoryMetrics } from "./model";

interface EnvironmentInput {
  audioContextSampleRate: number | null;
  vadVersion: string;
  sttSupported: boolean;
}

interface MemoryMetricsInput {
  startBytes: number | null;
  endBytes: number | null;
  peakBytes: number | null;
  method: MemoryMeasurementMethod;
  sampleCount: number;
  startBreakdownJson: string;
  endBreakdownJson: string;
  workerAttributedBytes: number | null;
  wasmAttributedBytes: number | null;
  workerWasmAttributedBytes: number | null;
}

interface MemoryAttributionSummary {
  workerAttributedBytes: number;
  wasmAttributedBytes: number;
  workerWasmAttributedBytes: number;
}

export interface MeasuredMemory {
  bytes: number | null;
  method: MemoryMeasurementMethod;
  breakdownJson: string;
  workerAttributedBytes: number | null;
  wasmAttributedBytes: number | null;
  workerWasmAttributedBytes: number | null;
}

const DETAILED_MEMORY_TIMEOUT_MS: number = 1_500;
const detailedMemoryWithinTimeout = (
  measure: () => Promise<UserAgentSpecificMemoryResult>,
): Promise<UserAgentSpecificMemoryResult> =>
  new Promise((resolve, reject) => {
    const timeoutId: number = window.setTimeout(
      () => reject(new Error("Detailed page memory measurement timed out")),
      DETAILED_MEMORY_TIMEOUT_MS,
    );
    void measure.call(performance).then(
      (measurement) => {
        window.clearTimeout(timeoutId);
        resolve(measurement);
      },
      (error: unknown) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });

const attributionText = (entry: UserAgentSpecificMemoryBreakdown): string =>
  (entry.attribution ?? [])
    .map((attribution) => `${attribution.scope ?? ""} ${attribution.url ?? ""}`.toLowerCase())
    .join(" ");
const typeText = (entry: UserAgentSpecificMemoryBreakdown): string =>
  (entry.types ?? []).join(" ").toLowerCase();
const sumAttributedBytes = (
  breakdown: readonly UserAgentSpecificMemoryBreakdown[],
): MemoryAttributionSummary =>
  breakdown.reduce<MemoryAttributionSummary>(
    (summary, entry) => {
      const attribution: string = attributionText(entry);
      const types: string = typeText(entry);
      const worker: boolean = attribution.includes("worker");
      const wasm: boolean =
        types.includes("wasm") ||
        types.includes("webassembly") ||
        attribution.includes(".wasm") ||
        attribution.includes("ort-wasm");
      return {
        workerAttributedBytes: summary.workerAttributedBytes + (worker ? entry.bytes : 0),
        wasmAttributedBytes: summary.wasmAttributedBytes + (wasm ? entry.bytes : 0),
        workerWasmAttributedBytes:
          summary.workerWasmAttributedBytes + (worker && wasm ? entry.bytes : 0),
      };
    },
    { workerAttributedBytes: 0, wasmAttributedBytes: 0, workerWasmAttributedBytes: 0 },
  );

export const readHeapBytes = (): number | null => performance.memory?.usedJSHeapSize ?? null;

export const readPageMemorySnapshot = (): MeasuredMemory => {
  const bytes: number | null = readHeapBytes();
  return {
    bytes,
    method: bytes === null ? "unavailable" : "performance.memory.usedJSHeapSize",
    breakdownJson: "[]",
    workerAttributedBytes: null,
    wasmAttributedBytes: null,
    workerWasmAttributedBytes: null,
  };
};

export const measurePageMemory = async (): Promise<MeasuredMemory> => {
  if (performance.measureUserAgentSpecificMemory !== undefined) {
    try {
      const measurement: UserAgentSpecificMemoryResult = await detailedMemoryWithinTimeout(
        performance.measureUserAgentSpecificMemory,
      );
      const breakdown: readonly UserAgentSpecificMemoryBreakdown[] = measurement.breakdown ?? [];
      return {
        bytes: measurement.bytes,
        method: "measureUserAgentSpecificMemory",
        breakdownJson: JSON.stringify(breakdown, null, 2),
        ...sumAttributedBytes(breakdown),
      };
    } catch {
      // Fall through to Chromium's synchronous measured JS heap counter.
    }
  }
  return readPageMemorySnapshot();
};

export const buildMemoryMetrics = ({
  startBytes,
  endBytes,
  peakBytes,
  method,
  sampleCount,
  startBreakdownJson,
  endBreakdownJson,
  workerAttributedBytes,
  wasmAttributedBytes,
  workerWasmAttributedBytes,
}: MemoryMetricsInput): VadMemoryMetrics => ({
  supported: startBytes !== null && endBytes !== null,
  method,
  scope: "page",
  sampleCount,
  startBreakdownJson,
  endBreakdownJson,
  startBytes,
  endBytes,
  peakBytes,
  deltaBytes: startBytes === null || endBytes === null ? null : endBytes - startBytes,
  workerAttributedBytes,
  wasmAttributedBytes,
  workerWasmAttributedBytes,
});

export const buildEnvironmentText = ({
  audioContextSampleRate,
  vadVersion,
  sttSupported,
}: EnvironmentInput): string =>
  [
    `userAgent=${navigator.userAgent}`,
    `platform=${navigator.platform || "unknown"}`,
    `hardwareConcurrency=${navigator.hardwareConcurrency}`,
    `deviceMemoryGiB=${navigator.deviceMemory ?? "unavailable"}`,
    `online=${navigator.onLine}`,
    `crossOriginIsolated=${globalThis.crossOriginIsolated}`,
    `audioContextSampleRateHz=${audioContextSampleRate ?? "unknown"}`,
    `vad=${vadVersion}`,
    `webSpeechApi=${sttSupported ? "supported" : "unsupported"}`,
    `displayMode=${window.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser"}`,
  ].join("\n");
