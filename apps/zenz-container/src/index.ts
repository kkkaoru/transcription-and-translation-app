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

interface ContainerRoute {
  container: DurableObjectStub<ZenzContainer>;
  upstreamPath: string;
  n5Enabled: boolean;
}

type ComputeTier = "basic" | "standard";
type ModelSize = "small" | "xsmall";
type N5Mode = "n5-off" | "n5-on";

const HEALTH_PATH = "/health";
const RELEASE_PATH = "/release";
const N5_PREFIX = "/n5";
const N5_PORT = 8081;
const HEALTH_RETRY_COUNT = 180;
const HEALTH_RETRY_DELAY_MS = 500;
const SLEEP_AFTER = "1m";
const DEFAULT_PORT = 8080;
const PATH_PATTERN = /^\/(basic|standard)\/(small|xsmall)\/(n5-off|n5-on)(\/.*)?$/;
const llamaArguments = (contextSize: number, threads: number): string[] => [
  "--host",
  "0.0.0.0",
  "--port",
  String(DEFAULT_PORT),
  "--ctx-size",
  String(contextSize),
  "--parallel",
  "1",
  "--threads",
  String(threads),
  "--no-mmap",
];
const standardEntrypoint: string[] = [
  "/usr/local/bin/zenz-entrypoint",
  "/usr/local/bin/llama-server",
  "--model",
  "/models/model.gguf",
  ...llamaArguments(1024, 2),
];
const basicEntrypoint: string[] = [
  "/usr/local/bin/zenz-entrypoint",
  "/usr/local/bin/llama-server",
  "--model",
  "/models/model.gguf",
  ...llamaArguments(256, 1),
];

export abstract class ZenzContainer extends Container {
  defaultPort = DEFAULT_PORT;
  requiredPorts = [DEFAULT_PORT];
  pingEndpoint = "localhost/health";
  sleepAfter = SLEEP_AFTER;
  enableInternet = false;
  entrypoint = standardEntrypoint;

  override async onActivityExpired(): Promise<void> {
    await this.destroy();
  }
}

export class ZenzBasicSmallN5OffContainer extends ZenzContainer {
  override entrypoint = basicEntrypoint;
}
export class ZenzBasicSmallN5OnContainer extends ZenzContainer {
  override entrypoint = basicEntrypoint;
  override requiredPorts = [DEFAULT_PORT, N5_PORT];
}
export class ZenzBasicXsmallN5OffContainer extends ZenzContainer {
  override entrypoint = basicEntrypoint;
}
export class ZenzBasicXsmallN5OnContainer extends ZenzContainer {
  override entrypoint = basicEntrypoint;
  override requiredPorts = [DEFAULT_PORT, N5_PORT];
}
export class ZenzStandardSmallN5OffContainer extends ZenzContainer {}
export class ZenzStandardSmallN5OnContainer extends ZenzContainer {
  override requiredPorts = [DEFAULT_PORT, N5_PORT];
}
export class ZenzStandardXsmallN5OffContainer extends ZenzContainer {}
export class ZenzStandardXsmallN5OnContainer extends ZenzContainer {
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

const containerRoute = (pathname: string, env: Env): ContainerRoute | undefined => {
  const match = PATH_PATTERN.exec(pathname);
  if (!match) return undefined;
  const tier: ComputeTier = match[1] === "basic" ? "basic" : "standard";
  const model: ModelSize = match[2] === "small" ? "small" : "xsmall";
  const n5Mode: N5Mode = match[3] === "n5-on" ? "n5-on" : "n5-off";
  return {
    container: selectedContainer(env, tier, model, n5Mode),
    upstreamPath: match[4] || HEALTH_PATH,
    n5Enabled: n5Mode === "n5-on",
  };
};

const waitUntilReady = async (
  container: DurableObjectStub<ZenzContainer>,
  request: Request,
): Promise<Response | undefined> => {
  for (let attempt = 0; attempt < HEALTH_RETRY_COUNT; attempt += 1) {
    const response = await container.fetch(request);
    if (response.ok) return response;
    await response.body?.cancel();
    await scheduler.wait(HEALTH_RETRY_DELAY_MS);
  }
  return undefined;
};

const releaseContainer = async (container: DurableObjectStub<ZenzContainer>): Promise<Response> => {
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
    const isN5Request = route.upstreamPath.startsWith(N5_PREFIX);
    if (isN5Request && !route.n5Enabled) {
      return Response.json({ error: "N5 LM is disabled for this profile" }, { status: 409 });
    }
    url.pathname = isN5Request
      ? route.upstreamPath.slice(N5_PREFIX.length) || HEALTH_PATH
      : route.upstreamPath;
    const healthUrl = new URL(url);
    healthUrl.pathname = HEALTH_PATH;
    const healthRequest = new Request(healthUrl, { method: "GET" });
    const port = isN5Request ? N5_PORT : DEFAULT_PORT;
    const healthResponse = await waitUntilReady(route.container, switchPort(healthRequest, port));
    if (!healthResponse) {
      return Response.json({ error: "selected container did not become ready" }, { status: 503 });
    }
    if (url.pathname === HEALTH_PATH) return healthResponse;
    await healthResponse.body?.cancel();
    return route.container.fetch(switchPort(new Request(url, request), port));
  },
} satisfies ExportedHandler<Env>;
