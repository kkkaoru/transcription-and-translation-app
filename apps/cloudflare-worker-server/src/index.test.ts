import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AZOOKEY_MAX_TEXT_BYTES,
  AZOOKEY_MODE,
  AZOOKEY_PROTOCOL,
  AZOOKEY_WS_PATH,
  BROWSER_VIBRATO_MODE,
} from "./azookey.js";
import { createWorker, type Env, type WorkerHandler } from "./index.js";
import { WORKERS_AI_ASR_MODEL, type WorkersAiAsrRun } from "./workers-ai-asr.js";

const VIBRATO_DICTIONARY_PATH = "/vibrato/system.dic.zst";
const AZOOKEY_DICTIONARY_PATH = "/azookey/system.azkdict.gz";

const env = {
  CORS_ORIGIN: "https://captions.example.com",
  MODEL_ROUTES: JSON.stringify({
    "hy-mt2-1.8b-gguf": { baseUrl: "https://models.example.com", servedModel: "hy-live" },
  }),
};

type WorkerRequest = Parameters<WorkerHandler["fetch"]>[0];

const asWorkerRequest = (request: unknown): WorkerRequest => request as WorkerRequest;

const wav = (): File => {
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
  return new File([bytes], "caption.wav", { type: "audio/wav" });
};

const transcriptionRequest = (): Request => {
  const form = new FormData();
  form.set("model", "parapper-ja");
  form.set("language", "ja");
  form.set("file", wav());
  return new Request("https://worker.example/v1/audio/transcriptions", {
    method: "POST",
    body: form,
  });
};

