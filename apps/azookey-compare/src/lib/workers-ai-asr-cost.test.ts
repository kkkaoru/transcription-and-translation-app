// This file runs with bun.
import { describe, expect, it } from "vitest";
import { audioSecondsFromPcmLength, WORKERS_AI_ASR_PCM_SAMPLE_RATE } from "./workers-ai-asr-cost";

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
