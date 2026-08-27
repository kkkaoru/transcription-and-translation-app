// This file runs with bun.
import { Container } from "@cloudflare/containers-outbound";

interface Env {
  BAKED_CRIU_BENCHMARK_TOKEN?: string;
  NORMAL_BENCHMARK: DurableObjectNamespace<NormalBenchmarkContainer>;
  NORMAL_NOMMAP_BENCHMARK: DurableObjectNamespace<NormalNommapBenchmarkContainer>;
  BAKED_CRIU_BENCHMARK: DurableObjectNamespace<BakedCriuBenchmarkContainer>;
}

export interface ColdStartMeasurement {
  recordedAt: string;
  mode: "normal" | "normal-nommap" | "baked-criu";
  readyMs: number;
  firstCompletionMs: number;
  totalMs: number;
  healthStatus: number;
  completionStatus: number;
}

interface MeasureOptions {
  mode: ColdStartMeasurement["mode"];
}

const BENCHMARK_INSTANCE_PREFIX = "cold-start-benchmark-v1";
const CRIU_BOOTSTRAP_ERROR_SERVER_ENV = "CRIU_BOOTSTRAP_ERROR_SERVER";
const NORMAL_PATH = "/normal";
const NORMAL_NOMMAP_PATH = "/normal-nommap";
const BAKED_CRIU_PATH = "/baked-criu";
const LLAMA_PORT = 8080;
const TEXT_ENCODER = new TextEncoder();
const COMPLETION_BODY = JSON.stringify({
  prompt: "test",
  n_predict: 1,
  temperature: 0,
});
const BENCHMARK_MODES: ReadonlyMap<string, ColdStartMeasurement["mode"]> = new Map([
  [NORMAL_PATH, "normal"],
  [NORMAL_NOMMAP_PATH, "normal-nommap"],
  [BAKED_CRIU_PATH, "baked-criu"],
]);
const LLAMA_ENTRYPOINT: string[] = [
  "/usr/local/bin/llama-server",
  "--model",
  "/models/model.gguf",
  "--host",
  "0.0.0.0",
  "--port",
  String(LLAMA_PORT),
  "--ctx-size",
  "256",
  "--batch-size",
  "256",
  "--ubatch-size",
  "256",
  "--parallel",
  "1",
  "--threads",
  "1",
  "--threads-batch",
  "1",
  "--no-webui",
  "--no-warmup",
];
const elapsedSince = (startedAt: number): number => Math.max(0, performance.now() - startedAt);

const digestsEqual = (actual: ArrayBuffer, expected: ArrayBuffer): boolean => {
  const expectedBytes = new Uint8Array(expected);
  return (
    new Uint8Array(actual).reduce(
      (difference, byte, index) => difference | (byte ^ expectedBytes[index]),
      0,
    ) === 0
  );
};

const authorized = async (request: Request, expectedToken: string): Promise<boolean> => {
  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(authorization.slice(prefix.length))),
    crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(expectedToken)),
  ]);
  return digestsEqual(actualDigest, expectedDigest);
};

export const fasterMode = (
  normal: ColdStartMeasurement,
  bakedCriu: ColdStartMeasurement,
): ColdStartMeasurement["mode"] => (normal.totalMs <= bakedCriu.totalMs ? "normal" : "baked-criu");

abstract class BenchmarkContainer extends Container<Env> {
  defaultPort = LLAMA_PORT;
  sleepAfter = "30s";
  enableInternet = false;

  async measureColdStart(options: MeasureOptions): Promise<ColdStartMeasurement> {
    const startedAt = performance.now();
    try {
      const health = await this.containerFetch("http://container/health", {}, LLAMA_PORT);
      const readyMs = elapsedSince(startedAt);
      const healthBody = await health.text();
      if (!health.ok) {
        throw new Error(`Health check failed with HTTP ${health.status}: ${healthBody}`);
      }
      const completionStartedAt = performance.now();
      const completion = await this.containerFetch(
        "http://container/completion",
        {
          method: "POST",
          headers: { "content-type": "application/json", connection: "close" },
          body: COMPLETION_BODY,
        },
        LLAMA_PORT,
      );
      await completion.text();
      if (!completion.ok) {
        throw new Error(`Completion failed with HTTP ${completion.status}`);
      }
      return {
        recordedAt: new Date().toISOString(),
        mode: options.mode,
        readyMs,
        firstCompletionMs: elapsedSince(completionStartedAt),
        totalMs: elapsedSince(startedAt),
        healthStatus: health.status,
        completionStatus: completion.status,
      };
    } finally {
      this.ctx.waitUntil(this.destroy());
    }
  }

  async onActivityExpired(): Promise<void> {
    await this.destroy();
  }
}

export class NormalBenchmarkContainer extends BenchmarkContainer {
  entrypoint = LLAMA_ENTRYPOINT;
}

export class NormalNommapBenchmarkContainer extends BenchmarkContainer {
  entrypoint = [...LLAMA_ENTRYPOINT, "--no-mmap"];
}

export class BakedCriuBenchmarkContainer extends BenchmarkContainer {
  envVars = { [CRIU_BOOTSTRAP_ERROR_SERVER_ENV]: "1" };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    const mode = BENCHMARK_MODES.get(url.pathname);
    if (!mode || request.method !== "POST") {
      return Response.json(
        {
          error: "POST /normal, POST /normal-nommap, or POST /baked-criu is required",
        },
        { status: 404 },
      );
    }
    const token = env.BAKED_CRIU_BENCHMARK_TOKEN;
    if (!token) {
      return Response.json({ error: "Benchmark token is not configured" }, { status: 503 });
    }
    if (!(await authorized(request, token))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const benchmarkInstanceId = `${BENCHMARK_INSTANCE_PREFIX}-${crypto.randomUUID()}`;
    if (mode === "normal") {
      const container = env.NORMAL_BENCHMARK.getByName(benchmarkInstanceId);
      return Response.json(await container.measureColdStart({ mode }));
    }
    if (mode === "normal-nommap") {
      const container = env.NORMAL_NOMMAP_BENCHMARK.getByName(benchmarkInstanceId);
      return Response.json(await container.measureColdStart({ mode }));
    }
    const container = env.BAKED_CRIU_BENCHMARK.getByName(benchmarkInstanceId);
    return Response.json(await container.measureColdStart({ mode }));
  },
} satisfies ExportedHandler<Env>;
