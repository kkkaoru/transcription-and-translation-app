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
  });

  it("prices 3 seconds of audio at about $0.00026, never about $3", () => {
    const threeSeconds = estimateWorkersAiAsrCost(3);
    expect(threeSeconds.usd).toBeCloseTo(WORKERS_AI_ASR_HTTP_USD_PER_AUDIO_MINUTE / 20, 9);
    expect(threeSeconds.usd).toBeCloseTo(0.00026, 9);
    expect(threeSeconds.usd).toBeLessThan(0.001);
    expect(threeSeconds.usd).not.toBeCloseTo(3, 1);
    expect(threeSeconds.neurons).toBeCloseTo(WORKERS_AI_ASR_HTTP_NEURONS_PER_AUDIO_MINUTE / 20, 2);
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
  });

  it("returns zero cost summary for Web Speech", () => {
    expect(webSpeechAsrCostSummaryJa()).toContain("$0");
    expect(webSpeechAsrCostSummaryJa()).toContain("Cloudflare Workers AI 課金なし");
    expect(utteranceAsrCostFields("web-speech", 3)).toEqual({
      asrCostUsd: 0,
      asrCostSummaryJa: webSpeechAsrCostSummaryJa(),
    });
  });

  it("fills Workers AI ASR fields from duration even when the dollar amount is tiny", () => {
    const fields = utteranceAsrCostFields("workers-ai-asr", 3);
    expect(fields.asrCostUsd).toBeCloseTo(0.00026, 9);
    expect(fields.asrCostSummaryJa).toContain("Cloudflare Workers AI ASR");
    expect(fields.asrCostSummaryJa).toContain("3.00s");
    expect(formatWorkersAiAsrCostUsd(fields.asrCostUsd)).not.toMatch(/[eE]/);
    expect(fields.asrCostSummaryJa).not.toMatch(/\$[0-9.]*[eE]/);
    expect(shouldShowWorkersAiAsrCostAmount({ recognitionProvider: "workers-ai-asr" })).toBe(true);
    expect(shouldShowWorkersAiAsrCostAmount({ origin: "workers-ai-asr", asrCostUsd: 0 })).toBe(
      true,
    );
    expect(
      shouldShowWorkersAiAsrCostAmount({ recognitionProvider: "web-speech", asrCostUsd: 0 }),
    ).toBe(false);
  });

  it("formats small nonzero USD as decimals without scientific notation", () => {
    expect(formatWorkersAiAsrCostUsd(0.000_000_26)).toBe("$0.00000026");
    expect(formatWorkersAiAsrCostUsd(2.6e-7)).toBe("$0.00000026");
    expect(formatWorkersAiAsrCostUsd(0)).toBe("$0");
    for (const usd of [1e-12, 2.6e-7, 0.00000026, 0.00026, 0.0052, 10]) {
      const formatted = formatWorkersAiAsrCostUsd(usd);
      expect(formatted).not.toMatch(/[eE]/);
      expect(formatted.startsWith("$")).toBe(true);
    }
  });

  it("builds a Japanese row summary", () => {
    const summary = workersAiAsrCostSummaryJa(estimateWorkersAiAsrCost(1.5));
    expect(summary).toContain("Cloudflare Workers AI ASR");
    expect(summary).toContain("1.50s");
    expect(summary).toContain("$0.0052/分");
    expect(summary).not.toMatch(/\$[0-9.]*[eE]/);
  });
});
