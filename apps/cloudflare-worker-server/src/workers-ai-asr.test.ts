import { describe, expect, it, vi } from "vitest";
import {
  createWorkersAiAsrTranscriber,
  WORKERS_AI_ASR_DEFAULT_TIMEOUT_MS,
  WORKERS_AI_ASR_LANGUAGE,
  WORKERS_AI_ASR_MAX_PCM_BYTES,
  WORKERS_AI_ASR_MAX_TIMEOUT_MS,
  WORKERS_AI_ASR_MIN_TIMEOUT_MS,
  WORKERS_AI_ASR_MODEL,
  type WorkersAiAsrRun,
  workersAiAsrTimeoutMs,
} from "./workers-ai-asr.js";

const pcm = (): Uint8Array => Uint8Array.from([0, 1, 2, 3]);

const novaResult = (transcript = "明日の天気は晴れ") => ({
  results: {
    channels: [{ alternatives: [{ transcript }] }],
  },
});

describe("Workers AI Nova-3 ASR adapter", () => {
  it("parses a bounded timeout configuration", () => {
    expect(workersAiAsrTimeoutMs({})).toBe(WORKERS_AI_ASR_DEFAULT_TIMEOUT_MS);
    expect(workersAiAsrTimeoutMs({ WORKERS_AI_ASR_TIMEOUT_MS: "  " })).toBe(
      WORKERS_AI_ASR_DEFAULT_TIMEOUT_MS,
    );
    expect(workersAiAsrTimeoutMs({ WORKERS_AI_ASR_TIMEOUT_MS: "not-a-number" })).toBe(
      WORKERS_AI_ASR_DEFAULT_TIMEOUT_MS,
    );
    expect(workersAiAsrTimeoutMs({ WORKERS_AI_ASR_TIMEOUT_MS: "0" })).toBe(
      WORKERS_AI_ASR_MIN_TIMEOUT_MS,
    );
    expect(workersAiAsrTimeoutMs({ WORKERS_AI_ASR_TIMEOUT_MS: "999999" })).toBe(
      WORKERS_AI_ASR_MAX_TIMEOUT_MS,
    );
    expect(workersAiAsrTimeoutMs({ WORKERS_AI_ASR_TIMEOUT_MS: "250" })).toBe(250);
  });

  it("sends Japanese WAV input to the explicitly selected Nova-3 model", async () => {
    const run = vi.fn<WorkersAiAsrRun>((model, input, options) => {
      expect(model).toBe(WORKERS_AI_ASR_MODEL);
      expect(input.language).toBe(WORKERS_AI_ASR_LANGUAGE);
      expect(input.audio.contentType).toBe("audio/wav");
      const body = input.audio.body as unknown as string;
      expect(typeof body).toBe("string");
      expect([
        ...Uint8Array.from(atob(body), (character) => character.charCodeAt(0)).slice(0, 4),
      ]).toEqual([82, 73, 70, 70]);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(novaResult());
    });
    const transcribe = createWorkersAiAsrTranscriber({}, run);
    await expect(transcribe(pcm())).resolves.toBe("明日の天気は晴れ");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("accepts the Workers AI raw response form", async () => {
    const run = vi.fn<WorkersAiAsrRun>(() =>
      Promise.resolve(
        new Response(JSON.stringify(novaResult("音声認識")), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(createWorkersAiAsrTranscriber({}, run)(pcm())).resolves.toBe("音声認識");
  });

  it("maps unavailable, failed, malformed, and non-JSON responses", async () => {
    await expect(createWorkersAiAsrTranscriber({})(pcm())).rejects.toMatchObject({
      status: 503,
      code: "asr_workers_ai_unavailable",
    });

    await expect(
      createWorkersAiAsrTranscriber({}, () => Promise.reject(new Error("AI offline")))(pcm()),
    ).rejects.toMatchObject({
      status: 502,
      code: "asr_workers_ai_failed",
      message: "AI offline",
    });

    await expect(
      createWorkersAiAsrTranscriber({}, () => Promise.reject("AI offline"))(pcm()),
    ).rejects.toMatchObject({
      status: 502,
      code: "asr_workers_ai_failed",
      message: "Workers AI ASR failed",
    });

    await expect(
      createWorkersAiAsrTranscriber({}, () => Promise.resolve({}))(pcm()),
    ).rejects.toMatchObject({
      status: 502,
      code: "asr_workers_ai_invalid_response",
    });
    for (const malformed of [
      { results: null },
      { results: { channels: "not-an-array" } },
      { results: { channels: [] } },
      { results: { channels: [{ alternatives: "not-an-array" }] } },
      { results: { channels: [{ alternatives: [] }] } },
      { results: { channels: [{ alternatives: [{}] }] } },
      { results: { channels: [{ alternatives: [{ transcript: 42 }] }] } },
    ]) {
      await expect(
        createWorkersAiAsrTranscriber({}, () => Promise.resolve(malformed))(pcm()),
      ).rejects.toMatchObject({
        status: 502,
        code: "asr_workers_ai_invalid_response",
      });
    }
    await expect(
      createWorkersAiAsrTranscriber({}, () =>
        Promise.resolve(new Response("not-json", { status: 200 })),
      )(pcm()),
    ).rejects.toMatchObject({
      status: 502,
      code: "asr_workers_ai_invalid_response",
    });
    await expect(
      createWorkersAiAsrTranscriber({}, () =>
        Promise.resolve(new Response("busy", { status: 429 })),
      )(pcm()),
    ).rejects.toMatchObject({
      status: 502,
      code: "asr_workers_ai_failed",
    });
  });

  it("rejects malformed or oversized PCM before invoking AI", async () => {
    const run = vi.fn<WorkersAiAsrRun>(() => Promise.resolve(novaResult()));
    await expect(createWorkersAiAsrTranscriber({}, run)(new Uint8Array())).rejects.toMatchObject({
      status: 400,
      code: "asr_workers_ai_invalid_audio",
    });
    await expect(createWorkersAiAsrTranscriber({}, run)(new Uint8Array([1]))).rejects.toMatchObject(
      {
        status: 400,
        code: "asr_workers_ai_invalid_audio",
      },
    );
    await expect(
      createWorkersAiAsrTranscriber({}, run)(new Uint8Array(WORKERS_AI_ASR_MAX_PCM_BYTES + 2)),
    ).rejects.toMatchObject({
      status: 400,
      code: "asr_workers_ai_audio_too_large",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("aborts a slow AI call at the configured timeout", async () => {
    const run = vi.fn<WorkersAiAsrRun>(
      (_model, _input, options) =>
        new Promise<unknown>((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          void resolve;
        }),
    );
    await expect(
      createWorkersAiAsrTranscriber({ WORKERS_AI_ASR_TIMEOUT_MS: "100" }, run)(pcm()),
    ).rejects.toMatchObject({
      status: 504,
      code: "asr_workers_ai_timeout",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
