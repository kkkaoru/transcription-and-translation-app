// This file runs with bun.
import { Container, ContainerProxy, type OutboundHandler } from "@cloudflare/containers-outbound";

export { ContainerProxy };

interface Env {
  CRIU_CACHE_CHECKPOINTS: R2Bucket;
  CRIU_CACHE_DIAGNOSTIC: DurableObjectNamespace<CriuCacheDiagnosticContainer>;
  CRIU_CACHE_DIAGNOSTIC_TOKEN?: string;
}

interface RestoreMeasurement {
  cacheStatus: string;
  containerStartMs: number;
  restorePipelineMs: number;
  downloadMs: number;
  archiveBytes: number;
  healthStatus: number;
  completionStatus: number;
  stdout: string;
  stderr: string;
}

export interface CriuCacheDiagnosticReport {
  recordedAt: string;
  succeeded: boolean;
  first: RestoreMeasurement | null;
  second: RestoreMeasurement | null;
  workersCacheHit: boolean;
  containerRestarted: boolean;
  restorePipelineDeltaMs: number | null;
  totalReadyDeltaMs: number | null;
  error: string | null;
}

export interface CachedRestoreReport {
  recordedAt: string;
  succeeded: boolean;
  measurement: RestoreMeasurement | null;
  error: string | null;
}

interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

const VIRTUAL_CHECKPOINT_HOST = "checkpoint.r2";
const CHECKPOINT_KEY = "checkpoints/llama-xsmall-amd64-criu-4.2.1.tar.gz";
const CHECKPOINT_PATH = `/${CHECKPOINT_KEY}`;
const CHECKPOINT_SHA256 = "03b99a129b5e64ecf61b78c99bfab081092c120db411141ecdb7d797d9aa9537";
const CACHE_NAME = "zenz-criu-checkpoint-archives";
const CACHE_TTL_SECONDS = 600;
const DIAGNOSTIC_INSTANCE_ID = "criu-workers-cache-probe-v1";
const LAST_REPORT_STORAGE_KEY = "last-criu-workers-cache-report";
const LAST_CACHED_REPORT_STORAGE_KEY = "last-criu-workers-cache-hit-report";
const CACHE_RUN_ID_STORAGE_KEY = "criu-workers-cache-run-id";
const RUN_PATH = "/run";
const CACHED_RUN_PATH = "/cached";
const LAST_REPORT_PATH = "/last";
const LAST_CACHED_REPORT_PATH = "/last-cached";
const MAX_OUTPUT_CHARACTERS = 16_384;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const elapsedSince = (startedAt: number): number => Math.max(0, performance.now() - startedAt);

const boundedText = (bytes: ArrayBuffer): string =>
  TEXT_DECODER.decode(bytes).slice(0, MAX_OUTPUT_CHARACTERS);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

const responseWithCacheStatus = (response: Response, status: "HIT" | "MISS"): Response => {
  const headers = new Headers(response.headers);
  headers.set("x-zenz-workers-cache", status);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const checkpointOutboundHandler: OutboundHandler<Env> = async (request, env) => {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== CHECKPOINT_PATH) {
    return new Response("Not Found", { status: 404 });
  }
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return responseWithCacheStatus(cached, "HIT");
  const checkpoint = await env.CRIU_CACHE_CHECKPOINTS.get(CHECKPOINT_KEY);
  if (!checkpoint) return new Response("Checkpoint not found", { status: 404 });
  const response = new Response(checkpoint.body, {
    headers: {
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "content-length": String(checkpoint.size),
      "content-type": "application/gzip",
      etag: checkpoint.httpEtag,
    },
  });
  await cache.put(request, response.clone());
  return responseWithCacheStatus(response, "MISS");
};

const parseOutputValue = (stdout: string, key: string): string =>
  stdout
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1)
    .trim() ?? "missing";

