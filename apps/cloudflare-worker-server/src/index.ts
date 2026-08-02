import type { GatewayConfig } from "@caption-bridge/inference-server-core";
import {
  createGatewayFetchHandler,
  GatewayError,
  pcm16ToWav,
  validateGatewayConfig,
} from "@caption-bridge/inference-server-core";
import vibratoWasm from "../wasm/vibrato_wasm_bg.wasm";
import {
  AZOOKEY_MAX_TEXT_BYTES,
  AZOOKEY_MODE,
  AZOOKEY_MODEL,
  AZOOKEY_PROTOCOL,
  AZOOKEY_WS_PATH,
  type AzookeyRequestDependencies,
  azookeyTimeoutMs,
  BROWSER_VIBRATO_MODE,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_SWITCHING_PROTOCOLS,
  openAzookeySocket,
} from "./azookey.js";
import azookeyWasm from "./azookey-wasm.js";

export interface Env {
  ASR_API_TOKEN?: string;
  ASR_UPSTREAM_URL?: string;
  AZOOKEY_API_TOKEN?: string;
  AZOOKEY_TIMEOUT_MS?: string;
  VIBRATO_UPSTREAM_URL?: string;
  VIBRATO_API_TOKEN?: string;
  VIBRATO_DICTIONARY_URL?: string;
  CORS_ORIGIN?: string;
  MODEL_ROUTES: string;
  ASSETS?: WorkerAssets;
}

export interface WorkerAssets {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface WorkerHandler {
  fetch(request: Request, env: Env): Promise<Response>;
}

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_GATEWAY = 502;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const LOCAL_GATEWAY_HOST = "127.0.0.1";
const LOCAL_GATEWAY_PORT = 8765;
const DEFAULT_PARAPPER_TIMEOUT_MS = 18_000;
export const VIBRATO_DICTIONARY_PATH = "/vibrato/system.dic.zst";

/**
 * The Worker adapter accepts the native fetch function as well as a small
 * synchronous test double.  The gateway core always receives an async fetch
 * function; createWorker normalizes this union at the boundary.
 */
export type WorkerFetcher = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Response | Promise<Response>;

export interface WorkerDependencies extends AzookeyRequestDependencies {
  fetch?: typeof fetch;
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
  } catch (error) {
    if (error instanceof Error) {
      throw new Error("MODEL_ROUTES must be valid JSON");
    }
    throw error;
  }
  return validateGatewayConfig({
    listen: { host: LOCAL_GATEWAY_HOST, port: LOCAL_GATEWAY_PORT },
    parapper: {
      url: env.ASR_UPSTREAM_URL ?? "https://asr.unavailable.invalid/v1/audio/transcriptions",
      timeoutMs: DEFAULT_PARAPPER_TIMEOUT_MS,
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
  fetcher: WorkerFetcher,
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
      throw new GatewayError(HTTP_BAD_GATEWAY, "asr_connection_failed", detail);
    }
    if (!response.ok) {
      throw new GatewayError(
        HTTP_BAD_GATEWAY,
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
        HTTP_BAD_GATEWAY,
        "asr_invalid_response",
        "ASR upstream response has no text field",
      );
    }
    return (payload as { text: string }).text;
  };
};

export const createWorker = (
  fetcher: WorkerFetcher = fetch,
  dependencies: WorkerDependencies = {},
): WorkerHandler => ({
  async fetch(request, env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: HTTP_NO_CONTENT }), env.CORS_ORIGIN);
    }
    const url = new URL(request.url);
    if (url.pathname === VIBRATO_DICTIONARY_PATH && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname === "/v1/azookey") {
      if (request.method !== "GET") {
        return cors(
          json(HTTP_METHOD_NOT_ALLOWED, {
            error: { code: "method_not_allowed", message: "GET is required" },
          }),
          env.CORS_ORIGIN,
        );
      }
      return cors(
        json(HTTP_OK, {
          ok: true,
          service: "azookey",
          protocol: AZOOKEY_PROTOCOL,
          model: AZOOKEY_MODEL,
          websocketPath: AZOOKEY_WS_PATH,
          maxTextBytes: AZOOKEY_MAX_TEXT_BYTES,
          timeoutMs: azookeyTimeoutMs(env),
          auth: {
            scheme: "bearer",
            configured: Boolean(env.AZOOKEY_API_TOKEN?.trim()),
            transport: "authorization-header-or-first-frame",
          },
          vibrato: {
            workerStage:
              env.VIBRATO_DICTIONARY_URL?.trim() || env.VIBRATO_UPSTREAM_URL?.trim()
                ? "configured"
                : "unconfigured",
            transport: env.VIBRATO_DICTIONARY_URL?.trim() ? "wasm" : "http",
            contract: env.VIBRATO_DICTIONARY_URL?.trim()
              ? "Vibrato WASM + zstd system dictionary"
              : "POST {text, language} -> {text}",
          },
          modes: {
            worker: AZOOKEY_MODE,
            browser: BROWSER_VIBRATO_MODE,
          },
        }),
        env.CORS_ORIGIN,
      );
    }
    if (url.pathname === AZOOKEY_WS_PATH) {
      const fetcher = dependencies.fetcher ?? fetch;
      const assets = env.ASSETS;
      const dictionaryFetcher =
        dependencies.vibratoDictionaryFetcher ??
        (assets && env.VIBRATO_DICTIONARY_URL?.trim().startsWith("/")
          ? (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              const assetRequest =
                input instanceof Request
                  ? new Request(input, init)
                  : new Request(new URL(String(input), request.url), init);
              return assets.fetch(assetRequest);
            }
          : fetcher);
      const response = await openAzookeySocket(request, env, {
        ...dependencies,
        fetcher,
        vibratoDictionaryFetcher: dictionaryFetcher,
        wasmModule: dependencies.wasmModule ?? azookeyWasm,
        vibratoWasmModule: dependencies.vibratoWasmModule ?? vibratoWasm,
      });
      // Reconstructing a Response drops the non-standard `webSocket` slot
      // required by the Workers runtime for a 101 upgrade. CORS is relevant
      // to the pre-upgrade HTTP errors, not to the upgraded socket itself.
      return response.status === HTTP_SWITCHING_PROTOCOLS
        ? response
        : cors(response, env.CORS_ORIGIN);
    }
    let config: GatewayConfig;
    try {
      config = workerConfig(env);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid Worker configuration";
      return cors(
        json(HTTP_INTERNAL_SERVER_ERROR, {
          error: { code: "invalid_configuration", message: detail },
        }),
        env.CORS_ORIGIN,
      );
    }
    const transcribe = upstreamTranscriber(env, fetcher);
    const handler = createGatewayFetchHandler(config, {
      // The shared gateway core deliberately models the platform fetch as
      // async.  Awaiting here also makes synchronous test doubles conform to
      // that contract without changing production behavior.
      fetch: (input, init) => Promise.resolve(fetcher(input, init)),
      ...(transcribe ? { transcribe } : {}),
    });
    return cors(await handler(request), env.CORS_ORIGIN);
  },
});

export default createWorker() as ExportedHandler<Env>;
