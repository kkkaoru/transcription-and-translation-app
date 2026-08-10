/**
 * Per-utterance Cloudflare Workers usage estimate (Workers Paid Standard overage rates).
 *
 * CPU-ms uses billed `cpuTime` from Workers invocation logs (wrangler tail), either
 * directly when returned on the wire, or via log-calibrated wall → billed CPU mapping.
 *
 * @see https://developers.cloudflare.com/workers/platform/pricing/
 */

import { formatDecimalUsd } from "./format-usd";
import {
  COMPARE_WS_UPGRADE_CALIBRATION,
  INFERENCE_WS_CONVERT_CALIBRATION,
  WORKERS_BILLED_CPU_CAPTURED_AT,
  WORKERS_BILLED_CPU_FIELD_CPU,
  WORKERS_BILLED_CPU_FIELD_WALL,
  WORKERS_BILLED_CPU_OBSERVABILITY_NOTE,
  WORKERS_BILLED_CPU_UNIT,
  type WorkersBilledCpuCalibrationSample,
} from "./workers-billed-cpu-calibration";

/** Published overage rate: inbound Worker requests (USD per request). */
export const CF_WORKERS_REQUEST_USD_PER_REQUEST = 0.3 / 1_000_000;

/** Published overage rate: CPU time (USD per CPU millisecond). */
export const CF_WORKERS_CPU_USD_PER_MS = 0.02 / 1_000_000;

/** Included monthly allotment (account-level; not amortized per utterance). */
export const CF_WORKERS_INCLUDED_REQUESTS_PER_MONTH = 10_000_000;

/** Included monthly CPU-ms allotment (account-level). */
export const CF_WORKERS_INCLUDED_CPU_MS_PER_MONTH = 30_000_000;

export const CF_WORKERS_PRICING_SOURCE_URL =
  "https://developers.cloudflare.com/workers/platform/pricing/";

export const CF_CONVERSION_COST_ACCOUNT_NOTE =
  "Workers Paid の月額 $5 と含まれる 1,000 万リクエスト / 3,000 万 CPU-ms はアカウント全体の枠です。ここでは超過単価による当該変換の利用量見積もりのみ表示します。";

export const CF_CONVERSION_COST_BILLED_CPU_NOTE =
  "CPU-ms は Workers 起動ログの cpuTime（課金対象 CPU、単位 ms）に基づく推定です。protocol の elapsedMs は wall 時間であり、ログ校正比（median cpuTime ÷ median wallTime）で billed CPU に換算しています。";

export const CF_CONVERSION_COST_EXTERNAL_GGUF_NOTE =
  "外部 GGUF 推論（MODEL_ROUTES 上流）は Cloudflare 課金外です。下記は Worker 側のリクエスト / CPU 見積もりのみです。";

export const CF_CONVERSION_COST_BROWSER_COMPLETE_LABEL = "Cloudflare 課金なし";

export interface CloudflareConversionCostInput {
  /** True when this utterance used `/ws/azookey` (worker-vibrato path). */
  usedWebSocket: boolean;
  /** True when this turn performed a new WebSocket Upgrade (compare worker). */
  openedNewWebSocket: boolean;
  /** Inference convert round-trip wall ms (`azookey.result.elapsedMs`). */
  workerElapsedMs?: number;
  /** Billed inference cpuTime (ms) when returned on the wire; overrides calibration. */
  workerBilledCpuMs?: number;
  /** Compare-worker wall ms when measured separately. */
  compareElapsedMs?: number;
  /** Billed compare cpuTime (ms) when returned on the wire; overrides calibration. */
  compareBilledCpuMs?: number;
  /** When true, a GGUF upstream may have run outside Cloudflare. */
  usesExternalGgufUpstream?: boolean;
  /** When conversion failed before inference, still billable compare requests may apply. */
  failedBeforeInference?: boolean;
}

export interface CloudflareConversionCostBreakdownLine {
  label: string;
  quantity: number;
  unitLabel: string;
  usd: number;
}

