// This file runs with bun.
import {
  AZOOKEY_DICTIONARY_CONFIG_KEYS,
  AZOOKEY_DICTIONARY_KIND,
  DICTIONARY_WARM_MOMENT,
  VIBRATO_IPADIC_KIND,
} from "@caption-bridge/dictionaries";
import type { GatewayConfig, UserLexiconRpc } from "@caption-bridge/inference-server-core";
import {
  correlationHeadersFromRequest,
  createGatewayFetchHandler,
  createMemoryUserLexicon,
  createUserLexiconEntryId,
  GatewayError,
  pcm16ToWav,
  USER_LEXICON_DO_NAME,
  validateGatewayConfig,
} from "@caption-bridge/inference-server-core";
import vibratoWasm from "../wasm/vibrato_wasm_bg.wasm";
import {
  AZOOKEY_MAX_TEXT_BYTES,
  AZOOKEY_MODE,
  AZOOKEY_MODEL,
  AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED,
  AZOOKEY_PROTOCOL,
  AZOOKEY_WS_PATH,
  type AzookeyFetcher,
  type AzookeyMessage,
  AzookeyProtocolError,
  type AzookeyRequestDependencies,
  advertisedConvertModels,
  azookeyDictionaryTimeoutMs,
  azookeyTimeoutMs,
  BROWSER_VIBRATO_MODE,
  byteLimitTransform,
  collectStream,
  convertAzookeyMessage,
  convertTextWithStoredUserLexicon,
  createVibratoWasmConverter,
  createWasmConverter,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_SWITCHING_PROTOCOLS,
  openAzookeySocket,
  parseModelRoutes,
  warmZenzUpstreams,
  wrapUserLexiconWrites,
} from "./azookey.js";
import azookeyWasm from "./azookey-wasm.js";
import {
  type ProfileConversionInput,
  ProfileConverterDO,
  type ProfileConverterRpc,
} from "./profile-converter-do.js";
import { UserLexiconDO } from "./user-lexicon-do.js";

export { ProfileConverterDO, UserLexiconDO };

import {
  createWorkersAiAsrTranscriber,
  handleWorkersAiAsrTranscription,
  WORKERS_AI_ASR_HTTP_PATH,
  type WorkersAiAsrEnvironment,
  type WorkersAiAsrRun,
} from "./workers-ai-asr.js";
import {
  handleWorkersAiSpeechPipeline,
  WORKERS_AI_SPEECH_PIPELINE_ID,
  WORKERS_AI_SPEECH_PIPELINE_PATH,
} from "./workers-ai-speech-pipeline.js";
import {
  parseConversionModel,
  parseZenzContainerProfile,
  type ZenzContainerProfile,
  type ZenzConversionModel,
  zenzCompletionTokenBudget,
  zenzContainerBaseUrl,
} from "./zenz-container-profile.js";

export interface Env {
  AI?: Ai;
  ASR_API_TOKEN?: string;
  ASR_PROVIDER?: string;
  ASR_UPSTREAM_URL?: string;
  AZOOKEY_API_TOKEN?: string;
  AZOOKEY_DICTIONARY_URL?: string;
  AZOOKEY_DICTIONARY_TIMEOUT_MS?: string;
  AZOOKEY_TIMEOUT_MS?: string;
  USER_LEXICON?: {
    idFromName: (name: string) => { toString: () => string };
    get: (id: { toString: () => string }) => UserLexiconRpc;
  };
  PROFILE_CONVERTER?: {
    idFromName: (name: string) => { toString: () => string };
    get: (id: { toString: () => string }) => ProfileConverterRpc;
  };
  AZOOKEY_PROFILE_DO?: string;
  USER_LEXICON_IMPORTS?: {
    put: (key: string, value: string) => Promise<unknown>;
    get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
    delete: (key: string) => Promise<unknown>;
  };
  USER_LEXICON_IMPORT_QUEUE?: {
    send: (message: { importId: string }) => Promise<void>;
  };
  WORKERS_AI_ASR_TIMEOUT_MS?: string;
  VIBRATO_UPSTREAM_URL?: string;
  VIBRATO_API_TOKEN?: string;
  VIBRATO_DICTIONARY_URL?: string;
  CORS_ORIGIN?: string;
  MODEL_ROUTES: string;
  ASSETS?: WorkerAssets;
  ZENZ_GGUF?: WorkerAssets;
}

