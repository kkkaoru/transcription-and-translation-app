#!/usr/bin/env node

/**
 * Cross-layer recognition verification runner.
 *
 * The default lane is deterministic and safe to run in CI: desktop, Worker,
 * and inference-gateway tests/typechecks run concurrently.  Optional lanes
 * exercise the real Parapper WebSocket, browser screenshots, a packaged
 * Tauri app, a deployed Worker, and the future AzooKey comparison app.
 * Every command writes its complete output below the report directory and the
 * final JSON report records pass/fail/skipped/blocked without hiding failures.
 *
 * Usage:
 *   node scripts/recognition-integration.mjs
 *   node scripts/recognition-integration.mjs --ws --coverage
 *   node scripts/recognition-integration.mjs --ui --tauri
 *   node scripts/recognition-integration.mjs --worker-url https://...
 *
 * Output defaults to /tmp/kotoba-recognition-integration-<timestamp>.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const valueFor = (flag, fallback = null) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = path.resolve(
  valueFor("--out-dir", process.env.RECOGNITION_INTEGRATION_OUT_DIR) ||
    path.join(os.tmpdir(), `kotoba-recognition-integration-${timestamp}`),
);
fs.mkdirSync(outputDirectory, { recursive: true });

const results = [];
const notes = [];
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}`,
  outputDirectory,
  flags: {
    websocket: hasFlag("--ws") || hasFlag("--require-ws"),
    requireWebsocket: hasFlag("--require-ws"),
    coverage: hasFlag("--coverage"),
    ui: hasFlag("--ui"),
    tauri: hasFlag("--tauri"),
    remoteWorker: Boolean(valueFor("--worker-url", process.env.RECOGNITION_WORKER_URL)),
  },
  results,
  notes,
};

const log = (line) => {
  console.log(line);
  fs.appendFileSync(path.join(outputDirectory, "integration.log"), `${line}\n`);
};

const record = (name, status, detail = "", extra = {}) => {
  const entry = {
    name,
    status,
    ok: status === "pass" || status === "skipped",
    ...(detail ? { detail } : {}),
    ...extra,
  };
  results.push(entry);
  const label = status.toUpperCase().padEnd(7);
  log(`${label} ${name}${detail ? ` — ${detail}` : ""}`);
  return entry;
};

const note = (message) => {
  notes.push(message);
  log(`INFO    ${message}`);
};

const tail = (value, max = 1_200) => {
  const text = String(value || "").trim();
  return text.length > max ? `…${text.slice(-max)}` : text;
};

const runCommand = (name, command, args, options = {}) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: { ...process.env, CI: process.env.CI || "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timeoutMs = options.timeoutMs || 180_000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        name,
        code: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
      });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        name,
        code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });
  });

const writeCommandLog = (name, result) => {
  const safeName = name.replace(/[^a-z0-9._-]+/gi, "-");
  fs.writeFileSync(
    path.join(outputDirectory, `${safeName}.log`),
    `${result.stdout || ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`,
  );
};

const runRequiredCommand = async (spec) => {
  const result = await runCommand(spec.name, spec.command, spec.args, spec);
  writeCommandLog(spec.name, result);
  const detail = result.timedOut
    ? `timeout after ${spec.timeoutMs || 180_000}ms`
    : result.code === 0
      ? `${result.durationMs}ms`
      : `exit=${result.code ?? "spawn-error"}; ${tail(result.stderr || result.stdout)}`;
  record(spec.name, result.code === 0 ? "pass" : "fail", detail, {
    command: [spec.command, ...spec.args].join(" "),
    durationMs: result.durationMs,
    logFile: path.join(outputDirectory, `${spec.name.replace(/[^a-z0-9._-]+/gi, "-")}.log`),
  });
  return result;
};

const baselineCommands = [
  {
    name: "desktop recognition modes and unit tests",
    command: "bun",
    args: ["--filter=@caption-bridge/desktop", "run", "test", "--", "--reporter=dot"],
    timeoutMs: 180_000,
  },
  {
    name: "desktop typecheck",
    command: "bun",
    args: ["--filter=@caption-bridge/desktop", "run", "typecheck"],
    timeoutMs: 120_000,
  },
  {
    name: "Worker tests",
    command: "bun",
    args: ["run", "worker:test", "--", "--reporter=dot"],
    timeoutMs: 120_000,
  },
  {
    name: "Worker typecheck",
    command: "bun",
    args: ["run", "worker:typecheck"],
    timeoutMs: 120_000,
  },
  {
    name: "inference gateway tests",
    command: "bun",
    args: ["--filter=@caption-bridge/inference-gateway", "run", "test", "--", "--reporter=dot"],
    timeoutMs: 120_000,
  },
];

const comparisonAppDirectory = path.join(repoRoot, "apps", "azookey-compare");
const readComparisonPackage = () => {
  if (!fs.existsSync(comparisonAppDirectory)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(comparisonAppDirectory, "package.json"), "utf8"));
  } catch {
    return null;
  }
};

const comparisonAppCommands = () => {
  if (!fs.existsSync(comparisonAppDirectory)) {
    record(
      "AzooKey comparison app",
      "skipped",
      "apps/azookey-compare is not present yet; no app was inferred or generated",
    );
    return [];
  }
  const packageJson = readComparisonPackage();
  if (!packageJson) {
    record("AzooKey comparison app", "fail", "package.json could not be read");
    return [];
  }
  const commands = [];
  for (const [script, label] of [
    ["typecheck", "typecheck"],
    ["test", "tests"],
  ]) {
    if (typeof packageJson.scripts?.[script] !== "string") {
      record(
        `AzooKey comparison app ${label}`,
        "skipped",
        `package script ${script} is not defined`,
      );
      continue;
    }
    commands.push({
      name: `AzooKey comparison app ${label}`,
      command: "bun",
      args: ["run", script, ...(script === "test" ? ["--", "--reporter=dot"] : [])],
      cwd: comparisonAppDirectory,
      timeoutMs: 120_000,
    });
  }
  return commands;
};

const comparisonAppCoverageCommand = () => {
  const packageJson = readComparisonPackage();
  if (!packageJson) return null;
  if (typeof packageJson.scripts?.["test:coverage"] !== "string") {
    record(
      "AzooKey comparison app coverage",
      "skipped",
      "package script test:coverage is not defined",
    );
    return null;
  }
  return {
    name: "AzooKey comparison app coverage",
    command: "bun",
    args: ["run", "test:coverage", "--", "--reporter=dot"],
    cwd: comparisonAppDirectory,
    timeoutMs: 180_000,
    summaryPath: path.join(comparisonAppDirectory, "coverage", "coverage-summary.json"),
    coverageKey: "azookeyCompare",
  };
};

const loadWebSocket = async () => {
  const candidates = [
    path.join(repoRoot, "apps", "inference-gateway", "node_modules", "ws", "index.js"),
    path.join(repoRoot, "node_modules", ".bun", "node_modules", "ws", "index.js"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const loaded = await import(pathToFileURL(candidate).href);
      return loaded.default || loaded.WebSocket || loaded;
    } catch {
      // Try the next workspace installation.
    }
  }
  return null;
};

const probeParapperWebSocket = async () => {
  const url = valueFor(
    "--ws-url",
    process.env.PARAPPER_WS_URL || "ws://127.0.0.1:18082/ws/recognition",
  );
  const WebSocket = await loadWebSocket();
  if (!WebSocket) {
    record(
      "Parapper WebSocket protocol probe",
      hasFlag("--require-ws") ? "fail" : "skipped",
      "ws package is not installed",
    );
    return;
  }
  const sessionId = `integration-${Date.now().toString(36)}`;
  const messages = [];
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // Best effort; the timeout is the evidence.
      }
      finish();
    }, 10_000);
    const close = () => {
      clearTimeout(timer);
      finish();
    };
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          version: 1,
          type: "session.start",
          session_id: sessionId,
          audio: { encoding: "pcm_s16le", sample_rate: 16_000, channels: 1 },
        }),
      );
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      messages.push(message);
      if (message.type === "session.ready") {
        socket.send(JSON.stringify({ version: 1, type: "session.stop", session_id: sessionId }));
      } else if (message.type === "session.done") {
        close();
        try {
          socket.close();
        } catch {
          // Already done.
        }
      } else if (message.type === "error" && message.fatal) {
        close();
        try {
          socket.close();
        } catch {
          // Already done.
        }
      }
    });
    socket.on("error", close);
    socket.on("close", close);
  });
  const types = messages.map((message) => message.type);
  const ready = types.includes("session.ready");
  const done = types.includes("session.done");
  const ok = ready && done;
  const detail = `${url}; events=${types.join(",") || "none"}`;
  record(
    "Parapper WebSocket protocol probe",
    ok ? "pass" : hasFlag("--require-ws") ? "fail" : "skipped",
    detail,
    {
      sessionId,
      events: types,
    },
  );
};

const probeRemoteWorker = async () => {
  const url = valueFor("--worker-url", process.env.RECOGNITION_WORKER_URL);
  if (!url) return;
  const endpoint = `${url.replace(/\/$/u, "")}/health`;
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
    const body = await response.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    record(
      "deployed Worker health",
      response.ok && json?.status === "ok" ? "pass" : "fail",
      `${response.status} ${body.slice(0, 240)}`,
      { url: endpoint },
    );
  } catch (error) {
    record(
      "deployed Worker health",
      "fail",
      error instanceof Error ? error.message : String(error),
      { url: endpoint },
    );
  }
};

const runOptionalUi = async () => {
  if (!hasFlag("--ui")) return;
  const result = await runRequiredCommand({
    name: "browser UI screenshots",
    command: "node",
    args: ["scripts/capture-ui-screenshots.mjs", "--exercise-recovery"],
    timeoutMs: 180_000,
    env: { CB_OUT_DIR: path.join(outputDirectory, "browser-ui") },
  });
  if (result.code !== 0)
    note("UI screenshot lane requires an already-running Vite server and Playwright Chromium");
};

const runOptionalTauri = async () => {
  if (!hasFlag("--tauri")) return;
  await runRequiredCommand({
    name: "Tauri packaged app smoke",
    command: "node",
    args: [
      "scripts/tauri-smoke.mjs",
      "--build",
      "--ui",
      "--exercise-capture",
      "--out-dir",
      path.join(outputDirectory, "tauri"),
    ],
    timeoutMs: 900_000,
  });
};

const main = async () => {
  // Baseline checks are independent and intentionally start together.
  await Promise.all([...baselineCommands, ...comparisonAppCommands()].map(runRequiredCommand));

  if (hasFlag("--coverage")) {
    const desktopCoverage = {
      name: "desktop coverage",
      command: "bun",
      args: ["--filter=@caption-bridge/desktop", "run", "test:coverage", "--", "--reporter=dot"],
      timeoutMs: 180_000,
      summaryPath: path.join(repoRoot, "apps", "desktop", "coverage", "coverage-summary.json"),
      coverageKey: "desktop",
    };
    const workerCoverage = {
      name: "Worker coverage",
      command: "bun",
      args: ["--cwd=apps/cloudflare-worker-server", "run", "test:coverage", "--", "--reporter=dot"],
      timeoutMs: 180_000,
      summaryPath: path.join(
        repoRoot,
        "apps",
        "cloudflare-worker-server",
        "coverage",
        "coverage-summary.json",
      ),
      coverageKey: "worker",
    };
    const coverageSpecs = [desktopCoverage, workerCoverage];
    const compareCoverage = comparisonAppCoverageCommand();
    if (compareCoverage) coverageSpecs.push(compareCoverage);
    const coverageResults = await Promise.all(coverageSpecs.map(runRequiredCommand));
    report.coverage = {};
    for (const [index, spec] of coverageSpecs.entries()) {
      const coverage = coverageResults[index];
      if (fs.existsSync(spec.summaryPath)) {
        try {
          report.coverage[spec.coverageKey] = JSON.parse(fs.readFileSync(spec.summaryPath, "utf8"));
          note(`${spec.name} summary copied from ${spec.summaryPath}`);
          if (coverage.code !== 0) {
            note(`${spec.name} exited non-zero; the summary is retained for threshold diagnostics`);
          }
        } catch (error) {
          record(
            `${spec.name} summary`,
            "fail",
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        record(
          `${spec.name} summary`,
          "fail",
          `${spec.name} did not produce coverage-summary.json`,
        );
      }
    }
  }

  if (hasFlag("--ws") || hasFlag("--require-ws")) await probeParapperWebSocket();
  await probeRemoteWorker();
  await runOptionalUi();
  await runOptionalTauri();

  report.finishedAt = new Date().toISOString();
  report.failed = results.filter((entry) => entry.status === "fail").map((entry) => entry.name);
  report.blocked = results.filter((entry) => entry.status === "blocked").map((entry) => entry.name);
  report.skipped = results.filter((entry) => entry.status === "skipped").map((entry) => entry.name);
  const reportPath = path.join(outputDirectory, "report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log(`REPORT  ${reportPath}`);
  process.exitCode = report.failed.length > 0 ? 1 : 0;
};

await main();
