import { pcm16FromWav } from "./audio.js";
import type { GatewayConfig, TextModelRoute } from "./config.js";

export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_BYTES = 256 * 1024;

type Json = Record<string, unknown>;

export class GatewayError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class SerialGate {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface GatewayDependencies {
  fetch?: typeof fetch;
  transcribe?: (pcm: Uint8Array) => Promise<string>;
}

const isGatewayError = (error: unknown): error is GatewayError => error instanceof GatewayError;

const json = (status: number, body: Json): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const fail = (status: number, code: string, message: string): never => {
  throw new GatewayError(status, code, message);
};

const textField = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const requiredTranscriber = (
  transcribe: GatewayDependencies["transcribe"],
): NonNullable<GatewayDependencies["transcribe"]> => {
  if (!transcribe) {
    return fail(503, "asr_unavailable", "This inference server has no configured ASR runtime");
  }
  return transcribe;
};

const requiredModelId = (value: unknown): string => {
  if (typeof value !== "string") {
    return fail(400, "model_required", "Chat request requires a model ID");
  }
  const model = value.trim();
  if (!model) {
    return fail(400, "model_required", "Chat request requires a model ID");
  }
  return model;
};

const requiredModelRoute = (route: TextModelRoute | undefined, model: string): TextModelRoute => {
  if (!route) {
    return fail(404, "model_not_configured", `No route is configured for model ${model}`);
  }
  return route;
};

const readJson = async (request: Request): Promise<Json> => {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    fail(413, "request_too_large", "JSON request exceeds the size limit");
  }
  const body = await request
    .text()
    .catch(() => fail(400, "invalid_json", "Could not read the JSON request"));
  if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES) {
    fail(413, "request_too_large", "JSON request exceeds the size limit");
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(400, "invalid_json", "JSON request must be an object");
    }
    return parsed as Json;
  } catch (error) {
    if (isGatewayError(error)) {
      throw error;
    }
    return fail(400, "invalid_json", "Could not parse the JSON request");
  }
};

const readTranscription = async (
  request: Request,
): Promise<{ language?: string; model?: string; wav: Uint8Array }> => {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    fail(415, "unsupported_media_type", "Use multipart/form-data for audio");
  }
  const form = await request
    .formData()
    .catch(() => fail(400, "invalid_multipart", "Could not read multipart audio"));
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return fail(400, "audio_missing", "Multipart request requires a file field");
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return fail(413, "audio_too_large", "Audio request exceeds the size limit");
  }
  const model = textField(form, "model");
  const language = textField(form, "language");
  return {
    wav: new Uint8Array(await file.arrayBuffer()),
    ...(model ? { model } : {}),
    ...(language ? { language } : {}),
  };
};

const modelEndpoint = (baseUrl: string): string =>
  `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

const completionEndpoint = (baseUrl: string): string => `${baseUrl.replace(/\/$/, "")}/completion`;

const isZenzModel = (model: string): boolean => model.startsWith("zenz-");

const zenzPrompt = (payload: Json): string => {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) {
    return fail(400, "zenz_prompt_required", "Zenz requires a single delimited conversion prompt");
  }
  const last = messages.at(-1);
  const content =
    last && typeof last === "object" && !Array.isArray(last)
      ? (last as Record<string, unknown>)["content"]
      : undefined;
  if (
    typeof content !== "string" ||
    !content.startsWith("\u{EE00}") ||
    !content.endsWith("\u{EE01}") ||
    content.length <= 2
  ) {
    return fail(400, "zenz_prompt_required", "Zenz requires a single delimited conversion prompt");
  }
  return content;
};

const modelRequest = (model: string, payload: Json, route: TextModelRoute): Json => {
  const { model_path: _modelPath, ...passthrough } = payload;
  const request: Json = { ...passthrough, model: route.servedModel ?? model };
  if (model.startsWith("hy-mt2-")) {
    request["top_k"] ??= 20;
    request["repetition_penalty"] ??= 1.05;
  }
  return request;
};

const zenzRequest = (payload: Json): Json => ({
  prompt: zenzPrompt(payload),
  n_predict: Math.min(typeof payload["max_tokens"] === "number" ? payload["max_tokens"] : 128, 128),
  temperature: 0,
  stream: false,
});

const zenzResponse = (status: number, model: string, body: string): Response => {
  if (status < 200 || status >= 300) {
    return new Response(body, {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  let content: unknown;
  try {
    content = (JSON.parse(body) as Record<string, unknown>)["content"];
  } catch {
    return json(502, {
      error: { code: "invalid_model_response", message: "Zenz returned invalid JSON" },
    });
  }
  if (typeof content !== "string") {
    return json(502, {
      error: { code: "invalid_model_response", message: "Zenz response has no content" },
    });
  }
  return json(200, {
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    model,
    object: "chat.completion",
  });
};

const forwardChat = async (
  model: string,
  route: TextModelRoute,
  payload: Json,
  fetcher: typeof fetch,
): Promise<Response> => {
  const zenz = isZenzModel(model);
  const response = await fetcher(
    zenz ? completionEndpoint(route.baseUrl) : modelEndpoint(route.baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(zenz ? zenzRequest(payload) : modelRequest(model, payload, route)),
    },
  ).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : "connection failed";
    return fail(502, "model_connection_failed", detail);
  });
  const body = await response.text();
  if (zenz) {
    return zenzResponse(response.status, model, body);
  }
  return new Response(body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    },
  });
};

const errorResponse = (error: unknown): Response => {
  if (isGatewayError(error)) {
    return json(error.status, { error: { code: error.code, message: error.message } });
  }
  return json(500, {
    error: {
      code: "internal_error",
      message: "The inference gateway encountered an internal error",
    },
  });
};

export const createGatewayFetchHandler = (
  config: GatewayConfig,
  dependencies: GatewayDependencies = {},
): ((request: Request) => Promise<Response>) => {
  const asrGate = new SerialGate();
  const fetcher = dependencies.fetch ?? fetch;
  const transcribe = dependencies.transcribe;
  return async (request: Request): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && path === "/health") {
        return json(200, { status: "ok", asr: "parapper", models: Object.keys(config.models) });
      }
      if (request.method === "POST" && path === "/v1/audio/transcriptions") {
        const transcription = await readTranscription(request);
        if (transcription.model !== "parapper-ja") {
          fail(400, "unsupported_asr_model", "Only parapper-ja is supported");
        }
        let pcm: Uint8Array;
        try {
          pcm = pcm16FromWav(transcription.wav);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "WAV validation failed";
          fail(400, "invalid_audio", detail);
        }
        const text = await asrGate.run(() => requiredTranscriber(transcribe)(pcm));
        return json(200, {
          text,
          ...(transcription.language ? { language: transcription.language } : {}),
        });
      }
      if (request.method === "POST" && path === "/v1/chat/completions") {
        const payload = await readJson(request);
        const modelId = requiredModelId(payload["model"]);
        const route = requiredModelRoute(config.models[modelId], modelId);
        return forwardChat(modelId, route, payload, fetcher);
      }
      return json(404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      return errorResponse(error);
    }
  };
};