export interface WorkerAssets {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface WorkerQueueMessage {
  body: { importId: string };
}

export interface WorkerQueueBatch {
  messages: readonly WorkerQueueMessage[];
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerHandler {
  fetch(request: Request, env: Env, ctx?: WorkerExecutionContext): Promise<Response>;
  queue: (batch: WorkerQueueBatch, env: Env) => Promise<void>;
}

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_GATEWAY = 502;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const LOCAL_GATEWAY_HOST = "127.0.0.1";
const LOCAL_GATEWAY_PORT = 8765;
const DEFAULT_PARAPPER_TIMEOUT_MS = 18_000;
/** Upper bound for the parapper ASR upstream JSON body before it is parsed. */
const ASR_MAX_RESPONSE_BYTES = 65_536;
const PIPELINE_STANDARD_AZOOKEY_TIMEOUT_MS = 4_500;
const PIPELINE_STANDARD_ZENZ_TIMEOUT_MS = 3_500;
const PIPELINE_BASIC_AZOOKEY_TIMEOUT_MS = 4_500;
const PIPELINE_BASIC_ZENZ_TIMEOUT_MS = 3_500;
const PIPELINE_DICTIONARY_FALLBACK_TIMEOUT_MS = 3_000;
const PROFILE_CONVERTER_ENABLED = "on";
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

const profileFormFromSearch = (url: URL): FormData => {
  const form = new FormData();
  for (const key of ["conversionModel", "computeTier", "containerModel", "n5Lm"]) {
    const value = url.searchParams.get(key);
    if (value !== null) form.set(key, value);
  }
  return form;
};

const containerServiceOrigin = (
  env: Env,
  conversionModel: ZenzConversionModel,
): string | undefined => {
  const routes = parseModelRoutes(env.MODEL_ROUTES);
  const route =
    conversionModel === "zenz-v3.2-small-gguf"
      ? routes["zenz-v3.2-small-gguf"]
      : routes["zenz-v3.2-xsmall-gguf"];
  return route?.baseUrl;
};

const profileBaseUrl = (
  env: Env,
  conversionModel: ZenzConversionModel,
  profile: ZenzContainerProfile,
): string | undefined => {
  const origin = containerServiceOrigin(env, conversionModel);
  return origin ? zenzContainerBaseUrl(origin, profile) : undefined;
};

const parseN5Response = async (
  response: Response,
): Promise<{ text: string; elapsedMs: number }> => {
  const value: unknown = await response.json();
  if (
    !response.ok ||
    typeof value !== "object" ||
    value === null ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    !("elapsedMs" in value) ||
    typeof value.elapsedMs !== "number" ||
    !Number.isFinite(value.elapsedMs)
  ) {
    throw new Error(`Input N5 LM returned ${String(response.status)}`);
  }
  return { text: value.text, elapsedMs: Math.max(0, value.elapsedMs) };
};

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
  headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
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

const workersAiEnvironment = (env: Env): WorkersAiAsrEnvironment => {
  const aiBinding = env.AI;
  return {
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
                  audio: { ...input.audio, body: input.audio.body as unknown as object },
                },
                options,
              ),
          },
        }
      : {}),
  };
};

const userLexiconFor = (
  env: Env,
  dependencies: WorkerDependencies,
  memoryLexicon: UserLexiconRpc,
): UserLexiconRpc => {
  if (dependencies.userLexicon) {
    return wrapUserLexiconWrites(dependencies.userLexicon);
  }
  if (env.USER_LEXICON) {
    return wrapUserLexiconWrites(
      env.USER_LEXICON.get(env.USER_LEXICON.idFromName(USER_LEXICON_DO_NAME)),
    );
  }
  return wrapUserLexiconWrites(memoryLexicon);
};

