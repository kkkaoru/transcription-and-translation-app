// This file runs with bun.
import { Container } from "@cloudflare/containers";

interface Env {
  SNAPSHOT_DIAGNOSTIC: DurableObjectNamespace<SnapshotDiagnosticContainer>;
  SNAPSHOT_DIAGNOSTIC_TOKEN?: string;
}

interface SnapshotDescriptor {
  id: string;
  size: number;
  name: string | null;
}

interface StartupMeasurement {
  startupMs: number;
  completionMs: number;
  marker: string;
  processStartTicks: string;
  bootId: string;
}

export interface ProcessIdentity {
  processStartTicks: string;
  bootId: string;
}

interface SnapshotStep {
  name: string;
  elapsedMs: number;
  detail: string;
}

export interface SnapshotDiagnosticReport {
  recordedAt: string;
  succeeded: boolean;
  snapshotApiAvailable: boolean;
  snapshotCreated: boolean;
  cacheHit: boolean;
  filesystemRestored: boolean;
  vmIdentityRestored: boolean;
  processIdentityRestored: boolean;
  startupAccelerated: boolean;
  firstCompletionAccelerated: boolean;
  snapshot: SnapshotDescriptor | null;
  initial: StartupMeasurement | null;
  coldControl: StartupMeasurement | null;
  snapshotRestore: StartupMeasurement | null;
  snapshotCreationMs: number | null;
  cachePutMs: number | null;
  cacheMatchMs: number | null;
  startupDeltaMs: number | null;
  startupDeltaPercent: number | null;
  completionDeltaMs: number | null;
  completionDeltaPercent: number | null;
  error: string | null;
  steps: SnapshotStep[];
}

interface StartOptions {
  container: globalThis.Container;
  snapshot?: ContainerSnapshot;
}

interface ProcessOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface AttemptResult<T> {
  value: T | null;
  error: string | null;
}

const DIAGNOSTIC_INSTANCE_ID = "snapshot-capability-probe-v1";
const RUN_PATH = "/run";
const LAST_REPORT_PATH = "/last";
const LAST_REPORT_STORAGE_KEY = "last-snapshot-diagnostic-report";
const SNAPSHOT_MARKER_PATH = "/snapshot-poc-marker";
const SNAPSHOT_START_TICKS_PATH = "/snapshot-poc-start-ticks";
const SNAPSHOT_BOOT_ID_PATH = "/snapshot-poc-boot-id";
const CACHE_NAME = "zenz-container-snapshot-diagnostic";
const CACHE_TTL_SECONDS = 600;
const LLAMA_PORT = 8080;
const READY_ATTEMPTS = 200;
const READY_INTERVAL_MS = 100;
const MAX_OUTPUT_CHARACTERS = 4_096;
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
const COMPLETION_BODY = JSON.stringify({
  prompt: "test",
  n_predict: 1,
  temperature: 0,
});
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const elapsedSince = (startedAt: number): number => Math.max(0, performance.now() - startedAt);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const attempt = async <T>(operation: () => Promise<T>): Promise<AttemptResult<T>> =>
  operation()
    .then((value) => ({ value, error: null }))
    .catch((error: unknown) => ({ value: null, error: errorMessage(error) }));

const boundedText = (bytes: ArrayBuffer): string =>
  TEXT_DECODER.decode(bytes).slice(0, MAX_OUTPUT_CHARACTERS);

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

export const parseSnapshotDescriptor = (value: unknown): SnapshotDescriptor | null => {
  if (typeof value !== "object" || value === null) return null;
  if (!("id" in value) || typeof value.id !== "string") return null;
  if (!("size" in value) || typeof value.size !== "number") return null;
  if (!("name" in value) || (typeof value.name !== "string" && value.name !== null)) return null;
  return { id: value.id, size: value.size, name: value.name };
};

export const startupDeltaPercent = (coldMs: number, restoredMs: number): number =>
  coldMs === 0 ? 0 : ((coldMs - restoredMs) / coldMs) * 100;

export const identitiesMatch = (original: ProcessIdentity, restored: ProcessIdentity): boolean =>
  original.bootId !== "missing" &&
  original.processStartTicks !== "missing" &&
  original.bootId === restored.bootId &&
  original.processStartTicks === restored.processStartTicks;

const exec = async (container: globalThis.Container, argv: string[]): Promise<ProcessOutput> => {
  const process = await container.exec(argv, { stdout: "pipe", stderr: "pipe" });
  const output = await process.output();
  return {
    exitCode: output.exitCode,
    stdout: boundedText(output.stdout),
    stderr: boundedText(output.stderr),
  };
};

