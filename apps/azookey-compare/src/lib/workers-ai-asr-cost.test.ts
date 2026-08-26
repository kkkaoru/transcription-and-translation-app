// This file runs with bun.
import { describe, expect, it } from "vitest";
import {
  addWorkersAiAsrUsage,
  audioSecondsFromPcmLength,
  billedWorkersAiAsrModels,
  emptyWorkersAiAsrAudioSeconds,
  WORKERS_AI_ASR_PCM_SAMPLE_RATE,
  workersAiAsrCostUsd,
} from "./workers-ai-asr-cost";

const NOVA = "@cf/deepgram/nova-3" as const;
const WHISPER = "@cf/openai/whisper-large-v3-turbo" as const;

describe("audioSecondsFromPcmLength", () => {
  it("converts 16 kHz samples to seconds", () => {
    expect(audioSecondsFromPcmLength(32_000)).toBe(2);
    expect(WORKERS_AI_ASR_PCM_SAMPLE_RATE).toBe(16_000);
  });

  it("rejects invalid lengths and rates", () => {
    expect(audioSecondsFromPcmLength(0)).toBe(0);
    expect(audioSecondsFromPcmLength(Number.NaN)).toBe(0);
    expect(audioSecondsFromPcmLength(16_000, 0)).toBe(0);
  });
});

describe("Workers AI ASR billing", () => {
  it("bills both Nova and Whisper when Nova script drift triggers a rerun", () => {
    const result = {
      model: WHISPER,
      requestedModel: NOVA,
      asrModelFallback: "nova-3-unexpected-language-script",
    };

    expect(billedWorkersAiAsrModels(result, NOVA)).toEqual([NOVA, WHISPER]);
    const usage = addWorkersAiAsrUsage(emptyWorkersAiAsrAudioSeconds(), result, NOVA, 60);
    expect(usage).toEqual({ [NOVA]: 60, [WHISPER]: 60 });
    expect(workersAiAsrCostUsd(usage)).toBeCloseTo(0.00571, 10);
  });

  it("bills only the effective model when no fallback inference ran", () => {
    const novaUsage = addWorkersAiAsrUsage(
      emptyWorkersAiAsrAudioSeconds(),
      { model: NOVA },
      NOVA,
      30,
    );
    const switchedUsage = addWorkersAiAsrUsage(novaUsage, { model: WHISPER }, WHISPER, 60);

    expect(switchedUsage).toEqual({ [NOVA]: 30, [WHISPER]: 60 });
    expect(workersAiAsrCostUsd(switchedUsage)).toBeCloseTo(0.00311, 10);
  });

  it("does not mutate or add invalid durations", () => {
    const usage = emptyWorkersAiAsrAudioSeconds();
    expect(addWorkersAiAsrUsage(usage, { model: NOVA }, NOVA, Number.NaN)).toBe(usage);
  });
});