const profileConverterFor = (
  env: Env,
  profile: ZenzContainerProfile,
): ProfileConverterRpc | undefined => {
  if (env.AZOOKEY_PROFILE_DO !== PROFILE_CONVERTER_ENABLED || !env.PROFILE_CONVERTER) {
    return undefined;
  }
  const name = `${profile.computeTier}:${profile.modelSize}:${profile.n5Mode}`;
  return env.PROFILE_CONVERTER.get(env.PROFILE_CONVERTER.idFromName(name));
};

const dictionaryFetchersFor = (
  requestUrl: string,
  env: Env,
  dependencies: WorkerDependencies,
  fallbackFetcher: AzookeyFetcher,
): {
  fetcher: AzookeyFetcher;
  vibratoDictionaryFetcher: AzookeyFetcher;
  azookeyDictionaryFetcher: AzookeyFetcher;
} => {
  const platformFetcher = dependencies.fetcher ?? fallbackFetcher;
  const zenzFetcher: AzookeyFetcher = (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    return new URL(request.url).hostname === "zenz.internal" && env.ZENZ_GGUF
      ? env.ZENZ_GGUF.fetch(request)
      : platformFetcher(input, init);
  };
  const assets = env.ASSETS;
  const assetFetcher = assets ? cachedAssetFetcher(assets, requestUrl) : undefined;
  return {
    fetcher: zenzFetcher,
    vibratoDictionaryFetcher:
      dependencies.vibratoDictionaryFetcher ??
      (assetFetcher && env.VIBRATO_DICTIONARY_URL?.trim().startsWith("/")
        ? assetFetcher
        : platformFetcher),
    azookeyDictionaryFetcher:
      dependencies.azookeyDictionaryFetcher ??
      (assetFetcher && env.AZOOKEY_DICTIONARY_URL?.trim().startsWith("/")
        ? assetFetcher
        : platformFetcher),
  };
};

/** Cross-realm-safe brand check for Wrangler compiled-WASM module bindings. */
export const isCompiledWasmModule = (module: WebAssembly.Module): boolean => {
  try {
    WebAssembly.Module.imports(module);
    return true;
  } catch {
    return false;
  }
};

const warmAzookeyIsolate = async (
  requestUrl: string,
  env: Env,
  dependencies: WorkerDependencies,
  fallbackFetcher: AzookeyFetcher,
): Promise<void> => {
  const wasmModule = dependencies.wasmModule ?? azookeyWasm;
  if (!isCompiledWasmModule(wasmModule)) {
    return;
  }
  const fetchers = dictionaryFetchersFor(requestUrl, env, dependencies, fallbackFetcher);
  const converter =
    dependencies.converter ??
    createWasmConverter(
      wasmModule,
      env.AZOOKEY_DICTIONARY_URL,
      fetchers.azookeyDictionaryFetcher,
      azookeyDictionaryTimeoutMs(env),
    );
  await converter.warmup?.("http");
  await warmZenzUpstreams(parseModelRoutes(env.MODEL_ROUTES), fetchers.fetcher);
};

