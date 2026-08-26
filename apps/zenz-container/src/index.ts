// This file runs with bun.
import { Container, getContainer, switchPort } from "@cloudflare/containers";

interface Env {
  ZENZ_BASIC_SMALL_N5_OFF: DurableObjectNamespace<ZenzBasicSmallN5OffContainer>;
  ZENZ_BASIC_SMALL_N5_ON: DurableObjectNamespace<ZenzBasicSmallN5OnContainer>;
  ZENZ_BASIC_XSMALL_N5_OFF: DurableObjectNamespace<ZenzBasicXsmallN5OffContainer>;
  ZENZ_BASIC_XSMALL_N5_ON: DurableObjectNamespace<ZenzBasicXsmallN5OnContainer>;
  ZENZ_STANDARD_SMALL_N5_OFF: DurableObjectNamespace<ZenzStandardSmallN5OffContainer>;
  ZENZ_STANDARD_SMALL_N5_ON: DurableObjectNamespace<ZenzStandardSmallN5OnContainer>;
  ZENZ_STANDARD_XSMALL_N5_OFF: DurableObjectNamespace<ZenzStandardXsmallN5OffContainer>;
  ZENZ_STANDARD_XSMALL_N5_ON: DurableObjectNamespace<ZenzStandardXsmallN5OnContainer>;
}

export interface ContainerStub {
  fetch(request: Request): Promise<Response>;
  destroy(): Promise<void>;
}

interface ContainerRoute {
  container: ContainerStub;
  upstreamPath: string;
  n5Enabled: boolean;
}

export interface ParsedContainerRoute {
  tier: ComputeTier;
  model: ModelSize;
  n5Mode: N5Mode;
  upstreamPath: string;
}

interface LlamaRuntimeOptions {
  contextSize: number;
  threads: number;
  batchSize: number;
  supervised: boolean;
}

export interface WarmupTarget {
  path: string;
  port: number;
  body: string;
}

interface ContainerFetchOptions {
  container: ContainerStub;
  request: Request;
  port: number;
}

interface DeadlineFetchOptions extends ContainerFetchOptions {
  deadline: Promise<void>;
}

interface WarmContainerOptions {
  route: ContainerRoute;
  url: URL;
  ggufEnabled: boolean;
}

type ComputeTier = "basic" | "standard";
type ModelSize = "small" | "xsmall";
type N5Mode = "n5-off" | "n5-on";

const HEALTH_PATH = "/health";
const RELEASE_PATH = "/release";
const WARMUP_PATH = "/warmup";
const N5_ONLY_WARMUP_PATH = "/n5-warmup";
const COMPLETION_PATH = "/completion";
const N5_PREFIX = "/n5";
const N5_RESCORE_PATH = "/rescore";
const N5_PORT = 8081;
const CONTAINER_TIMING_HEADER = "x-kotoba-container-headers-ms";
const CONTAINER_FETCH_TIMEOUT_MS = 90_000;
const SLEEP_AFTER = "30s";
const DEFAULT_PORT = 8080;
const PATH_PATTERN = /^\/(basic|standard)\/(small|xsmall)\/(n5-off|n5-on)(\/.*)?$/;
const LLAMA_SERVER = "/usr/local/bin/llama-server";
const ZENZ_ENTRYPOINT = "/usr/local/bin/zenz-entrypoint";
const MODEL_PATH = "/models/model.gguf";
const MODEL_WARMUP_BODY = JSON.stringify({
  prompt: "\u{EE00}テスト\u{EE01}",
  n_predict: 1,
  temperature: 0,
  cache_prompt: true,
});
const N5_WARMUP_BODY = JSON.stringify({ text: "テスト" });
const llamaEntrypoint = (options: LlamaRuntimeOptions): string[] => [
  ...(options.supervised ? [ZENZ_ENTRYPOINT, LLAMA_SERVER] : [LLAMA_SERVER]),
  "--model",
  MODEL_PATH,
  "--host",
  "0.0.0.0",
  "--port",
  String(DEFAULT_PORT),
  "--ctx-size",
  String(options.contextSize),
  "--batch-size",
  String(options.batchSize),
  "--ubatch-size",
  String(options.batchSize),
  "--parallel",
  "1",
  "--threads",
  String(options.threads),
  "--threads-batch",
  String(options.threads),
  "--no-webui",
];
const STANDARD_ENTRYPOINT: string[] = llamaEntrypoint({
  contextSize: 256,
  threads: 2,
  batchSize: 256,
  supervised: false,
});
const STANDARD_N5_ENTRYPOINT: string[] = llamaEntrypoint({
  contextSize: 256,
  threads: 2,
  batchSize: 256,
  supervised: true,
});
const BASIC_ENTRYPOINT: string[] = llamaEntrypoint({
  contextSize: 256,
  threads: 1,
  batchSize: 256,
  supervised: false,
});
const BASIC_N5_ENTRYPOINT: string[] = llamaEntrypoint({
  contextSize: 256,
  threads: 1,
  batchSize: 256,
  supervised: true,
});

