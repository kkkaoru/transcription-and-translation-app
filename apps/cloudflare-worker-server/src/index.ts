import type { GatewayConfig } from "@caption-bridge/inference-server-core";
import {
  createGatewayFetchHandler,
  GatewayError,
  pcm16ToWav,
  validateGatewayConfig,
} from "@caption-bridge/inference-server-core";

export interface Env {
  ASR_API_TOKEN?: string;
  ASR_UPSTREAM_URL?: string;
  CORS_ORIGIN?: string;
  MODEL_ROUTES: string;
}

export interface WorkerHandler {
  fetch(request: Request, env: Env): Promise<Response>;
}

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const workerConfig = (env: Env): GatewayConfig => {
  let models: unknown;
  try {
    models = JSON.parse(env.MODEL_ROUTES);
  } catch {
    throw new Error("MODEL_ROUTES must be valid JSON");
  }
  return validateGatewayConfig({
    listen: { host: "127.0.0.1", port: 8765 },
    parapper: {
      url: env.ASR_UPSTREAM_URL ?? "https://asr.unavailable.invalid/v1/audio/transcriptions",
      timeoutMs: 18_000,
    },
    models,
  });
};

const cors = (response: Response, origin: string | undefined): Response => {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization");
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return new Response(response.body, { status: response.status, headers });
};

const upstreamTranscriber = (
  env: Env,
  fetcher: typeof fetch,
): ((pcm: Uint8Array) => Promise<string>) | undefined => {
  const upstreamUrl = env.ASR_UPSTREAM_URL;
  if (!upstreamUrl) {
    return undefined;
  }
  return async (pcm: Uint8Array): Promise<string> => {
    const form = new FormData();
    form.set("model", "parapper-ja");
    form.set("file", new File([pcm16ToWav(pcm)], "caption.wav", { type: "audio/wav" }));
    let response: Response;
    try {
      response = await fetcher(upstreamUrl, {
        method: "POST",
        body: form,
        ...(env.ASR_API_TOKEN ? { headers: { authorization: `Bearer ${env.ASR_API_TOKEN}` } } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "connection failed";
      throw new GatewayError(502, "asr_connection_failed", detail);
    }
    if (!response.ok) {
      throw new GatewayError(
        502,
        "asr_upstream_failed",
        `ASR upstream returned ${response.status}`,
      );
    }
    const payload: unknown = await response.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as { text?: unknown }).text !== "string"
    ) {
      throw new GatewayError(
        502,
        "asr_invalid_response",
        "ASR upstream response has no text field",
      );
    }
    return (payload as { text: string }).text;
  };
};

export const createWorker = (fetcher: typeof fetch = fetch): WorkerHandler => ({
  async fetch(request, env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }), env.CORS_ORIGIN);
    }
    let config: GatewayConfig;
    try {
      config = workerConfig(env);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid Worker configuration";
      return cors(
        json(500, { error: { code: "invalid_configuration", message: detail } }),
        env.CORS_ORIGIN,
      );
    }
    const transcribe = upstreamTranscriber(env, fetcher);
    const handler = createGatewayFetchHandler(config, {
      fetch: fetcher,
      ...(transcribe ? { transcribe } : {}),
    });
    return cors(await handler(request), env.CORS_ORIGIN);
  },
});

export default createWorker() as ExportedHandler<Env>;
