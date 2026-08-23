/**
 * This file runs with bun.
 *
 * Audio duration helpers for the fixed Nova-3 Worker pipeline.
 */

export const WORKERS_AI_ASR_PCM_SAMPLE_RATE = 16_000;

export const audioSecondsFromPcmLength = (
  pcmLength: number,
  sampleRate = WORKERS_AI_ASR_PCM_SAMPLE_RATE,
): number =>
  Number.isFinite(pcmLength) && pcmLength > 0 && Number.isFinite(sampleRate) && sampleRate > 0
    ? pcmLength / sampleRate
    : 0;