export abstract class ZenzContainer extends Container {
  defaultPort = DEFAULT_PORT;
  requiredPorts = [DEFAULT_PORT];
  pingEndpoint = "localhost/health";
  sleepAfter = SLEEP_AFTER;
  enableInternet = false;
  entrypoint = STANDARD_ENTRYPOINT;

  override async onActivityExpired(): Promise<void> {
    // Do not use the library default (graceful SIGTERM): idle inference
    // containers have no state to flush and must release compute immediately.
    await this.destroy();
  }
}

export class ZenzBasicSmallN5OffContainer extends ZenzContainer {
  override entrypoint = BASIC_ENTRYPOINT;
}
export class ZenzBasicSmallN5OnContainer extends ZenzContainer {
  override entrypoint = BASIC_N5_ENTRYPOINT;
  override requiredPorts = [DEFAULT_PORT, N5_PORT];
}
export class ZenzBasicXsmallN5OffContainer extends ZenzContainer {
  override entrypoint = BASIC_ENTRYPOINT;
}
export class ZenzBasicXsmallN5OnContainer extends ZenzContainer {
  override entrypoint = BASIC_N5_ENTRYPOINT;
  override requiredPorts = [DEFAULT_PORT, N5_PORT];
}
export class ZenzStandardSmallN5OffContainer extends ZenzContainer {}
export class ZenzStandardSmallN5OnContainer extends ZenzContainer {
  override entrypoint = STANDARD_N5_ENTRYPOINT;
  override requiredPorts = [DEFAULT_PORT, N5_PORT];
}
export class ZenzStandardXsmallN5OffContainer extends ZenzContainer {}
export class ZenzStandardXsmallN5OnContainer extends ZenzContainer {
  override entrypoint = STANDARD_N5_ENTRYPOINT;
  override requiredPorts = [DEFAULT_PORT, N5_PORT];
}

const selectedContainer = (
  env: Env,
  tier: ComputeTier,
  model: ModelSize,
  n5Mode: N5Mode,
): DurableObjectStub<ZenzContainer> => {
  const key = `${tier}:${model}:${n5Mode}`;
  const containers = new Map<string, DurableObjectStub<ZenzContainer>>([
    ["basic:small:n5-off", getContainer(env.ZENZ_BASIC_SMALL_N5_OFF, key)],
    ["basic:small:n5-on", getContainer(env.ZENZ_BASIC_SMALL_N5_ON, key)],
    ["basic:xsmall:n5-off", getContainer(env.ZENZ_BASIC_XSMALL_N5_OFF, key)],
    ["basic:xsmall:n5-on", getContainer(env.ZENZ_BASIC_XSMALL_N5_ON, key)],
    ["standard:small:n5-off", getContainer(env.ZENZ_STANDARD_SMALL_N5_OFF, key)],
    ["standard:small:n5-on", getContainer(env.ZENZ_STANDARD_SMALL_N5_ON, key)],
    ["standard:xsmall:n5-off", getContainer(env.ZENZ_STANDARD_XSMALL_N5_OFF, key)],
    ["standard:xsmall:n5-on", getContainer(env.ZENZ_STANDARD_XSMALL_N5_ON, key)],
  ]);
  const container = containers.get(key);
  if (!container) {
    throw new Error("Container profile is not configured");
  }
  return container;
};

export const parseContainerRoute = (pathname: string): ParsedContainerRoute | undefined => {
  const match = PATH_PATTERN.exec(pathname);
  if (!match) return undefined;
  return {
    tier: match[1] === "basic" ? "basic" : "standard",
    model: match[2] === "small" ? "small" : "xsmall",
    n5Mode: match[3] === "n5-on" ? "n5-on" : "n5-off",
    upstreamPath: match[4] || HEALTH_PATH,
  };
};

const containerRoute = (pathname: string, env: Env): ContainerRoute | undefined => {
  const profile = parseContainerRoute(pathname);
  return profile
    ? {
        container: selectedContainer(env, profile.tier, profile.model, profile.n5Mode),
        upstreamPath: profile.upstreamPath,
        n5Enabled: profile.n5Mode === "n5-on",
      }
    : undefined;
};

// Container.fetch already starts the instance and waits for its configured
// ports. A separate /health fetch doubled the Durable Object proxy work on
// every hot completion without adding readiness guarantees.
export const fetchContainerBeforeDeadline = async (
  options: DeadlineFetchOptions,
): Promise<Response> => {
  const fetchPromise = options.container.fetch(switchPort(options.request, options.port));
  const timeoutPromise = options.deadline.then(() => undefined);
  try {
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (!response) {
      throw new Error(
        `Container request exceeded ${String(CONTAINER_FETCH_TIMEOUT_MS)}ms and was killed`,
      );
    }
    if (response.status < 500) return response;
    await response.body?.cancel();
    throw new Error(`Container returned ${String(response.status)} and was killed`);
  } catch (error) {
    await options.container.destroy();
    throw error;
  }
};

const fetchContainer = async (options: ContainerFetchOptions): Promise<Response> => {
  const deadlineController = new AbortController();
  try {
    return await fetchContainerBeforeDeadline({
      ...options,
      deadline: scheduler.wait(CONTAINER_FETCH_TIMEOUT_MS, {
        signal: deadlineController.signal,
      }),
    });
  } finally {
    deadlineController.abort();
  }
};