export interface CloudflareConversionCostEstimate {
  usd: number;
  requests: number;
  /** Total billed CPU-ms used in the $ formula. */
  billedCpuMs: number;
  /** Total protocol wall ms (for display; not used in $ unless calibrated). */
  wallMs: number;
  breakdown: CloudflareConversionCostBreakdownLine[];
  note: string;
  sourceUrl: string;
  /** Short Japanese one-liner for row meta. */
  summaryJa: string;
  /** True when no Cloudflare path ran (browser-complete). */
  browserComplete: boolean;
}

const roundUsd = (value: number): number => Math.round(value * 1_000_000_000) / 1_000_000_000;

const requestCostUsd = (count: number): number =>
  roundUsd(count * CF_WORKERS_REQUEST_USD_PER_REQUEST);

const cpuCostUsd = (cpuMs: number): number => roundUsd(cpuMs * CF_WORKERS_CPU_USD_PER_MS);

const roundCpuMs = (value: number): number =>
  Math.max(0, Math.round(Number.isFinite(value) ? value : 0));

/** Map protocol wall ms → billed CPU ms using log-calibrated median cpuTime / wallTime. */
export const estimateBilledCpuMsFromWall = (
  wallMs: number | undefined,
  calibration: WorkersBilledCpuCalibrationSample,
): number => {
  if (wallMs === undefined || !Number.isFinite(wallMs) || wallMs <= 0) {
    return 0;
  }
  return roundCpuMs(wallMs * calibration.cpuWallRatio);
};

/** Billed CPU for a new compare WebSocket Upgrade (median cpuTime from tail samples). */
export const compareWsUpgradeBilledCpuMs = (): number =>
  roundCpuMs(COMPARE_WS_UPGRADE_CALIBRATION.medianCpuMs);

const resolveInferenceBilledCpuMs = (input: CloudflareConversionCostInput): number => {
  if (input.workerBilledCpuMs !== undefined) {
    return roundCpuMs(input.workerBilledCpuMs);
  }
  return estimateBilledCpuMsFromWall(input.workerElapsedMs, INFERENCE_WS_CONVERT_CALIBRATION);
};

const resolveCompareBilledCpuMs = (
  input: CloudflareConversionCostInput,
  includeUpgrade: boolean,
): number => {
  if (input.compareBilledCpuMs !== undefined) {
    return roundCpuMs(input.compareBilledCpuMs);
  }
  const fromWall = estimateBilledCpuMsFromWall(
    input.compareElapsedMs,
    COMPARE_WS_UPGRADE_CALIBRATION,
  );
  const upgradeCpu = includeUpgrade ? compareWsUpgradeBilledCpuMs() : 0;
  return roundCpuMs(fromWall + upgradeCpu);
};

/** Format USD without collapsing small nonzero values to $0.00. Decimal only. */
export const formatCloudflareCostUsd = (usd: number): string => formatDecimalUsd(usd);

const formatQuantity = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

