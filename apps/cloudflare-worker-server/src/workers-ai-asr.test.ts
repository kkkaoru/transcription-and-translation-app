import { readFileSync } from "node:fs";
import { pcm16ToWav } from "@caption-bridge/inference-server-core";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkersAiAsrTranscriber,
  handleWorkersAiAsrTranscription,
  postprocessWorkersAiAsrTranscript,
  WORKERS_AI_ASR_CLIENT_SEGMENTATION,
  WORKERS_AI_ASR_DEFAULT_TIMEOUT_MS,
  WORKERS_AI_ASR_HTTP_PATH,
  WORKERS_AI_ASR_LANGUAGE,
  WORKERS_AI_ASR_MAX_PCM_BYTES,
  WORKERS_AI_ASR_MAX_RESPONSE_BYTES,
  WORKERS_AI_ASR_MAX_TIMEOUT_MS,
  WORKERS_AI_ASR_MIN_TIMEOUT_MS,
  WORKERS_AI_ASR_MODEL,
  type WorkersAiAsrRun,
  workersAiAsrTimeoutMs,
} from "./workers-ai-asr.js";

const greetingWav = readFileSync(
  new URL("../../desktop/src/overlay/fixtures/greeting-kikoemasu.wav", import.meta.url),
);

const pcm = (): Uint8Array => {
  const samples = Int16Array.from({ length: 2048 }, (_, index) =>
    index % 2 === 0 ? 20_000 : -20_000,
  );
  return new Uint8Array(samples.buffer);
};

const novaResult = (transcript = "明日の天気は晴れ") => ({
  results: {
    channels: [{ alternatives: [{ transcript }] }],
  },
});

const wavFile = (): File => new File([pcm16ToWav(pcm())], "caption.wav", { type: "audio/wav" });

