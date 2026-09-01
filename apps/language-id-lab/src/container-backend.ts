// Runs with Bun during build and test.
import { Container, getContainer } from "@cloudflare/containers";
import {
  type ContainerInferenceMethod,
  type ContainerTier,
  inferenceMethod,
  isContainerInferenceMethod,
} from "./inference-methods";

export type ComputeTier = ContainerTier;

interface ParsedLanguageRoute {
  method: ContainerInferenceMethod;
  tier: ContainerTier;
  operation: "health" | "warmup" | "infer" | "reset" | "release";
}

interface ContainerStub {
  startAndWaitForPorts(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  destroy(): Promise<void>;
}

interface ContainerRequestOptions {
  request: Request;
  container: ContainerStub;
  operation: ParsedLanguageRoute["operation"] | "track";
}

interface RustTrackerEnvironment {
  SPEECHBRAIN_ECAPA_BASIC: Env["SPEECHBRAIN_ECAPA_BASIC"];
}

interface RustTrackerRequestOptions {
  env: RustTrackerEnvironment;
  sessionId: string;
  operation: "health" | "track" | "reset";
  body?: string;
}

interface RuntimeScheduler {
  wait(delayMs: number, options: { signal: AbortSignal }): Promise<void>;
}

declare const scheduler: RuntimeScheduler;

const CONTAINER_PORT: number = 8080;
const CONTAINER_IDLE_TIMEOUT: string = "30s";
const CONTAINER_REQUEST_TIMEOUT_MS: number = 90_000;
const SESSION_ID_HEADER: string = "x-kotoba-session-id";
const LANGUAGE_ROUTE_PATTERN: RegExp =
  /^\/api\/language\/(speechbrain-ecapa-basic|speechbrain-ecapa-standard|nvidia-ambernet-basic|nvidia-ambernet-standard)\/(health|warmup|infer|reset|release)$/u;
const SESSION_ID_PATTERN: RegExp = /^[A-Za-z0-9_-]{1,64}$/u;

export abstract class LanguageIdContainer extends Container<Env> {
  defaultPort = CONTAINER_PORT;
  requiredPorts = [CONTAINER_PORT];
  pingEndpoint = "localhost/health";
  sleepAfter = CONTAINER_IDLE_TIMEOUT;
  enableInternet = false;

