import { describe, expect, it } from "vitest";
import { buildWorkersAiAsrSmokeWav, workersAiAsrSmokeWavFile } from "./workers-ai-asr-fixture";

describe("workers-ai-asr-fixture", () => {
  it("builds a valid RIFF WAV payload", () => {
    const wav = buildWorkersAiAsrSmokeWav();
    expect([...wav.slice(0, 4)]).toEqual([...new TextEncoder().encode("RIFF")]);
    expect(wav.length).toBeGreaterThan(44);
  });

  it("wraps the WAV as an upload File", () => {
    const file = workersAiAsrSmokeWavFile();
    expect(file.name).toBe("asr-smoke.wav");
    expect(file.type).toBe("audio/wav");
  });
});
