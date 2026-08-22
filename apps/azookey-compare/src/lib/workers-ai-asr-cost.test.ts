// This file runs with bun.
import { describe, expect, it } from "vitest";
import {
  audioSecondsFromPcmLength,
  estimateWorkersAiAsrCost,
  formatWorkersAiAsrCostUsd,
  normalizeWorkersAiAsrAudioSeconds,
  shouldShowWorkersAiAsrCostAmount,
  utteranceAsrCostFields,
  WORKERS_AI_ASR_HTTP_NEURONS_PER_AUDIO_MINUTE,
  WORKERS_AI_ASR_HTTP_USD_PER_AUDIO_MINUTE,
  WORKERS_AI_ASR_PCM_SAMPLE_RATE,
  webSpeechAsrCostSummaryJa,
  workersAiAsrCostSummaryJa,
} from "./workers-ai-asr-cost";

describe("workers-ai-asr-cost", () => {
  it("uses HTTP model unit price per audio minute", () => {
    const oneMinute = estimateWorkersAiAsrCost(60);
    expect(oneMinute.usd).toBe(WORKERS_AI_ASR_HTTP_USD_PER_AUDIO_MINUTE);
    expect(oneMinute.usd).toBeCloseTo(0.0052, 9);
    expect(oneMinute.neurons).toBe(WORKERS_AI_ASR_HTTP_NEURONS_PER_AUDIO_MINUTE);
    expect(oneMinute.transport).toBe("http");
    expect(oneMinute.audioSeconds).toBe(60);
    expect(oneMinute.sourceUrl).toContain("nova-3");
    expect(oneMinute.formula).toBe(
      "USD = (audioSeconds / 60) × 0.0052\nUSD = (60 / 60) × 0.0052 = $0.0052",
    );
  });

  it("prices 3 seconds of audio at about $0.00026, never about $3", () => {
    const threeSeconds = estimateWorkersAiAsrCost(3);
    expect(threeSeconds.usd).toBeCloseTo(WORKERS_AI_ASR_HTTP_USD_PER_AUDIO_MINUTE / 20, 9);
    expect(threeSeconds.usd).toBeCloseTo(0.00026, 9);
    expect(threeSeconds.usd).toBeLessThan(0.001);
    expect(threeSeconds.usd).not.toBeCloseTo(3, 1);
    expect(threeSeconds.neurons).toBeCloseTo(WORKERS_AI_ASR_HTTP_NEURONS_PER_AUDIO_MINUTE / 20, 2);
    expect(threeSeconds.formula).toBe(
      "USD = (audioSeconds / 60) × 0.0052\nUSD = (3 / 60) × 0.0052 = $0.00026",
    );
  });

  it("converts PCM sample counts via 16 kHz, not as a public seconds API", () => {
    expect(audioSecondsFromPcmLength(48_000)).toBe(3);
    expect(audioSecondsFromPcmLength(48_000, WORKERS_AI_ASR_PCM_SAMPLE_RATE)).toBe(3);
    expect(audioSecondsFromPcmLength(16_000)).toBe(1);
    expect(audioSecondsFromPcmLength(0)).toBe(0);
    expect(audioSecondsFromPcmLength(-8)).toBe(0);
    expect(audioSecondsFromPcmLength(16_000, 0)).toBe(0);
    expect(audioSecondsFromPcmLength(16_000, Number.NaN)).toBe(0);
    expect(estimateWorkersAiAsrCost(audioSecondsFromPcmLength(48_000)).usd).toBeCloseTo(0.00026, 9);
  });

  it("guards sample counts accidentally passed as seconds", () => {
    expect(normalizeWorkersAiAsrAudioSeconds(48_000)).toBe(3);
    expect(normalizeWorkersAiAsrAudioSeconds(3)).toBe(3);
    expect(normalizeWorkersAiAsrAudioSeconds(60)).toBe(60);
    expect(normalizeWorkersAiAsrAudioSeconds(0)).toBe(0);
    expect(normalizeWorkersAiAsrAudioSeconds(-2)).toBe(0);
    expect(normalizeWorkersAiAsrAudioSeconds(Number.NaN)).toBe(0);
    expect(estimateWorkersAiAsrCost(Number.NaN).usd).toBe(0);
    expect(estimateWorkersAiAsrCost(Number.POSITIVE_INFINITY).audioSeconds).toBe(0);
    const mistakenSamples = estimateWorkersAiAsrCost(48_000);
    expect(mistakenSamples.audioSeconds).toBe(3);
    expect(mistakenSamples.usd).toBeCloseTo(0.00026, 9);
    expect(mistakenSamples.usd).not.toBeCloseTo(4.16, 1);
    expect(mistakenSamples.formula).toBe(
      "USD = (audioSeconds / 60) × 0.0052\nUSD = (3 / 60) × 0.0052 = $0.00026",
    );
  });

  it("returns zero cost summary and USD = 0 formula for Web Speech", () => {
    expect(webSpeechAsrCostSummaryJa()).toBe(
      "Web Speech ASR $0 · Cloudflare Workers AI 課金なし\nUSD = 0",
    );
    expect(utteranceAsrCostFields("web-speech", 3)).toStrictEqual({
      asrCostUsd: 0,
      asrCostSummaryJa: "Web Speech ASR $0 · Cloudflare Workers AI 課金なし\nUSD = 0",
      asrCostFormula: "USD = 0",
    });
  });

  it("fills Workers AI ASR fields from duration even when the dollar amount is tiny", () => {
    const fields = utteranceAsrCostFields("workers-ai-asr", 3);
    expect(fields.asrCostUsd).toBeCloseTo(0.00026, 9);
    expect(fields.asrCostFormula).toBe(
      "USD = (audioSeconds / 60) × 0.0052\nUSD = (3 / 60) × 0.0052 = $0.00026",
    );
    expect(fields.asrCostSummaryJa).toBe(
      "Cloudflare Workers AI ASR 推定 $0.00026 · 3.00s · HTTP $0.0052/分 · ~23.64 neurons\nUSD = (audioSeconds / 60) × 0.0052\nUSD = (3 / 60) × 0.0052 = $0.00026",
    );
    expect(formatWorkersAiAsrCostUsd(fields.asrCostUsd)).toBe("$0.00026");
    expect(utteranceAsrCostFields("workers-ai-asr").asrCostUsd).toBe(0);
    expect(shouldShowWorkersAiAsrCostAmount({ recognitionProvider: "workers-ai-asr" })).toBe(true);
    expect(shouldShowWorkersAiAsrCostAmount({ origin: "workers-ai-asr", asrCostUsd: 0 })).toBe(
      true,
    );
    expect(
      shouldShowWorkersAiAsrCostAmount({ recognitionProvider: "web-speech", asrCostUsd: 0 }),
    ).toBe(false);
    expect(
      shouldShowWorkersAiAsrCostAmount({ recognitionProvider: "web-speech", asrCostUsd: 0.01 }),
    ).toBe(true);
  });

  it("formats small nonzero USD as decimals without scientific notation", () => {
    expect(formatWorkersAiAsrCostUsd(0.000_000_26)).toBe("$0.00000026");
    expect(formatWorkersAiAsrCostUsd(2.6e-7)).toBe("$0.00000026");
    expect(formatWorkersAiAsrCostUsd(0)).toBe("$0");
    expect(formatWorkersAiAsrCostUsd(1e-12)).toBe("$0.000000000001");
    expect(formatWorkersAiAsrCostUsd(0.00000026)).toBe("$0.00000026");
    expect(formatWorkersAiAsrCostUsd(0.00026)).toBe("$0.00026");
    expect(formatWorkersAiAsrCostUsd(0.0052)).toBe("$0.0052");
    expect(formatWorkersAiAsrCostUsd(10)).toBe("$10");
  });

  it("builds a Japanese row summary that includes this utterance formula", () => {
    const summary = workersAiAsrCostSummaryJa(estimateWorkersAiAsrCost(1.5));
    expect(summary).toBe(
      "Cloudflare Workers AI ASR 推定 $0.00013 · 1.50s · HTTP $0.0052/分 · ~11.82 neurons\nUSD = (audioSeconds / 60) × 0.0052\nUSD = (1.5 / 60) × 0.0052 = $0.00013",
    );
  });
});
