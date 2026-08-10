import { describe, expect, it, vi } from "vitest";
import { transcribeWorkersAiAsr } from "./workers-ai-asr-client";
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