const fetchContainerWithMetrics = async (
  options: ContainerFetchOptions & { profile: ParsedContainerRoute },
): Promise<Response> => {
  const startedAt = performance.now();
  try {
    const response = await fetchContainer(options);
    const elapsedMs = Math.max(0, performance.now() - startedAt);
    // biome-ignore lint/suspicious/noConsole: Workers Observability ingests structured JSON logs
    console.log(
      JSON.stringify({
        event: "zenz_container_metrics",
        tier: options.profile.tier,
        model: options.profile.model,
        n5Mode: options.profile.n5Mode,
        path: options.profile.upstreamPath,
        elapsedMs,
        status: response.status,
        outcome: "completed",
      }),
    );
    const headers = new Headers(response.headers);
    headers.set(CONTAINER_TIMING_HEADER, String(elapsedMs));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    const elapsedMs = Math.max(0, performance.now() - startedAt);
    // biome-ignore lint/suspicious/noConsole: Workers Observability ingests structured JSON logs
    console.error(
      JSON.stringify({
        event: "zenz_container_metrics",
        tier: options.profile.tier,
        model: options.profile.model,
        n5Mode: options.profile.n5Mode,
        path: options.profile.upstreamPath,
        elapsedMs,
        status: 503,
        outcome: "killed",
        error: error instanceof Error ? error.message : "Unknown container failure",
      }),
    );
    return Response.json(
      { error: "selected container failed and was killed", elapsedMs },
      { status: 503, headers: { [CONTAINER_TIMING_HEADER]: String(elapsedMs) } },
    );
  }
};

export const warmupTargets = (options: {
  n5Enabled: boolean;
  ggufEnabled: boolean;
}): WarmupTarget[] => [
  ...(options.ggufEnabled
    ? [{ path: COMPLETION_PATH, port: DEFAULT_PORT, body: MODEL_WARMUP_BODY }]
    : []),
  ...(options.n5Enabled ? [{ path: N5_RESCORE_PATH, port: N5_PORT, body: N5_WARMUP_BODY }] : []),
];

const warmContainer = async (options: WarmContainerOptions): Promise<Response> => {
  const startedAt = performance.now();
  try {
    const responses = await Promise.all(
      warmupTargets({
        n5Enabled: options.route.n5Enabled,
        ggufEnabled: options.ggufEnabled,
      }).map((target) => {
        const targetUrl = new URL(options.url);
        targetUrl.pathname = target.path;
        return fetchContainer({
          container: options.route.container,
          request: new Request(targetUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: target.body,
          }),
          port: target.port,
        });
      }),
    );
    const failed = responses.find((response) => !response.ok);
    await Promise.all(responses.map((response) => response.body?.cancel()));
    if (failed) {
      await options.route.container.destroy();
      return Response.json({ error: "selected container warm-up failed" }, { status: 503 });
    }
    return Response.json({
      ok: true,
      warmed: warmupTargets({
        n5Enabled: options.route.n5Enabled,
        ggufEnabled: options.ggufEnabled,
      }).map((target) => (target.port === N5_PORT ? "n5" : "gguf")),
      elapsedMs: performance.now() - startedAt,
    });
  } catch (error) {
    return Response.json(
      {
        error: "selected container warm-up failed and was killed",
        detail: error instanceof Error ? error.message : "Unknown container failure",
        elapsedMs: Math.max(0, performance.now() - startedAt),
      },
      { status: 503 },
    );
  }
};

const releaseContainer = async (container: ContainerStub): Promise<Response> => {
  await container.destroy();
  return Response.json({ ok: true, state: "destroyed" });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = containerRoute(url.pathname, env);
    if (!route) {
      return Response.json(
        { error: "path must select compute tier, model size, and N5 mode" },
        { status: 404 },
      );
    }
    if (route.upstreamPath === RELEASE_PATH) return releaseContainer(route.container);
    if (route.upstreamPath === WARMUP_PATH) {
      return warmContainer({ route, url, ggufEnabled: true });
    }
    if (route.upstreamPath === N5_ONLY_WARMUP_PATH && route.n5Enabled) {
      return warmContainer({ route, url, ggufEnabled: false });
    }
    const isN5Request = route.upstreamPath.startsWith(N5_PREFIX);
    if (isN5Request && !route.n5Enabled) {
      return Response.json({ error: "N5 LM is disabled for this profile" }, { status: 409 });
    }
    url.pathname = isN5Request
      ? route.upstreamPath.slice(N5_PREFIX.length) || HEALTH_PATH
      : route.upstreamPath;
    const port = isN5Request ? N5_PORT : DEFAULT_PORT;
    const profile = parseContainerRoute(new URL(request.url).pathname);
    if (!profile) throw new Error("Container profile disappeared after route validation");
    return await fetchContainerWithMetrics({
      container: route.container,
      request: new Request(url, request),
      port,
      profile,
    });
  },
} satisfies ExportedHandler<Env>;
