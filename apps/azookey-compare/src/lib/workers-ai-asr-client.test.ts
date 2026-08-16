import { describe, expect, it, vi } from "vitest";
import {
  isLoopbackWorkersAiAsrEndpoint,
  probeWorkersAiAsrRoute,
  transcribeWorkersAiAsr,
  WORKERS_AI_ASR_LOCAL_UNAVAILABLE_JA,
} from "./workers-ai-asr-client";
import { workersAiAsrSmokeWavFile } from "./workers-ai-asr-fixture";

describe("workers-ai-asr-client", () => {
  it("posts multipart WAV to the explicit compare ASR route", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        text: "こんにちは",
        language: "ja",
        model: "@cf/deepgram/nova-3",
        transport: "http",
      }),
    );
    const file = workersAiAsrSmokeWavFile();
    const result = await transcribeWorkersAiAsr(file, {
      endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
      language: "ja",
      fetchImpl,
    });
    expect(result.text).toBe("こんにちは");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://compare.example/v1/asr/workers-ai/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("forwards the Worker reading field when Nova-3 post-processing supplies it", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        text: "きょうはいいてんき",
        reading: "きょうはいいてんき",
        language: "ja",
        model: "@cf/deepgram/nova-3",
        transport: "http",
      }),
    );
    const result = await transcribeWorkersAiAsr(workersAiAsrSmokeWavFile(), {
      endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
      fetchImpl,
    });
    expect(result).toStrictEqual({
      text: "きょうはいいてんき",
      reading: "きょうはいいてんき",
      language: "ja",
      model: "@cf/deepgram/nova-3",
      transport: "http",
    });
  });

  it("surfaces server errors without printing secrets", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { code: "asr_workers_ai_unavailable", message: "binding missing" } },
        { status: 503 },
      ),
    );
    await expect(
      transcribeWorkersAiAsr(workersAiAsrSmokeWavFile(), {
        endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
        fetchImpl,
      }),
    ).rejects.toThrow("binding missing");
  });

  it("maps generic HTTP failures and malformed payloads", async () => {
    await expect(
      transcribeWorkersAiAsr(workersAiAsrSmokeWavFile(), {
        endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
        fetchImpl: vi.fn(async () => new Response("not-json", { status: 502 })),
      }),
    ).rejects.toThrow("Cloudflare Workers AI ASR が JSON 以外を返しました（502）");

    await expect(
      transcribeWorkersAiAsr(workersAiAsrSmokeWavFile(), {
        endpointUrl: "http://127.0.0.1:3000/v1/asr/workers-ai/transcriptions",
        fetchImpl: vi.fn(
          async () =>
            new Response("<!DOCTYPE html>404: This page could not be found.", { status: 404 }),
        ),
      }),
    ).rejects.toThrow(
      "Cloudflare Workers AI ASR の経路が見つかりません（404）。ローカルなら bun run worker:dev を起動し、Next.js が inference（既定 http://127.0.0.1:8787）へ proxy しているか確認してください",
    );

    await expect(
      transcribeWorkersAiAsr(workersAiAsrSmokeWavFile(), {
        endpointUrl: "http://127.0.0.1:3000/v1/asr/workers-ai/transcriptions",
        fetchImpl: vi.fn(() => {
          throw new TypeError("fetch failed");
        }),
      }),
    ).rejects.toThrow(
      "Cloudflare Workers AI ASR に接続できません。ローカルなら bun run azookey-compare:dev と bun run worker:dev を起動してください",
    );

    await expect(
      transcribeWorkersAiAsr(workersAiAsrSmokeWavFile(), {
        endpointUrl: "http://127.0.0.1:3000/v1/asr/workers-ai/transcriptions",
        fetchImpl: vi.fn(async () => new Response("Internal Server Error", { status: 500 })),
      }),
    ).rejects.toThrow(
      "Cloudflare Workers AI ASR に接続できません。ローカルなら bun run azookey-compare:dev と bun run worker:dev を起動してください",
    );

    await expect(
      transcribeWorkersAiAsr(workersAiAsrSmokeWavFile(), {
        endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
        fetchImpl: vi.fn(async () => Response.json({ error: { code: "busy" } }, { status: 429 })),
      }),
    ).rejects.toThrow("Cloudflare Workers AI ASR に失敗しました（429）");

    await expect(
      transcribeWorkersAiAsr(workersAiAsrSmokeWavFile(), {
        endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
        fetchImpl: vi.fn(async () => Response.json({ language: "ja" })),
      }),
    ).rejects.toThrow("Cloudflare Workers AI ASR の応答に text がありません");
  });

  it("probes loopback ASR before speech and keeps hosted compare unprobed", async () => {
    expect(
      isLoopbackWorkersAiAsrEndpoint("http://127.0.0.1:3000/v1/asr/workers-ai/transcriptions"),
    ).toBe(true);
    expect(
      isLoopbackWorkersAiAsrEndpoint("http://localhost:3000/v1/asr/workers-ai/transcriptions"),
    ).toBe(true);
    expect(
      isLoopbackWorkersAiAsrEndpoint(
        "https://azookey-compare.kaoru.workers.dev/v1/asr/workers-ai/transcriptions",
      ),
    ).toBe(false);
    expect(isLoopbackWorkersAiAsrEndpoint("   ")).toBe(false);
    expect(isLoopbackWorkersAiAsrEndpoint("http://[")).toBe(false);
    expect(WORKERS_AI_ASR_LOCAL_UNAVAILABLE_JA).toMatch(/Access/);
    expect(WORKERS_AI_ASR_LOCAL_UNAVAILABLE_JA).toMatch(/worker:dev/);

    await expect(
      probeWorkersAiAsrRoute("http://127.0.0.1:3000/v1/asr/workers-ai/transcriptions", {
        fetchImpl: vi.fn(async () => Response.json({ ok: true })),
      }),
    ).resolves.toBeUndefined();

    await expect(
      probeWorkersAiAsrRoute("http://127.0.0.1:3000/v1/asr/workers-ai/transcriptions", {
        fetchImpl: vi.fn(async () =>
          Response.json(
            {
              error: {
                code: "asr_workers_ai_unavailable",
                message: WORKERS_AI_ASR_LOCAL_UNAVAILABLE_JA,
              },
            },
            { status: 503 },
          ),
        ),
      }),
    ).rejects.toThrow(WORKERS_AI_ASR_LOCAL_UNAVAILABLE_JA);

    await expect(
      probeWorkersAiAsrRoute("http://127.0.0.1:3000/v1/asr/workers-ai/transcriptions", {
        fetchImpl: vi.fn(async () => Response.json({ error: { code: "busy" } }, { status: 503 })),
      }),
    ).rejects.toThrow(WORKERS_AI_ASR_LOCAL_UNAVAILABLE_JA);

    await expect(
      probeWorkersAiAsrRoute("http://127.0.0.1:3000/v1/asr/workers-ai/transcriptions", {
        fetchImpl: vi.fn(async () => Response.json({ error: { code: "busy" } }, { status: 429 })),
      }),
    ).rejects.toThrow("Cloudflare Workers AI ASR に失敗しました（429）");

    await expect(
      probeWorkersAiAsrRoute("http://127.0.0.1:3000/v1/asr/workers-ai/transcriptions", {
        fetchImpl: vi.fn(async () => new Response("<html>404</html>", { status: 404 })),
      }),
    ).rejects.toThrow(
      "Cloudflare Workers AI ASR の経路が見つかりません（404）。ローカルなら bun run worker:dev を起動し、Next.js が inference（既定 http://127.0.0.1:8787）へ proxy しているか確認してください",
    );

    await expect(
      probeWorkersAiAsrRoute("http://127.0.0.1:3000/v1/asr/workers-ai/transcriptions", {
        fetchImpl: vi.fn(async () => new Response("bad", { status: 502 })),
      }),
    ).rejects.toThrow(
      "Cloudflare Workers AI ASR に接続できません。ローカルなら bun run azookey-compare:dev と bun run worker:dev を起動してください",
    );

    await expect(
      probeWorkersAiAsrRoute("http://127.0.0.1:3000/v1/asr/workers-ai/transcriptions", {
        fetchImpl: vi.fn(() => {
          throw new TypeError("fetch failed");
        }),
      }),
    ).rejects.toThrow(
      "Cloudflare Workers AI ASR に接続できません。ローカルなら bun run azookey-compare:dev と bun run worker:dev を起動してください",
    );
  });

  it("accepts Blob input and bearer auth headers", async () => {
    const fetchImpl = vi.fn((_url, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer worker-token" });
      return Promise.resolve(Response.json({ text: "blob ok", transport: "http" }));
    });
    await expect(
      transcribeWorkersAiAsr(new Blob([workersAiAsrSmokeWavFile()]), {
        endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
        auth: { scheme: "bearer", token: "worker-token" },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ text: "blob ok", transport: "http" });
  });
});
