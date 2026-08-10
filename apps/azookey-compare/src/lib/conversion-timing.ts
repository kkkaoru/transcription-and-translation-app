/** Wall-clock and display helpers for comparison conversion timings. */

export const nowMs = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export const elapsedSinceMs = (startedAt: number, endedAt: number = nowMs()): number =>
  Math.max(0, Math.round(endedAt - startedAt));

export const sumElapsedMs = (...parts: Array<number | undefined>): number | undefined => {
  const values = parts.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (values.length === 0) {
    return undefined;
  }
  return Math.max(0, Math.round(values.reduce((sum, value) => sum + value, 0)));
};

/** `undefined` is unmeasured; `0` is a reported zero (do not collapse them). */
export const formatMilliseconds = (value: number | undefined): string =>
  value === undefined ? "未計測" : `${Math.round(value)} ms`;

export type ConversionTimingFields = {
  wasmElapsedMs?: number;
  workerElapsedMs?: number;
  azookeyElapsedMs?: number;
  totalElapsedMs?: number;
};

export const formatRowTiming = (timing: ConversionTimingFields): string => {
  const parts: string[] = [];
  if (timing.wasmElapsedMs !== undefined) {
    parts.push(`Vibrato ${formatMilliseconds(timing.wasmElapsedMs)}`);
  }
  // Worker-vibrato uses inference `elapsedMs`; browser-compact maps local AzooKey ms here.
  // `0` must stay visible: production may currently report elapsedMs: 0.
  const converterMs = timing.workerElapsedMs ?? timing.azookeyElapsedMs;
  parts.push(`Cloudflare Worker ${formatMilliseconds(converterMs)}`);
  parts.push(`合計処理時間 ${formatMilliseconds(timing.totalElapsedMs)}`);
  return `処理時間 ${parts.join(" · ")}`;
};
