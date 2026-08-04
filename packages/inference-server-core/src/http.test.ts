import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "./config.js";
import {
  correlationHeadersFromRequest,
  createGatewayFetchHandler,
  GatewayError,
  MAX_AUDIO_BYTES,
  MAX_JSON_BYTES,
  SerialGate,
} from "./http.js";

const config: GatewayConfig = {
  listen: { host: "127.0.0.1", port: 8_765 },
  parapper: { url: "ws://127.0.0.1:18082/ws/recognition", timeoutMs: 1_000 },
  models: {
    "hy-mt2-1.8b-gguf": { baseUrl: "http://models.test:8082", servedModel: "hy-local" },
    "plain-model": { baseUrl: "https://models.test/" },
    "zenz-v3.2-small-gguf": { baseUrl: "http://models.test:8081" },
  },
};

const wav = (): Blob => {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 40, true);
  header.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  header.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, 4, true);
  return new Blob([header, Uint8Array.from([0, 0, 1, 0])], { type: "audio/wav" });
};

const transcription = (
  options: { model?: string; language?: string; file?: Blob | string; headers?: HeadersInit } = {},
): Request => {
  const form = new FormData();
  if (options.model !== undefined) form.set("model", options.model);
  if (options.language !== undefined) form.set("language", options.language);
  if (options.file !== undefined) {
    if (typeof options.file === "string") form.set("file", options.file);
    else form.set("file", options.file, "caption.wav");
  }
  return new Request("https://gateway.example/v1/audio/transcriptions", {
    method: "POST",
    ...(options.headers ? { headers: options.headers } : {}),
    body: form,
  });
};