export const createWorker = (
  fetcher: WorkerFetcher = fetch,
  dependencies: WorkerDependencies = {},
): WorkerHandler => {
  const memoryLexicon = createMemoryUserLexicon(createUserLexiconEntryId);
  return {
    async queue(batch, env): Promise<void> {
      const lexicon = userLexiconFor(env, dependencies, memoryLexicon);
      await Promise.all(
        batch.messages.map((message) => lexicon.processQueuedImport(message.body.importId)),
      );
    },
    async fetch(request, env, ctx): Promise<Response> {
      const userLexicon = userLexiconFor(env, dependencies, memoryLexicon);
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
        const availableModels = advertisedConvertModels(parseModelRoutes(env.MODEL_ROUTES));
        const response = cors(
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
              kind: AZOOKEY_DICTIONARY_KIND.system,
              configKey: AZOOKEY_DICTIONARY_CONFIG_KEYS.system,
              warmMoment: DICTIONARY_WARM_MOMENT.workerWebSocketUpgrade,
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
              kind: VIBRATO_IPADIC_KIND,
              warmMoment: DICTIONARY_WARM_MOMENT.workerWebSocketUpgrade,
            },
            modes: {
              worker: AZOOKEY_MODE,
              browser: BROWSER_VIBRATO_MODE,
            },
          }),
          env.CORS_ORIGIN,
        );
        if (ctx) {
          ctx.waitUntil(
            warmAzookeyIsolate(request.url, env, dependencies, fetcher).catch(() => undefined),
          );
        }
        return response;
      }
      if (url.pathname === AZOOKEY_WS_PATH) {
        const fetchers = dictionaryFetchersFor(request.url, env, dependencies, fetcher);
        let response: Response;
        try {
          response = await openAzookeySocket(request, env, {
            ...dependencies,
            fetcher: fetchers.fetcher,
            vibratoDictionaryFetcher: fetchers.vibratoDictionaryFetcher,
            azookeyDictionaryFetcher: fetchers.azookeyDictionaryFetcher,
            wasmModule: dependencies.wasmModule ?? azookeyWasm,
            vibratoWasmModule: dependencies.vibratoWasmModule ?? vibratoWasm,
            userLexicon,
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
      if (url.pathname === WORKERS_AI_ASR_HTTP_PATH) {
        return cors(
          await handleWorkersAiAsrTranscription(request, workersAiEnvironment(env), {
            ...(dependencies.workersAiRun ? { run: dependencies.workersAiRun } : {}),
          }),
          env.CORS_ORIGIN,
        );
      }
      if (url.pathname === WORKERS_AI_SPEECH_PIPELINE_PATH) {
        const fetchers = dictionaryFetchersFor(request.url, env, dependencies, fetcher);
        const wasmModule = dependencies.wasmModule ?? azookeyWasm;
        const converter =
          dependencies.converter ??
          (isCompiledWasmModule(wasmModule)
            ? createWasmConverter(
                wasmModule,
                env.AZOOKEY_DICTIONARY_URL,
                fetchers.azookeyDictionaryFetcher,
                azookeyDictionaryTimeoutMs(env),
              )
            : undefined);
        const vibrato =
          dependencies.vibratoConverter ??
          createVibratoWasmConverter(
            dependencies.vibratoWasmModule ?? vibratoWasm,
            env.VIBRATO_DICTIONARY_URL,
            fetchers.vibratoDictionaryFetcher,
            azookeyDictionaryTimeoutMs(env),
          );
        if (!converter || !vibrato) {
          return cors(
            json(HTTP_INTERNAL_SERVER_ERROR, {
              error: {
                code: "azookey_runtime_failed",
                message: "AzooKey runtime is unavailable",
              },
            }),
            env.CORS_ORIGIN,
          );
        }
        if (request.method === "GET" || request.method === "DELETE") {
          const profileForm = profileFormFromSearch(url);
          const conversionModel = parseConversionModel(profileForm.get("conversionModel"));
          const profile = conversionModel
            ? parseZenzContainerProfile(profileForm, conversionModel)
            : null;
          if (!conversionModel || !profile) {
            return cors(
              json(HTTP_BAD_REQUEST, {
                error: { code: "invalid_container_profile", message: "Unsupported profile" },
              }),
              env.CORS_ORIGIN,
            );
          }
          const needsContainer = conversionModel !== "none" || profile.n5Mode === "on";
          const baseUrl = needsContainer
            ? profileBaseUrl(env, conversionModel, profile)
            : undefined;
          if (needsContainer && !baseUrl) {
            return cors(
              json(HTTP_SERVICE_UNAVAILABLE, {
                error: {
                  code: "conversion_model_unavailable",
                  message: "Container profile route unavailable",
                },
              }),
              env.CORS_ORIGIN,
            );
          }
          if (request.method === "DELETE") {
            if (baseUrl) {
              const releaseResponse = await fetchers.fetcher(`${baseUrl}/release`, {
                method: "DELETE",
              });
              await releaseResponse.body?.cancel();
              if (!releaseResponse.ok) {
                return cors(
                  json(HTTP_SERVICE_UNAVAILABLE, {
                    error: { code: "container_release_failed", message: "Release failed" },
                  }),
                  env.CORS_ORIGIN,
                );
              }
            }
            return cors(json(HTTP_OK, { ok: true, state: "released" }), env.CORS_ORIGIN);
          }
          const warmups: Promise<unknown>[] = [];
          const profileConverter =
            conversionModel === "none" ? undefined : profileConverterFor(env, profile);
          if (conversionModel !== "none") {
            if (profile.computeTier === "basic") {
              warmups.push(
                Promise.resolve(vibrato.warmup?.())
                  .then(() => vibrato.release?.())
                  .then(() => profileConverter?.warmProfile(baseUrl) ?? converter.warmup?.("http")),
              );
            } else {
              warmups.push(
                Promise.resolve(
                  profileConverter?.warmProfile(baseUrl) ?? converter.warmup?.("http"),
                ),
                Promise.resolve(vibrato.warmup?.()),
              );
            }
          }
          if (baseUrl && !profileConverter) {
            const warmupPath = conversionModel === "none" ? "/n5-warmup" : "/warmup";
            warmups.push(
              Promise.resolve(fetchers.fetcher(`${baseUrl}${warmupPath}`)).then(
                async (response) => {
                  await response.body?.cancel();
                  if (!response.ok) {
                    throw new Error(`Container warm-up returned ${String(response.status)}`);
                  }
                },
              ),
            );
          }
          try {
            await Promise.all(warmups);
          } catch (error) {
            const detail = error instanceof Error ? error.message : "Unknown warm-up failure";
            return cors(
              json(HTTP_SERVICE_UNAVAILABLE, {
                error: {
                  code: "container_warmup_failed",
                  message: "Selected Container is unavailable",
                  detail,
                },
              }),
              env.CORS_ORIGIN,
            );
          }
          return cors(
            json(HTTP_OK, {
              ok: true,
              pipeline: WORKERS_AI_SPEECH_PIPELINE_ID,
              conversionModel,
              containerProfile: profile,
            }),
            env.CORS_ORIGIN,
          );
        }
        return cors(
          await handleWorkersAiSpeechPipeline(request, {
            asrEnvironment: workersAiEnvironment(env),
            ...(dependencies.workersAiRun ? { run: dependencies.workersAiRun } : {}),
            vibrato: (text, language) => Promise.resolve(vibrato(text, language)),
            ...(vibrato.release ? { releaseVibrato: vibrato.release } : {}),
            rescoreN5: async (text, profile) => {
              const baseUrl = profileBaseUrl(env, "none", profile);
              if (!baseUrl) throw new Error("Input N5 LM profile is unavailable");
              const profileConverter = profileConverterFor(env, profile);
              if (profileConverter) {
                const result = await profileConverter.rescoreProfile(text, baseUrl);
                return { ...result, model: "input_n5_lm_v1" };
              }
              const response = await fetchers.fetcher(`${baseUrl}/n5/rescore`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text }),
              });
              const result = await parseN5Response(response);
              return { ...result, model: "input_n5_lm_v1" };
            },
            convert: async ({ text, model, leftContext, profile, useUserLexicon }) => {
              const baseUrl = profileBaseUrl(env, model, profile);
              if (!baseUrl) throw new Error("Selected GGUF profile is unavailable");
              const configuredRoutes = parseModelRoutes(env.MODEL_ROUTES);
              const selectedRoute = configuredRoutes[model];
              if (!selectedRoute) throw new Error("Selected GGUF route is unavailable");
              const timeoutMs =
                profile.computeTier === "basic"
                  ? PIPELINE_BASIC_AZOOKEY_TIMEOUT_MS
                  : PIPELINE_STANDARD_AZOOKEY_TIMEOUT_MS;
              const zenzUpstreamMaxMs =
                profile.computeTier === "basic"
                  ? PIPELINE_BASIC_ZENZ_TIMEOUT_MS
                  : PIPELINE_STANDARD_ZENZ_TIMEOUT_MS;
              const profileConverter = profileConverterFor(env, profile);
              if (profileConverter) {
                const profileInput: ProfileConversionInput = {
                  text,
                  model,
                  leftContext,
                  baseUrl,
                  timeoutMs,
                  zenzUpstreamMaxMs,
                  zenzNPredict: zenzCompletionTokenBudget(text, profile.computeTier),
                  fallbackTimeoutMs: PIPELINE_DICTIONARY_FALLBACK_TIMEOUT_MS,
                  useUserLexicon,
                };
                return profileConverter.convertProfile(profileInput);
              }
              const conversionMessage: AzookeyMessage = {
                type: "azookey.convert",
                requestId: crypto.randomUUID(),
                source: "web-speech",
                language: "ja",
                sourceText: text,
                vibratoInput: text,
                mode: AZOOKEY_MODE,
                model,
                leftContext: leftContext || "前文なし",
              };
              const converted = await convertAzookeyMessage(conversionMessage, {
                converter,
                timeoutMs,
                zenzUpstreamMaxMs,
                deferDictionaryUntilZenz: false,
                zenzNPredict: zenzCompletionTokenBudget(text, profile.computeTier),
                modelRoutes: { ...configuredRoutes, [model]: { ...selectedRoute, baseUrl } },
                fetcher: fetchers.fetcher,
                ...(useUserLexicon ? { userLexicon } : {}),
                wsOrHttp: "http",
              }).catch(async (error: unknown) => {
                if (
                  !(error instanceof AzookeyProtocolError) ||
                  error.code !== "conversion_timeout"
                ) {
                  throw error;
                }
                const fallback = await convertAzookeyMessage(
                  { ...conversionMessage, model: AZOOKEY_MODEL },
                  {
                    converter,
                    timeoutMs: PIPELINE_DICTIONARY_FALLBACK_TIMEOUT_MS,
                    fetcher: fetchers.fetcher,
                    ...(useUserLexicon ? { userLexicon } : {}),
                    wsOrHttp: "http",
                  },
                );
                return {
                  ...fallback,
                  requestedModel: model,
                  modelFallback: AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED,
                };
              });
              if (converted.model !== model && !converted.modelFallback) {
                throw new Error(`${model} GGUF completion returned an invalid model`);
              }
              return {
                text: converted.convertedText,
                model: converted.model,
                usedCompletion: converted.usedCompletion,
                ...(converted.modelFallback ? { modelFallback: converted.modelFallback } : {}),
              };
            },
          }),
          env.CORS_ORIGIN,
        );
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
      const transcribe = usesWorkersAiAsr(env.ASR_PROVIDER)
        ? createWorkersAiAsrTranscriber(workersAiEnvironment(env), dependencies.workersAiRun)
        : upstreamTranscriber(env, fetcher);
      const fetchers = dictionaryFetchersFor(request.url, env, dependencies, fetcher);
      const azookeyDictionaryFetcher = fetchers.azookeyDictionaryFetcher;
      const wasmModule = dependencies.wasmModule ?? azookeyWasm;
      const wasmConverter = isCompiledWasmModule(wasmModule)
        ? createWasmConverter(
            wasmModule,
            env.AZOOKEY_DICTIONARY_URL,
            azookeyDictionaryFetcher,
            azookeyDictionaryTimeoutMs(env),
          )
        : undefined;
      const decoder = dependencies.converter ?? wasmConverter;
      const handler = createGatewayFetchHandler(config, {
        // The shared gateway core deliberately models the platform fetch as
        // async.  Awaiting here also makes synchronous test doubles conform to
        // that contract without changing production behavior.
        fetch: (input, init) => Promise.resolve(fetcher(input, init)),
        ...(transcribe ? { transcribe } : {}),
        userLexicon,
        ...(decoder
          ? {
              convertWithUserLexicon: {
                convert: ({ text }) =>
                  convertTextWithStoredUserLexicon({
                    converter: decoder,
                    lexicon: userLexicon,
                    text,
                  }),
              },
            }
          : {}),
      });
      return cors(await handler(request), env.CORS_ORIGIN);
    },
  };
};

export default createWorker() as ExportedHandler<Env>;
