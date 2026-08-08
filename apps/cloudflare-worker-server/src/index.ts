import type { GatewayConfig } from "@caption-bridge/inference-server-core";
import {
  correlationHeadersFromRequest,
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
  AZOOKEY_ZENZ_SMALL_MODEL,
  AZOOKEY_ZENZ_XSMALL_MODEL,
  AZOOKEY_WS_PATH,
  type AzookeyFetcher,
  type AzookeyRequestDependencies,
  azookeyDictionaryTimeoutMs,
  azookeyTimeoutMs,
  BROWSER_VIBRATO_MODE,
  byteLimitTransform,
  collectStream,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_SWITCHING_PROTOCOLS,
  openAzookeySocket,
} from "./azookey.js";
import azookeyWasm from "./azookey-wasm.js";
import { createWorkersAiAsrTranscriber, type WorkersAiAsrRun } from "./workers-ai-asr.js";

export interface Env {
  AI?: Ai;
  ASR_API_TOKEN?: string;
  ASR_PROVIDER?: string;
  ASR_UPSTREAM_URL?: string;
  AZOOKEY_API_TOKEN?: string;
  AZOOKEY_DICTIONARY_URL?: string;
  AZOOKEY_DICTIONARY_TIMEOUT_MS?: string;
  AZOOKEY_TIMEOUT_MS?: string;
  WORKERS_AI_ASR_TIMEOUT_MS?: string;
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
/** Upper bound for the parapper ASR upstream JSON body before it is parsed. */
const ASR_MAX_RESPONSE_BYTES = 65_536;
// Keep entrypoint exports limited to the Worker handler/function shapes that
// workerd accepts. Tests use the protocol path literal instead of exporting a
// string binding from the module entrypoint.
const VIBRATO_DICTIONARY_PATH = "/vibrato/system.dic.zst";
const VIBRATO_COPYING_PATH = "/vibrato/COPYING";
const VIBRATO_NOTICE_PATH = "/vibrato/NOTICE";
const AZOOKEY_DICTIONARY_PATH = "/azookey/system.azkdict.gz";
const PUBLIC_ASSET_PATHS = new Set([
  VIBRATO_DICTIONARY_PATH,
  VIBRATO_COPYING_PATH,
  VIBRATO_NOTICE_PATH,
  AZOOKEY_DICTIONARY_PATH,
]);
const assetFetcherCache = new WeakMap<WorkerAssets, AzookeyFetcher>();

const cachedAssetFetcher = (assets: WorkerAssets, requestUrl: string): AzookeyFetcher => {
  const cached = assetFetcherCache.get(assets);
  if (cached) {
    return cached;
  }
  // Asset bindings are deployment-scoped, not host-scoped. Keep one fetcher
  // per binding so custom hostnames share the loaded dictionary, while using a
  // real Worker origin rather than an invented URL for the initial request.
  const origin = new URL(requestUrl).origin;
  const fetcher: AzookeyFetcher = (input, init) => {
    const assetRequest =
      input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), origin), init);
    return assets.fetch(assetRequest);
  };
  assetFetcherCache.set(assets, fetcher);
  return fetcher;
};

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
  workersAiRun?: WorkersAiAsrRun;
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
  headers.set(
    "access-control-allow-headers",
    "content-type, authorization, x-request-id, x-session-id, x-agent-id, x-parent-agent-id",
  );
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return new Response(response.body, { status: response.status, headers });
};