const waitForHealth = async (
  container: globalThis.Container,
  remainingAttempts: number,
): Promise<void> => {
  try {
    const response = await container.getTcpPort(LLAMA_PORT).fetch("http://container/health");
    if (response.ok) return;
  } catch (error) {
    if (remainingAttempts <= 1) throw error;
  }
  if (remainingAttempts <= 1) throw new Error("llama-server health check timed out");
  await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
  await waitForHealth(container, remainingAttempts - 1);
};

const readProcessEvidence = async (container: globalThis.Container): Promise<ProcessOutput> =>
  exec(container, [
    "/bin/sh",
    "-c",
    `printf 'marker='; cat ${SNAPSHOT_MARKER_PATH} 2>/dev/null || printf 'missing'; printf '\nprocess_start_ticks='; cut -d ' ' -f 22 /proc/1/stat; printf '\nboot_id='; cat /proc/sys/kernel/random/boot_id`,
  ]);

const parseEvidence = (output: string, key: string): string =>
  output
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1)
    .trim() ?? "missing";

const runCompletion = async (container: globalThis.Container): Promise<number> => {
  const startedAt = performance.now();
  const response = await container.getTcpPort(LLAMA_PORT).fetch("http://container/completion", {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: COMPLETION_BODY,
  });
  if (!response.ok) throw new Error(`llama completion failed with HTTP ${response.status}`);
  await response.text();
  return elapsedSince(startedAt);
};

const startAndMeasure = async (options: StartOptions): Promise<StartupMeasurement> => {
  const startedAt = performance.now();
  options.container.start({
    entrypoint: LLAMA_ENTRYPOINT,
    enableInternet: false,
    ...(options.snapshot ? { containerSnapshot: options.snapshot } : {}),
  });
  await waitForHealth(options.container, READY_ATTEMPTS);
  const startupMs = elapsedSince(startedAt);
  const [completionMs, evidence] = await Promise.all([
    runCompletion(options.container),
    readProcessEvidence(options.container),
  ]);
  if (evidence.exitCode !== 0) {
    throw new Error(`process evidence failed: ${evidence.stderr}`);
  }
  return {
    startupMs,
    completionMs,
    marker: parseEvidence(evidence.stdout, "marker"),
    processStartTicks: parseEvidence(evidence.stdout, "process_start_ticks"),
    bootId: parseEvidence(evidence.stdout, "boot_id"),
  };
};

const writeSnapshotEvidence = async (
  container: globalThis.Container,
  marker: string,
): Promise<ProcessIdentity> => {
  const output = await exec(container, [
    "/bin/sh",
    "-c",
    `printf '%s' "$1" >${SNAPSHOT_MARKER_PATH}; cut -d ' ' -f 22 /proc/1/stat >${SNAPSHOT_START_TICKS_PATH}; cat /proc/sys/kernel/random/boot_id >${SNAPSHOT_BOOT_ID_PATH}; printf 'process_start_ticks='; cat ${SNAPSHOT_START_TICKS_PATH}; printf '\nboot_id='; cat ${SNAPSHOT_BOOT_ID_PATH}`,
    "snapshot-poc",
    marker,
  ]);
  if (output.exitCode !== 0) throw new Error(`snapshot marker creation failed: ${output.stderr}`);
  return {
    processStartTicks: parseEvidence(output.stdout, "process_start_ticks"),
    bootId: parseEvidence(output.stdout, "boot_id"),
  };
};

const destroyContainer = async (container: globalThis.Container): Promise<void> => {
  if (!container.running) return;
  await container.destroy();
};

const snapshotToDescriptor = (snapshot: ContainerSnapshot): SnapshotDescriptor => ({
  id: snapshot.id,
  size: snapshot.size,
  name: snapshot.name ?? null,
});

const descriptorToSnapshot = (snapshot: SnapshotDescriptor): ContainerSnapshot => ({
  id: snapshot.id,
  size: snapshot.size,
  ...(snapshot.name ? { name: snapshot.name } : {}),
});

