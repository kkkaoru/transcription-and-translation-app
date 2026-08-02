import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createGatewayFetchHandler,
  GatewayError,
  MAX_AUDIO_BYTES,
} from "@caption-bridge/inference-server-core";
import type { GatewayConfig } from "./config.js";
import { transcribeWithParapper } from "./parapper.js";
import {
  type CorrelationContext,
  correlationFromHeaders,
  correlationHeaders,
  emitStructuredLog,
} from "./structuredLog.js";

export interface GatewayDependencies {
  fetch?: typeof fetch;
  transcribe?: (pcm: Uint8Array, signal?: AbortSignal, request?: Request) => Promise<string>;
}

const MAX_PROXY_REQUEST_BYTES = MAX_AUDIO_BYTES + 64 * 1024;

const writeJson = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  correlation: CorrelationContext,
): void => {
  // A browser/desktop stop can close the HTTP stream while ASR is still
  // settling. Do not attempt a second write (which would surface as an
  // uncaught ERR_STREAM_WRITE_AFTER_END and obscure the original session error).
  if (response.writableEnded || response.destroyed) {
    return;
  }
  try {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      ...correlationHeaders(correlation),
    });
    response.end(JSON.stringify(body));
  } catch {
    response.destroy();
  }
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

const toFetchRequest = async (
  request: IncomingMessage,
  signal: AbortSignal,
  correlation: CorrelationContext,
): Promise<Request> => {
  const method = request.method as string;
  const headers = requestHeaders(request);
  for (const [name, value] of Object.entries(correlationHeaders(correlation))) {
    headers.set(name, value);
  }
  const url = `http://${headers.get("host") ?? "kotoba-beacon.local"}${request.url as string}`;
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers, signal });
  }
  return new Request(url, { method, headers, body: await requestBody(request), signal });
};

const writeFetchResponse = async (
  response: ServerResponse,
  result: Response,
  correlation: CorrelationContext,
): Promise<void> => {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  try {
    const body = Buffer.from(await result.arrayBuffer());
    if (response.writableEnded || response.destroyed) {
      return;
    }
    response.writeHead(result.status, {
      ...Object.fromEntries(result.headers.entries()),
      ...correlationHeaders(correlation),
    });
    response.end(body);
  } catch {
    // The peer may have cancelled the request while the upstream body was
    // being read. There is no response left to recover; close quietly.
    if (!response.destroyed) {
      response.destroy();
    }
  }
};

const handleAdapterError = (
  response: ServerResponse,
  error: unknown,
  correlation: CorrelationContext,
): { status: number; code: string } => {
  if (error instanceof GatewayError) {
    writeJson(
      response,
      error.status,
      { error: { code: error.code, message: error.message } },
      correlation,
    );
    return { status: error.status, code: error.code };
  }
  writeJson(
    response,
    500,
    {
      error: {
        code: "internal_error",
        message: "The inference gateway encountered an internal error",
      },
    },
    correlation,
  );
  return { status: 500, code: "internal_error" };
};

export const createGatewayServer = (
  config: GatewayConfig,
  dependencies: GatewayDependencies = {},
): Server => {
  const transcribe =
    dependencies.transcribe ??
    ((pcm: Uint8Array, signal?: AbortSignal, request?: Request) => {
      const apiKey = config.parapper.apiKeyEnv ? process.env[config.parapper.apiKeyEnv] : undefined;
      const correlation = request ? correlationFromHeaders(request.headers) : undefined;
      return transcribeWithParapper(pcm, {
        ...config.parapper,
        ...(apiKey ? { apiKey } : {}),
        ...(signal ? { signal } : {}),
        ...(correlation ? { correlation } : {}),
      });
    });
  const handler = createGatewayFetchHandler(config, {
    transcribe,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  return createServer((request, response) => {
    const requestAbort = new AbortController();
    const correlation = correlationFromHeaders(requestHeaders(request));
    const method = request.method ?? "UNKNOWN";
    // Keep query values out of logs: gateway URLs can contain user supplied
    // tokens even though the request body is never logged.
    const path = (request.url ?? "/").split("?", 1)[0] ?? "/";
    const startedAt = Date.now();
    let requestFinished = false;
    const emitHttpLog = (event: string, fields: Record<string, unknown> = {}): void => {
      try {
        emitStructuredLog(event, correlation, {
          log_event: event,
          method,
          path,
          ...fields,
        });
      } catch {
        // Logging must never turn a settled HTTP request into a process error.
      }
    };
    const finishRequest = (status: number, fields: Record<string, unknown> = {}): void => {
      if (requestFinished) {
        return;
      }
      requestFinished = true;
      const outcome = status >= 400 ? "failed" : "completed";
      const terminalFields = {
        status,
        outcome,
        duration_ms: Date.now() - startedAt,
        ...fields,
      };
      if (outcome === "failed") {
        emitHttpLog("http_request_failure", terminalFields);
      }
      emitHttpLog("http_request_end", terminalFields);
    };
    emitHttpLog("http_request_start", { outcome: "started" });

    const abortRequest = (): void => {
      requestAbort.abort();
      // A disconnected client may leave an adapter that ignores AbortSignal
      // unresolved. Record the transport failure immediately so every request
      // still has a terminal lifecycle event.
      finishRequest(499, { error_code: "client_closed_request" });
    };
    // Request/response stream errors are expected when the UI cancels a
    // capture or navigates away. Install no-op listeners so Node does not turn
    // the transport race into an uncaught process-level error.
    request.once("aborted", abortRequest);
    request.once("error", () => {
      abortRequest();
      if (!response.writableEnded && !response.destroyed) {
        response.destroy();
      }
    });
    response.once("close", () => {
      // `close` also fires after a normal response has finished. At that
      // point the handler has already settled; only abort an in-flight request
      // whose peer disappeared before we could write its response.
      if (!response.writableEnded) {
        abortRequest();
      }
    });
    response.once("error", () => undefined);
    void toFetchRequest(request, requestAbort.signal, correlation)
      .then(handler)
      .then(async (result) => {
        await writeFetchResponse(response, result, correlation);
        finishRequest(result.status);
      })
      .catch((error: unknown) => {
        const failure = handleAdapterError(response, error, correlation);
        finishRequest(failure.status, { error_code: failure.code });
      });
  });
};