  override async onActivityExpired(): Promise<void> {
    await this.destroy();
  }
}

export class SpeechbrainEcapaBasicContainer extends LanguageIdContainer {}

export class SpeechbrainEcapaStandardContainer extends LanguageIdContainer {}

export class NvidiaAmbernetBasicContainer extends LanguageIdContainer {}

export class NvidiaAmbernetStandardContainer extends LanguageIdContainer {}

export const parseLanguageRoute = (pathname: string): ParsedLanguageRoute | undefined => {
  const match: RegExpExecArray | null = LANGUAGE_ROUTE_PATTERN.exec(pathname);
  if (match === null || !isContainerInferenceMethod(match[1])) return undefined;
  const method: ContainerInferenceMethod = match[1];
  const definition = inferenceMethod(method);
  if (definition.tier === null) return undefined;
  const tier: ContainerTier = definition.tier;
  const operation = match[2];
  if (
    operation !== "health" &&
    operation !== "warmup" &&
    operation !== "infer" &&
    operation !== "reset" &&
    operation !== "release"
  ) {
    return undefined;
  }
  return { method, tier, operation };
};

export const validSessionId = (value: string | null): value is string =>
  value !== null && SESSION_ID_PATTERN.test(value);

const selectedContainer = (options: {
  env: Env;
  method: ContainerInferenceMethod;
  sessionId: string;
}): ContainerStub => {
  if (options.method === "speechbrain-ecapa-basic") {
    return getContainer(options.env.SPEECHBRAIN_ECAPA_BASIC, options.sessionId);
  }
  if (options.method === "speechbrain-ecapa-standard") {
    return getContainer(options.env.SPEECHBRAIN_ECAPA_STANDARD, options.sessionId);
  }
  if (options.method === "nvidia-ambernet-basic") {
    return getContainer(options.env.NVIDIA_AMBERNET_BASIC, options.sessionId);
  }
  return getContainer(options.env.NVIDIA_AMBERNET_STANDARD, options.sessionId);
};

export const fetchContainerBeforeDeadline = async (
  options: ContainerRequestOptions & { deadline: Promise<void> },
): Promise<Response> => {
  const fetchPromise: Promise<Response> = (async () => {
    await options.container.startAndWaitForPorts();
    return options.container.fetch(options.request);
  })();
  const timeoutPromise: Promise<undefined> = options.deadline.then(() => undefined);
  try {
    const response: Response | undefined = await Promise.race([fetchPromise, timeoutPromise]);
    if (response === undefined) {
      throw new Error(`Language ID Container exceeded ${String(CONTAINER_REQUEST_TIMEOUT_MS)} ms`);
    }
    if (response.status < 500) return response;
    await response.body?.cancel();
    throw new Error(`Language ID Container returned ${String(response.status)}`);
  } catch (error) {
    await options.container.destroy();
    throw error;
  }
};

const proxyContainer = async (options: ContainerRequestOptions): Promise<Response> => {
  const deadlineController = new AbortController();
  try {
    return await fetchContainerBeforeDeadline({
      ...options,
      deadline: scheduler.wait(CONTAINER_REQUEST_TIMEOUT_MS, {
        signal: deadlineController.signal,
      }),
    });
  } finally {
    deadlineController.abort();
  }
};

export const requestRustTracker = (options: RustTrackerRequestOptions): Promise<Response> => {
  const container: ContainerStub = getContainer(
    options.env.SPEECHBRAIN_ECAPA_BASIC,
    options.sessionId,
  );
  const headers = new Headers({ "x-kotoba-session-id": options.sessionId });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return proxyContainer({
    request: new Request(`http://container/${options.operation}`, {
      method: options.operation === "health" ? "GET" : "POST",
      headers,
      body: options.body,
    }),
    container,
    operation: options.operation,
  });
};

export const releaseRustTracker = async (
  env: RustTrackerEnvironment,
  sessionId: string,
): Promise<void> => {
  const container: ContainerStub = getContainer(env.SPEECHBRAIN_ECAPA_BASIC, sessionId);
  await container.destroy();
};

export const handleLanguageContainerRequest = async (
  request: Request,
  env: Env,
): Promise<Response | undefined> => {
  const url = new URL(request.url);
  const route: ParsedLanguageRoute | undefined = parseLanguageRoute(url.pathname);
  if (route === undefined) return undefined;
  const sessionId: string | null = request.headers.get(SESSION_ID_HEADER);
  if (!validSessionId(sessionId)) {
    return Response.json(
      { error: "A valid x-kotoba-session-id header is required" },
      { status: 400 },
    );
  }
  const container: ContainerStub = selectedContainer({
    env,
    method: route.method,
    sessionId,
  });
  if (route.operation === "release") {
    await container.destroy();
    return Response.json({ ok: true, state: "destroyed", idleTimeout: CONTAINER_IDLE_TIMEOUT });
  }
  url.pathname = `/${route.operation}`;
  const startedAt: number = performance.now();
  try {
    const response: Response = await proxyContainer({
      request: new Request(url, request),
      container,
      operation: route.operation,
    });
    const headers = new Headers(response.headers);
    headers.set("x-kotoba-inference-method", route.method);
    headers.set("x-kotoba-container-tier", route.tier);
    headers.set("x-kotoba-container-idle-timeout", CONTAINER_IDLE_TIMEOUT);
    headers.set("x-kotoba-container-elapsed-ms", String(performance.now() - startedAt));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    const message: string = error instanceof Error ? error.message : "Unknown Container failure";
    // biome-ignore lint/suspicious/noConsole: Workers Observability ingests structured failures.
    console.error(
      JSON.stringify({
        event: "language_id_container_failure",
        method: route.method,
        tier: route.tier,
        operation: route.operation,
        elapsedMs: performance.now() - startedAt,
        error: message,
      }),
    );
    return Response.json({ error: message }, { status: 503 });
  }
};
