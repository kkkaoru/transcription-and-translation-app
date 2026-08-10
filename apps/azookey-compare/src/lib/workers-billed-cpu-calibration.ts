/**
 * Log-calibrated billed CPU for azookey-compare / kotoba-beacon-inference.
 *
 * Source: `bunx wrangler tail <worker> --format json` with
 * `CLOUDFLARE_ACCOUNT_ID=78109ec18c7c85b194b19fb32e3bb149` (Personal / kaoru.workers.dev).
 * Fields are top-level `cpuTime` / `wallTime` on each tail event (Workers Trace Events).
 * Units: **milliseconds** — matches Workers Paid CPU-ms billing ($0.02 / million CPU ms).
 *
 * @see https://developers.cloudflare.com/changelog/post/2025-04-09-workers-timing/
 * @see https://developers.cloudflare.com/workers/platform/pricing/
 */

export const WORKERS_BILLED_CPU_FIELD_CPU = "cpuTime";
export const WORKERS_BILLED_CPU_FIELD_WALL = "wallTime";
export const WORKERS_BILLED_CPU_UNIT = "ms";

/** ISO timestamp when wrangler tail samples below were captured. */
export const WORKERS_BILLED_CPU_CAPTURED_AT = "2026-08-10T05:56:00Z";

export interface WorkersBilledCpuCalibrationSample {
  /** Number of invocation log events in the sample. */
  sampleSize: number;
  /** Median billed cpuTime (ms). */
  medianCpuMs: number;
  /** Median wallTime (ms). */
  medianWallMs: number;
  /** medianCpuMs / medianWallMs — used to map protocol wall elapsedMs → billed CPU. */
  cpuWallRatio: number;
}

/**
 * azookey-compare `/ws/azookey` upgrade invocations (wrangler tail, n=2):
 * cpuTime 5/3 ms, wallTime 1253/662 ms → median cpu 4 ms, wall 957.5 ms.
 */
export const COMPARE_WS_UPGRADE_CALIBRATION: WorkersBilledCpuCalibrationSample = {
  sampleSize: 2,
  medianCpuMs: 4,
  medianWallMs: 957.5,
  cpuWallRatio: 4 / 957.5,
};

/**
 * kotoba-beacon-inference `/ws/azookey` conversion invocations (wrangler tail, n=2,
 * health probes with cpuTime 0 excluded):
 * cpuTime 878/450 ms, wallTime 1203/633 ms → median cpu 664 ms, wall 918 ms.
 */
export const INFERENCE_WS_CONVERT_CALIBRATION: WorkersBilledCpuCalibrationSample = {
  sampleSize: 2,
  medianCpuMs: 664,
  medianWallMs: 918,
  cpuWallRatio: 664 / 918,
};

/** Observability API (last 24h, same account) returned count=0 for filtered queries — tail used instead. */
export const WORKERS_BILLED_CPU_OBSERVABILITY_NOTE =
  "Cloudflare Observability calculations（$metadata.service フィルタ）はサンプル期間 count=0 のため未使用。wrangler tail の invocation ログを採用。";
