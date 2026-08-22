/**
 * This file runs with bun.
 *
 * Per-utterance Cloudflare Workers usage estimate (Workers Paid Standard overage rates).
 *
 * The $ formula uses only this request: request flags on this utterance, plus
 * this response's billed cpuTime when present, otherwise this request's wall ms.
 * Log-calibration medians are never applied.
 *
 * @see https://developers.cloudflare.com/workers/platform/pricing/
 */

import { formatDecimalUsd } from "./format-usd";

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
  "cpuMs は当該変換の値だけを使います。レスポンスに cpuTime があるときはその billed CPU、なければこのリクエストの wall（workerElapsedMs / compareElapsedMs）です。他発話やログ中央値は使いません。";

export const CF_CONVERSION_COST_EXTERNAL_GGUF_NOTE =
  "外部 GGUF 推論（MODEL_ROUTES 上流）は Cloudflare 課金外です。下記は Worker 側のリクエスト / CPU 見積もりのみです。";

export const CF_CONVERSION_COST_BROWSER_COMPLETE_LABEL = "Cloudflare 課金なし";

export const CF_WORKERS_REQUEST_RATE_FORMULA: string = "0.30 / 1,000,000";

export const CF_WORKERS_CPU_RATE_FORMULA: string = "0.02 / 1,000,000";

export const CF_CONVERSION_COST_FORMULA_TEMPLATE: string = `USD = requests × (${CF_WORKERS_REQUEST_RATE_FORMULA}) + cpuMs × (${CF_WORKERS_CPU_RATE_FORMULA})`;

export const CF_CONVERSION_COST_INFERENCE_WALL_LABEL: string =
  "inference CPU（このリクエスト wall）";

export const CF_CONVERSION_COST_INFERENCE_BILLED_LABEL: string =
  "inference CPU（このレスポンス cpuTime）";

export const CF_CONVERSION_COST_COMPARE_WALL_LABEL: string = "compare CPU（このリクエスト wall）";

export const CF_CONVERSION_COST_COMPARE_BILLED_LABEL: string =
  "compare CPU（このレスポンス cpuTime）";

const CPU_MS_FROM_THIS_RESPONSE: string = "cpuTime from this response";

const CPU_MS_FROM_THIS_REQUEST_WALL: string = "this request wall; billed cpuTime not on the wire";

export interface CloudflareConversionCostInput {
  /** True when this utterance used `/ws/azookey` (worker-vibrato path). */
  usedWebSocket: boolean;
  /** True when this turn performed a new WebSocket Upgrade (compare worker). */
  openedNewWebSocket: boolean;
  /** Inference convert round-trip wall ms (`azookey.result.elapsedMs`). */
  workerElapsedMs?: number;
  /** Billed inference cpuTime (ms) when returned on this response. */
  workerBilledCpuMs?: number;
  /** Compare-worker connect wall ms measured for this request. */
  compareElapsedMs?: number;
  /** Billed compare cpuTime (ms) when returned on this response. */
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
  /** CPU-ms used in the $ formula (this-request billed cpuTime or wall). */
  billedCpuMs: number;
  /** Total protocol wall ms for display. */
  wallMs: number;
  breakdown: CloudflareConversionCostBreakdownLine[];
  note: string;
  sourceUrl: string;
  /** Short Japanese one-liner for row meta, including this request's arithmetic. */
  summaryJa: string;
  /** Arithmetic with this utterance's integers plugged in. */
  formula: string;
  /** True when no Cloudflare path ran (browser-complete). */
  browserComplete: boolean;
}

interface ThisRequestCpuTerm {
  ms: number;
  formulaPart: string;
  breakdownLabel: string;
}

const roundUsd = (value: number): number => Math.round(value * 1_000_000_000) / 1_000_000_000;

const requestCostUsd = (count: number): number =>
  roundUsd(count * CF_WORKERS_REQUEST_USD_PER_REQUEST);