describe("Workers AI Nova-3 ASR adapter", () => {
  it("strips Japanese token-gap spaces and passes kana through the reading gate", () => {
    expect(postprocessWorkersAiAsrTranscript("きょう は いい てんき")).toStrictEqual({
      text: "きょうはいいてんき",
      reading: "きょうはいいてんき",
    });
    expect(postprocessWorkersAiAsrTranscript("今日 は いい 天気")).toStrictEqual({
      text: "今日はいい天気",
      reading: "今日はいい天気",
    });
    expect(WORKERS_AI_ASR_MODEL).toBe("@cf/deepgram/nova-3");
    expect(WORKERS_AI_ASR_LANGUAGE).toBe("ja");
  });

  it("parses a bounded timeout configuration", () => {
    expect(workersAiAsrTimeoutMs({})).toBe(WORKERS_AI_ASR_DEFAULT_TIMEOUT_MS);
    expect(workersAiAsrTimeoutMs({ WORKERS_AI_ASR_TIMEOUT_MS: "  " })).toBe(
      WORKERS_AI_ASR_DEFAULT_TIMEOUT_MS,
    );
    expect(workersAiAsrTimeoutMs({ WORKERS_AI_ASR_TIMEOUT_MS: "not-a-number" })).toBe(
      WORKERS_AI_ASR_DEFAULT_TIMEOUT_MS,
    );
    expect(workersAiAsrTimeoutMs({ WORKERS_AI_ASR_TIMEOUT_MS: "1.5" })).toBe(
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
      expect(input.audio.body).toBeInstanceOf(ReadableStream);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(novaResult());
    });
    const transcribe = createWorkersAiAsrTranscriber({}, run);
    await expect(transcribe(pcm())).resolves.toBe("明日の天気は晴れ");
    expect(run).toHaveBeenCalledTimes(1);

    const formWithoutLanguage = new FormData();
    formWithoutLanguage.set("file", wavFile());
    formWithoutLanguage.set("segmentation", WORKERS_AI_ASR_CLIENT_SEGMENTATION);
    const defaultLanguageResponse = await handleWorkersAiAsrTranscription(
      new Request(`https://worker.example${WORKERS_AI_ASR_HTTP_PATH}`, {
        method: "POST",
        body: formWithoutLanguage,
      }),
      {},
      run,
    );
    await expect(defaultLanguageResponse.json()).resolves.toMatchObject({
      language: "ja",
      segmentation: WORKERS_AI_ASR_CLIENT_SEGMENTATION,
    });

    const formWithBlankLanguage = new FormData();
    formWithBlankLanguage.set("file", wavFile());
    formWithBlankLanguage.set("language", "   ");
    const blankLanguageResponse = await handleWorkersAiAsrTranscription(
      new Request(`https://worker.example${WORKERS_AI_ASR_HTTP_PATH}`, {
        method: "POST",
        body: formWithBlankLanguage,
      }),
      {},
      run,
    );
    await expect(blankLanguageResponse.json()).resolves.toMatchObject({
      language: "ja",
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("trusts browser Silero segmentation instead of applying the Worker RMS VAD twice", async () => {
    const run = vi.fn<WorkersAiAsrRun>(() => Promise.resolve(novaResult("小さい声")));
    const transcribe = createWorkersAiAsrTranscriber({}, run);
    const quiet = new Uint8Array(2_048 * 2);

    await expect(transcribe(quiet)).resolves.toBe("");
    expect(run).not.toHaveBeenCalled();

    await expect(transcribe(quiet, undefined, undefined, { presegmented: true })).resolves.toBe(
      "小さい声",
    );
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

  it("rejects an oversized raw Response body and a Response with no body", async () => {
    const oversized = new Uint8Array(WORKERS_AI_ASR_MAX_RESPONSE_BYTES + 1);
    await expect(
      createWorkersAiAsrTranscriber({}, () =>
        Promise.resolve(new Response(oversized, { status: 200 })),
      )(pcm()),
    ).rejects.toMatchObject({
      status: 502,
      code: "asr_workers_ai_invalid_response",
      message: "Workers AI ASR response exceeds the byte limit",
    });
    await expect(
      createWorkersAiAsrTranscriber({}, () => Promise.resolve(new Response(null, { status: 200 })))(
        pcm(),
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "asr_workers_ai_invalid_response",
      message: "Workers AI ASR response has no body",
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

  it("serves the explicit HTTP route without requiring ASR_PROVIDER", async () => {
    const run = vi.fn<WorkersAiAsrRun>(() => Promise.resolve(novaResult("Nova-3 route")));
    const form = new FormData();
    form.set("file", wavFile());
    form.set("language", "ja");
    const response = await handleWorkersAiAsrTranscription(
      new Request(`https://worker.example${WORKERS_AI_ASR_HTTP_PATH}`, {
        method: "POST",
        body: form,
      }),
      {},
      run,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      text: "Nova-3 route",
      language: "ja",
      model: WORKERS_AI_ASR_MODEL,
      transport: "http",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("segments the greeting speech fixture through the shipped Nova-3 handler", async () => {
    const run = vi.fn<WorkersAiAsrRun>(() =>
      Promise.resolve(novaResult("こんにちは 聞こえますか")),
    );
    const form = new FormData();
    form.set("file", new File([greetingWav], "greeting-kikoemasu.wav", { type: "audio/wav" }));
    const response = await handleWorkersAiAsrTranscription(
      new Request(`https://worker.example${WORKERS_AI_ASR_HTTP_PATH}`, {
        method: "POST",
        body: form,
      }),
      {},
      run,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      text: "こんにちは聞こえますか",
      reading: "こんにちは聞こえますか",
      language: "ja",
      model: "@cf/deepgram/nova-3",
      transport: "http",
      segmentation: "worker-energy-v1",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe("@cf/deepgram/nova-3");
  });

  it("returns empty text without invoking Nova-3 when VAD finds no speech", async () => {
    const run = vi.fn<WorkersAiAsrRun>(() => Promise.resolve(novaResult("should-not-run")));
    const silence = new Uint8Array(4096);
    await expect(createWorkersAiAsrTranscriber({}, run)(silence)).resolves.toBe("");
    expect(run).not.toHaveBeenCalled();
  });

  it("applies Japanese ASR post-processing on the shipped Nova-3 HTTP handler", async () => {
    const run = vi.fn<WorkersAiAsrRun>(() => Promise.resolve(novaResult("きょう は いい てんき")));
    const form = new FormData();
    form.set("file", wavFile());
    const response = await handleWorkersAiAsrTranscription(
      new Request(`https://worker.example${WORKERS_AI_ASR_HTTP_PATH}`, {
        method: "POST",
        body: form,
      }),
      {},
      run,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      text: "きょうはいいてんき",
      reading: "きょうはいいてんき",
      language: "ja",
      model: "@cf/deepgram/nova-3",
      transport: "http",
      segmentation: "worker-energy-v1",
    });
  });

  it("rejects non-record worker results and missing audio stream bodies", async () => {
    await expect(
      createWorkersAiAsrTranscriber({}, () => Promise.resolve(null))(pcm()),
    ).rejects.toMatchObject({
      status: 502,
      code: "asr_workers_ai_invalid_response",
    });

    const NativeResponse = Response;
    vi.stubGlobal(
      "Response",
      class {
        body = null;
      },
    );
    try {
      await expect(
        createWorkersAiAsrTranscriber({}, () => Promise.resolve(novaResult()))(pcm()),
      ).rejects.toMatchObject({
        status: 502,
        code: "asr_workers_ai_failed",
        message: "Workers AI ASR could not build the audio stream",
      });
    } finally {
      vi.stubGlobal("Response", NativeResponse);
    }
  });

  it("maps HTTP route method, multipart, WAV, and inference failures", async () => {
    const request = (form?: FormData) =>
      new Request(`https://worker.example${WORKERS_AI_ASR_HTTP_PATH}`, {
        method: "POST",
        ...(form ? { body: form } : {}),
      });
    await expect(
      handleWorkersAiAsrTranscription(request(), {}, () => Promise.resolve(novaResult())),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      handleWorkersAiAsrTranscription(
        new Request(`https://worker.example${WORKERS_AI_ASR_HTTP_PATH}`, { method: "GET" }),
        {},
      ),
    ).resolves.toMatchObject({ status: 405 });

    const missingFile = new FormData();
    missingFile.set("language", "ja");
    await expect(handleWorkersAiAsrTranscription(request(missingFile), {})).resolves.toMatchObject({
      status: 400,
    });

    const invalidSegmentation = new FormData();
    invalidSegmentation.set("file", wavFile());
    invalidSegmentation.set("segmentation", "untrusted-client");
    const invalidSegmentationResponse = await handleWorkersAiAsrTranscription(
      request(invalidSegmentation),
      {},
    );
    await expect(invalidSegmentationResponse.json()).resolves.toMatchObject({
      error: { code: "invalid_segmentation" },
    });

    const invalidWav = new FormData();
    invalidWav.set("file", new File(["not-wav"], "caption.wav", { type: "audio/wav" }));
    await expect(handleWorkersAiAsrTranscription(request(invalidWav), {})).resolves.toMatchObject({
      status: 400,
    });

    const valid = new FormData();
    valid.set("file", wavFile());
    const unavailable = await handleWorkersAiAsrTranscription(request(valid), {});
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "asr_workers_ai_unavailable" },
    });

    const failed = new FormData();
    failed.set("file", wavFile());
    const failedResponse = await handleWorkersAiAsrTranscription(request(failed), {}, () =>
      Promise.reject(new Error("provider failed")),
    );
    await expect(failedResponse.json()).resolves.toMatchObject({
      error: { code: "asr_workers_ai_failed", message: "provider failed" },
    });

    const failedWithoutError = new FormData();
    failedWithoutError.set("file", wavFile());
    const failedWithoutErrorResponse = await handleWorkersAiAsrTranscription(
      request(failedWithoutError),
      {},
      () => Promise.reject("provider failed without Error"),
    );
    await expect(failedWithoutErrorResponse.json()).resolves.toMatchObject({
      error: { code: "asr_workers_ai_failed" },
    });

    const exploding = wavFile();
    exploding.arrayBuffer = () => Promise.reject(new TypeError("arrayBuffer failed"));
    const explodingRequest = {
      method: "POST",
      formData: async () =>
        ({
          get: (name: string) => (name === "file" ? exploding : null),
        }) as FormData,
    } as unknown as Request;
    await expect(handleWorkersAiAsrTranscription(explodingRequest, {})).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});
