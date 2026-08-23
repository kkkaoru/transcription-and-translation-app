// This file runs with bun.
import { describe, expect, it, vi } from "vitest";
import {
  handleWorkersAiSpeechPipeline,
  WORKERS_AI_SPEECH_PIPELINE_PATH,
  workersAiSpeechAsrPayload,
} from "./workers-ai-speech-pipeline.js";

const wavFile = (): File => {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 38, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, 2, true);
  return new File([bytes], "utterance.wav", { type: "audio/wav" });
};

const request = (): Request => {
  const form = new FormData();
  form.set("file", wavFile());
  form.set("language", "ja");
  form.set("segmentation", "client-silero-v1");
  return new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
    method: "POST",
    body: form,
  });
};

const asrRun = () =>
  Promise.resolve({
    results: { channels: [{ alternatives: [{ transcript: "きょうはいいてんき" }] }] },
  });

const identityVibrato = (text: string): Promise<string> => Promise.resolve(text);

describe("Workers AI speech pipeline", () => {
  it("validates internal ASR payloads", () => {
    expect(workersAiSpeechAsrPayload({ text: "最小" })).toStrictEqual({
      text: "最小",
      language: "ja",
      model: "@cf/deepgram/nova-3",
    });
    expect(() => workersAiSpeechAsrPayload(null)).toThrow(
      "Workers AI ASR response is missing text",
    );
  });

  it("returns visible ASR, Vibrato, and AzooKey stages from one request", async () => {
    const vibrato = vi.fn(() => Promise.resolve("きょうはいいてんき"));
    const convert = vi.fn(() => Promise.resolve("今日はいい天気"));
    const response = await handleWorkersAiSpeechPipeline(request(), {
      asrEnvironment: {},
      run: vi.fn(asrRun),
      vibrato,
      convert,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "きょうはいいてんき",
      vibratoText: "きょうはいいてんき",
      convertedText: "今日はいい天気",
      pipeline: "workers-ai-vibrato-azookey-v2",
      logs: [
        { stage: "asr", output: "きょうはいいてんき" },
        { stage: "vibrato", output: "きょうはいいてんき" },
        { stage: "azookey", output: "今日はいい天気" },
      ],
    });
    expect(vibrato).toHaveBeenCalledWith("きょうはいいてんき", "ja");
    expect(convert).toHaveBeenCalledWith("きょうはいいてんき");
  });

  it("does not invoke processing when ASR rejects the upload", async () => {
    const convert = vi.fn(() => Promise.resolve("unused"));
    const response = await handleWorkersAiSpeechPipeline(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, { method: "GET" }),
      { asrEnvironment: {}, vibrato: identityVibrato, convert },
    );

    expect(response.status).toBe(405);
    expect(convert).not.toHaveBeenCalled();
  });

  it("returns an empty result without invoking morphology for silence", async () => {
    const vibrato = vi.fn(identityVibrato);
    const convert = vi.fn(() => Promise.resolve("unused"));
    const response = await handleWorkersAiSpeechPipeline(request(), {
      asrEnvironment: {},
      run: vi.fn(() =>
        Promise.resolve({ results: { channels: [{ alternatives: [{ transcript: "" }] }] } }),
      ),
      vibrato,
      convert,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "",
      vibratoText: "",
      convertedText: "",
      pipeline: "workers-ai-vibrato-azookey-v2",
      logs: [],
    });
    expect(vibrato).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });

  it("returns a bounded pipeline error response", async () => {
    const response = await handleWorkersAiSpeechPipeline(request(), {
      asrEnvironment: {},
      run: vi.fn(asrRun),
      vibrato: identityVibrato,
      convert: () => Promise.reject(new Error("dictionary unavailable")),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({
      error: { code: "azookey_conversion_failed", message: "dictionary unavailable" },
    });

    const nonErrorResponse = await handleWorkersAiSpeechPipeline(request(), {
      asrEnvironment: {},
      run: vi.fn(asrRun),
      vibrato: identityVibrato,
      convert: () => Promise.reject("offline"),
    });
    expect(await nonErrorResponse.json()).toStrictEqual({
      error: { code: "azookey_conversion_failed", message: "AzooKey conversion failed" },
    });
  });
});