describe("Cloudflare Worker inference adapter", () => {
  it("exposes the versioned AzooKey comparison contract and CORS metadata", async () => {
    const response = await createWorker().fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(env.CORS_ORIGIN);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      protocol: AZOOKEY_PROTOCOL,
      model: "azookey-rust-wasm",
      websocketPath: AZOOKEY_WS_PATH,
      maxTextBytes: AZOOKEY_MAX_TEXT_BYTES,
      modes: { worker: AZOOKEY_MODE, browser: BROWSER_VIBRATO_MODE },
    });

    const authenticated = await createWorker().fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      { ...env, AZOOKEY_API_TOKEN: " worker-secret " },
    );
    await expect(authenticated.json()).resolves.toMatchObject({
      auth: { configured: true },
    });

    const wasmDictionary = await createWorker().fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      {
        ...env,
        VIBRATO_DICTIONARY_URL: "https://dictionary.example/system.dic.zst",
      },
    );
    await expect(wasmDictionary.json()).resolves.toMatchObject({
      vibrato: {
        workerStage: "configured",
        transport: "wasm",
        contract: "Vibrato reading pre-pass",
      },
    });

    const portableDictionary = await createWorker().fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      { ...env, AZOOKEY_DICTIONARY_URL: AZOOKEY_DICTIONARY_PATH },
    );
    await expect(portableDictionary.json()).resolves.toMatchObject({
      dictionary: { configured: true, transport: "portable-wasm" },
      vibrato: { workerStage: "passthrough", transport: "azookey-mixed-input" },
    });
  });

  it("serves the Worker-hosted Vibrato dictionary through the assets binding", async () => {
    const assets = {
      fetch: vi.fn((request: Request) => {
        expect(new URL(request.url).pathname).toBe(VIBRATO_DICTIONARY_PATH);
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "application/zstd" },
          }),
        );
      }),
    };
    const response = await createWorker().fetch(
      new Request(`https://worker.example${VIBRATO_DICTIONARY_PATH}`),
      { ...env, ASSETS: assets },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/zstd");
    await expect(response.arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(assets.fetch).toHaveBeenCalledTimes(1);
  });

  it("serves the official portable AzooKey archive through the assets binding", async () => {
    const archive = new Uint8Array([31, 139, 8, 0]);
    const assets = {
      fetch: vi.fn((request: Request) => {
        expect(new URL(request.url).pathname).toBe(AZOOKEY_DICTIONARY_PATH);
        return Promise.resolve(
          new Response(archive, {
            status: 200,
            headers: { "content-type": "application/gzip" },
          }),
        );
      }),
    };
    const response = await createWorker().fetch(
      new Request(`https://worker.example${AZOOKEY_DICTIONARY_PATH}`),
      { ...env, ASSETS: assets },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/gzip");
    await expect(response.arrayBuffer()).resolves.toEqual(archive.buffer);
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it("routes Worker Vibrato warmup through the assets binding", async () => {
    class TestSocket extends EventTarget {
      readonly sent: string[] = [];

      accept(): void {}

      send(message: string): void {
        this.sent.push(message);
      }
    }

    const server = new TestSocket();
    const client = new TestSocket() as unknown as WebSocket;
    const assets = {
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response(readFileSync(new URL("../public/vibrato/system.dic.zst", import.meta.url))),
        ),
      ),
    };
    const vibratoWasmModule = new WebAssembly.Module(
      readFileSync(new URL("../wasm/vibrato_wasm_bg.wasm", import.meta.url)),
    );
    const response = await createWorker(undefined, {
      converter: (text) => text,
      vibratoWasmModule,
      socketPair: () => ({ client, server: server as unknown as WebSocket }),
    }).fetch(
      new Request(`https://worker.example${AZOOKEY_WS_PATH}`, {
        headers: { upgrade: "websocket" },
      }),
      { ...env, ASSETS: assets, VIBRATO_DICTIONARY_URL: VIBRATO_DICTIONARY_PATH },
    );
    expect(response.status).toBe(101);
    expect(assets.fetch).toHaveBeenCalledTimes(1);
    expect(server.sent[0]).toContain('"type":"azookey.ready"');
  });

  it("shares one portable AzooKey asset and Wasm instance across request origins", async () => {
    class TestSocket extends EventTarget {
      readonly sent: string[] = [];

      accept(): void {}

      send(message: string): void {
        this.sent.push(message);
      }
    }

    const dictionary = readFileSync(
      new URL("../public/azookey/system.azkdict.gz", import.meta.url),
    );
    const assets = {
      fetch: vi.fn((request: Request) => {
        expect(new URL(request.url).pathname).toBe(AZOOKEY_DICTIONARY_PATH);
        return Promise.resolve(new Response(dictionary));
      }),
    };
    const wasmModule = new WebAssembly.Module(
      readFileSync(new URL("../wasm/azookey.wasm", import.meta.url)),
    );
    const servers: TestSocket[] = [];
    const worker = createWorker(undefined, {
      wasmModule,
      socketPair: () => {
        const server = new TestSocket();
        servers.push(server);
        return {
          client: new TestSocket() as unknown as WebSocket,
          server: server as unknown as WebSocket,
        };
      },
    });
    for (const host of ["worker.example", "captions.example.com"]) {
      const response = await worker.fetch(
        new Request(`https://${host}${AZOOKEY_WS_PATH}`, { headers: { upgrade: "websocket" } }),
        { ...env, ASSETS: assets, AZOOKEY_DICTIONARY_URL: AZOOKEY_DICTIONARY_PATH },
      );
      expect(response.status).toBe(101);
    }
    expect(assets.fetch).toHaveBeenCalledTimes(1);
    expect(servers).toHaveLength(2);
    for (const server of servers) {
      expect(JSON.parse(server.sent[0] ?? "{}")).toMatchObject({
        type: "azookey.ready",
        vibrato: { workerStage: "passthrough" },
      });
    }
  }, 20_000);

  it("rejects non-GET metadata requests and non-upgrade WebSocket requests", async () => {
    const worker = createWorker();
    const method = await worker.fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey", { method: "POST" })),
      env,
    );
    expect(method.status).toBe(405);
    await expect(method.json()).resolves.toMatchObject({
      error: { code: "method_not_allowed" },
    });

    const upgrade = await worker.fetch(
      asWorkerRequest(new Request(`https://worker.example${AZOOKEY_WS_PATH}`)),
      env,
    );
    expect(upgrade.status).toBe(426);
    await expect(upgrade.json()).resolves.toMatchObject({
      error: { code: "upgrade_required" },
    });
  });

  it("upgrades AzooKey sockets with injected runtime dependencies", async () => {
    class TestSocket extends EventTarget {
      readonly sent: string[] = [];

      accept(): void {}

      send(message: string): void {
        this.sent.push(message);
      }
    }

    const client = new TestSocket() as unknown as WebSocket;
    const server = new TestSocket();
    const response = await createWorker(undefined, {
      converter: (text) => `converted:${text}`,
      socketPair: () => ({ client, server: server as unknown as WebSocket }),
    }).fetch(
      new Request(`https://worker.example${AZOOKEY_WS_PATH}`, {
        headers: { upgrade: "websocket" },
      }),
      env,
    );

    expect(response.status).toBe(101);
    expect(server.sent[0]).toContain('"type":"azookey.ready"');
  });

  it("proxies only configured chat models with CORS protection", async () => {
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "hy-live", top_k: 20 });
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] })),
      );
    });
    const response = await createWorker(fetcher).fetch(
      new Request("https://worker.example/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "hy-mt2-1.8b-gguf", messages: [] }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(env.CORS_ORIGIN);
    await expect(response.json()).resolves.toEqual({
      choices: [{ message: { content: "hello" } }],
    });
  });

  it("keeps ASR unavailable until an explicit HTTPS upstream is configured", async () => {
    const form = new FormData();
    form.set("model", "parapper-ja");
    form.set("file", new File([new Uint8Array(44)], "caption.wav", { type: "audio/wav" }));
    const response = await createWorker().fetch(
      new Request("https://worker.example/v1/audio/transcriptions", { method: "POST", body: form }),
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_audio" } });
  });

  it("forwards valid audio to the configured upstream and preserves CORS headers", async () => {
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ authorization: "Bearer test-token" });
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("parapper-ja");
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      expect((file as File).type).toBe("audio/wav");
      expect((file as File).size).toBe(46);
      return new Response(JSON.stringify({ text: "明日の天気は晴れ" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const response = await createWorker(fetcher).fetch(transcriptionRequest(), {
      ...env,
      ASR_API_TOKEN: "test-token",
      ASR_UPSTREAM_URL: "https://asr.example/v1/audio/transcriptions",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(env.CORS_ORIGIN);
    await expect(response.json()).resolves.toEqual({ text: "明日の天気は晴れ", language: "ja" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://asr.example/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses Workers AI Nova-3 only when ASR_PROVIDER explicitly opts in", async () => {
    const workersAiRun: WorkersAiAsrRun = vi.fn((model, input) => {
      expect(model).toBe(WORKERS_AI_ASR_MODEL);
      expect(input.language).toBe("ja");
      return Promise.resolve({
        results: {
          channels: [{ alternatives: [{ transcript: "Workers AI の文字起こし" }] }],
        },
      });
    });
    const upstream = vi.fn(() => {
      throw new Error("the opt-in path must not call the upstream");
    });
    const response = await createWorker(upstream, { workersAiRun }).fetch(transcriptionRequest(), {
      ...env,
      ASR_PROVIDER: " Workers-AI ",
      ASR_UPSTREAM_URL: "https://asr.example/transcribe",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(env.CORS_ORIGIN);
    await expect(response.json()).resolves.toEqual({
      text: "Workers AI の文字起こし",
      language: "ja",
    });
    expect(workersAiRun).toHaveBeenCalledTimes(1);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps the Workers AI provider unavailable without an AI binding or test seam", async () => {
    const response = await createWorker().fetch(transcriptionRequest(), {
      ...env,
      ASR_PROVIDER: "workers-ai",
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "asr_workers_ai_unavailable" },
    });
  });

  it("adapts a real-shaped AI binding while keeping the provider opt-in", async () => {
    const bindingRun = vi.fn((model: string, input: Record<string, unknown>) => {
      expect(model).toBe(WORKERS_AI_ASR_MODEL);
      const audio = input["audio"] as { body?: unknown; contentType?: unknown };
      expect(typeof audio.body).toBe("string");
      expect(audio.contentType).toBe("audio/wav");
      return Promise.resolve({
        results: { channels: [{ alternatives: [{ transcript: "AI binding" }] }] },
      });
    });
    const ai = { run: bindingRun } as unknown as NonNullable<Env["AI"]>;
    const response = await createWorker().fetch(transcriptionRequest(), {
      ...env,
      AI: ai,
      ASR_PROVIDER: "workers-ai",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ text: "AI binding", language: "ja" });
    expect(bindingRun).toHaveBeenCalledTimes(1);
  });

  it("does not invoke an available AI binding when the provider flag is unset", async () => {
    const bindingRun = vi.fn(() => Promise.resolve({ results: {} }));
    const ai = { run: bindingRun } as unknown as NonNullable<Env["AI"]>;
    const response = await createWorker().fetch(transcriptionRequest(), { ...env, AI: ai });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "asr_unavailable" } });
    expect(bindingRun).not.toHaveBeenCalled();
  });

  it("maps upstream connection, status, and payload failures to stable ASR errors", async () => {
    const request = transcriptionRequest();
    const configured = { ...env, ASR_UPSTREAM_URL: "https://asr.example/transcribe" };

    const connection = await createWorker(() => {
      throw new Error("upstream offline");
    }).fetch(asWorkerRequest(request.clone()), configured);
    expect(connection.status).toBe(502);
    await expect(connection.json()).resolves.toMatchObject({
      error: { code: "asr_connection_failed", message: "upstream offline" },
    });

    const failed = await createWorker(async () => new Response("busy", { status: 429 })).fetch(
      asWorkerRequest(request.clone()),
      configured,
    );
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({ error: { code: "asr_upstream_failed" } });

    const malformed = await createWorker(async () => new Response(JSON.stringify({}))).fetch(
      asWorkerRequest(request.clone()),
      configured,
    );
    expect(malformed.status).toBe(502);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "asr_invalid_response" },
    });

    const nonErrorConnection = await createWorker(() => {
      throw "upstream offline";
    }).fetch(asWorkerRequest(request.clone()), configured);
    expect(nonErrorConnection.status).toBe(502);
    await expect(nonErrorConnection.json()).resolves.toMatchObject({
      error: { code: "asr_connection_failed", message: "connection failed" },
    });
  });

  it("returns a service-unavailable response for valid audio without an upstream", async () => {
    const response = await createWorker().fetch(asWorkerRequest(transcriptionRequest()), {
      MODEL_ROUTES: env.MODEL_ROUTES,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ error: { code: "asr_unavailable" } });
  });

  it("turns an upstream JSON decoding failure into an internal error", async () => {
    const response = await createWorker(async () => new Response("not-json")).fetch(
      asWorkerRequest(transcriptionRequest()),
      { ...env, ASR_UPSTREAM_URL: "https://asr.example/transcribe" },
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "internal_error" } });
  });

  it("uses a safe fallback message for non-Error configuration failures", async () => {
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "configuration parse failed";
    });
    try {
      const response = await createWorker().fetch(
        new Request("https://worker.example/health"),
        env,
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_configuration", message: "invalid Worker configuration" },
      });
    } finally {
      parse.mockRestore();
    }
  });

  it("rejects malformed model route configuration and handles preflight", async () => {
    const worker = createWorker();
    const invalid = await worker.fetch(new Request("https://worker.example/health"), {
      ...env,
      MODEL_ROUTES: "not-json",
    });
    expect(invalid.status).toBe(500);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "invalid_configuration" },
    });
    const preflight = await worker.fetch(
      new Request("https://worker.example/v1/chat/completions", { method: "OPTIONS" }),
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(env.CORS_ORIGIN);
  });
});
