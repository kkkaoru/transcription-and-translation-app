// This file runs with bun.
import { readFileSync } from "node:fs";
import { createMemoryUserLexicon, pcm16ToWav } from "@caption-bridge/inference-server-core";
import { describe, expect, it, vi } from "vitest";
import {
  AZOOKEY_MAX_TEXT_BYTES,
  AZOOKEY_MODE,
  AZOOKEY_PROTOCOL,
  AZOOKEY_WS_PATH,
  AzookeyProtocolError,
  BROWSER_VIBRATO_MODE,
} from "./azookey.js";
import { createWorker, type Env, isCompiledWasmModule, type WorkerHandler } from "./index.js";
import type { ProfileConversionResult } from "./profile-converter-do.js";
import {
  WORKERS_AI_ASR_HTTP_PATH,
  WORKERS_AI_ASR_MODEL,
  type WorkersAiAsrRun,
} from "./workers-ai-asr.js";
import { WORKERS_AI_SPEECH_PIPELINE_PATH } from "./workers-ai-speech-pipeline.js";

const VIBRATO_DICTIONARY_PATH = "/vibrato/system.dic.zst";
const VIBRATO_NOTICE_PATH = "/vibrato/NOTICE";
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

const speechWav = (): File => {
  const samples = Int16Array.from({ length: 2048 }, (_, index) =>
    index % 2 === 0 ? 20_000 : -20_000,
  );
  return new File([pcm16ToWav(new Uint8Array(samples.buffer))], "caption.wav", {
    type: "audio/wav",
  });
};

