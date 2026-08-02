import { pcm16FromWav } from "./audio.js";
import type { GatewayConfig, TextModelRoute } from "./config.js";

export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_BYTES = 256 * 1024;
const HTTP_OK = 200;
const HTTP_SUCCESS_MAX_EXCLUSIVE = 300;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_REQUEST_TOO_LARGE = 413;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;
const DEFAULT_MAX_TOKENS = 128;
const ZENZ_PROMPT_DELIMITER_LENGTH = 2;
const HY_DEFAULT_TOP_K = 20;
const HY_DEFAULT_REPETITION_PENALTY = 1.05;
const ZERO_TEMPERATURE = 0;
const FIRST_CHOICE_INDEX = 0;
const DEFAULT_CONTENT_LENGTH = 0;
const JSON_LAST_INDEX = -1;

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
  /**
   * Transcribe one PCM chunk. The request signal is optional so adapters that
   * do not own a cancellable upstream can keep their existing one-argument
   * implementation, while streaming adapters can stop promptly when the
   * client disconnects.
   */
  transcribe?: (pcm: Uint8Array, signal?: AbortSignal) => Promise<string>;
}

const isGatewayError = (error: unknown): error is GatewayError => error instanceof GatewayError;

/**
 * Older Parapper adapters returned VAD no-speech as HTTP 422
 * `transcript_missing`; newer adapters return `{text:""}`. Keep the HTTP
 * boundary compatible with both so a stale sidecar cannot turn ambient chunks
 * into fatal capture errors.
 */
const isNoSpeechFailure = (error: unknown): boolean => {
  if (error instanceof GatewayError) {
    const code = error.code.trim().toLowerCase();
    if (["transcript_missing", "no_transcript", "empty_transcript", "no_speech"].includes(code)) {
      return true;
    }
  }
  const detail =
    error instanceof Error
      ? error.message.toLowerCase()
      : typeof error === "string"
        ? error.toLowerCase()
        : "";
  return (
    detail.includes("transcript_missing") ||
    detail.includes("without a final transcript") ||
    detail.includes("no final transcript") ||
    detail.includes("no transcript") ||
    detail.includes("empty transcript") ||
    detail.includes("no speech")
  );
};

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
    return fail(
      HTTP_SERVICE_UNAVAILABLE,
      "asr_unavailable",
      "This inference server has no configured ASR runtime",
    );
  }
  return transcribe;
};

const requiredModelId = (value: unknown): string => {
  if (typeof value !== "string") {
    return fail(HTTP_BAD_REQUEST, "model_required", "Chat request requires a model ID");
  }
  const model = value.trim();
  if (!model) {
    return fail(HTTP_BAD_REQUEST, "model_required", "Chat request requires a model ID");
  }
  return model;
};

const requiredModelRoute = (route: TextModelRoute | undefined, model: string): TextModelRoute => {
  if (!route) {
    return fail(
      HTTP_NOT_FOUND,
      "model_not_configured",
      `No route is configured for model ${model}`,
    );
  }
  return route;
};

const readJson = async (request: Request): Promise<Json> => {
  const contentLength = Number(request.headers.get("content-length") ?? DEFAULT_CONTENT_LENGTH);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    fail(HTTP_REQUEST_TOO_LARGE, "request_too_large", "JSON request exceeds the size limit");
  }
  const body = await request
    .text()
    .catch(() => fail(HTTP_BAD_REQUEST, "invalid_json", "Could not read the JSON request"));
  if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES) {
    fail(HTTP_REQUEST_TOO_LARGE, "request_too_large", "JSON request exceeds the size limit");
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(HTTP_BAD_REQUEST, "invalid_json", "JSON request must be an object");
    }
    return parsed as Json;
  } catch (error) {
    if (isGatewayError(error)) {
      throw error;
    }
    return fail(HTTP_BAD_REQUEST, "invalid_json", "Could not parse the JSON request");
  }
};