const cpuCostUsd = (cpuMs: number): number => roundUsd(cpuMs * CF_WORKERS_CPU_USD_PER_MS);

const roundCpuMs = (value: number): number =>
  Math.max(0, Math.round(Number.isFinite(value) ? value : 0));

/** Format USD without collapsing small nonzero values to $0.00. Decimal only. */
export const formatCloudflareCostUsd = (usd: number): string => formatDecimalUsd(usd);

const formatQuantity = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

const thisRequestInferenceCpu = (
  input: CloudflareConversionCostInput,
): ThisRequestCpuTerm | undefined => {
  if (input.failedBeforeInference) {
    return undefined;
  }
  if (input.workerBilledCpuMs !== undefined) {
    const ms = roundCpuMs(input.workerBilledCpuMs);
    return {
      ms,
      formulaPart: `workerBilledCpuMs ${ms} (${CPU_MS_FROM_THIS_RESPONSE})`,
      breakdownLabel: CF_CONVERSION_COST_INFERENCE_BILLED_LABEL,
    };
  }
  const ms = roundCpuMs(input.workerElapsedMs ?? 0);
  return {
    ms,
    formulaPart: `workerElapsedMs ${ms} (${CPU_MS_FROM_THIS_REQUEST_WALL})`,
    breakdownLabel: CF_CONVERSION_COST_INFERENCE_WALL_LABEL,
  };
};

const thisRequestCompareCpu = (
  input: CloudflareConversionCostInput,
): ThisRequestCpuTerm | undefined => {
  if (input.compareBilledCpuMs !== undefined) {
    const ms = roundCpuMs(input.compareBilledCpuMs);
    return {
      ms,
      formulaPart: `compareBilledCpuMs ${ms} (${CPU_MS_FROM_THIS_RESPONSE})`,
      breakdownLabel: CF_CONVERSION_COST_COMPARE_BILLED_LABEL,
    };
  }
  if (input.compareElapsedMs === undefined) {
    return undefined;
  }
  const ms = roundCpuMs(input.compareElapsedMs);
  return {
    ms,
    formulaPart: `compareElapsedMs ${ms} (${CPU_MS_FROM_THIS_REQUEST_WALL})`,
    breakdownLabel: CF_CONVERSION_COST_COMPARE_WALL_LABEL,
  };
};

const describeRequests = (input: CloudflareConversionCostInput, requests: number): string => {
  if (!input.usedWebSocket) {
    return `requests = ${requests} (browser complete)`;
  }
  if (input.openedNewWebSocket && input.failedBeforeInference) {
    return `requests = ${requests} (this WebSocket Upgrade)`;
  }
  if (input.openedNewWebSocket) {
    return `requests = ${requests} (this convert + this WebSocket Upgrade)`;
  }
  return `requests = ${requests} (this convert)`;
};

const describeCpuMs = (
  inference: ThisRequestCpuTerm | undefined,
  compare: ThisRequestCpuTerm | undefined,
  cpuMs: number,
): string => {
  if (inference !== undefined && compare !== undefined) {
    return `cpuMs = ${inference.formulaPart} + ${compare.formulaPart}`;
  }
  if (inference !== undefined) {
    return `cpuMs = ${inference.formulaPart}`;
  }
  if (compare !== undefined) {
    return `cpuMs = ${compare.formulaPart}`;
  }
  return `cpuMs = ${cpuMs}`;
};

const buildConversionCostFormula = (options: {
  requests: number;
  cpuMs: number;
  usd: number;
  requestLine: string;
  cpuLine: string;
}): string =>
  [
    CF_CONVERSION_COST_FORMULA_TEMPLATE,
    `USD = ${options.requests} × (${CF_WORKERS_REQUEST_RATE_FORMULA}) + ${options.cpuMs} × (${CF_WORKERS_CPU_RATE_FORMULA}) = ${formatCloudflareCostUsd(options.usd)}`,
    options.cpuLine,
    options.requestLine,
  ].join("\n");

