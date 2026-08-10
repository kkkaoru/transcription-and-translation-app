/**
 * Workers AI Nova-3 ASR list pricing (HTTP `env.AI.run` transport).
 *
 * @see https://developers.cloudflare.com/workers-ai/models/nova-3/
 * @see https://developers.cloudflare.com/workers-ai/platform/pricing/
 */

import type { RecognitionProvider } from "./contract";
import { formatDecimalUsd } from "./format-usd";

/** HTTP transcription: $0.0052 / audio minute (@cf/deepgram/nova-3). */
export const WORKERS_AI_ASR_HTTP_USD_PER_AUDIO_MINUTE = 0.0052;

/** Nova-3 / Silero PCM sample rate used for duration. */
export const WORKERS_AI_ASR_PCM_SAMPLE_RATE = 16_000;

/**
 * Utterances are seconds, not minutes. Values above this are almost certainly
 * 16 kHz PCM sample counts passed as if they were seconds.
 */
export const WORKERS_AI_ASR_MAX_PLAUSIBLE_SECONDS = 120;

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

export const WORKERS_AI_ASR_WEB_SPEECH_NOTE = "Cloudflare Workers AI 課金なし";

const roundUsd = (value: number): number => Math.round(value * 1_000_000_000) / 1_000_000_000;

const roundNeurons = (value: number): number => Math.round(value * 100) / 100;

/**
 * Convert a PCM frame count to seconds. Public sample-count helpers must
 * divide by 16 kHz — never treat length as seconds.
 */
export const audioSecondsFromPcmLength = (
  pcmLength: number,
  sampleRate = WORKERS_AI_ASR_PCM_SAMPLE_RATE,
): number => {
  if (!Number.isFinite(pcmLength) || pcmLength <= 0) {
    return 0;
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return 0;
  }
  return pcmLength / sampleRate;
};

/**
 * Accept seconds, but if the value looks like 16 kHz PCM samples, convert.
 * `estimateWorkersAiAsrCost` itself takes seconds; use `audioSecondsFromPcmLength`
 * when the caller has a sample count.
 */
export const normalizeWorkersAiAsrAudioSeconds = (audioSeconds: number): number => {
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) {
    return 0;
  }
  if (audioSeconds > WORKERS_AI_ASR_MAX_PLAUSIBLE_SECONDS) {
    return audioSecondsFromPcmLength(audioSeconds, WORKERS_AI_ASR_PCM_SAMPLE_RATE);
  }
  return audioSeconds;
};

/** Format USD without collapsing small nonzero values to $0.00. Decimal only. */
export const formatWorkersAiAsrCostUsd = (usd: number): string => formatDecimalUsd(usd);

/** Primary model-unit price from audio duration (HTTP per-minute rate). */
export const estimateWorkersAiAsrCost = (audioSeconds: number): WorkersAiAsrCostEstimate => {
  const seconds = normalizeWorkersAiAsrAudioSeconds(
    Number.isFinite(audioSeconds) ? audioSeconds : 0,
  );
  const minutes = seconds / 60;
  const usd = roundUsd(minutes * WORKERS_AI_ASR_HTTP_USD_PER_AUDIO_MINUTE);
  const neurons = roundNeurons(minutes * WORKERS_AI_ASR_HTTP_NEURONS_PER_AUDIO_MINUTE);
  const note =
    "Nova-3 HTTP（env.AI.run）: $0.0052/分 · 472.73 neurons/分。Neurons 超過は $0.011/1,000 neurons（Cloudflare Workers Paid・日 10k 無料枠超過分）。Cloudflare Workers 月額 $5 は按分しません。";
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
    `Cloudflare Workers AI ASR 推定 ${formatWorkersAiAsrCostUsd(estimate.usd)} · ` +
    `${secondsLabel}s · HTTP $0.0052/分 · ~${estimate.neurons} neurons`
  );
};

export const webSpeechAsrCostSummaryJa = (): string =>
  `Web Speech ASR ${formatWorkersAiAsrCostUsd(0)} · ${WORKERS_AI_ASR_WEB_SPEECH_NOTE}`;

export const isWorkersAiAsrRecognition = (
  provider?: RecognitionProvider | string,
  origin?: string,
): boolean => provider === "workers-ai-asr" || origin === "workers-ai-asr";

/** Tiny ASR $ must still show the Workers AI amount; Web Speech stays $0. */
export const shouldShowWorkersAiAsrCostAmount = (row: {
  origin?: string;
  recognitionProvider?: RecognitionProvider | string;
  asrCostUsd?: number;
}): boolean => {
  if (isWorkersAiAsrRecognition(row.recognitionProvider, row.origin)) {
    return true;
  }
  return row.asrCostUsd !== undefined && Number.isFinite(row.asrCostUsd) && row.asrCostUsd > 0;
};

export const utteranceAsrCostFields = (
  provider: RecognitionProvider | undefined,
  audioSeconds?: number,
): { asrCostUsd: number; asrCostSummaryJa: string } => {
  if (provider === "workers-ai-asr") {
    const estimate = estimateWorkersAiAsrCost(audioSeconds ?? 0);
    return {
      asrCostUsd: estimate.usd,
      asrCostSummaryJa: workersAiAsrCostSummaryJa(estimate),
    };
  }
  return {
    asrCostUsd: 0,
    asrCostSummaryJa: webSpeechAsrCostSummaryJa(),
  };
};