const transcriptionRequest = (headers?: HeadersInit, file: File = wav()): Request => {
  const form = new FormData();
  form.set("model", "parapper-ja");
  form.set("language", "ja");
  form.set("file", file);
  return new Request("https://worker.example/v1/audio/transcriptions", {
    method: "POST",
    ...(headers ? { headers } : {}),
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
      dictionary: {
        fetchTimeoutMs: 10_000,
        kind: "system",
        configKey: "azookey-rust",
        warmMoment: "websocket-upgrade",
      },
      vibrato: { kind: "vibrato-ipadic", warmMoment: "websocket-upgrade" },
      modes: { worker: AZOOKEY_MODE, browser: BROWSER_VIBRATO_MODE },
    });

    const authenticated = await createWorker().fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      { ...env, AZOOKEY_API_TOKEN: " worker-secret " },
    );
    await expect(authenticated.json()).resolves.toMatchObject({
      auth: { configured: true },
    });

    const malformedModelRoutes = await createWorker().fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      { ...env, MODEL_ROUTES: "not-json" },
    );
    await expect(malformedModelRoutes.json()).resolves.toMatchObject({
      models: ["azookey-rust-wasm"],
    });

    const liveZenzCatalog = await createWorker().fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      {
        ...env,
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.example" },
        }),
      },
    );
    await expect(liveZenzCatalog.json()).resolves.toMatchObject({
      models: ["azookey-rust-wasm", "zenz-v3.2-small-gguf"],
    });

    const emptyBaseUrlCatalog = await createWorker().fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      {
        ...env,
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-small-gguf": { baseUrl: "   " },
        }),
      },
    );
    await expect(emptyBaseUrlCatalog.json()).resolves.toMatchObject({
      models: ["azookey-rust-wasm"],
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
      {
        ...env,
        AZOOKEY_DICTIONARY_URL: AZOOKEY_DICTIONARY_PATH,
        AZOOKEY_DICTIONARY_TIMEOUT_MS: "1100",
      },
    );
    await expect(portableDictionary.json()).resolves.toMatchObject({
      dictionary: { configured: true, transport: "portable-wasm", fetchTimeoutMs: 1_100 },
      vibrato: { workerStage: "passthrough", transport: "azookey-mixed-input" },
    });

    const portableAndVibrato = await createWorker().fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      {
        ...env,
        AZOOKEY_DICTIONARY_URL: AZOOKEY_DICTIONARY_PATH,
        VIBRATO_DICTIONARY_URL: VIBRATO_DICTIONARY_PATH,
      },
    );
    await expect(portableAndVibrato.json()).resolves.toMatchObject({
      dictionary: { configured: true, transport: "portable-wasm" },
      vibrato: {
        workerStage: "configured",
        transport: "wasm",
        contract: "Vibrato reading pre-pass",
      },
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

  it("serves the bundled Vibrato attribution notices through the assets binding", async () => {
    const assets = {
      fetch: vi.fn((request: Request) => {
        expect(new URL(request.url).pathname).toBe(VIBRATO_NOTICE_PATH);
        return Promise.resolve(new Response("IPADIC notice", { status: 200 }));
      }),
    };
    const response = await createWorker().fetch(
      new Request(`https://worker.example${VIBRATO_NOTICE_PATH}`),
      { ...env, ASSETS: assets },
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("IPADIC notice");
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it("brand-checks a compiled WASM module without relying on realm identity", () => {
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(isCompiledWasmModule(module)).toBe(true);
  });

  it("skips isolate warmup when an injected wasm value is not a module", async () => {
    const dependencies = Object.defineProperty({}, "wasmModule", { value: 1 });
    const response = await createWorker(undefined, dependencies).fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      env,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(200);
  });

  it("schedules isolate wasm warmup on GET /v1/azookey without blocking the response", async () => {
    const scheduled: Promise<unknown>[] = [];
    const warmupChannels: unknown[] = [];
    const warmup = (wsOrHttp?: unknown): Promise<void> => {
      warmupChannels.push(wsOrHttp);
      return Promise.resolve();
    };
    const converter = Object.assign((text: string) => text, { warmup });
    const wasmModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const response = await createWorker(undefined, { converter, wasmModule }).fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      env,
      {
        waitUntil: (promise) => {
          scheduled.push(promise);
        },
      },
    );
    expect(response.status).toBe(200);
    expect(scheduled).toHaveLength(1);
    const queued = scheduled[0];
    if (!queued) {
      throw new Error("waitUntil was not scheduled");
    }
    await queued;
    expect(warmupChannels).toStrictEqual(["http"]);
  });

  it("warms configured Zenz /health during GET /v1/azookey isolate warmup", async () => {
    const scheduled: Promise<unknown>[] = [];
    const healthUrls: string[] = [];
    const warmup = (): Promise<void> => Promise.resolve();
    const converter = Object.assign((text: string) => text, { warmup });
    const wasmModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const fetcher = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      healthUrls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    };
    const response = await createWorker(fetcher, { converter, wasmModule }).fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      {
        ...env,
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.example" },
        }),
      },
      {
        waitUntil: (promise) => {
          scheduled.push(promise);
        },
      },
    );
    expect(response.status).toBe(200);
    const queued = scheduled[0];
    if (!queued) {
      throw new Error("waitUntil was not scheduled");
    }
    await queued;
    expect(healthUrls).toStrictEqual(["https://zenz.example/health"]);
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
      fetch: vi.fn((request: Request) => {
        expect(new URL(request.url).origin).toBe("https://worker.example");
        return Promise.resolve(
          new Response(
            readFileSync(
              new URL("../../../assets/vibrato/ipadic-mecab-2_7_0/system.dic.zst", import.meta.url),
            ),
          ),
        );
      }),
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
    const assetOrigins: string[] = [];
    const assets = {
      fetch: vi.fn((request: Request) => {
        expect(new URL(request.url).pathname).toBe(AZOOKEY_DICTIONARY_PATH);
        assetOrigins.push(new URL(request.url).origin);
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
    expect(assetOrigins).toEqual(["https://worker.example"]);
    expect(servers).toHaveLength(2);
    for (const server of servers) {
      expect(JSON.parse(server.sent[0] ?? "{}")).toMatchObject({
        type: "azookey.ready",
        vibrato: { workerStage: "passthrough" },
      });
    }
  }, 20_000);

  it("maps unexpected AzooKey runtime errors to an internal response", async () => {
    const response = await createWorker(undefined, {
      converter: (text) => text,
      socketPair: () => {
        throw new Error("WebSocket runtime is unavailable");
      },
    }).fetch(
      new Request(`https://worker.example${AZOOKEY_WS_PATH}`, {
        headers: { upgrade: "websocket" },
      }),
      env,
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe(env.CORS_ORIGIN);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "azookey_runtime_failed", message: "AzooKey runtime is unavailable" },
    });
  });

  it("keeps configured Worker Vibrato metadata consistent with the ready envelope", async () => {
    class TestSocket extends EventTarget {
      readonly sent: string[] = [];

      accept(): void {}

      send(message: string): void {
        this.sent.push(message);
      }
    }

    const server = new TestSocket();
    const worker = createWorker(undefined, {
      converter: (text) => text,
      vibratoConverter: (text) => text,
      socketPair: () => ({
        client: new TestSocket() as unknown as WebSocket,
        server: server as unknown as WebSocket,
      }),
    });
    const configured = { ...env, VIBRATO_UPSTREAM_URL: "https://vibrato.example/convert" };
    const metadata = await worker.fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey")),
      configured,
    );
    const upgrade = await worker.fetch(
      new Request(`https://worker.example${AZOOKEY_WS_PATH}`, {
        headers: { upgrade: "websocket" },
      }),
      configured,
    );

    expect(upgrade.status).toBe(101);
    const metadataBody = (await metadata.json()) as { vibrato: { workerStage: string } };
    const readyBody = JSON.parse(server.sent[0] ?? "{}") as { vibrato: { workerStage: string } };
    expect(metadataBody.vibrato.workerStage).toBe("configured");
    expect(readyBody.vibrato.workerStage).toBe(metadataBody.vibrato.workerStage);
  });

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

  it("forwards correlation headers to ASR and chat upstreams and advertises them in CORS", async () => {
    const correlation = {
      "x-request-id": "worker-request-1",
      "x-session-id": "worker-session-1",
      "x-agent-id": "worker-agent-1",
      "x-parent-agent-id": "worker-parent-1",
    };
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(correlation)) {
        expect(headers.get(name)).toBe(value);
      }
      if (headers.get("authorization")) {
        expect(headers.get("authorization")).toBe("Bearer worker-token");
      }
      return Promise.resolve(new Response(JSON.stringify({ text: "correlated" })));
    });
    const worker = createWorker(fetcher);
    const asr = await worker.fetch(transcriptionRequest(correlation), {
      ...env,
      ASR_API_TOKEN: "worker-token",
      ASR_UPSTREAM_URL: "https://asr.example/transcribe",
    });
    expect(asr.status).toBe(200);
    await expect(asr.json()).resolves.toMatchObject({ text: "correlated" });

    const chat = await worker.fetch(
      new Request("https://worker.example/v1/chat/completions", {
        method: "POST",
        headers: { ...correlation, "content-type": "application/json" },
        body: JSON.stringify({ model: "hy-mt2-1.8b-gguf", messages: [] }),
      }),
      env,
    );
    expect(chat.status).toBe(200);
    await expect(chat.json()).resolves.toEqual({ text: "correlated" });

    const preflight = await worker.fetch(
      new Request("https://worker.example/v1/chat/completions", {
        method: "OPTIONS",
        headers: {
          origin: env.CORS_ORIGIN,
          "access-control-request-headers":
            "content-type, x-request-id, x-session-id, x-agent-id, x-parent-agent-id",
        },
      }),
      env,
    );
    expect(preflight.status).toBe(204);
    const allowedHeaders = preflight.headers.get("access-control-allow-headers") ?? "";
    for (const name of Object.keys(correlation)) {
      expect(allowedHeaders).toContain(name);
    }
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
    const response = await createWorker(upstream, { workersAiRun }).fetch(
      transcriptionRequest(undefined, speechWav()),
      {
        ...env,
        ASR_PROVIDER: " Workers-AI ",
        ASR_UPSTREAM_URL: "https://asr.example/transcribe",
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(env.CORS_ORIGIN);
    await expect(response.json()).resolves.toEqual({
      text: "Workers AI の文字起こし",
      language: "ja",
    });
    expect(workersAiRun).toHaveBeenCalledTimes(1);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("runs Nova-3 STT and AzooKey conversion through one Worker request", async () => {
    const workersAiRun: WorkersAiAsrRun = vi.fn(() =>
      Promise.resolve({
        results: { channels: [{ alternatives: [{ transcript: "きょうはいいてんき" }] }] },
      }),
    );
    const converter = vi.fn(() => Promise.resolve("今日はいい天気"));
    const form = new FormData();
    form.set("file", speechWav());
    form.set("language", "ja");
    form.set("segmentation", "client-silero-v1");
    form.set("conversionModel", "zenz-v3.2-small-gguf");
    form.set("computeTier", "standard");
    form.set("containerModel", "small");
    form.set("n5Lm", "off");

    const response = await createWorker(
      vi.fn(() => Response.json({ content: "今日はいい天気" })),
      {
        workersAiRun,
        converter,
        vibratoConverter: (text) => text,
      },
    ).fetch(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      {
        ...env,
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.example" },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "きょうはいいてんき",
      convertedText: "今日はいい天気",
      pipeline: "workers-ai-profiled-azookey-v4",
      segmentation: "client-silero-v1",
    });
    expect(converter).toHaveBeenCalledWith(
      "きょうはいいてんき",
      expect.any(AbortSignal),
      undefined,
    );
  });

  it("routes selected conversion through a warm profile Durable Object", async () => {
    const workersAiRun: WorkersAiAsrRun = vi.fn(() =>
      Promise.resolve({
        results: { channels: [{ alternatives: [{ transcript: "きょうはいいてんき" }] }] },
      }),
    );
    const convertProfile = vi.fn(
      (): Promise<ProfileConversionResult> =>
        Promise.resolve({
          text: "今日はいい天気",
          model: "zenz-v3.2-small-gguf",
          usedCompletion: true,
        }),
    );
    const idFromName = vi.fn(() => ({ toString: () => "profile-standard-small" }));
    const get = vi.fn(() => ({
      warmProfile: vi.fn(() => Promise.resolve()),
      rescoreProfile: vi.fn(() => Promise.resolve({ text: "", elapsedMs: 0 })),
      convertProfile,
    }));
    const form = new FormData();
    form.set("file", speechWav());
    form.set("language", "ja");
    form.set("segmentation", "client-silero-v1");
    form.set("conversionModel", "zenz-v3.2-small-gguf");
    form.set("computeTier", "standard");
    form.set("containerModel", "small");
    form.set("n5Lm", "off");
    form.set("leftContext", "前文");

    const response = await createWorker(vi.fn(), {
      workersAiRun,
      converter: vi.fn(() => "unused"),
      vibratoConverter: (text) => text,
    }).fetch(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      {
        ...env,
        AZOOKEY_PROFILE_DO: "on",
        PROFILE_CONVERTER: { idFromName, get },
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.internal" },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      convertedText: "今日はいい天気",
      usedCompletion: true,
    });
    expect(idFromName).toHaveBeenCalledWith("standard:small:off");
    expect(convertProfile).toHaveBeenCalledWith({
      text: "きょうはいいてんき",
      model: "zenz-v3.2-small-gguf",
      leftContext: "前文",
      baseUrl: "https://zenz.internal/standard/small/n5-off",
      timeoutMs: 4500,
      zenzUpstreamMaxMs: 3500,
      zenzNPredict: 8,
      fallbackTimeoutMs: 3000,
      useUserLexicon: true,
    });
  });

  it("runs the basic N5 profile with deferred dictionary materialization", async () => {
    const workersAiRun: WorkersAiAsrRun = vi.fn(() =>
      Promise.resolve({
        results: { channels: [{ alternatives: [{ transcript: "おはよございます" }] }] },
      }),
    );
    const converter = vi.fn(() => Promise.resolve("おはようございます"));
    const release = vi.fn();
    const vibratoConverter = Object.assign((text: string) => text, { release });
    const upstream = vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.endsWith("/n5/rescore")
        ? Response.json({ text: "おはようございます", elapsedMs: 12.5 })
        : Response.json({ content: "おはようございます" });
    });
    const form = new FormData();
    form.set("file", speechWav());
    form.set("language", "ja");
    form.set("segmentation", "client-silero-v1");
    form.set("conversionModel", "zenz-v3.2-xsmall-gguf");
    form.set("computeTier", "basic");
    form.set("containerModel", "xsmall");
    form.set("n5Lm", "on");
    form.set("leftContext", "前文");

    const response = await createWorker(upstream, {
      workersAiRun,
      converter,
      vibratoConverter,
    }).fetch(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      {
        ...env,
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-xsmall-gguf": { baseUrl: "https://zenz.internal" },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      containerProfile: { computeTier: "basic", modelSize: "xsmall", n5Mode: "on" },
      logs: [
        { stage: "asr" },
        { stage: "vibrato" },
        { stage: "n5_lm", elapsedMs: 12.5 },
        { stage: "azookey" },
      ],
    });
    expect(release).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledWith(
      "https://zenz.internal/basic/xsmall/n5-on/n5/rescore",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns the dictionary baseline when the bounded selected conversion times out", async () => {
    const converter = vi
      .fn()
      .mockRejectedValueOnce(new AzookeyProtocolError("conversion_timeout", "conversion timed out"))
      .mockResolvedValue("今日はいい天気");
    const form = new FormData();
    form.set("file", speechWav());
    form.set("language", "ja");
    form.set("segmentation", "client-silero-v1");
    form.set("conversionModel", "zenz-v3.2-xsmall-gguf");
    form.set("computeTier", "standard");
    form.set("containerModel", "xsmall");
    form.set("n5Lm", "off");
    const responsePromise = createWorker(vi.fn(), {
      workersAiRun: vi.fn(() =>
        Promise.resolve({
          results: { channels: [{ alternatives: [{ transcript: "きょうはいいてんき" }] }] },
        }),
      ),
      converter,
      vibratoConverter: (text) => text,
    }).fetch(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      {
        ...env,
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-xsmall-gguf": { baseUrl: "https://zenz.internal" },
        }),
      },
    );

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      convertedText: "今日はいい天気",
      usedCompletion: false,
      modelFallback: "upstream-failed",
    });
    expect(converter).toHaveBeenCalledTimes(2);
  });

  it("applies the stored lexicon converter contract in the single-Worker pipeline", async () => {
    const workersAiRun: WorkersAiAsrRun = vi.fn(() =>
      Promise.resolve({
        results: { channels: [{ alternatives: [{ transcript: "ぶいあーるちゃっと" }] }] },
      }),
    );
    const convertWithContext = vi.fn(() => Promise.resolve("VRChat"));
    const converter = Object.assign(
      vi.fn(() => Promise.resolve("unused")),
      {
        dictionaryRevision: "revision-1",
        syncUserLexicon: () => Promise.resolve(1),
        convertWithContext,
      },
    );
    const form = new FormData();
    form.set("file", speechWav());
    form.set("language", "ja");
    form.set("segmentation", "client-silero-v1");
    form.set("conversionModel", "zenz-v3.2-small-gguf");
    form.set("computeTier", "standard");
    form.set("containerModel", "small");
    form.set("n5Lm", "off");

    const response = await createWorker(
      vi.fn(() => Response.json({ content: "VRChat" })),
      {
        workersAiRun,
        converter,
        vibratoConverter: (text) => text,
      },
    ).fetch(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      {
        ...env,
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.example" },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ convertedText: "VRChat" });
    expect(convertWithContext).toHaveBeenCalledWith(
      "ぶいあーるちゃっと",
      expect.any(AbortSignal),
      undefined,
      1,
    );
  });

  it("skips AzooKey warm-up when the capability route selects no GGUF", async () => {
    const warmup = vi.fn(() => Promise.resolve());
    const converter = Object.assign(
      vi.fn(() => Promise.resolve("変換")),
      { warmup },
    );
    const waitUntil = vi.fn();

    const response = await createWorker(vi.fn(), {
      converter,
      vibratoConverter: (text) => text,
    }).fetch(
      new Request(
        `https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}?conversionModel=none&computeTier=standard&containerModel=xsmall&n5Lm=off`,
      ),
      env,
      { waitUntil },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      ok: true,
      pipeline: "workers-ai-profiled-azookey-v4",
      conversionModel: "none",
      containerProfile: { computeTier: "standard", modelSize: "xsmall", n5Mode: "off" },
    });
    expect(warmup).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("wakes the selected private Zenz Container before speech", async () => {
    const containerFetch = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ status: "ok" }),
    );
    const response = await createWorker(undefined, {
      converter: Object.assign(
        vi.fn(() => Promise.resolve("変換")),
        {
          warmup: vi.fn(() => Promise.resolve()),
        },
      ),
      vibratoConverter: Object.assign((text: string) => text, {
        warmup: vi.fn(() => Promise.resolve()),
      }),
    }).fetch(
      new Request(
        `https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}?conversionModel=zenz-v3.2-xsmall-gguf&computeTier=standard&containerModel=xsmall&n5Lm=on`,
      ),
      {
        ...env,
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-xsmall-gguf": { baseUrl: "https://zenz.internal" },
        }),
        ZENZ_GGUF: { fetch: containerFetch },
      },
    );

    expect(response.status).toBe(200);
    expect(containerFetch).toHaveBeenCalledTimes(1);
    const input = containerFetch.mock.calls[0]?.[0];
    expect(input).toBeInstanceOf(Request);
    expect(input instanceof Request ? input.url : String(input)).toBe(
      "https://zenz.internal/standard/xsmall/n5-on/warmup",
    );
  });

  it("warms only N5 when GGUF conversion is disabled", async () => {
    const containerFetch = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ status: "ok" }),
    );
    const response = await createWorker(undefined, {
      converter: vi.fn(() => Promise.resolve("変換")),
      vibratoConverter: (text) => text,
    }).fetch(
      new Request(
        `https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}?conversionModel=none&computeTier=basic&containerModel=xsmall&n5Lm=on`,
      ),
      {
        ...env,
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-xsmall-gguf": { baseUrl: "https://zenz.internal" },
        }),
        ZENZ_GGUF: { fetch: containerFetch },
      },
    );

    expect(response.status).toBe(200);
    expect(containerFetch).toHaveBeenCalledTimes(1);
    const input = containerFetch.mock.calls[0]?.[0];
    expect(input instanceof Request ? input.url : String(input)).toBe(
      "https://zenz.internal/basic/xsmall/n5-on/n5-warmup",
    );
  });

  it("releases selected profiles and avoids a Container call when processing is off", async () => {
    const containerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "busy" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const worker = createWorker(undefined, {
      converter: vi.fn(() => Promise.resolve("変換")),
      vibratoConverter: (text) => text,
    });
    const noContainer = await worker.fetch(
      new Request(
        `https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}?conversionModel=none&computeTier=basic&containerModel=xsmall&n5Lm=off`,
        { method: "DELETE" },
      ),
      env,
    );
    expect(noContainer.status).toBe(200);
    expect(containerFetch).not.toHaveBeenCalled();

    const releaseUrl = `https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}?conversionModel=zenz-v3.2-small-gguf&computeTier=basic&containerModel=small&n5Lm=on`;
    const failed = await worker.fetch(new Request(releaseUrl, { method: "DELETE" }), {
      ...env,
      MODEL_ROUTES: JSON.stringify({
        "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.internal" },
      }),
      ZENZ_GGUF: { fetch: containerFetch },
    });
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: "container_release_failed" },
    });

    const released = await worker.fetch(new Request(releaseUrl, { method: "DELETE" }), {
      ...env,
      MODEL_ROUTES: JSON.stringify({
        "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.internal" },
      }),
      ZENZ_GGUF: { fetch: containerFetch },
    });
    expect(released.status).toBe(200);
    const releaseInput = containerFetch.mock.calls[1]?.[0];
    expect(releaseInput instanceof Request ? releaseInput.url : String(releaseInput)).toBe(
      "https://zenz.internal/basic/small/n5-on/release",
    );
  });

  it("rejects invalid, unavailable, and unhealthy Container warm-ups", async () => {
    const converter = Object.assign(
      vi.fn(() => Promise.resolve("変換")),
      {
        warmup: vi.fn(() => Promise.resolve()),
      },
    );
    const worker = createWorker(undefined, {
      converter,
      vibratoConverter: (text) => text,
    });
    const invalid = await worker.fetch(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}?conversionModel=other`),
      env,
    );
    expect(invalid.status).toBe(400);

    const unavailable = await worker.fetch(
      new Request(
        `https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}?conversionModel=zenz-v3.2-small-gguf&computeTier=standard&containerModel=small&n5Lm=off`,
      ),
      env,
    );
    expect(unavailable.status).toBe(503);

    const unhealthy = await worker.fetch(
      new Request(
        `https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}?conversionModel=zenz-v3.2-small-gguf&computeTier=standard&containerModel=small&n5Lm=off`,
      ),
      {
        ...env,
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.internal" },
        }),
        ZENZ_GGUF: { fetch: () => Promise.resolve(new Response(null, { status: 503 })) },
      },
    );
    expect(unhealthy.status).toBe(503);
    await expect(unhealthy.json()).resolves.toMatchObject({
      error: { code: "container_warmup_failed", detail: "Container warm-up returned 503" },
    });

    const unknownFailure = await worker.fetch(
      new Request(
        `https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}?conversionModel=zenz-v3.2-small-gguf&computeTier=standard&containerModel=small&n5Lm=off`,
      ),
      {
        ...env,
        MODEL_ROUTES: JSON.stringify({
          "zenz-v3.2-small-gguf": { baseUrl: "https://zenz.internal" },
        }),
        ZENZ_GGUF: { fetch: () => Promise.reject("untyped failure") },
      },
    );
    expect(unknownFailure.status).toBe(503);
    await expect(unknownFailure.json()).resolves.toMatchObject({
      error: { code: "container_warmup_failed", detail: "Unknown warm-up failure" },
    });
  });

  it("reports unavailable conversion and supports no-GGUF probing without a context", async () => {
    const unavailableDependencies = Object.defineProperty({}, "wasmModule", { value: 1 });
    const unavailable = await createWorker(undefined, unavailableDependencies).fetch(
      asWorkerRequest(new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`)),
      env,
    );
    expect(unavailable.status).toBe(500);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "azookey_runtime_failed" },
    });

    const warmup = vi.fn(() => Promise.resolve());
    const converter = Object.assign(
      vi.fn(() => Promise.resolve("変換")),
      { warmup },
    );
    const available = await createWorker(undefined, {
      converter,
      vibratoConverter: (text) => text,
    }).fetch(
      new Request(
        `https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}?conversionModel=none&computeTier=standard&containerModel=xsmall&n5Lm=off`,
      ),
      env,
    );
    expect(available.status).toBe(200);
    expect(warmup).not.toHaveBeenCalled();
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
      expect(audio.body).toBeInstanceOf(ReadableStream);
      expect(audio.contentType).toBe("audio/wav");
      return Promise.resolve({
        results: { channels: [{ alternatives: [{ transcript: "AI binding" }] }] },
      });
    });
    const ai = { run: bindingRun } as unknown as NonNullable<Env["AI"]>;
    const response = await createWorker().fetch(transcriptionRequest(undefined, speechWav()), {
      ...env,
      AI: ai,
      ASR_PROVIDER: "workers-ai",
      WORKERS_AI_ASR_TIMEOUT_MS: "1500",
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

  it("routes explicit Workers AI ASR through the dedicated path without ASR_PROVIDER", async () => {
    const workersAiRun: WorkersAiAsrRun = vi.fn(() =>
      Promise.resolve({
        results: { channels: [{ alternatives: [{ transcript: "dedicated route" }] }] },
      }),
    );
    const form = new FormData();
    form.set("file", speechWav());
    form.set("language", "ja");
    const response = await createWorker(vi.fn(), { workersAiRun }).fetch(
      new Request(`https://worker.example${WORKERS_AI_ASR_HTTP_PATH}`, {
        method: "POST",
        body: form,
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(env.CORS_ORIGIN);
    await expect(response.json()).resolves.toMatchObject({
      text: "dedicated route",
      language: "ja",
      transport: "http",
    });
    expect(workersAiRun).toHaveBeenCalledTimes(1);
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

  it("turns an upstream JSON decoding failure into a bad-gateway error", async () => {
    const response = await createWorker(async () => new Response("not-json")).fetch(
      asWorkerRequest(transcriptionRequest()),
      { ...env, ASR_UPSTREAM_URL: "https://asr.example/transcribe" },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "asr_invalid_response", message: "ASR upstream response was not valid JSON" },
    });
  });

  it("rejects an oversized ASR upstream response body before JSON parsing", async () => {
    const oversized = new Uint8Array(65_537);
    const response = await createWorker(async () => new Response(oversized)).fetch(
      asWorkerRequest(transcriptionRequest()),
      { ...env, ASR_UPSTREAM_URL: "https://asr.example/transcribe" },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "asr_invalid_response",
        message: "ASR upstream response exceeds the byte limit",
      },
    });
  });

  it("rejects an ASR upstream response with no body", async () => {
    const response = await createWorker(async () => new Response(null, { status: 200 })).fetch(
      asWorkerRequest(transcriptionRequest()),
      { ...env, ASR_UPSTREAM_URL: "https://asr.example/transcribe" },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "asr_invalid_response", message: "ASR upstream response has no body" },
    });
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

  it("routes Workers AI ASR through the bound AI run when the provider is enabled", async () => {
    const run = vi.fn(() =>
      Promise.resolve({ results: { channels: [{ alternatives: [{ transcript: "bound" }] }] } }),
    );
    const form = new FormData();
    form.set("file", speechWav());
    const response = await createWorker().fetch(
      asWorkerRequest(
        new Request(`https://worker.example${WORKERS_AI_ASR_HTTP_PATH}`, {
          method: "POST",
          body: form,
        }),
      ),
      {
        ...env,
        ASR_PROVIDER: "workers-ai",
        WORKERS_AI_ASR_TIMEOUT_MS: "1500",
        AI: { run } as unknown as NonNullable<Env["AI"]>,
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ text: "bound" });
    expect(run).toHaveBeenCalledOnce();
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

  it("persists a Worker-owned lexicon and converts ぶいあーるちゃっと without a client TSV", async () => {
    const lexicon = createMemoryUserLexicon(() => "created-id");
    const wasmModule = new WebAssembly.Module(
      readFileSync(new URL("../wasm/azookey.wasm", import.meta.url)),
    );
    const worker = createWorker(fetch, { userLexicon: lexicon, wasmModule });
    const created = await worker.fetch(
      asWorkerRequest(
        new Request("https://worker.example/azookey/user-lexicon/entries", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reading: "ぶいあーるちゃっと", word: "VRC" }),
        }),
      ),
      env,
    );
    expect(created.status).toBe(201);
    const converted = await worker.fetch(
      asWorkerRequest(
        new Request("https://worker.example/v1/azookey/convert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "ぶいあーるちゃっと" }),
        }),
      ),
      env,
    );
    expect(converted.status).toBe(200);
    await expect(converted.json()).resolves.toStrictEqual({
      convertedText: "VRC",
      lexiconEntryCount: 1,
      revision: "1",
    });
    const rejected = await worker.fetch(
      asWorkerRequest(
        new Request("https://worker.example/v1/azookey/convert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "ぶいあーるちゃっと",
            userDictionaryTsv: "クライアント\t無視\n",
          }),
        }),
      ),
      env,
    );
    expect(rejected.status).toBe(400);
    const retired = await worker.fetch(
      asWorkerRequest(new Request("https://worker.example/v1/azookey/user-dictionary")),
      env,
    );
    expect(retired.status).toBe(404);
    const listed = await worker.fetch(
      asWorkerRequest(new Request("https://worker.example/azookey/user-lexicon/entries?limit=50")),
      env,
    );
    await expect(listed.json()).resolves.toStrictEqual({
      revision: "1",
      entryCount: 1,
      entries: [{ id: "created-id", reading: "ぶいあーるちゃっと", word: "VRC" }],
      nextCursor: null,
    });
  }, 20_000);
});
