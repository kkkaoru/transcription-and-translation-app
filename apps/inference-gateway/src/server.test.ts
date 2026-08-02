import { once } from "node:events";
import type { Server } from "node:http";
import { GatewayError } from "@caption-bridge/inference-server-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "./config.js";
import { createGatewayServer } from "./server.js";

const config: GatewayConfig = {
  listen: { host: "127.0.0.1", port: 8765 },
  parapper: { url: "ws://127.0.0.1:18082/ws/recognition", timeoutMs: 1000 },
  models: {
    "hy-mt2-1.8b-gguf": { baseUrl: "http://models.test:8082", servedModel: "hy-local" },
    "zenz-v3.2-small-gguf": { baseUrl: "http://models.test:8081" },
  },
};

const wav = (): Blob => {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set(Buffer.from("RIFF"), 0);
  view.setUint32(4, 40, true);
  header.set(Buffer.from("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  header.set(Buffer.from("data"), 36);
  view.setUint32(40, 4, true);
  return new Blob([header, new Uint8Array([0, 0, 1, 0])], { type: "audio/wav" });
};

const open = async (server: Server): Promise<{ close: () => Promise<void>; origin: string }> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("gateway test server has no TCP address");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

describe("inference gateway HTTP contract", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("reports health and bridges an OpenAI-shaped Parapper transcription request", async () => {
    const transcribe = vi.fn((pcm: Uint8Array) =>
      Promise.resolve().then(() => {
        expect([...pcm]).toEqual([0, 0, 1, 0]);
        return "こんにちは";
      }),
    );
    const connection = await open(createGatewayServer(config, { transcribe }));
    closers.push(connection.close);
    await expect(
      fetch(`${connection.origin}/health`).then((response) => response.json()),
    ).resolves.toEqual({
      status: "ok",
      asr: "parapper",
      models: ["hy-mt2-1.8b-gguf", "zenz-v3.2-small-gguf"],
    });
    const form = new FormData();
    form.set("model", "parapper-ja");
    form.set("language", "ja");
    form.set("file", wav(), "caption.wav");
    const response = await fetch(`${connection.origin}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "こんにちは", language: "ja" });
    expect(transcribe).toHaveBeenCalledTimes(1);
    const withoutLanguage = new FormData();
    withoutLanguage.set("model", "parapper-ja");
    withoutLanguage.set("file", wav(), "caption.wav");
    await expect(
      fetch(`${connection.origin}/v1/audio/transcriptions`, {
        method: "POST",
        body: withoutLanguage,
      }).then((response) => response.json()),
    ).resolves.toEqual({ text: "こんにちは" });
  });

  it("returns HTTP 200 for a Parapper no-speech window without a final transcript", async () => {
    const transcribe = vi.fn(async () => "");
    const connection = await open(createGatewayServer(config, { transcribe }));
    closers.push(connection.close);
    const form = new FormData();
    form.set("model", "parapper-ja");
    form.set("file", wav(), "silent-caption.wav");

    const response = await fetch(`${connection.origin}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "" });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("normalizes a legacy 422 transcript_missing adapter error to an empty success", async () => {
    const transcribe = vi.fn(() => {
      throw new GatewayError(
        422,
        "transcript_missing",
        "Parapper completed without a final transcript",
      );
    });
    const connection = await open(createGatewayServer(config, { transcribe }));
    closers.push(connection.close);
    const form = new FormData();
    form.set("model", "parapper-ja");
    form.set("file", wav(), "legacy-silent-caption.wav");

    const response = await fetch(`${connection.origin}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "" });
  });

  it("releases the ASR gate after a failed chunk so the next request can recover", async () => {
    const transcribe = vi
      .fn<(pcm: Uint8Array) => Promise<string>>()
      .mockRejectedValueOnce(new GatewayError(504, "parapper_timeout", "sidecar timed out"))
      .mockResolvedValueOnce("復旧した音声");
    const connection = await open(createGatewayServer(config, { transcribe }));
    closers.push(connection.close);

    const first = new FormData();
    first.set("model", "parapper-ja");
    first.set("file", wav(), "timed-out.wav");
    const failed = await fetch(`${connection.origin}/v1/audio/transcriptions`, {
      method: "POST",
      body: first,
    });
    expect(failed.status).toBe(504);

    const second = new FormData();
    second.set("model", "parapper-ja");
    second.set("file", wav(), "recovery.wav");
    const recovered = await fetch(`${connection.origin}/v1/audio/transcriptions`, {
      method: "POST",
      body: second,
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ text: "復旧した音声" });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid routes, model IDs, and malformed transcription requests", async () => {
    const connection = await open(
      createGatewayServer(config, { transcribe: async () => "unused" }),
    );
    closers.push(connection.close);
    const unsupported = new FormData();
    unsupported.set("model", "other-asr");
    unsupported.set("file", wav(), "caption.wav");
    await expect(
      fetch(`${connection.origin}/v1/audio/transcriptions`, {
        method: "POST",
        body: unsupported,
      }).then(async (response) => ({ body: await response.json(), status: response.status })),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: "unsupported_asr_model" } } });
    await expect(
      fetch(`${connection.origin}/v1/audio/transcriptions`, { method: "POST", body: "nope" }).then(
        async (response) => ({ body: await response.json(), status: response.status }),
      ),
    ).resolves.toMatchObject({ status: 415, body: { error: { code: "unsupported_media_type" } } });
    await expect(
      fetch(`${connection.origin}/v1/chat/completions`, { method: "POST", body: "[]" }).then(
        async (response) => ({ body: await response.json(), status: response.status }),
      ),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: "invalid_json" } } });
    const missingFile = new FormData();
    missingFile.set("model", "parapper-ja");
    await expect(
      fetch(`${connection.origin}/v1/audio/transcriptions`, {
        method: "POST",
        body: missingFile,
      }).then(async (response) => ({ body: await response.json(), status: response.status })),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: "audio_missing" } } });
    const missingModel = new FormData();
    missingModel.set("file", wav(), "caption.wav");
    await expect(
      fetch(`${connection.origin}/v1/audio/transcriptions`, {
        method: "POST",
        body: missingModel,
      }).then(async (response) => ({ body: await response.json(), status: response.status })),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: "unsupported_asr_model" } } });
    await expect(
      fetch(`${connection.origin}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data" },
        body: "not-a-valid-boundary",
      }).then(async (response) => ({ body: await response.json(), status: response.status })),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: "invalid_multipart" } } });
    await expect(
      fetch(`${connection.origin}/v1/chat/completions`, { method: "POST", body: "{" }).then(
        async (response) => ({ body: await response.json(), status: response.status }),
      ),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: "invalid_json" } } });
    await expect(
      fetch(`${connection.origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }).then(async (response) => ({ body: await response.json(), status: response.status })),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: "model_required" } } });
    await expect(
      fetch(`${connection.origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "   " }),
      }).then(async (response) => ({ body: await response.json(), status: response.status })),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: "model_required" } } });
    await expect(
      fetch(`${connection.origin}/not-a-route`).then((response) => response.status),
    ).resolves.toBe(404);
  });

  it("routes each text model to its configured llama.cpp endpoint without forwarding model paths", async () => {
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve().then(() => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(String(input)).toBe("http://models.test:8082/v1/chat/completions");
        expect(body).toMatchObject({
          model: "hy-local",
          top_k: 20,
          repetition_penalty: 1.05,
        });
        expect(body["model_path"]).toBeUndefined();
        return new Response(JSON.stringify({ choices: [{ message: { content: "Hello" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const connection = await open(
      createGatewayServer(config, { fetch: fetcher, transcribe: async () => "unused" }),
    );
    closers.push(connection.close);
    const response = await fetch(`${connection.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "hy-mt2-1.8b-gguf",
        model_path: "/untrusted/model.gguf",
        messages: [],
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      choices: [{ message: { content: "Hello" } }],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports unknown models and model server failures", async () => {
    const fetcher = vi.fn(() => Promise.resolve().then(() => Promise.reject(new Error("offline"))));
    const connection = await open(
      createGatewayServer(config, { fetch: fetcher, transcribe: async () => "unused" }),
    );
    closers.push(connection.close);
    const unknown = await fetch(`${connection.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "unconfigured" }),
    });
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({
      error: { code: "model_not_configured" },
    });
    const offline = await fetch(`${connection.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zenz-v3.2-small-gguf",
        messages: [{ role: "user", content: "\u{EE00}セイドガタカイ\u{EE01}" }],
      }),
    });
    expect(offline.status).toBe(502);
    await expect(offline.json()).resolves.toMatchObject({
      error: { code: "model_connection_failed" },
    });
    const stringFailure = await open(
      createGatewayServer(config, {
        fetch: async () => Promise.reject("offline"),
        transcribe: async () => "unused",
      }),
    );
    closers.push(stringFailure.close);
    const fallback = await fetch(`${stringFailure.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zenz-v3.2-small-gguf",
        messages: [{ role: "user", content: "\u{EE00}セイドガタカイ\u{EE01}" }],
      }),
    });
    await expect(fallback.json()).resolves.toMatchObject({
      error: { code: "model_connection_failed", message: "connection failed" },
    });
  });

  it("uses Zenz's completion protocol and returns an OpenAI-compatible response", async () => {
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve().then(() => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          prompt: "\u{EE00}セイドガタカイ\u{EE01}",
          n_predict: 128,
          temperature: 0,
          stream: false,
        });
        return new Response(JSON.stringify({ content: "精度が高い" }), { status: 200 });
      }),
    );
    const connection = await open(
      createGatewayServer(config, { fetch: fetcher, transcribe: async () => "unused" }),
    );
    closers.push(connection.close);
    const response = await fetch(`${connection.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zenz-v3.2-small-gguf",
        messages: [{ role: "user", content: "\u{EE00}セイドガタカイ\u{EE01}" }],
        model_path: "ignored",
        max_tokens: 512,
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: "zenz-v3.2-small-gguf",
      choices: [{ message: { content: "精度が高い" } }],
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://models.test:8081/completion");
  });

  it("uses a JSON content type fallback when an upstream server omits the header", async () => {
    const fetcher = vi.fn(
      async () =>
        ({
          status: 200,
          headers: { get: () => null },
          text: async () => "{}",
        }) as unknown as Response,
    );
    const connection = await open(
      createGatewayServer(config, { fetch: fetcher, transcribe: async () => "unused" }),
    );
    closers.push(connection.close);
    const response = await fetch(`${connection.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zenz-v3.2-small-gguf",
        messages: [{ role: "user", content: "\u{EE00}セイドガタカイ\u{EE01}" }],
      }),
    });
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("turns malformed WAV files and unexpected backend errors into JSON gateway errors", async () => {
    const connection = await open(
      createGatewayServer(config, {
        transcribe: () => Promise.resolve().then(() => Promise.reject(new Error("unexpected"))),
      }),
    );
    closers.push(connection.close);
    const malformed = new FormData();
    malformed.set("model", "parapper-ja");
    malformed.set("file", new Blob(["not a wav"]), "caption.wav");
    const malformedResponse = await fetch(`${connection.origin}/v1/audio/transcriptions`, {
      method: "POST",
      body: malformed,
    });
    expect(malformedResponse.status).toBe(400);
    await expect(malformedResponse.json()).resolves.toMatchObject({
      error: { code: "invalid_audio" },
    });
    const valid = new FormData();
    valid.set("model", "parapper-ja");
    valid.set("file", wav(), "caption.wav");
    const unexpected = await fetch(`${connection.origin}/v1/audio/transcriptions`, {
      method: "POST",
      body: valid,
    });
    expect(unexpected.status).toBe(500);
    await expect(unexpected.json()).resolves.toMatchObject({ error: { code: "internal_error" } });
  });

  it("propagates a cancelled HTTP request to the ASR transcriber", async () => {
    const observedSignals: Array<AbortSignal | undefined> = [];
    const transcribe = vi.fn((_pcm: Uint8Array, signal?: AbortSignal) => {
      observedSignals.push(signal);
      return new Promise<string>((resolve) => {
        signal?.addEventListener("abort", () => resolve(""), { once: true });
      });
    });
    const connection = await open(createGatewayServer(config, { transcribe }));
    closers.push(connection.close);
    const form = new FormData();
    form.set("model", "parapper-ja");
    form.set("file", wav(), "cancelled-caption.wav");
    const controller = new AbortController();
    const pending = fetch(`${connection.origin}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    const signal = observedSignals[0];
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it("caps adapter request bodies and uses the configured Parapper connection by default", async () => {
    const connection = await open(
      createGatewayServer({
        ...config,
        parapper: { ...config.parapper, timeoutMs: 100, url: "ws://127.0.0.1:1/ws/recognition" },
      }),
    );
    closers.push(connection.close);

    const oversized = await fetch(`${connection.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", padding: "a".repeat(2 * 1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "request_too_large" },
    });

    const asr = new FormData();
    asr.set("model", "parapper-ja");
    asr.set("file", wav(), "caption.wav");
    const unavailable = await fetch(`${connection.origin}/v1/audio/transcriptions`, {
      method: "POST",
      body: asr,
    });
    expect(unavailable.status).toBe(502);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "parapper_connection_failed" },
    });

    await expect(fetch(`${connection.origin}/health`, { method: "HEAD" })).resolves.toMatchObject({
      status: 404,
    });
  });
});
