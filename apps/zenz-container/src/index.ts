// This file runs with bun.
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  ZENZ_SMALL: DurableObjectNamespace<ZenzSmallContainer>;
  ZENZ_XSMALL: DurableObjectNamespace<ZenzXsmallContainer>;
}

const HEALTH_PATH = "/health";
const HEALTH_RETRY_COUNT = 180;
const HEALTH_RETRY_DELAY_MS = 500;

const commonArguments = [
  "--host",
  "0.0.0.0",
  "--port",
  "8080",
  "--ctx-size",
  "1024",
  "--parallel",
  "1",
  "--threads",
  "2",
  "--no-mmap",
];

export class ZenzSmallContainer extends Container {
  defaultPort = 8080;
  pingEndpoint = "localhost/health";
  sleepAfter = "1m";
  enableInternet = false;
  entrypoint = ["/usr/local/bin/llama-server", "--model", "/models/model.gguf", ...commonArguments];
}

export class ZenzXsmallContainer extends Container {
  defaultPort = 8080;
  pingEndpoint = "localhost/health";
  sleepAfter = "1m";
  enableInternet = false;
  entrypoint = ["/usr/local/bin/llama-server", "--model", "/models/model.gguf", ...commonArguments];
}

const modelContainer = (pathname: string, env: Env) =>
  pathname.startsWith("/small/")
    ? getContainer(env.ZENZ_SMALL, "small")
    : pathname.startsWith("/xsmall/")
      ? getContainer(env.ZENZ_XSMALL, "xsmall")
      : undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const container = modelContainer(url.pathname, env);
    if (!container) {
      return Response.json({ error: "model must be small or xsmall" }, { status: 404 });
    }
    url.pathname = url.pathname.replace(/^\/(?:small|xsmall)/, "") || HEALTH_PATH;
    let healthResponse: Response | undefined;
    for (let attempt = 0; attempt < HEALTH_RETRY_COUNT; attempt += 1) {
      const healthUrl = new URL(url);
      healthUrl.pathname = HEALTH_PATH;
      healthResponse = await container.fetch(new Request(healthUrl, { method: "GET" }));
      if (healthResponse.ok) {
        break;
      }
      await healthResponse.body?.cancel();
      healthResponse = undefined;
      await scheduler.wait(HEALTH_RETRY_DELAY_MS);
    }
    if (!healthResponse) {
      return Response.json({ error: "model did not become ready" }, { status: 503 });
    }
    if (url.pathname === HEALTH_PATH) {
      return healthResponse;
    }
    await healthResponse.body?.cancel();
    return container.fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