export const parseOutputNumber = (stdout: string, key: string): number => {
  const parsed = Number(parseOutputValue(stdout, key));
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${key} in restore output`);
  return parsed;
};

const restoreCommand = (runId: string): string[] => [
  "/bin/sh",
  "-c",
  `set -eu
archive=/tmp/criu-workers-cache.tar.gz
root=/tmp/criu-workers-cache
image_dir="$root/criu-llama"
work_dir=/tmp/criu-workers-cache-restore
rm -rf "$archive" "$root" "$work_dir"
mkdir -p "$root" "$work_dir"
restored_pid=
cleanup() {
  if [ -n "$restored_pid" ]; then kill "$restored_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
python3 - <<'PY'
import shutil
import time
import urllib.request

started = time.monotonic()
with urllib.request.urlopen("http://${VIRTUAL_CHECKPOINT_HOST}${CHECKPOINT_PATH}?run=${runId}", timeout=30) as response:
    cache_status = response.headers.get("x-zenz-workers-cache", "missing")
    with open("/tmp/criu-workers-cache.tar.gz", "wb") as archive:
        shutil.copyfileobj(response, archive)
print("workers_cache=" + cache_status)
print("download_ms=" + str(round((time.monotonic() - started) * 1000, 3)))
PY
archive_bytes=$(wc -c <"$archive" | tr -d ' ')
printf 'archive_bytes=%s\n' "$archive_bytes"
echo '${CHECKPOINT_SHA256}  /tmp/criu-workers-cache.tar.gz' | sha256sum -c -
tar -xzf "$archive" -C "$root"
rm "$archive"
if ! setarch x86_64 -R criu restore --images-dir "$image_dir" --work-dir "$work_dir" --shell-job --restore-detached --pidfile "$work_dir/restored.pid" --log-file restore.log --cpu-cap=none -v4; then
  cat "$work_dir/restore.log"
  exit 30
fi
restored_pid=$(cat "$work_dir/restored.pid")
kill -0 "$restored_pid"
python3 - <<'PY'
import json
import time
import urllib.request

for _ in range(40):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=2) as response:
            print("health_status=" + str(response.status))
            break
    except Exception:
        time.sleep(0.25)
else:
    raise RuntimeError("restored llama-server did not become healthy")
body = json.dumps({"prompt": "test", "n_predict": 1, "temperature": 0}).encode()
request = urllib.request.Request(
    "http://127.0.0.1:8080/completion",
    data=body,
    headers={"content-type": "application/json", "connection": "close"},
)
with urllib.request.urlopen(request, timeout=30) as response:
    response.read()
    print("completion_status=" + str(response.status))
PY
kill "$restored_pid"
restored_pid=
trap - EXIT
`,
];

const runRestore = async (
  container: globalThis.Container,
  runId: string,
  containerStartMs: number,
): Promise<RestoreMeasurement> => {
  const startedAt = performance.now();
  const process = await container.exec(restoreCommand(runId), {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await process.output();
  const commandOutput: CommandOutput = {
    exitCode: output.exitCode,
    stdout: boundedText(output.stdout),
    stderr: boundedText(output.stderr),
    elapsedMs: elapsedSince(startedAt),
  };
  if (commandOutput.exitCode !== 0) {
    throw new Error(
      `restore command exited ${commandOutput.exitCode}: ${commandOutput.stderr}${commandOutput.stdout}`,
    );
  }
  return {
    cacheStatus: parseOutputValue(commandOutput.stdout, "workers_cache"),
    containerStartMs,
    restorePipelineMs: commandOutput.elapsedMs,
    downloadMs: parseOutputNumber(commandOutput.stdout, "download_ms"),
    archiveBytes: parseOutputNumber(commandOutput.stdout, "archive_bytes"),
    healthStatus: parseOutputNumber(commandOutput.stdout, "health_status"),
    completionStatus: parseOutputNumber(commandOutput.stdout, "completion_status"),
    stdout: commandOutput.stdout,
    stderr: commandOutput.stderr,
  };
};

export const cacheSequenceSucceeded = (first: string, second: string): boolean =>
  first === "MISS" && second === "HIT";

const failureReport = (error: unknown): CriuCacheDiagnosticReport => ({
  recordedAt: new Date().toISOString(),
  succeeded: false,
  first: null,
  second: null,
  workersCacheHit: false,
  containerRestarted: false,
  restorePipelineDeltaMs: null,
  totalReadyDeltaMs: null,
  error: errorMessage(error),
});

export class CriuCacheDiagnosticContainer extends Container<Env> {
  sleepAfter = "30s";
  enableInternet = false;
  entrypoint = ["/bin/sleep", "infinity"];

  private async startMeasured(): Promise<number> {
    const startedAt = performance.now();
    await this.start();
    return elapsedSince(startedAt);
  }

  private async executeBenchmark(): Promise<CriuCacheDiagnosticReport> {
    const container = this.ctx.container;
    if (!container) throw new Error("Cloudflare Container runtime is unavailable");
    const runId = crypto.randomUUID();
    await this.ctx.storage.put(CACHE_RUN_ID_STORAGE_KEY, runId);
    const firstStartMs = await this.startMeasured();
    const first = await runRestore(container, runId, firstStartMs);
    await this.destroy();
    const secondStartMs = await this.startMeasured();
    const second = await runRestore(container, runId, secondStartMs);
    const restorePipelineDeltaMs = first.restorePipelineMs - second.restorePipelineMs;
    const firstTotalMs = first.containerStartMs + first.restorePipelineMs;
    const secondTotalMs = second.containerStartMs + second.restorePipelineMs;
    return {
      recordedAt: new Date().toISOString(),
      succeeded: cacheSequenceSucceeded(first.cacheStatus, second.cacheStatus),
      first,
      second,
      workersCacheHit: second.cacheStatus === "HIT",
      containerRestarted: true,
      restorePipelineDeltaMs,
      totalReadyDeltaMs: firstTotalMs - secondTotalMs,
      error: cacheSequenceSucceeded(first.cacheStatus, second.cacheStatus)
        ? null
        : `Expected MISS then HIT, received ${first.cacheStatus} then ${second.cacheStatus}`,
    };
  }

  async runBenchmark(): Promise<CriuCacheDiagnosticReport> {
    const report = await this.executeBenchmark().catch((error: unknown) => failureReport(error));
    await this.ctx.storage.put(LAST_REPORT_STORAGE_KEY, report);
    await this.destroy();
    return report;
  }

  async runCachedRestore(): Promise<CachedRestoreReport> {
    const runId = await this.ctx.storage.get<string>(CACHE_RUN_ID_STORAGE_KEY);
    const report = await (async (): Promise<CachedRestoreReport> => {
      if (!runId) throw new Error("Run POST /run before POST /cached");
      const container = this.ctx.container;
      if (!container) throw new Error("Cloudflare Container runtime is unavailable");
      const containerStartMs = await this.startMeasured();
      const measurement = await runRestore(container, runId, containerStartMs);
      if (measurement.cacheStatus !== "HIT") {
        throw new Error(`Expected Workers Cache HIT, received ${measurement.cacheStatus}`);
      }
      return {
        recordedAt: new Date().toISOString(),
        succeeded: true,
        measurement,
        error: null,
      };
    })().catch((error: unknown) => ({
      recordedAt: new Date().toISOString(),
      succeeded: false,
      measurement: null,
      error: errorMessage(error),
    }));
    await this.ctx.storage.put(LAST_CACHED_REPORT_STORAGE_KEY, report);
    await this.destroy();
    return report;
  }

  async getLastReport(): Promise<CriuCacheDiagnosticReport | null> {
    return (await this.ctx.storage.get<CriuCacheDiagnosticReport>(LAST_REPORT_STORAGE_KEY)) ?? null;
  }

  async getLastCachedReport(): Promise<CachedRestoreReport | null> {
    return (
      (await this.ctx.storage.get<CachedRestoreReport>(LAST_CACHED_REPORT_STORAGE_KEY)) ?? null
    );
  }

  async onActivityExpired(): Promise<void> {
    await this.destroy();
  }
}

CriuCacheDiagnosticContainer.outboundByHost = {
  [VIRTUAL_CHECKPOINT_HOST]: checkpointOutboundHandler,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    const isRunRequest = url.pathname === RUN_PATH && request.method === "POST";
    const isCachedRunRequest = url.pathname === CACHED_RUN_PATH && request.method === "POST";
    const isLastReportRequest = url.pathname === LAST_REPORT_PATH && request.method === "GET";
    const isLastCachedReportRequest =
      url.pathname === LAST_CACHED_REPORT_PATH && request.method === "GET";
    if (
      !isRunRequest &&
      !isCachedRunRequest &&
      !isLastReportRequest &&
      !isLastCachedReportRequest
    ) {
      return Response.json(
        { error: "POST /run, POST /cached, GET /last, or GET /last-cached is required" },
        { status: 404 },
      );
    }
    const token = env.CRIU_CACHE_DIAGNOSTIC_TOKEN;
    if (!token) {
      return Response.json(
        { error: "CRIU Cache diagnostic token is not configured" },
        { status: 503 },
      );
    }
    if (!(await authorized(request, token))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const diagnostic = env.CRIU_CACHE_DIAGNOSTIC.getByName(DIAGNOSTIC_INSTANCE_ID);
    if (isRunRequest) return Response.json(await diagnostic.runBenchmark());
    if (isCachedRunRequest) return Response.json(await diagnostic.runCachedRestore());
    return Response.json(
      isLastCachedReportRequest
        ? await diagnostic.getLastCachedReport()
        : await diagnostic.getLastReport(),
    );
  },
} satisfies ExportedHandler<Env>;
