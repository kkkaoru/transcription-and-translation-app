/**
 * Per-utterance Cloudflare Workers usage estimate (Workers Paid Standard overage rates).
 *
 * @see https://developers.cloudflare.com/workers/platform/pricing/
 */

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

export const CF_CONVERSION_COST_CPU_PROXY_NOTE =
  "CPU 時間は公式の課金対象 CPU-ms ではなく、推論応答の wall-clock（elapsedMs）を代理値として用いています。";

export const CF_CONVERSION_COST_EXTERNAL_GGUF_NOTE =
  "外部 GGUF 推論（MODEL_ROUTES 上流）は Cloudflare 課金外です。下記は Worker 側のリクエスト / CPU 見積もりのみです。";

export const CF_CONVERSION_COST_BROWSER_COMPLETE_LABEL = "Cloudflare 課金なし";

export interface CloudflareConversionCostInput {
  /** True when this utterance used `/ws/azookey` (worker-vibrato path). */
  usedWebSocket: boolean;
  /** True when this turn performed a new WebSocket Upgrade (compare worker). */
  openedNewWebSocket: boolean;
  /** Inference / convert round-trip wall-clock ms (CPU proxy). */
  workerElapsedMs?: number;
  /** Optional compare-worker CPU proxy when measured separately. */
  compareElapsedMs?: number;
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
  cpuMs: number;
  breakdown: CloudflareConversionCostBreakdownLine[];
  note: string;
  sourceUrl: string;
  /** Short Japanese one-liner for row meta. */
  summaryJa: string;
  /** True when no Cloudflare path ran (browser-complete). */
  browserComplete: boolean;
}

const roundUsd = (value: number): number =>
  Math.round(value * 1_000_000_000) / 1_000_000_000;

const requestCostUsd = (count: number): number =>
  roundUsd(count * CF_WORKERS_REQUEST_USD_PER_REQUEST);

const cpuCostUsd = (cpuMs: number): number => roundUsd(cpuMs * CF_WORKERS_CPU_USD_PER_MS);

/** Format USD without collapsing small nonzero values to $0.00. */
export const formatCloudflareCostUsd = (usd: number): string => {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "$0";
  }
  if (usd >= 0.000_001) {
    return `$${usd.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  return `$${usd.toExponential(2)}`;
};

const formatQuantity = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

export const estimateCloudflareConversionCost = (
  input: CloudflareConversionCostInput,
): CloudflareConversionCostEstimate => {
  if (!input.usedWebSocket) {
    return {
      usd: 0,
      requests: 0,
      cpuMs: 0,
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

  const compareCpuMs = Math.max(0, Math.round(input.compareElapsedMs ?? 0));
  const inferenceCpuMs = Math.max(0, Math.round(input.workerElapsedMs ?? 0));
  const cpuMs = compareCpuMs + inferenceCpuMs;

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
  if (compareCpuMs > 0) {
    breakdown.push({
      label: "compare CPU（代理）",
      quantity: compareCpuMs,
      unitLabel: "ms",
      usd: cpuCostUsd(compareCpuMs),
    });
  }
  if (inferenceCpuMs > 0) {
    breakdown.push({
      label: "inference CPU（wall-clock 代理）",
      quantity: inferenceCpuMs,
      unitLabel: "ms",
      usd: cpuCostUsd(inferenceCpuMs),
    });
  }

  const requestUsd = requestCostUsd(requests);
  const cpuUsd = cpuCostUsd(cpuMs);
  const usd = roundUsd(requestUsd + cpuUsd);

  const notes = [CF_CONVERSION_COST_ACCOUNT_NOTE, CF_CONVERSION_COST_CPU_PROXY_NOTE];
  if (input.usesExternalGgufUpstream) {
    notes.push(CF_CONVERSION_COST_EXTERNAL_GGUF_NOTE);
  }
  if (input.failedBeforeInference && wsUpgradeRequests > 0) {
    notes.push("推論前に失敗しましたが、WebSocket Upgrade 分のリクエストは発生している可能性があります。");
  }

  const summaryJa =
    `推定 Cloudflare 利用料（Workers Paid 超過単価） ${formatCloudflareCostUsd(usd)} · ` +
    `内訳: リクエスト ${formatQuantity(requests)} × $0.30/百万 + CPU ≈ ${formatQuantity(cpuMs)} ms × $0.02/百万 ms`;

  return {
    usd,
    requests,
    cpuMs,
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
