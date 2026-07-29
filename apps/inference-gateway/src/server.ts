import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createGatewayFetchHandler,
  GatewayError,
  MAX_AUDIO_BYTES,
} from "@caption-bridge/inference-server-core";
import type { GatewayConfig } from "./config.js";
import { transcribeWithParapper } from "./parapper.js";

export interface GatewayDependencies {
  fetch?: typeof fetch;
  transcribe?: (pcm: Uint8Array) => Promise<string>;
}

const MAX_PROXY_REQUEST_BYTES = MAX_AUDIO_BYTES + 64 * 1024;

const writeJson = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const requestHeaders = (request: IncomingMessage): Headers =>
  new Headers(Object.entries(request.headers).map(([name, value]) => [name, String(value)]));

const requestBody = async (request: IncomingMessage): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_PROXY_REQUEST_BYTES) {
      throw new GatewayError(413, "request_too_large", "Request exceeds the size limit");
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
};

const toFetchRequest = async (request: IncomingMessage): Promise<Request> => {
  const method = request.method as string;
  const headers = requestHeaders(request);
  const url = `http://${headers.get("host") ?? "kotoba-beacon.local"}${request.url as string}`;
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  return new Request(url, { method, headers, body: await requestBody(request) });
};

const writeFetchResponse = async (response: ServerResponse, result: Response): Promise<void> => {
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  response.end(Buffer.from(await result.arrayBuffer()));
};

const handleAdapterError = (response: ServerResponse, error: unknown): void => {
  if (error instanceof GatewayError) {
    writeJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  writeJson(response, 500, {
    error: {
      code: "internal_error",
      message: "The inference gateway encountered an internal error",
    },
  });
};

export const createGatewayServer = (
  config: GatewayConfig,
  dependencies: GatewayDependencies = {},
): Server => {
  const transcribe =
    dependencies.transcribe ??
    ((pcm: Uint8Array) => {
      const apiKey = config.parapper.apiKeyEnv ? process.env[config.parapper.apiKeyEnv] : undefined;
      return transcribeWithParapper(pcm, { ...config.parapper, ...(apiKey ? { apiKey } : {}) });
    });
  const handler = createGatewayFetchHandler(config, {
    transcribe,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  return createServer((request, response) => {
    void toFetchRequest(request)
      .then(handler)
      .then(async (result) => writeFetchResponse(response, result))
      .catch((error: unknown) => handleAdapterError(response, error));
  });
};