const upstreamTranscriber = (
  env: Env,
  fetcher: WorkerFetcher,
): ((pcm: Uint8Array, signal?: AbortSignal, request?: Request) => Promise<string>) | undefined => {
  const upstreamUrl = env.ASR_UPSTREAM_URL;
  if (!upstreamUrl) {
    return undefined;
  }
  return async (pcm: Uint8Array, signal?: AbortSignal, request?: Request): Promise<string> => {
    const form = new FormData();
    form.set("model", "parapper-ja");
    // Copy into an ArrayBuffer-backed view for the stricter Workers DOM Blob
    // typings (the gateway's Uint8Array may be backed by SharedArrayBuffer).
    form.set(
      "file",
      new File([new Uint8Array(pcm16ToWav(pcm))], "caption.wav", { type: "audio/wav" }),
    );
    let response: Response;
    try {
      response = await fetcher(upstreamUrl, {
        method: "POST",
        body: form,
        headers: {
          ...correlationHeadersFromRequest(request),
          ...(env.ASR_API_TOKEN ? { authorization: `Bearer ${env.ASR_API_TOKEN}` } : {}),
        },
        ...(signal ? { signal } : {}),
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
    if (!response.body) {
      throw new GatewayError(
        HTTP_BAD_GATEWAY,
        "asr_invalid_response",
        "ASR upstream response has no body",
      );
    }
    let payload: unknown;
    try {
      const bounded = response.body.pipeThrough(
        byteLimitTransform(ASR_MAX_RESPONSE_BYTES, "ASR upstream response exceeds the byte limit"),
      );
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await collectStream(bounded)),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "ASR upstream response exceeds the byte limit"
      ) {
        throw new GatewayError(HTTP_BAD_GATEWAY, "asr_invalid_response", error.message);
      }
      throw new GatewayError(
        HTTP_BAD_GATEWAY,
        "asr_invalid_response",
        "ASR upstream response was not valid JSON",
      );
    }
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

const usesWorkersAiAsr = (provider: string | undefined): boolean =>
  provider?.trim().toLowerCase() === "workers-ai";

export const createWorker = (
  fetcher: WorkerFetcher = fetch,
  dependencies: WorkerDependencies = {},
): WorkerHandler => ({
  async fetch(request, env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: HTTP_NO_CONTENT }), env.CORS_ORIGIN);
    }
    const url = new URL(request.url);
    if (env.ASSETS && PUBLIC_ASSET_PATHS.has(url.pathname)) {
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
      const hasVibratoUpstream = Boolean(env.VIBRATO_UPSTREAM_URL?.trim());
      const hasVibratoDictionary = Boolean(env.VIBRATO_DICTIONARY_URL?.trim());
      const hasAzookeyDictionary = Boolean(env.AZOOKEY_DICTIONARY_URL?.trim());
      const modelRoutes = (() => {
        try {
          return JSON.parse(env.MODEL_ROUTES ?? "{}") as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      const availableModels = [
        AZOOKEY_MODEL,
        ...[AZOOKEY_ZENZ_XSMALL_MODEL, AZOOKEY_ZENZ_SMALL_MODEL].filter((id) =>
          Boolean(modelRoutes[id]),
        ),
      ];
      return cors(
        json(HTTP_OK, {
          ok: true,
          service: "azookey",
          protocol: AZOOKEY_PROTOCOL,
          model: AZOOKEY_MODEL,
          models: availableModels,
          websocketPath: AZOOKEY_WS_PATH,
          maxTextBytes: AZOOKEY_MAX_TEXT_BYTES,
          timeoutMs: azookeyTimeoutMs(env),
          auth: {
            scheme: "bearer",
            configured: Boolean(env.AZOOKEY_API_TOKEN?.trim()),
            transport: "authorization-header-or-first-frame",
          },
          dictionary: {
            configured: hasAzookeyDictionary,
            transport: hasAzookeyDictionary ? "portable-wasm" : "builtin",
            fetchTimeoutMs: azookeyDictionaryTimeoutMs(env),
            contract: "official AzooKey LOUDS/MM/CID caption dictionary",
          },
          vibrato: {
            workerStage:
              hasVibratoUpstream || hasVibratoDictionary
                ? "configured"
                : hasAzookeyDictionary
                  ? "passthrough"
                  : "unconfigured",
            transport: hasVibratoUpstream
              ? "http"
              : hasVibratoDictionary
                ? "wasm"
                : hasAzookeyDictionary
                  ? "azookey-mixed-input"
                  : "none",
            contract:
              hasVibratoUpstream || hasVibratoDictionary
                ? "Vibrato reading pre-pass"
                : "mixed Japanese text is converted directly by full AzooKey",
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
      const assetFetcher = assets ? cachedAssetFetcher(assets, request.url) : undefined;
      const vibratoDictionaryFetcher =
        dependencies.vibratoDictionaryFetcher ??
        (assetFetcher && env.VIBRATO_DICTIONARY_URL?.trim().startsWith("/")
          ? assetFetcher
          : fetcher);
      const azookeyDictionaryFetcher =
        dependencies.azookeyDictionaryFetcher ??
        (assetFetcher && env.AZOOKEY_DICTIONARY_URL?.trim().startsWith("/")
          ? assetFetcher
          : fetcher);
      let response: Response;
      try {
        response = await openAzookeySocket(request, env, {
          ...dependencies,
          fetcher,
          vibratoDictionaryFetcher,
          azookeyDictionaryFetcher,
          wasmModule: dependencies.wasmModule ?? azookeyWasm,
          vibratoWasmModule: dependencies.vibratoWasmModule ?? vibratoWasm,
        });
      } catch {
        return cors(
          json(HTTP_INTERNAL_SERVER_ERROR, {
            error: { code: "azookey_runtime_failed", message: "AzooKey runtime is unavailable" },
          }),
          env.CORS_ORIGIN,
        );
      }
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
    const aiBinding = env.AI;
    const transcribe = usesWorkersAiAsr(env.ASR_PROVIDER)
      ? createWorkersAiAsrTranscriber(
          {
            ...(env.WORKERS_AI_ASR_TIMEOUT_MS
              ? { WORKERS_AI_ASR_TIMEOUT_MS: env.WORKERS_AI_ASR_TIMEOUT_MS }
              : {}),
            ...(aiBinding
              ? {
                  AI: {
                    run: (model, input, options) =>
                      aiBinding.run(
                        model,
                        {
                          ...input,
                          // Generated Workers types currently declare Nova-3's
                          // base64 body as object; the binding contract is a
                          // base64 string (matching Cloudflare's adapter).
                          audio: { ...input.audio, body: input.audio.body as unknown as object },
                        },
                        options,
                      ),
                  },
                }
              : {}),
          },
          dependencies.workersAiRun,
        )
      : upstreamTranscriber(env, fetcher);
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