const pushCpuBreakdown = (
  breakdown: CloudflareConversionCostBreakdownLine[],
  term: ThisRequestCpuTerm | undefined,
): void => {
  if (term === undefined || term.ms <= 0) {
    return;
  }
  breakdown.push({
    label: term.breakdownLabel,
    quantity: term.ms,
    unitLabel: "ms",
    usd: cpuCostUsd(term.ms),
  });
};

const browserCompleteEstimate = (): CloudflareConversionCostEstimate => {
  const formula = buildConversionCostFormula({
    requests: 0,
    cpuMs: 0,
    usd: 0,
    requestLine: "requests = 0 (browser complete)",
    cpuLine: "cpuMs = 0",
  });
  return {
    usd: 0,
    requests: 0,
    billedCpuMs: 0,
    wallMs: 0,
    breakdown: [],
    note: "ブラウザ完結モードのため Cloudflare Worker は呼ばれません。",
    sourceUrl: CF_WORKERS_PRICING_SOURCE_URL,
    summaryJa: `${CF_CONVERSION_COST_BROWSER_COMPLETE_LABEL} · 0 × (${CF_WORKERS_REQUEST_RATE_FORMULA}) + 0 × (${CF_WORKERS_CPU_RATE_FORMULA}) = $0`,
    formula,
    browserComplete: true,
  };
};

export const estimateCloudflareConversionCost = (
  input: CloudflareConversionCostInput,
): CloudflareConversionCostEstimate => {
  if (!input.usedWebSocket) {
    return browserCompleteEstimate();
  }

  const inferenceRequests = input.failedBeforeInference ? 0 : 1;
  const wsUpgradeRequests = input.openedNewWebSocket ? 1 : 0;
  const requests = wsUpgradeRequests + inferenceRequests;

  const inferenceWallMs = Math.max(0, Math.round(input.workerElapsedMs ?? 0));
  const compareWallMs = Math.max(0, Math.round(input.compareElapsedMs ?? 0));
  const wallMs = compareWallMs + inferenceWallMs;

  const inferenceCpu = thisRequestInferenceCpu(input);
  const compareCpu = thisRequestCompareCpu(input);
  const inferenceCpuMs = inferenceCpu?.ms ?? 0;
  const compareCpuMs = compareCpu?.ms ?? 0;
  const billedCpuMs = compareCpuMs + inferenceCpuMs;

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
  pushCpuBreakdown(breakdown, compareCpu);
  pushCpuBreakdown(breakdown, inferenceCpu);

  const requestUsd = requestCostUsd(requests);
  const cpuUsd = cpuCostUsd(billedCpuMs);
  const usd = roundUsd(requestUsd + cpuUsd);
  const formula = buildConversionCostFormula({
    requests,
    cpuMs: billedCpuMs,
    usd,
    requestLine: describeRequests(input, requests),
    cpuLine: describeCpuMs(inferenceCpu, compareCpu, billedCpuMs),
  });

  const notes = [CF_CONVERSION_COST_ACCOUNT_NOTE, CF_CONVERSION_COST_BILLED_CPU_NOTE];
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
    `cpuMs ${formatQuantity(billedCpuMs)} ms · ` +
    `${requests} × (${CF_WORKERS_REQUEST_RATE_FORMULA}) + ${billedCpuMs} × (${CF_WORKERS_CPU_RATE_FORMULA}) = ${formatCloudflareCostUsd(usd)}`;

  return {
    usd,
    requests,
    billedCpuMs,
    wallMs,
    breakdown,
    note: notes.join(" "),
    sourceUrl: CF_WORKERS_PRICING_SOURCE_URL,
    summaryJa,
    formula,
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
  if (!requested?.includes("gguf")) {
    return false;
  }
  if (options.modelFallback) {
    return false;
  }
  const resolved = options.resolvedModel?.trim();
  return !resolved || resolved.includes("gguf");
};