const cacheSnapshot = async (
  cacheKey: string,
  snapshot: SnapshotDescriptor,
): Promise<{ cachePutMs: number; cacheMatchMs: number; snapshot: SnapshotDescriptor }> => {
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(cacheKey);
  const putStartedAt = performance.now();
  await cache.put(
    cacheKey,
    new Response(JSON.stringify(snapshot), {
      headers: {
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
        "content-type": "application/json",
      },
    }),
  );
  const cachePutMs = elapsedSince(putStartedAt);
  const matchStartedAt = performance.now();
  const cached = await cache.match(cacheKey);
  const cacheMatchMs = elapsedSince(matchStartedAt);
  if (!cached) throw new Error("Cloudflare Cache did not return the stored snapshot handle");
  const parsed: unknown = JSON.parse(await cached.text());
  const restoredSnapshot = parseSnapshotDescriptor(parsed);
  if (!restoredSnapshot) throw new Error("Cloudflare Cache returned an invalid snapshot handle");
  return { cachePutMs, cacheMatchMs, snapshot: restoredSnapshot };
};

const stepElapsed = (steps: readonly SnapshotStep[], name: string): number | null =>
  steps.find((step) => step.name === name)?.elapsedMs ?? null;

const failureReport = (error: unknown, steps: SnapshotStep[]): SnapshotDiagnosticReport => ({
  recordedAt: new Date().toISOString(),
  succeeded: false,
  snapshotApiAvailable: steps.some((step) => step.name === "snapshot-api-available"),
  snapshotCreated: steps.some((step) =>
    ["snapshot-created", "directory-snapshot-created"].includes(step.name),
  ),
  cacheHit: steps.some((step) => step.name === "cache-hit"),
  filesystemRestored: false,
  vmIdentityRestored: false,
  processIdentityRestored: false,
  startupAccelerated: false,
  firstCompletionAccelerated: false,
  snapshot: null,
  initial: null,
  coldControl: null,
  snapshotRestore: null,
  snapshotCreationMs: null,
  cachePutMs: stepElapsed(steps, "cache-put"),
  cacheMatchMs: stepElapsed(steps, "cache-hit"),
  startupDeltaMs: null,
  startupDeltaPercent: null,
  completionDeltaMs: null,
  completionDeltaPercent: null,
  error: errorMessage(error),
  steps,
});

export class SnapshotDiagnosticContainer extends Container<Env> {
  sleepAfter = "30s";
  enableInternet = false;
  entrypoint = LLAMA_ENTRYPOINT;

