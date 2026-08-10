import { describe, expect, it } from "vitest";
import {
  estimateWorkersAiAsrCost,
  formatWorkersAiAsrCostUsd,
  webSpeechAsrCostSummaryJa,
  WORKERS_AI_ASR_HTTP_NEURONS_PER_AUDIO_MINUTE,
  WORKERS_AI_ASR_HTTP_USD_PER_AUDIO_MINUTE,
  workersAiAsrCostSummaryJa,
} from "./workers-ai-asr-cost";

describe("workers-ai-asr-cost", () => {
  it("uses HTTP model unit price per audio minute", () => {
    const oneMinute = estimateWorkersAiAsrCost(60);
    expect(oneMinute.usd).toBe(WORKERS_AI_ASR_HTTP_USD_PER_AUDIO_MINUTE);
    expect(oneMinute.neurons).toBe(WORKERS_AI_ASR_HTTP_NEURONS_PER_AUDIO_MINUTE);
    expect(oneMinute.transport).toBe("http");
    expect(oneMinute.audioSeconds).toBe(60);
    expect(oneMinute.sourceUrl).toContain("nova-3");
  });

  it("scales linearly with duration", () => {
    const threeSeconds = estimateWorkersAiAsrCost(3);
    expect(threeSeconds.usd).toBeCloseTo(WORKERS_AI_ASR_HTTP_USD_PER_AUDIO_MINUTE / 20, 9);
    expect(threeSeconds.neurons).toBeCloseTo(WORKERS_AI_ASR_HTTP_NEURONS_PER_AUDIO_MINUTE / 20, 2);
  });

  it("returns zero cost summary for Web Speech", () => {
    expect(webSpeechAsrCostSummaryJa()).toContain("$0");
    expect(webSpeechAsrCostSummaryJa()).toContain("Workers AI 課金なし");
  });

  it("formats small nonzero USD without rounding to zero", () => {
    expect(formatWorkersAiAsrCostUsd(0.000_000_26)).toMatch(/^\$/);
    expect(formatWorkersAiAsrCostUsd(0)).toBe("$0");
  });

  it("builds a Japanese row summary", () => {
    const summary = workersAiAsrCostSummaryJa(estimateWorkersAiAsrCost(1.5));
    expect(summary).toContain("Workers AI ASR");
    expect(summary).toContain("1.50s");
    expect(summary).toContain("$0.0052/分");
  });
});
