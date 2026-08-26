/**
 * This file runs with bun.
 *
 * Audio duration and fact-based Workers AI ASR billing helpers.
 */

import type { BrowserAsrModel } from "./workers-ai-asr-client";

export const WORKERS_AI_ASR_PCM_SAMPLE_RATE = 16_000;

export const WORKERS_AI_ASR_USD_PER_AUDIO_MINUTE: Readonly<Record<BrowserAsrModel, number>> = {
  "@cf/deepgram/nova-3": 0.0052,
  "@cf/openai/whisper-large-v3-turbo": 0.00051,
};

export type WorkersAiAsrAudioSeconds = Record<BrowserAsrModel, number>;

export interface WorkersAiAsrBillingResult {
  model?: string;
  requestedModel?: string;
  asrModelFallback?: string;
}

export const emptyWorkersAiAsrAudioSeconds = (): WorkersAiAsrAudioSeconds => ({
  "@cf/deepgram/nova-3": 0,
  "@cf/openai/whisper-large-v3-turbo": 0,
});

export const audioSecondsFromPcmLength = (
  pcmLength: number,
  sampleRate = WORKERS_AI_ASR_PCM_SAMPLE_RATE,
): number =>
  Number.isFinite(pcmLength) && pcmLength > 0 && Number.isFinite(sampleRate) && sampleRate > 0
    ? pcmLength / sampleRate
    : 0;

const isBrowserAsrModel = (model: string | undefined): model is BrowserAsrModel =>
  model === "@cf/deepgram/nova-3" || model === "@cf/openai/whisper-large-v3-turbo";

/**
 * Return every model that performed billable inference for one result.
 * A script-drift fallback first runs the requested Nova model and then reruns
 * the same audio through Whisper, so both model ledgers receive the duration.
 */
export const billedWorkersAiAsrModels = (
  result: WorkersAiAsrBillingResult,
  selectedModel: BrowserAsrModel,
): BrowserAsrModel[] => {
  const effectiveModel = isBrowserAsrModel(result.model) ? result.model : selectedModel;
  if (!result.asrModelFallback || !isBrowserAsrModel(result.requestedModel)) {
    return [effectiveModel];
  }
  return [...new Set<BrowserAsrModel>([result.requestedModel, effectiveModel])];
};

export const addWorkersAiAsrUsage = (
  current: WorkersAiAsrAudioSeconds,
  result: WorkersAiAsrBillingResult,
  selectedModel: BrowserAsrModel,
  audioSeconds: number,
): WorkersAiAsrAudioSeconds => {
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) return current;
  const next = { ...current };
  for (const model of billedWorkersAiAsrModels(result, selectedModel)) {
    next[model] += audioSeconds;
  }
  return next;
};

export const workersAiAsrCostUsd = (usage: WorkersAiAsrAudioSeconds): number =>
  (Object.entries(usage) as [BrowserAsrModel, number][]).reduce(
    (total, [model, audioSeconds]) =>
      total + (audioSeconds / 60) * WORKERS_AI_ASR_USD_PER_AUDIO_MINUTE[model],
    0,
  );