  private async executeBenchmark(
    cacheKey: string,
    steps: SnapshotStep[],
  ): Promise<SnapshotDiagnosticReport> {
    const container = this.ctx.container;
    if (!container) throw new Error("Cloudflare Container runtime is unavailable");
    if (typeof container.snapshotContainer !== "function") {
      throw new Error("Cloudflare runtime does not expose container.snapshotContainer()");
    }
    steps.push({
      name: "snapshot-api-available",
      elapsedMs: 0,
      detail: "snapshotContainer,snapshotDirectory",
    });
    try {
      const cacheProbe = await cacheSnapshot(cacheKey, {
        id: "synthetic-cache-round-trip",
        size: 0,
        name: "cache-probe",
      });
      steps.push({ name: "cache-put", elapsedMs: cacheProbe.cachePutMs, detail: "metadata" });
      steps.push({ name: "cache-hit", elapsedMs: cacheProbe.cacheMatchMs, detail: "metadata" });
      const initial = await startAndMeasure({ container });
      steps.push({ name: "initial-start", elapsedMs: initial.startupMs, detail: "HTTP 200" });
      const marker = crypto.randomUUID();
      const originalIdentity = await writeSnapshotEvidence(container, marker);
      const snapshotStartedAt = performance.now();
      const containerSnapshotAttempt = await attempt(() =>
        container.snapshotContainer({ name: `zenz-xsmall-${Date.now()}` }),
      );
      if (!containerSnapshotAttempt.value) {
        const directorySnapshotAttempt = await attempt(() =>
          container.snapshotDirectory({
            dir: "/tmp",
            name: `zenz-xsmall-tmp-${Date.now()}`,
          }),
        );
        if (directorySnapshotAttempt.value) {
          steps.push({
            name: "directory-snapshot-created",
            elapsedMs: elapsedSince(snapshotStartedAt),
            detail: directorySnapshotAttempt.value.id,
          });
        }
        const directoryResult = directorySnapshotAttempt.value
          ? `succeeded with id ${directorySnapshotAttempt.value.id}`
          : `failed: ${directorySnapshotAttempt.error}`;
        throw new Error(
          `snapshotContainer failed: ${containerSnapshotAttempt.error}; snapshotDirectory ${directoryResult}`,
        );
      }
      const nativeSnapshot = containerSnapshotAttempt.value;
      const snapshotCreationMs = elapsedSince(snapshotStartedAt);
      const snapshot = snapshotToDescriptor(nativeSnapshot);
      steps.push({ name: "snapshot-created", elapsedMs: snapshotCreationMs, detail: snapshot.id });
      const cached = await cacheSnapshot(cacheKey, snapshot);
      steps.push({ name: "cache-hit", elapsedMs: cached.cacheMatchMs, detail: cached.snapshot.id });
      await destroyContainer(container);
      const coldControl = await startAndMeasure({ container });
      steps.push({ name: "cold-control", elapsedMs: coldControl.startupMs, detail: "HTTP 200" });
      await destroyContainer(container);
      const snapshotRestore = await startAndMeasure({
        container,
        snapshot: descriptorToSnapshot(cached.snapshot),
      });
      steps.push({
        name: "snapshot-restore",
        elapsedMs: snapshotRestore.startupMs,
        detail: "HTTP 200",
      });
      const filesystemRestored = snapshotRestore.marker === marker;
      const restoredIdentity: ProcessIdentity = {
        processStartTicks: snapshotRestore.processStartTicks,
        bootId: snapshotRestore.bootId,
      };
      const vmIdentityRestored =
        originalIdentity.bootId !== "missing" &&
        originalIdentity.bootId === restoredIdentity.bootId;
      const processIdentityRestored = identitiesMatch(originalIdentity, restoredIdentity);
      const snapshotPathMs = snapshotRestore.startupMs + cached.cacheMatchMs;
      const startupDeltaMs = coldControl.startupMs - snapshotPathMs;
      const completionDeltaMs = coldControl.completionMs - snapshotRestore.completionMs;
      return {
        recordedAt: new Date().toISOString(),
        succeeded: true,
        snapshotApiAvailable: true,
        snapshotCreated: true,
        cacheHit: true,
        filesystemRestored,
        vmIdentityRestored,
        processIdentityRestored,
        startupAccelerated: startupDeltaMs > 0,
        firstCompletionAccelerated: completionDeltaMs > 0,
        snapshot,
        initial,
        coldControl,
        snapshotRestore,
        snapshotCreationMs,
        cachePutMs: cached.cachePutMs,
        cacheMatchMs: cached.cacheMatchMs,
        startupDeltaMs,
        startupDeltaPercent: startupDeltaPercent(coldControl.startupMs, snapshotPathMs),
        completionDeltaMs,
        completionDeltaPercent: startupDeltaPercent(
          coldControl.completionMs,
          snapshotRestore.completionMs,
        ),
        error: null,
        steps,
      };
    } finally {
      await destroyContainer(container);
    }
  }

  async runBenchmark(cacheKey: string): Promise<SnapshotDiagnosticReport> {
    const steps: SnapshotStep[] = [];
    const report = await this.executeBenchmark(cacheKey, steps).catch((error: unknown) =>
      failureReport(error, steps),
    );
    await this.ctx.storage.put(LAST_REPORT_STORAGE_KEY, report);
    return report;
  }

  async getLastReport(): Promise<SnapshotDiagnosticReport | null> {
    return (await this.ctx.storage.get<SnapshotDiagnosticReport>(LAST_REPORT_STORAGE_KEY)) ?? null;
  }

  async onActivityExpired(): Promise<void> {
    await this.destroy();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    const isRunRequest = url.pathname === RUN_PATH && request.method === "POST";
    const isLastReportRequest = url.pathname === LAST_REPORT_PATH && request.method === "GET";
    if (!isRunRequest && !isLastReportRequest) {
      return Response.json({ error: "POST /run or GET /last is required" }, { status: 404 });
    }
    const token = env.SNAPSHOT_DIAGNOSTIC_TOKEN;
    if (!token) {
      return Response.json(
        { error: "Snapshot diagnostic token is not configured" },
        { status: 503 },
      );
    }
    if (!(await authorized(request, token))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const diagnostic = env.SNAPSHOT_DIAGNOSTIC.getByName(DIAGNOSTIC_INSTANCE_ID);
    const cacheKey = new URL("/__snapshot-cache/v1", request.url).toString();
    return Response.json(
      isRunRequest ? await diagnostic.runBenchmark(cacheKey) : await diagnostic.getLastReport(),
    );
  },
} satisfies ExportedHandler<Env>;