const chat = (
  body: unknown,
  headers: HeadersInit = { "content-type": "application/json" },
): Request =>
  new Request("https://gateway.example/v1/chat/completions", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const jsonBody = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

describe("portable inference gateway HTTP contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serves health, preflight, and not-found responses", async () => {
    const handler = createGatewayFetchHandler(config);
    await expect(handler(new Request("https://gateway.example/health"))).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      jsonBody(await handler(new Request("https://gateway.example/health"))),
    ).resolves.toEqual({
      status: "ok",
      asr: "parapper",
      models: Object.keys(config.models),
    });
    expect(
      (await handler(new Request("https://gateway.example/", { method: "OPTIONS" }))).status,
    ).toBe(204);
    expect((await handler(new Request("https://gateway.example/unknown"))).status).toBe(404);
  });

  it("accepts valid audio with optional metadata and handles no-speech output", async () => {
    const transcribe = vi.fn((pcm: Uint8Array) => {
      expect([...pcm]).toEqual([0, 0, 1, 0]);
      return Promise.resolve("こんにちは");
    });
    const handler = createGatewayFetchHandler(config, { transcribe });
    const response = await handler(
      transcription({ model: "parapper-ja", language: " ja ", file: wav() }),
    );
    expect(response.status).toBe(200);
    await expect(jsonBody(response)).resolves.toEqual({ text: "こんにちは", language: "ja" });
    const withoutMetadata = await handler(transcription({ model: "parapper-ja", file: wav() }));
    await expect(jsonBody(withoutMetadata)).resolves.toEqual({ text: "こんにちは" });

    const silent = createGatewayFetchHandler(config, {
      transcribe: vi.fn(() => Promise.resolve("")),
    });
    await expect(
      jsonBody(await silent(transcription({ model: "parapper-ja", file: wav() }))),
    ).resolves.toEqual({
      text: "",
    });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("trims and bounds forwarded correlation headers", () => {
    const requestId = "r".repeat(300);
    expect(
      correlationHeadersFromRequest(
        new Request("https://gateway.example", {
          headers: {
            "x-request-id": `  ${requestId}  `,
            authorization: "Bearer secret",
          },
        }),
      ),
    ).toEqual({ "x-request-id": requestId.slice(0, 256) });
    expect(correlationHeadersFromRequest()).toEqual({});
  });

  it("forwards bounded correlation headers to ASR and chat adapters", async () => {
    const correlation = {
      "x-request-id": "request-core-1",
      "x-session-id": "session-core-1",
      "x-agent-id": "agent-core-1",
      "x-parent-agent-id": "parent-core-1",
    };
    const assertCorrelation = (headers: Headers): void => {
      for (const [name, value] of Object.entries(correlation)) {
        expect(headers.get(name)).toBe(value);
      }
    };
    const transcribe = vi.fn(
      (_pcm: Uint8Array, _signal: AbortSignal | undefined, request: Request | undefined) => {
        expect(request).toBeDefined();
        assertCorrelation(request?.headers ?? new Headers());
        return Promise.resolve("相関あり");
      },
    );
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      assertCorrelation(new Headers(init?.headers));
      return Promise.resolve(new Response(JSON.stringify({ choices: [] })));
    });
    const handler = createGatewayFetchHandler(config, { transcribe, fetch: fetcher });

    const asr = await handler(
      transcription({ model: "parapper-ja", file: wav(), headers: correlation }),
    );
    expect(asr.status).toBe(200);
    await expect(jsonBody(asr)).resolves.toEqual({ text: "相関あり" });

    const chatResponse = await handler(
      chat(
        { model: "plain-model", messages: [] },
        { "content-type": "application/json", ...correlation },
      ),
    );
    expect(chatResponse.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("normalizes legacy transcript-missing failures and releases the serial gate", async () => {
    const transcribe = vi
      .fn<(pcm: Uint8Array) => Promise<string>>()
      .mockRejectedValueOnce(
        new GatewayError(
          422,
          " transcript_missing ",
          "Parapper completed without a final transcript",
        ),
      )
      .mockRejectedValueOnce(new Error("no final transcript"))
      .mockRejectedValueOnce("no speech")
      .mockRejectedValueOnce(new GatewayError(504, "sidecar_timeout", "timed out"))
      .mockResolvedValueOnce("復旧した音声");
    const handler = createGatewayFetchHandler(config, { transcribe });
    for (let index = 0; index < 3; index += 1) {
      const response = await handler(transcription({ model: "parapper-ja", file: wav() }));
      expect(response.status).toBe(200);
      await expect(jsonBody(response)).resolves.toEqual({ text: "" });
    }
    expect((await handler(transcription({ model: "parapper-ja", file: wav() }))).status).toBe(504);
    const recovered = await handler(transcription({ model: "parapper-ja", file: wav() }));
    expect(recovered.status).toBe(200);
    await expect(jsonBody(recovered)).resolves.toEqual({ text: "復旧した音声" });
  });

  it("turns unexpected ASR failures into the stable internal error response", async () => {
    // Reject a non-Error value to exercise the generic error path.
    const rejected = createGatewayFetchHandler(config, {
      transcribe: () => Promise.reject({ unexpected: true }),
    });
    const response = await rejected(transcription({ model: "parapper-ja", file: wav() }));
    expect(response.status).toBe(500);
    await expect(jsonBody(response)).resolves.toMatchObject({ error: { code: "internal_error" } });
  });

  it("returns stable errors for malformed transcription requests", async () => {
    const handler = createGatewayFetchHandler(config, {
      transcribe: () => Promise.resolve("unused"),
    });
    await expect(
      jsonBody(await handler(transcription({ model: "other", file: wav() }))),
    ).resolves.toMatchObject({
      error: { code: "unsupported_asr_model" },
    });
    expect(
      (
        await handler(
          new Request("https://gateway.example/v1/audio/transcriptions", {
            method: "POST",
            body: "nope",
          }),
        )
      ).status,
    ).toBe(415);
    await expect(
      jsonBody(await handler(transcription({ model: "parapper-ja" }))),
    ).resolves.toMatchObject({
      error: { code: "audio_missing" },
    });
    await expect(
      jsonBody(await handler(transcription({ model: "parapper-ja", file: "not-a-file" }))),
    ).resolves.toMatchObject({
      error: { code: "audio_missing" },
    });
    const malformedMultipart = new Request("https://gateway.example/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": "multipart/form-data" },
      body: "not-a-valid-boundary",
    });
    await expect(jsonBody(await handler(malformedMultipart))).resolves.toMatchObject({
      error: { code: "invalid_multipart" },
    });
    await expect(
      jsonBody(await handler(transcription({ model: "parapper-ja", file: new Blob(["not wav"]) }))),
    ).resolves.toMatchObject({
      error: { code: "invalid_audio" },
    });
    const huge = new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)]);
    await expect(
      jsonBody(await handler(transcription({ model: "parapper-ja", file: huge }))),
    ).resolves.toMatchObject({
      error: { code: "audio_too_large" },
    });
    const unavailable = createGatewayFetchHandler(config);
    await expect(
      jsonBody(await unavailable(transcription({ model: "parapper-ja", file: wav() }))),
    ).resolves.toMatchObject({
      error: { code: "asr_unavailable" },
    });
  });

  it("routes standard model requests and preserves upstream responses", async () => {
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://models.test:8082/v1/chat/completions");
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({ model: "hy-local", top_k: 3, repetition_penalty: 1.2 });
      expect(payload["model_path"]).toBeUndefined();
      return Promise.resolve(
        new Response('{"choices":[{"message":{"content":"Hello"}}]}', {
          status: 201,
          headers: { "content-type": "application/custom+json" },
        }),
      );
    });
    const handler = createGatewayFetchHandler(config, { fetch: fetcher });
    const response = await handler(
      chat({
        model: "hy-mt2-1.8b-gguf",
        model_path: "/untrusted/model.gguf",
        top_k: 3,
        repetition_penalty: 1.2,
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/custom+json");
    expect(await response.json()).toEqual({ choices: [{ message: { content: "Hello" } }] });
    const plain = createGatewayFetchHandler(config, {
      fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
    });
    await expect(plain(chat({ model: "plain-model", messages: [] }))).resolves.toMatchObject({
      status: 200,
    });
  });

  it("returns model route and connection failures", async () => {
    const unknown = createGatewayFetchHandler(config);
    await expect(jsonBody(await unknown(chat({ model: "unconfigured" })))).resolves.toMatchObject({
      error: { code: "model_not_configured" },
    });
    const error = createGatewayFetchHandler(config, {
      fetch: () => Promise.reject(new Error("offline")),
    });
    await expect(jsonBody(await error(chat({ model: "plain-model" })))).resolves.toMatchObject({
      error: { code: "model_connection_failed", message: "offline" },
    });
    const stringError = createGatewayFetchHandler(config, {
      fetch: () => Promise.reject("offline"),
    });
    await expect(
      jsonBody(await stringError(chat({ model: "plain-model" }))),
    ).resolves.toMatchObject({
      error: { code: "model_connection_failed", message: "connection failed" },
    });
  });

  it("supports Zenz completion requests and validates the delimited prompt", async () => {
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        prompt: "\u{EE00}セイドガタカイ\u{EE01}",
        n_predict: 128,
        temperature: 0,
        stream: false,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ content: "精度が高い" }), { status: 200 }),
      );
    });
    const handler = createGatewayFetchHandler(config, { fetch: fetcher });
    const response = await handler(
      chat({
        model: "zenz-v3.2-small-gguf",
        messages: [{ role: "user", content: "\u{EE00}セイドガタカイ\u{EE01}" }],
        max_tokens: 512,
      }),
    );
    expect(await response.json()).toMatchObject({
      model: "zenz-v3.2-small-gguf",
      choices: [{ message: { content: "精度が高い" } }],
    });
    for (const payload of [
      { model: "zenz-v3.2-small-gguf" },
      { model: "zenz-v3.2-small-gguf", messages: [] },
      { model: "zenz-v3.2-small-gguf", messages: ["bad"] },
      { model: "zenz-v3.2-small-gguf", messages: [{ content: "bad" }] },
      { model: "zenz-v3.2-small-gguf", messages: [{ content: "\u{EE00}\u{EE01}" }] },
    ]) {
      await expect(jsonBody(await handler(chat(payload)))).resolves.toMatchObject({
        error: { code: "zenz_prompt_required" },
      });
    }
  });

  it("maps Zenz upstream status and malformed responses", async () => {
    const failed = createGatewayFetchHandler(config, {
      fetch: () => Promise.resolve(new Response("busy", { status: 429 })),
    });
    const failedResponse = await failed(
      chat({ model: "zenz-v3.2-small-gguf", messages: [{ content: "\u{EE00}x\u{EE01}" }] }),
    );
    expect(failedResponse.status).toBe(429);
    expect(await failedResponse.text()).toBe("busy");
    const invalidJson = createGatewayFetchHandler(config, {
      fetch: () => Promise.resolve(new Response("not-json")),
    });
    await expect(
      jsonBody(
        await invalidJson(
          chat({ model: "zenz-v3.2-small-gguf", messages: [{ content: "\u{EE00}x\u{EE01}" }] }),
        ),
      ),
    ).resolves.toMatchObject({
      error: { code: "invalid_model_response" },
    });
    const missingContent = createGatewayFetchHandler(config, {
      fetch: () => Promise.resolve(new Response("{}")),
    });
    await expect(
      jsonBody(
        await missingContent(
          chat({ model: "zenz-v3.2-small-gguf", messages: [{ content: "\u{EE00}x\u{EE01}" }] }),
        ),
      ),
    ).resolves.toMatchObject({
      error: { code: "invalid_model_response" },
    });
  });

  it("rejects malformed and oversized JSON chat requests", async () => {
    const handler = createGatewayFetchHandler(config, {
      fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
    });
    for (const body of ["[]", "{"]) {
      await expect(jsonBody(await handler(chat(body)))).resolves.toMatchObject({
        error: { code: "invalid_json" },
      });
    }
    await expect(jsonBody(await handler(chat({})))).resolves.toMatchObject({
      error: { code: "model_required" },
    });
    await expect(jsonBody(await handler(chat({ model: 1 })))).resolves.toMatchObject({
      error: { code: "model_required" },
    });
    await expect(jsonBody(await handler(chat({ model: "  " })))).resolves.toMatchObject({
      error: { code: "model_required" },
    });
    const lengthExceeded = await handler(
      chat(
        { model: "plain-model" },
        { "content-type": "application/json", "content-length": String(MAX_JSON_BYTES + 1) },
      ),
    );
    expect(lengthExceeded.status).toBe(413);
    const bodyExceeded = await handler(
      chat({ model: "plain-model", padding: "a".repeat(MAX_JSON_BYTES) }),
    );
    expect(bodyExceeded.status).toBe(413);
    const noLength = await handler(
      chat(
        { model: "plain-model" },
        { "content-type": "application/json", "content-length": "not-a-number" },
      ),
    );
    expect(noLength.status).toBe(200);
  });

  it("serializes successful and failed gate work", async () => {
    const gate = new SerialGate();
    const order: string[] = [];
    const first = gate.run(() => {
      order.push("first");
      return Promise.resolve("ok");
    });
    const second = gate.run(() => {
      order.push("second");
      return Promise.resolve("next");
    });
    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("next");
    await expect(gate.run(() => Promise.reject(new Error("failed")))).rejects.toThrow("failed");
    await expect(gate.run(() => Promise.resolve("after-failure"))).resolves.toBe("after-failure");
    expect(order).toEqual(["first", "second"]);
  });
});
