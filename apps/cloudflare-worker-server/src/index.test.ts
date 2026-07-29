import { describe, expect, it, vi } from "vitest";
import { createWorker } from "./index.js";

const env = {
  CORS_ORIGIN: "https://captions.example.com",
  MODEL_ROUTES: JSON.stringify({
    "hy-mt2-1.8b-gguf": { baseUrl: "https://models.example.com", servedModel: "hy-live" },
  }),
};

describe("Cloudflare Worker inference adapter", () => {
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
