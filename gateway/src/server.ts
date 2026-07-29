import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import Busboy from "busboy";
import { pcm16FromWav } from "./audio.js";
import type { GatewayConfig, TextModelRoute } from "./config.js";
import { GatewayError, SerialGate, transcribeWithParapper } from "./parapper.js";

const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;

interface TranscriptionRequest {
  language?: string;
  model?: string;
  wav: Uint8Array;
}

type Json = Record<string, unknown>;

export interface GatewayDependencies {
  fetch?: typeof fetch;
  transcribe?: (pcm: Uint8Array) => Promise<string>;
}

const isGatewayError = (error: unknown): error is GatewayError => error instanceof GatewayError;

const writeJson = (response: ServerResponse, status: number, body: Json): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

function fail(status: number, code: string, message: string): never {
  throw new GatewayError(status, code, message);
}

const requestPath = (request: IncomingMessage): string =>
  new URL(request.url ?? "/", "http://caption-bridge.local").pathname;

const readJson = (request: IncomingMessage): Promise<Json> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) {
        reject(new GatewayError(413, "request_too_large", "JSON request exceeds the size limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("error", reject);
    request.once("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          fail(400, "invalid_json", "JSON request must be an object");
        }
        resolve(parsed as Json);
      } catch (error) {
        reject(
          isGatewayError(error)
            ? error
            : new GatewayError(400, "invalid_json", "Could not parse the JSON request"),
        );
      }
    });
  });

const readTranscription = (request: IncomingMessage): Promise<TranscriptionRequest> =>
  new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"];
    if (!contentType?.startsWith("multipart/form-data")) {
      reject(new GatewayError(415, "unsupported_media_type", "Use multipart/form-data for audio"));
      return;
    }
    const fields: Record<string, string> = {};
    const chunks: Buffer[] = [];
    let audioBytes = 0;
    let fileSeen = false;
    let fileTooLarge = false;
    let parser: Busboy.Busboy;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: { fields: 8, files: 1, fileSize: MAX_AUDIO_BYTES },
      });
    } catch {
      reject(new GatewayError(400, "invalid_multipart", "Could not parse multipart headers"));
      return;
    }
    parser.on("field", (name, value) => {
      fields[name] = value;
    });
    parser.on("file", (name, stream) => {
      if (name !== "file" || fileSeen) {
        stream.resume();
        return;
      }
      fileSeen = true;
      stream.on("data", (chunk: Buffer) => {
        audioBytes += chunk.length;
        chunks.push(chunk);
      });
      stream.once("limit", () => {
        fileTooLarge = true;
      });
    });
    parser.once("error", () => {
      reject(new GatewayError(400, "invalid_multipart", "Could not read multipart audio"));
    });
    parser.once("close", () => {
      if (fileTooLarge || audioBytes > MAX_AUDIO_BYTES) {
        reject(new GatewayError(413, "audio_too_large", "Audio request exceeds the size limit"));
      } else if (!fileSeen) {
        reject(new GatewayError(400, "audio_missing", "Multipart request requires a file field"));
      } else {
        resolve({
          wav: new Uint8Array(Buffer.concat(chunks)),
          ...(fields["model"] ? { model: fields["model"] } : {}),
          ...(fields["language"] ? { language: fields["language"] } : {}),
        });
      }
    });
    request.pipe(parser);
  });

const modelEndpoint = (baseUrl: string): string =>
  `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

const modelRequest = (model: string, payload: Json, route: TextModelRoute): Json => {
  const { model_path: _modelPath, ...passthrough } = payload;
  const request: Json = { ...passthrough, model: route.servedModel ?? model };
  if (model.startsWith("hy-mt2-")) {
    request["top_k"] ??= 20;
    request["repetition_penalty"] ??= 1.05;
  }
  return request;
};

const forwardChat = async (
  model: string,
  route: TextModelRoute,
  payload: Json,
  fetcher: typeof fetch,
): Promise<{ body: string; contentType: string; status: number }> => {
  let response: Response;
  try {
    response = await fetcher(modelEndpoint(route.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(modelRequest(model, payload, route)),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "connection failed";
    throw new GatewayError(502, "model_connection_failed", detail);
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "application/json; charset=utf-8",
    body: await response.text(),
  };
};

const handleError = (response: ServerResponse, error: unknown): void => {
  if (isGatewayError(error)) {
    writeJson(response, error.status, { error: { code: error.code, message: error.message } });
  } else {
    writeJson(response, 500, {
      error: {
        code: "internal_error",
        message: "The inference gateway encountered an internal error",
      },
    });
  }
};

export const createGatewayServer = (
  config: GatewayConfig,
  dependencies: GatewayDependencies = {},
): Server => {
  const asrGate = new SerialGate();
  const transcribe =
    dependencies.transcribe ??
    ((pcm: Uint8Array) => {
      const apiKey = config.parapper.apiKeyEnv ? process.env[config.parapper.apiKeyEnv] : undefined;
      return transcribeWithParapper(pcm, { ...config.parapper, ...(apiKey ? { apiKey } : {}) });
    });
  const fetcher = dependencies.fetch ?? fetch;
  return createServer((request, response) => {
    void (async () => {
      const path = requestPath(request);
      if (request.method === "GET" && path === "/health") {
        writeJson(response, 200, {
          status: "ok",
          asr: "parapper",
          models: Object.keys(config.models),
        });
        return;
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
        const text = await asrGate.run(() => transcribe(pcm));
        writeJson(response, 200, {
          text,
          ...(transcription["language"] ? { language: transcription["language"] } : {}),
        });
        return;
      }
      if (request.method === "POST" && path === "/v1/chat/completions") {
        const payload = await readJson(request);
        const model = payload["model"];
        if (typeof model !== "string") {
          fail(400, "model_required", "Chat request requires a model ID");
        }
        const modelId = model.trim();
        if (!modelId) {
          fail(400, "model_required", "Chat request requires a model ID");
        }
        const route = config.models[modelId];
        if (!route) {
          fail(404, "model_not_configured", `No route is configured for model ${modelId}`);
        }
        const proxied = await forwardChat(modelId, route, payload, fetcher);
        response.writeHead(proxied.status, { "content-type": proxied.contentType });
        response.end(proxied.body);
        return;
      }
      writeJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
    })().catch((error: unknown) => handleError(response, error));
  });
};
