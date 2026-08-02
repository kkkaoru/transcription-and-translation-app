#!/usr/bin/env node

/**
 * Repeatable AzooKey latency benchmark for the native converter and the local
 * Wrangler/workerd adapter.
 *
 * The benchmark deliberately keeps its input corpus in this file.  That makes
 * a baseline worktree and the current worktree directly comparable even when
 * an older, untracked benchmark harness has disappeared.  Override the
 * corpus with AZOOKEY_BENCH_CASES_JSON when a historical input set is known.
 *
 * Examples:
 *   node scripts/azookey-benchmark.mjs --mode native
 *   node scripts/azookey-benchmark.mjs --source-root /tmp/azookey-baseline
 *   AZOOKEY_BENCH_ITERATIONS=100 node scripts/azookey-benchmark.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

const defaultCases = [
  ["short1", "きょうのてんきはあつい"],
  ["short2", "あしたははれるでしょう"],
  ["short3", "ほんじつのしんぶんをよみます"],
  ["long1", "きょうはよいてんきなのであさからこうえんをさんぽしました。".repeat(2)],
  [
    "long2",
    "おんせいにゅうりょくでしょっちゅうまちがえることばをかくにんしながら、" +
      "あたらしいぶんしょうをゆっくりとはなしてひょうじします。",
  ],
];

const rustString = (value) =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;

const parseArgs = (argv) => {
  const options = {
    mode: "all",
    sourceRoot: repositoryRoot,
    iterations: Number(process.env.AZOOKEY_BENCH_ITERATIONS ?? 100),
    port: Number(process.env.AZOOKEY_BENCH_PORT ?? 8797),
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") {
      options.mode = argv[++index];
    } else if (argument === "--source-root") {
      options.sourceRoot = resolve(argv[++index]);
    } else if (argument === "--iterations") {
      options.iterations = Number(argv[++index]);
    } else if (argument === "--port") {
      options.port = Number(argv[++index]);
    } else if (argument === "--quiet") {
      options.quiet = true;
    } else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/azookey-benchmark.mjs [options]");
      console.log("  --mode native|worker|all     benchmark one or both adapters");
      console.log("  --source-root PATH           worktree to benchmark");
      console.log("  --iterations N               samples per case (default: 100)");
      console.log("  --port N                     local Wrangler port (default: 8797)");
      console.log("  --quiet                      suppress progress messages");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!["native", "worker", "all"].includes(options.mode)) {
    throw new Error(`--mode must be native, worker, or all (got ${options.mode})`);
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 10) {
    throw new Error("--iterations must be an integer >= 10");
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error("--port must be an integer between 1024 and 65535");
  }
  return options;
};

const benchmarkCases = () => {
  const override = process.env.AZOOKEY_BENCH_CASES_JSON;
  if (!override) {
    return defaultCases;
  }
  let parsed;
  try {
    parsed = JSON.parse(override);
  } catch (error) {
    throw new Error(`AZOOKEY_BENCH_CASES_JSON is not valid JSON: ${error.message}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "string" ||
        entry[0].length === 0 ||
        entry[1].length === 0,
    )
  ) {
    throw new Error("AZOOKEY_BENCH_CASES_JSON must be a non-empty [[label, text], ...] array");
  }
  return parsed;
};

const percentile = (samples, quantile) => {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)];
};

const processTreeRssBytes = (rootPid) => {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" });
    const processes = rows
      .trim()
      .split("\n")
      .flatMap((line) => {
        const fields = line.trim().split(/\s+/).map(Number);
        return fields.length === 3 && fields.every(Number.isFinite)
          ? [[fields[0], fields[1], fields[2]]]
          : [];
      });
    const children = new Map();
    for (const [pid, ppid, rssKb] of processes) {
      const list = children.get(ppid) ?? [];
      list.push([pid, rssKb]);
      children.set(ppid, list);
    }
    const queue = [rootPid];
    const seen = new Set();
    let rssKb = 0;
    while (queue.length > 0) {
      const pid = queue.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const current = processes.find(([candidate]) => candidate === pid);
      if (current) rssKb += current[2];
      for (const [childPid] of children.get(pid) ?? []) queue.push(childPid);
    }
    return rssKb * 1024;
  } catch {
    return 0;
  }
};

const sampleRss = (child, state) => {
  const rss = processTreeRssBytes(child.pid);
  if (rss > state.maxRssBytes) state.maxRssBytes = rss;
};

const makeNativeSource = (cases) => `
use caption_bridge_azookey_rust::{AzooKeyDictionary, ConversionOptions, DictionaryPaths, convert_with_dictionary};
use std::hint::black_box;
use std::path::PathBuf;
use std::time::Instant;

const CASES: &[(&str, &str)] = &[${cases
  .map(([label, input]) => `(${rustString(label)}, ${rustString(input)})`)
  .join(",")}];

fn percentile(samples: &[f64], quantile: f64) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() as f64 * quantile).ceil() as usize).saturating_sub(1);
    sorted[index.min(sorted.len() - 1)]
}

fn main() {
    let root = std::env::args().nth(1).expect("dictionary root");
    let iterations: usize = std::env::args()
        .nth(2)
        .expect("iterations")
        .parse()
        .expect("iterations must be an integer");
    let load_started = Instant::now();
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(PathBuf::from(root)),
        ..DictionaryPaths::default()
    }).expect("public AzooKey dictionary should load");
    println!("META\\tdictionaryLoadMs\\t{:.3}\\tpid\\t{}", load_started.elapsed().as_secs_f64() * 1000.0, std::process::id());
    for (label, input) in CASES {
        let _ = black_box(convert_with_dictionary(input, &dictionary, ConversionOptions::default()));
        let mut samples = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            let started = Instant::now();
            let candidates = convert_with_dictionary(input, &dictionary, ConversionOptions::default());
            black_box(candidates);
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        println!("RESULT\\t{}\\t{:.3}\\t{:.3}\\t{}", label, percentile(&samples, 0.50), percentile(&samples, 0.95), samples.len());
    }
}
`;

const commandOutput = async (child) => {
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
  const [result] = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise([{ code, signal }]));
  });
  return { ...result, stdout, stderr };
};

const runNative = async ({ sourceRoot, iterations, cases, quiet }) => {
  const targetDirectory = await mkdtemp(resolve(tmpdir(), "azookey-native-target-"));
  const helperDirectory = await mkdtemp(resolve(tmpdir(), "azookey-native-helper-"));
  const helperSource = resolve(helperDirectory, "main.rs");
  const helperBinary = resolve(helperDirectory, "azookey-native-bench");
  try {
    if (!quiet) console.error(`[native] building release crate in ${sourceRoot}`);
    const build = spawn(
      "cargo",
      [
        "build",
        "--release",
        "--manifest-path",
        resolve(sourceRoot, "packages/azookey-rust/Cargo.toml"),
      ],
      {
        cwd: sourceRoot,
        env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
        stdio: "inherit",
      },
    );
    const buildResult = await new Promise((resolvePromise, reject) => {
      build.once("error", reject);
      build.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    if (buildResult.code !== 0)
      throw new Error(`cargo build failed (${buildResult.code ?? buildResult.signal})`);
    await writeFile(helperSource, makeNativeSource(cases), "utf8");
    const releaseDeps = resolve(targetDirectory, "release", "deps");
    const rlib = execFileSync(
      "find",
      [
        releaseDeps,
        "-maxdepth",
        "1",
        "-name",
        "libcaption_bridge_azookey_rust-*.rlib",
        "-print",
        "-quit",
      ],
      { encoding: "utf8" },
    ).trim();
    if (!rlib) throw new Error(`release rlib not found in ${releaseDeps}`);
    const compile = spawn(
      "rustc",
      [
        "--edition",
        "2021",
        helperSource,
        "-L",
        `dependency=${releaseDeps}`,
        "--extern",
        `caption_bridge_azookey_rust=${rlib}`,
        "-o",
        helperBinary,
      ],
      { cwd: sourceRoot, stdio: "inherit" },
    );
    const compileResult = await new Promise((resolvePromise, reject) => {
      compile.once("error", reject);
      compile.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    if (compileResult.code !== 0)
      throw new Error(
        `rustc benchmark helper failed (${compileResult.code ?? compileResult.signal})`,
      );
    const dictionaryRoot =
      process.env.AZOOKEY_DICTIONARY_ROOT ??
      resolve(sourceRoot, "submodules/azooKey_dictionary_storage/Dictionary");
    const child = spawn(helperBinary, [dictionaryRoot, String(iterations)], {
      cwd: sourceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rssState = { maxRssBytes: 0 };
    sampleRss(child, rssState);
    const rssTimer = setInterval(() => sampleRss(child, rssState), 25);
    const result = await commandOutput(child);
    clearInterval(rssTimer);
    sampleRss(child, rssState);
    if (result.code !== 0)
      throw new Error(
        `native benchmark failed (${result.code ?? result.signal}): ${result.stderr}`,
      );
    const metrics = { dictionaryLoadMs: null, maxRssBytes: rssState.maxRssBytes, cases: {} };
    for (const line of result.stdout.trim().split("\n")) {
      const [kind, key, first, second, count] = line.split("\t");
      if (kind === "META" && key === "dictionaryLoadMs") metrics.dictionaryLoadMs = Number(first);
      if (kind === "RESULT")
        metrics.cases[key] = {
          p50Ms: Number(first),
          p95Ms: Number(second),
          samples: Number(count),
        };
    }
    return metrics;
  } finally {
    await rm(targetDirectory, { recursive: true, force: true });
    await rm(helperDirectory, { recursive: true, force: true });
  }
};

const waitForHttp = async (url, child) => {
  const deadline = performance.now() + 60_000;
  let lastError = "not started";
  while (performance.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`wrangler exited before ready (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
};

const openWorkerSocket = async (url) => {
  const socket = new WebSocket(url);
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener("error", () => reject(new Error("worker WebSocket failed to open")), {
      once: true,
    });
  });
  const ready = new Promise((resolvePromise, reject) => {
    const onMessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "azookey.ready") {
          socket.removeEventListener("message", onMessage);
          resolvePromise(message);
        } else if (message.type === "azookey.error") {
          reject(new Error(message.error?.message ?? "worker ready failed"));
        }
      } catch (error) {
        reject(error);
      }
    };
    socket.addEventListener("message", onMessage);
  });
  await ready;
  return socket;
};

const convertOnWorker = (socket, input, requestId) =>
  new Promise((resolvePromise, reject) => {
    const onMessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "azookey.result" && message.requestId === requestId) {
          socket.removeEventListener("message", onMessage);
          resolvePromise(message);
        } else if (message.type === "azookey.error" && message.requestId === requestId) {
          socket.removeEventListener("message", onMessage);
          reject(new Error(message.error?.message ?? "worker conversion failed"));
        }
      } catch (error) {
        socket.removeEventListener("message", onMessage);
        reject(error);
      }
    };
    socket.addEventListener("message", onMessage);
    socket.send(
      JSON.stringify({
        type: "azookey.convert",
        requestId,
        source: "web-speech",
        language: "ja",
        sourceText: input,
        vibratoInput: input,
        mode: "worker-vibrato",
      }),
    );
  });

const wranglerBinary = (sourceRoot) => {
  const candidates = [
    process.env.WRANGLER_BIN,
    resolve(sourceRoot, "node_modules/.bin/wrangler"),
    resolve(sourceRoot, "apps/cloudflare-worker-server/node_modules/.bin/wrangler"),
    resolve(repositoryRoot, "node_modules/.bin/wrangler"),
    resolve(repositoryRoot, "apps/cloudflare-worker-server/node_modules/.bin/wrangler"),
    "wrangler",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next local installation or PATH entry.
    }
  }
  throw new Error(
    "wrangler executable not found; set WRANGLER_BIN or install the worker dependencies",
  );
};

const runWorker = async ({ sourceRoot, iterations, cases, port, quiet }) => {
  const command = wranglerBinary(sourceRoot);
  const workerDirectory = resolve(sourceRoot, "apps/cloudflare-worker-server");
  const child = spawn(
    command,
    [
      "dev",
      "--local",
      "--port",
      String(port),
      "--log-level",
      "error",
      "--var",
      "AZOOKEY_TIMEOUT_MS:2000",
    ],
    {
      cwd: workerDirectory,
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
      stdio: ["ignore", quiet ? "ignore" : "inherit", quiet ? "ignore" : "inherit"],
    },
  );
  const rssState = { maxRssBytes: 0 };
  const rssTimer = setInterval(() => sampleRss(child, rssState), 25);
  let socket;
  try {
    const started = performance.now();
    await waitForHttp(`http://127.0.0.1:${port}/v1/azookey`, child);
    socket = await openWorkerSocket(`ws://127.0.0.1:${port}/ws/azookey`);
    const coldReadyMs = performance.now() - started;
    const metrics = { coldReadyMs, maxRssBytes: rssState.maxRssBytes, cases: {} };
    for (const [label, input] of cases) {
      await convertOnWorker(socket, input, `warmup-${label}`);
      const samples = [];
      for (let index = 0; index < iterations; index += 1) {
        const requestId = `${label}-${index}`;
        const sampleStarted = performance.now();
        await convertOnWorker(socket, input, requestId);
        samples.push(performance.now() - sampleStarted);
      }
      metrics.cases[label] = {
        p50Ms: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        samples: samples.length,
      };
    }
    sampleRss(child, rssState);
    metrics.maxRssBytes = rssState.maxRssBytes;
    return metrics;
  } finally {
    clearInterval(rssTimer);
    if (socket) socket.close();
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise();
      }, 5_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
};

const formatBytes = (bytes) =>
  bytes === 0 ? "unknown" : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const cases = benchmarkCases();
  const result = {
    schema: 1,
    sourceRoot: options.sourceRoot,
    iterations: options.iterations,
    cases: Object.fromEntries(cases),
  };
  if (!options.quiet)
    console.error(`[benchmark] ${options.sourceRoot} (${options.iterations} samples/case)`);
  if (options.mode === "native" || options.mode === "all") {
    result.native = await runNative({ ...options, cases });
    if (!options.quiet) console.error(`[native] max RSS ${formatBytes(result.native.maxRssBytes)}`);
  }
  if (options.mode === "worker" || options.mode === "all") {
    result.worker = await runWorker({ ...options, cases });
    if (!options.quiet) console.error(`[worker] max RSS ${formatBytes(result.worker.maxRssBytes)}`);
  }
  console.log(JSON.stringify(result, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