const readTranscription = async (
  request: Request,
): Promise<{ language?: string; model?: string; wav: Uint8Array }> => {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    fail(
      HTTP_UNSUPPORTED_MEDIA_TYPE,
      "unsupported_media_type",
      "Use multipart/form-data for audio",
    );
  }
  const form = await request
    .formData()
    .catch(() => fail(HTTP_BAD_REQUEST, "invalid_multipart", "Could not read multipart audio"));
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return fail(HTTP_BAD_REQUEST, "audio_missing", "Multipart request requires a file field");
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return fail(HTTP_REQUEST_TOO_LARGE, "audio_too_large", "Audio request exceeds the size limit");
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
    return fail(
      HTTP_BAD_REQUEST,
      "zenz_prompt_required",
      "Zenz requires a single delimited conversion prompt",
    );
  }
  const last = messages.at(JSON_LAST_INDEX);
  const content =
    last && typeof last === "object" && !Array.isArray(last)
      ? (last as Record<string, unknown>)["content"]
      : undefined;
  if (
    typeof content !== "string" ||
    !content.startsWith("\u{EE00}") ||
    !content.endsWith("\u{EE01}") ||
    content.length <= ZENZ_PROMPT_DELIMITER_LENGTH
  ) {
    return fail(
      HTTP_BAD_REQUEST,
      "zenz_prompt_required",
      "Zenz requires a single delimited conversion prompt",
    );
  }
  return content;
};

const modelRequest = (model: string, payload: Json, route: TextModelRoute): Json => {
  const { model_path: _modelPath, ...passthrough } = payload;
  const request: Json = { ...passthrough, model: route.servedModel ?? model };
  if (model.startsWith("hy-mt2-")) {
    request["top_k"] ??= HY_DEFAULT_TOP_K;
    request["repetition_penalty"] ??= HY_DEFAULT_REPETITION_PENALTY;
  }
  return request;
};

const zenzRequest = (payload: Json): Json => ({
  prompt: zenzPrompt(payload),
  n_predict: Math.min(
    typeof payload["max_tokens"] === "number" ? payload["max_tokens"] : DEFAULT_MAX_TOKENS,
    DEFAULT_MAX_TOKENS,
  ),
  temperature: ZERO_TEMPERATURE,
  stream: false,
});

const zenzResponse = (status: number, model: string, body: string): Response => {
  if (status < HTTP_OK || status >= HTTP_SUCCESS_MAX_EXCLUSIVE) {
    return new Response(body, {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  let content: unknown;
  try {
    content = (JSON.parse(body) as Record<string, unknown>)["content"];
  } catch {
    return json(HTTP_BAD_GATEWAY, {
      error: { code: "invalid_model_response", message: "Zenz returned invalid JSON" },
    });
  }
  if (typeof content !== "string") {
    return json(HTTP_BAD_GATEWAY, {
      error: { code: "invalid_model_response", message: "Zenz response has no content" },
    });
  }
  return json(HTTP_OK, {
    choices: [
      { index: FIRST_CHOICE_INDEX, finish_reason: "stop", message: { role: "assistant", content } },
    ],
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
    return fail(HTTP_BAD_GATEWAY, "model_connection_failed", detail);
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
  return json(HTTP_INTERNAL_SERVER_ERROR, {
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
        return new Response(null, { status: HTTP_NO_CONTENT });
      }
      if (request.method === "GET" && path === "/health") {
        return json(HTTP_OK, { status: "ok", asr: "parapper", models: Object.keys(config.models) });
      }
      if (request.method === "POST" && path === "/v1/audio/transcriptions") {
        const transcription = await readTranscription(request);
        if (transcription.model !== "parapper-ja") {
          fail(HTTP_BAD_REQUEST, "unsupported_asr_model", "Only parapper-ja is supported");
        }
        let pcm: Uint8Array;
        try {
          pcm = pcm16FromWav(transcription.wav);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "WAV validation failed";
          fail(HTTP_BAD_REQUEST, "invalid_audio", detail);
        }
        const text = await asrGate
          .run(() => requiredTranscriber(transcribe)(pcm, request.signal))
          .catch((error: unknown) => {
            if (isNoSpeechFailure(error)) {
              return "";
            }
            throw error;
          });
        return json(HTTP_OK, {
          text,
          ...(transcription.language ? { language: transcription.language } : {}),
        });
      }
      if (request.method === "POST" && path === "/v1/chat/completions") {
        const payload = await readJson(request);
        const modelId = requiredModelId(payload["model"]);
        const route = requiredModelRoute(config.models[modelId], modelId);
        // Await so asynchronous upstream/protocol errors are normalized by the
        // surrounding gateway error boundary instead of escaping as a rejected
        // request promise.
        return await forwardChat(modelId, route, payload, fetcher);
      }
      return json(HTTP_NOT_FOUND, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      return errorResponse(error);
    }
  };
};
