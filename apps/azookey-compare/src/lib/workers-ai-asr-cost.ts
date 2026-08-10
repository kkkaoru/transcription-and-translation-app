/**
 * Workers AI Nova-3 ASR list pricing (HTTP `env.AI.run` transport).
 *
 * @see https://developers.cloudflare.com/workers-ai/models/nova-3/
 * @see https://developers.cloudflare.com/workers-ai/platform/pricing/
 */

/** HTTP transcription: $0.0052 / audio minute (@cf/deepgram/nova-3). */
export const WORKERS_AI_ASR_HTTP_USD_PER_AUDIO_MINUTE = 0.0052;

/** HTTP transcription: 472.73 neurons / audio minute. */
export const WORKERS_AI_ASR_HTTP_NEURONS_PER_AUDIO_MINUTE = 472.73;

/** Workers Paid overage above 10k neurons/day free tier. */
export const WORKERS_AI_NEURONS_USD_PER_1000 = 0.011;

export const WORKERS_AI_ASR_MODEL_DOC_URL =
  "https://developers.cloudflare.com/workers-ai/models/nova-3/";

export const WORKERS_AI_ASR_PRICING_SOURCE_URL =
  "https://developers.cloudflare.com/workers-ai/platform/pricing/";

export const WORKERS_AI_ASR_TRANSPORT = "http" as const;

export type WorkersAiAsrTransport = typeof WORKERS_AI_ASR_TRANSPORT;

export interface WorkersAiAsrCostEstimate {
  usd: number;
  audioSeconds: number;
  transport: WorkersAiAsrTransport;
  neurons: number;
  note: string;
  sourceUrl: string;
}

export const WORKERS_AI_ASR_WEB_SPEECH_NOTE = "Workers AI 課金なし";

const roundUsd = (value: number): number =>
  Math.round(value * 1_000_000_000) / 1_000_000_000;

const roundNeurons = (value: number): number => Math.round(value * 100) / 100;

/** Format USD without collapsing small nonzero values to $0.00. */
export const formatWorkersAiAsrCostUsd = (usd: number): string => {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "$0";
  }
  if (usd >= 0.000_001) {
    return `$${usd.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  return `$${usd.toExponential(2)}`;
};

/** Primary model-unit price from audio duration (HTTP per-minute rate). */
export const estimateWorkersAiAsrCost = (audioSeconds: number): WorkersAiAsrCostEstimate => {
  const seconds = Math.max(0, Number.isFinite(audioSeconds) ? audioSeconds : 0);
  const minutes = seconds / 60;
  const usd = roundUsd(minutes * WORKERS_AI_ASR_HTTP_USD_PER_AUDIO_MINUTE);
  const neurons = roundNeurons(minutes * WORKERS_AI_ASR_HTTP_NEURONS_PER_AUDIO_MINUTE);
  const note =
    "Nova-3 HTTP（env.AI.run）: $0.0052/分 · 472.73 neurons/分。Neurons 超過は $0.011/1,000 neurons（Workers Paid・日 10k 無料枠超過分）。Workers 月額 $5 は按分しません。";
  return {
    usd,
    audioSeconds: seconds,
    transport: WORKERS_AI_ASR_TRANSPORT,
    neurons,
    note,
    sourceUrl: WORKERS_AI_ASR_MODEL_DOC_URL,
  };
};

export const workersAiAsrCostSummaryJa = (estimate: WorkersAiAsrCostEstimate): string => {
  const secondsLabel = estimate.audioSeconds.toFixed(2);
  return (
    `Workers AI ASR 推定 ${formatWorkersAiAsrCostUsd(estimate.usd)} · ` +
    `${secondsLabel}s · HTTP $0.0052/分 · ~${estimate.neurons} neurons`
  );
};

export const webSpeechAsrCostSummaryJa = (): string =>
  `Web Speech ASR ${formatWorkersAiAsrCostUsd(0)} · ${WORKERS_AI_ASR_WEB_SPEECH_NOTE}`;