export const estimateCloudflareConversionCost = (
  input: CloudflareConversionCostInput,
): CloudflareConversionCostEstimate => {
  if (!input.usedWebSocket) {
    return {
      usd: 0,
      requests: 0,
      billedCpuMs: 0,
      wallMs: 0,
      breakdown: [],
      note: "ブラウザ完結モードのため Cloudflare Worker は呼ばれません。",
      sourceUrl: CF_WORKERS_PRICING_SOURCE_URL,
      summaryJa: CF_CONVERSION_COST_BROWSER_COMPLETE_LABEL,
      browserComplete: true,
    };
  }

  const inferenceRequests = input.failedBeforeInference ? 0 : 1;
  const wsUpgradeRequests = input.openedNewWebSocket ? 1 : 0;
  const requests = wsUpgradeRequests + inferenceRequests;

  const inferenceWallMs = Math.max(0, Math.round(input.workerElapsedMs ?? 0));
  const compareWallMs = Math.max(0, Math.round(input.compareElapsedMs ?? 0));
  const wallMs = compareWallMs + inferenceWallMs + (wsUpgradeRequests > 0 ? 0 : 0);

  const inferenceBilledCpuMs = input.failedBeforeInference ? 0 : resolveInferenceBilledCpuMs(input);
  const compareBilledCpuMs = resolveCompareBilledCpuMs(input, wsUpgradeRequests > 0);
  const billedCpuMs = compareBilledCpuMs + inferenceBilledCpuMs;

  const breakdown: CloudflareConversionCostBreakdownLine[] = [];

  if (wsUpgradeRequests > 0) {
    breakdown.push({
      label: "compare WebSocket Upgrade",
      quantity: wsUpgradeRequests,
      unitLabel: "リクエスト",
      usd: requestCostUsd(wsUpgradeRequests),
    });
  }
  if (inferenceRequests > 0) {
    breakdown.push({
      label: "inference 変換（service binding）",
      quantity: inferenceRequests,
      unitLabel: "リクエスト",
      usd: requestCostUsd(inferenceRequests),
    });
  }
  if (wsUpgradeRequests > 0 && compareWsUpgradeBilledCpuMs() > 0) {
    breakdown.push({
      label: "compare Upgrade CPU（ログ cpuTime 中央値）",
      quantity: compareWsUpgradeBilledCpuMs(),
      unitLabel: "ms",
      usd: cpuCostUsd(compareWsUpgradeBilledCpuMs()),
    });
  }
  if (input.compareElapsedMs !== undefined && input.compareElapsedMs > 0) {
    const proxyCpu = estimateBilledCpuMsFromWall(
      input.compareElapsedMs,
      COMPARE_WS_UPGRADE_CALIBRATION,
    );
    if (proxyCpu > 0) {
      breakdown.push({
        label: "compare CPU（ログ校正）",
        quantity: proxyCpu,
        unitLabel: "ms",
        usd: cpuCostUsd(proxyCpu),
      });
    }
  }
  if (inferenceBilledCpuMs > 0) {
    breakdown.push({
      label:
        input.workerBilledCpuMs !== undefined
          ? "inference CPU（ログ cpuTime）"
          : "inference CPU（ログ校正）",
      quantity: inferenceBilledCpuMs,
      unitLabel: "ms",
      usd: cpuCostUsd(inferenceBilledCpuMs),
    });
  }

  const requestUsd = requestCostUsd(requests);
  const cpuUsd = cpuCostUsd(billedCpuMs);
  const usd = roundUsd(requestUsd + cpuUsd);

  const notes = [
    CF_CONVERSION_COST_ACCOUNT_NOTE,
    CF_CONVERSION_COST_BILLED_CPU_NOTE,
    `校正ソース: wrangler tail ${WORKERS_BILLED_CPU_FIELD_CPU}/${WORKERS_BILLED_CPU_FIELD_WALL}（${WORKERS_BILLED_CPU_UNIT}） ${WORKERS_BILLED_CPU_CAPTURED_AT}。${WORKERS_BILLED_CPU_OBSERVABILITY_NOTE}`,
  ];
  if (input.usesExternalGgufUpstream) {
    notes.push(CF_CONVERSION_COST_EXTERNAL_GGUF_NOTE);
  }
  if (input.failedBeforeInference && wsUpgradeRequests > 0) {
    notes.push(
      "推論前に失敗しましたが、WebSocket Upgrade 分のリクエストは発生している可能性があります。",
    );
  }

  const summaryJa =
    `推定 Cloudflare 利用料（Workers Paid 超過単価） ${formatCloudflareCostUsd(usd)} · ` +
    `リクエスト ${formatQuantity(requests)} · wall ${formatQuantity(wallMs)} ms · ` +
    `billed CPU ${formatQuantity(billedCpuMs)} ms（$0.30/百万 req + $0.02/百万 CPU ms）`;

  return {
    usd,
    requests,
    billedCpuMs,
    wallMs,
    breakdown,
    note: notes.join(" "),
    sourceUrl: CF_WORKERS_PRICING_SOURCE_URL,
    summaryJa,
    browserComplete: false,
  };
};

/** Derive GGUF-upstream flag from converter model metadata (no upstream $ invented). */
export const usesExternalGgufUpstream = (options: {
  requestedModel?: string;
  resolvedModel?: string;
  modelFallback?: string;
}): boolean => {
  const requested = options.requestedModel?.trim();
  if (!requested || !requested.includes("gguf")) {
    return false;
  }
  if (options.modelFallback) {
    return false;
  }
  const resolved = options.resolvedModel?.trim();
  return !resolved || resolved.includes("gguf");
};
