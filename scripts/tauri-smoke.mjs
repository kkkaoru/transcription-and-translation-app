#!/usr/bin/env node

/**
 * macOS smoke harness for the packaged Kotoba Beacon application.
 *
 * The harness deliberately has two layers:
 *
 *  1. Native smoke (always available): launch the exact .app/binary, collect a
 *     window screenshot, wait for the embedded gateway/model services, and
 *     submit a short silent WAV to the real gateway. This exercises the same
 *     sidecars used by the desktop UI without requiring a microphone.
 *  2. UI smoke (best effort): when System Events has Accessibility permission,
 *     use the accessibility tree to press Live/Settings/Debug/Overlay and
 *     Start/Stop controls. macOS TCC commonly denies this to CI terminals; in
 *     that case the report records the denial and never pretends that a click
 *     happened.
 *
 * Usage:
 *   node scripts/tauri-smoke.mjs                 # release bundle + native smoke
 *   node scripts/tauri-smoke.mjs --build          # build release bundle, then smoke it
 *   node scripts/tauri-smoke.mjs --flavor debug  # target/debug binary
 *   node scripts/tauri-smoke.mjs --ui            # also attempt AX UI actions
 *   node scripts/tauri-smoke.mjs --exercise-capture
 *   node scripts/tauri-smoke.mjs --keep-alive
 *
 * Output is written to /tmp by default. Override with TAURI_SMOKE_OUT_DIR.
 * The script does not kill an app that it did not launch.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const valueFor = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const flavor = valueFor("--flavor", "release");
const useUi = hasFlag("--ui");
const exerciseCapture = hasFlag("--exercise-capture");
const buildRequested = hasFlag("--build");
const keepAlive = hasFlag("--keep-alive");
const noLaunch = hasFlag("--no-launch");
const buildCommand = valueFor(
  "--build-command",
  process.env.TAURI_SMOKE_BUILD_COMMAND || "bun run build:app",
);
const expectedChunkMs = process.env.TAURI_SMOKE_EXPECT_CHUNK_MS
  ? Number(process.env.TAURI_SMOKE_EXPECT_CHUNK_MS)
  : null;
const expectedSilenceGateDb = process.env.TAURI_SMOKE_EXPECT_SILENCE_GATE_DB
  ? Number(process.env.TAURI_SMOKE_EXPECT_SILENCE_GATE_DB)
  : null;
const expectedVadIntervalMs = process.env.TAURI_SMOKE_EXPECT_VAD_INTERVAL_MS
  ? Number(process.env.TAURI_SMOKE_EXPECT_VAD_INTERVAL_MS)
  : null;
const expectedVadThreshold = process.env.TAURI_SMOKE_EXPECT_VAD_THRESHOLD
  ? Number(process.env.TAURI_SMOKE_EXPECT_VAD_THRESHOLD)
  : null;
const expectedAdaptiveNoiseFloor = process.env.TAURI_SMOKE_EXPECT_ADAPTIVE_NOISE_FLOOR
  ? process.env.TAURI_SMOKE_EXPECT_ADAPTIVE_NOISE_FLOOR === "true"
  : null;
const expectedNoiseSuppression = process.env.TAURI_SMOKE_EXPECT_NOISE_SUPPRESSION
  ? process.env.TAURI_SMOKE_EXPECT_NOISE_SUPPRESSION === "true"
  : null;
const outDir = path.resolve(
  valueFor(
    "--out-dir",
    process.env.TAURI_SMOKE_OUT_DIR || path.join(os.tmpdir(), `kotoba-tauri-smoke-${stamp}`),
  ),
);
fs.mkdirSync(outDir, { recursive: true });

/** @type {Array<{name: string, ok: boolean, detail?: string}>} */
const checks = [];
const notes = [];
const startedProcesses = [];
const report = {
  schemaVersion: 2,
  startedAt: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}`,
  macOS: process.platform === "darwin" ? os.release() : null,
  flavor,
  outputDirectory: outDir,
  uiRequested: useUi,
  exerciseCapture,
  buildRequested,
  buildCommand: buildRequested ? buildCommand : null,
  checks,
  notes,
};

const log = (line) => {
  console.log(line);
  fs.appendFileSync(path.join(outDir, "smoke.log"), `${line}\n`);
};

const check = (name, ok, detail = "", options = {}) => {
  const status = options.status || (ok ? "pass" : "fail");
  const required = options.required !== false;
  checks.push({
    name,
    ok,
    status,
    required,
    ...(detail ? { detail } : {}),
  });
  const prefix =
    status === "blocked" ? "BLOCKED" : status === "skipped" ? "SKIP" : ok ? "PASS" : "FAIL";
  log(`${prefix}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const blocked = (name, detail = "") =>
  check(name, false, detail, { status: "blocked", required: false });

const skipped = (name, detail = "") =>
  check(name, true, detail, { status: "skipped", required: false });

const note = (message) => {
  notes.push(message);
  log(`INFO  ${message}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const exactProcessRows = () => {
  try {
    const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
    });
    return output
      .split("\n")
      .map((line) => {
        const match = line.trimStart().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const pidForExecutable = (executable) => {
  const row = exactProcessRows().find((candidate) => candidate.command.startsWith(executable));
  return row?.pid ?? null;
};

const processExists = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    // A just-exited sidecar can remain as a zombie until its parent reaps it;
    // treat that state as exited so cleanup does not report a false survivor.
    const state = execFileSync("/bin/ps", ["-p", String(pid), "-o", "state="], {
      encoding: "utf8",
    }).trim();
    return !/^Z/u.test(state);
  } catch {
    return false;
  }
};

const portIsListening = async (port) => {
  const result = await runShell("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return result.ok && result.stdout.trim().length > 0;
};

const runShell = async (command, args, options = {}) => {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    });
    return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? String(error),
      code: typeof error.code === "number" ? error.code : 1,
    };
  }
};

const waitFor = async (predicate, timeoutMs, intervalMs = 250) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
};

const appPath = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  "Kotoba Beacon.app",
);
const releaseExecutable = path.join(appPath, "Contents", "MacOS", "kotoba-beacon");
const debugExecutable = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "debug",
  "kotoba-beacon",
);
const executable = flavor === "debug" ? debugExecutable : releaseExecutable;
const launchTarget = flavor === "debug" ? debugExecutable : appPath;

const writeJson = (name, value) => {
  fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
};

const sha256File = (file) => {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

const inspectReleaseBundle = async () => {
  if (flavor !== "release") return;
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const resources = path.join(appPath, "Contents", "Resources");
  const macos = path.join(appPath, "Contents", "MacOS");
  const infoResult = fs.existsSync(infoPlist)
    ? await runShell("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPlist])
    : { ok: false, stdout: "", stderr: "Info.plist is missing" };
  let info = null;
  try {
    info = JSON.parse(infoResult.stdout);
  } catch {
    info = null;
  }
  const macosFiles = fs.existsSync(macos) ? fs.readdirSync(macos).sort() : [];
  const resourceFiles = fs.existsSync(resources)
    ? fs
        .readdirSync(resources, { withFileTypes: true })
        .map((entry) => entry.name)
        .sort()
    : [];
  const expectedSidecars = [
    "kotoba-beacon",
    "kotoba-inference-gateway",
    "kotoba-parapper",
    "kotoba-llama-server",
    "kotoba-zenz-server",
  ];
  const expectedResources = ["parapper-runtime", "llama-runtime", "zenz-runtime", "third-party"];
  const inventory = {
    appPath,
    infoPlist,
    info,
    macosFiles,
    resourceFiles,
    hashes: Object.fromEntries(
      expectedSidecars
        .map((name) => [name, sha256File(path.join(macos, name))])
        .filter(([, hash]) => hash),
    ),
    capturedAt: new Date().toISOString(),
  };
  writeJson("bundle-inventory.json", inventory);
  const configuredIdentifier = (() => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
      )?.identifier;
    } catch {
      return null;
    }
  })();
  check(
    "release bundle contains a readable Info.plist",
    Boolean(info) && info.CFBundleIdentifier === configuredIdentifier,
    info
      ? `${info.CFBundleIdentifier || "(missing id)"} ${info.CFBundleVersion || ""}`
      : infoResult.stderr,
  );
  check(
    "release bundle has one foreground executable",
    info?.CFBundleExecutable === "kotoba-beacon" &&
      fs.existsSync(path.join(macos, "kotoba-beacon")),
    `${info?.CFBundleExecutable || "(missing)"}; files=${macosFiles.join(", ")}`,
  );
  check(
    "release bundle declares microphone usage",
    typeof info?.NSMicrophoneUsageDescription === "string" &&
      info.NSMicrophoneUsageDescription.trim().length > 0,
    info?.NSMicrophoneUsageDescription || "missing NSMicrophoneUsageDescription",
  );
  check(
    "release bundle embeds all runtime sidecars",
    expectedSidecars.every((name) => macosFiles.includes(name)),
    expectedSidecars.filter((name) => !macosFiles.includes(name)).join(", ") || "all present",
  );
  check(
    "release bundle embeds runtime resources and notices",
    expectedResources.every((name) => resourceFiles.includes(name)) &&
      fs.existsSync(path.join(resources, "third-party", "model-runtime-notice.md")),
    expectedResources.filter((name) => !resourceFiles.includes(name)).join(", ") || "all present",
  );
};

const buildTauriBundle = async () => {
  if (!buildRequested) return true;
  if (process.platform !== "darwin") {
    note(
      "--build was requested, but Tauri runtime smoke is macOS-only; build was not run on this host.",
    );
    check("Tauri build host is macOS", false, process.platform, { status: "blocked" });
    return false;
  }
  note(`building Tauri bundle: ${buildCommand}`);
  const result = await runShell("/bin/sh", ["-lc", buildCommand], {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(
    path.join(outDir, "build.log"),
    `${result.stdout || ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`,
  );
  check(
    "Tauri release build completed",
    result.ok,
    result.ok ? buildCommand : `${result.stderr.trim().slice(-1000)} (see build.log)`,
  );
  if (result.ok) {
    await inspectReleaseBundle();
  }
  return result.ok;
};

const nativeConfigPath = () =>
  path.resolve(
    process.env.TAURI_SMOKE_CONFIG_PATH ||
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "com.kotobabeacon.desktop",
        "config.json",
      ),
  );

const nativeConfigEvidence = async () => {
  const file = nativeConfigPath();
  const config = await waitFor(
    () => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    12_000,
    250,
  );
  const sidecarFile = path.join(path.dirname(file), "parapper", "config.json");
  const sidecarConfig =
    !config || typeof config !== "object"
      ? (() => {
          try {
            return JSON.parse(fs.readFileSync(sidecarFile, "utf8"));
          } catch {
            return null;
          }
        })()
      : null;
  if (!config || typeof config !== "object") {
    skipped("native config file is readable", `${file} (not written until Settings → Save)`);
    note(
      sidecarConfig
        ? `Main config.json was not written; using the live Parapper config at ${sidecarFile} for VAD evidence.`
        : `No config.json was observed at ${file}; pass TAURI_SMOKE_CONFIG_PATH when using a custom Tauri app-data directory.`,
    );
  }
  const sourceConfig = config && typeof config === "object" ? config : sidecarConfig;
  if (!sourceConfig || typeof sourceConfig !== "object") return null;
  const isSidecarConfig = sourceConfig === sidecarConfig;
  const audio = isSidecarConfig
    ? {
        vadIntervalMs: sourceConfig.vad_interval_ms,
        vadThreshold: sourceConfig.vad_threshold,
        sidecarNoiseCancellation: sourceConfig.noise_cancellation_enabled,
      }
    : sourceConfig.audio && typeof sourceConfig.audio === "object"
      ? sourceConfig.audio
      : {};
  const models =
    sourceConfig.models && typeof sourceConfig.models === "object" ? sourceConfig.models : {};
  const evidence = {
    path: isSidecarConfig ? sidecarFile : file,
    source: isSidecarConfig ? "parapper-sidecar" : "tauri-app-config",
    observedAt: new Date().toISOString(),
    modifiedAt: (() => {
      try {
        return fs.statSync(isSidecarConfig ? sidecarFile : file).mtime.toISOString();
      } catch {
        return null;
      }
    })(),
    schemaVersion: sourceConfig.schemaVersion ?? null,
    models: {
      asr: models.asr ?? null,
      normalizer: models.normalizer ?? null,
      translator: models.translator ?? null,
    },
    audio: {
      chunkMs: audio.chunkMs ?? null,
      silenceGateDb: audio.silenceGateDb ?? null,
      vadIntervalMs: audio.vadIntervalMs ?? null,
      vadThreshold: audio.vadThreshold ?? null,
      noiseSuppression: audio.noiseSuppression ?? null,
      sidecarNoiseCancellation: audio.sidecarNoiseCancellation ?? null,
      adaptiveNoiseFloor: audio.adaptiveNoiseFloor ?? null,
      sampleRate: audio.sampleRate ?? null,
    },
    overlay: {
      width: sourceConfig.overlay?.width ?? null,
      height: sourceConfig.overlay?.height ?? null,
      browserSource: {
        enabled: sourceConfig.overlay?.browserSource?.enabled ?? null,
        port: sourceConfig.overlay?.browserSource?.port ?? null,
      },
    },
  };
  writeJson("native-config.json", evidence);
  report.nativeConfigEvidence = evidence;
  const chunkOk =
    isSidecarConfig ||
    (Number.isFinite(audio.chunkMs) && audio.chunkMs >= 320 && audio.chunkMs <= 4000);
  const gateOk =
    isSidecarConfig ||
    (Number.isFinite(audio.silenceGateDb) &&
      audio.silenceGateDb >= -90 &&
      audio.silenceGateDb <= 0);
  const vadIntervalOk =
    Number.isFinite(audio.vadIntervalMs) &&
    audio.vadIntervalMs >= 16 &&
    audio.vadIntervalMs <= 128 &&
    (audio.vadIntervalMs - 16) % 16 === 0;
  const vadThresholdOk =
    Number.isFinite(audio.vadThreshold) && audio.vadThreshold >= 0 && audio.vadThreshold <= 1;
  const nsOk = isSidecarConfig || typeof audio.noiseSuppression === "boolean";
  const adaptiveOk =
    audio.adaptiveNoiseFloor === undefined || typeof audio.adaptiveNoiseFloor === "boolean";
  check(
    isSidecarConfig
      ? "Parapper sidecar has valid VAD settings"
      : "native config has valid VAD/chunk settings",
    chunkOk && gateOk && vadIntervalOk && vadThresholdOk && nsOk && adaptiveOk,
    JSON.stringify(evidence.audio),
  );
  if (!isSidecarConfig) {
    check(
      "native config selects the AzooKey normalizer",
      models.normalizer === "azookey-rust",
      String(models.normalizer ?? "(missing)"),
    );
  } else {
    check(
      "Parapper sidecar carries VAD settings from the running app",
      vadIntervalOk && vadThresholdOk,
      JSON.stringify({ vadIntervalMs: audio.vadIntervalMs, vadThreshold: audio.vadThreshold }),
    );
  }
  if (expectedChunkMs != null) {
    check(
      "native config chunkMs matches requested value",
      audio.chunkMs === expectedChunkMs,
      `${audio.chunkMs}`,
    );
  }
  if (expectedSilenceGateDb != null) {
    check(
      "native config silenceGateDb matches requested value",
      audio.silenceGateDb === expectedSilenceGateDb,
      `${audio.silenceGateDb}`,
    );
  }
  if (expectedVadIntervalMs != null) {
    check(
      "native config vadIntervalMs matches requested value",
      audio.vadIntervalMs === expectedVadIntervalMs,
      `${audio.vadIntervalMs}`,
    );
  }
  if (expectedVadThreshold != null) {
    check(
      "native config vadThreshold matches requested value",
      audio.vadThreshold === expectedVadThreshold,
      `${audio.vadThreshold}`,
    );
  }
  if (expectedAdaptiveNoiseFloor != null) {
    check(
      "native config adaptiveNoiseFloor matches requested value",
      audio.adaptiveNoiseFloor === expectedAdaptiveNoiseFloor,
      `${audio.adaptiveNoiseFloor}`,
    );
  }
  if (expectedNoiseSuppression != null) {
    check(
      "native config noiseSuppression matches requested value",
      audio.noiseSuppression === expectedNoiseSuppression,
      `${audio.noiseSuppression}`,
    );
  }
  return evidence;
};

/**
 * Verify the caption-only loopback fallback on macOS, where the bundled
 * Syphon framework is not a reliable native path. This is separate from the
 * native gateway checks: a healthy app process is not proof that OBS can
 * actually discover the fallback source.
 */
const browserSourceEvidence = async (config) => {
  if (process.platform !== "darwin") {
    return;
  }
  const browserSource = config?.overlay?.browserSource;
  // Rust defaults this fallback on for a fresh macOS configuration. An
  // explicit persisted false remains an intentional opt-out and is reported
  // as skipped rather than treated as a runtime failure.
  if (browserSource?.enabled === false) {
    skipped("macOS OBS Browser Source fallback", "disabled in the persisted config");
    return;
  }
  const port = Number(browserSource?.port ?? 1_421);
  const portOk = Number.isInteger(port) && port >= 1_024 && port <= 65_535;
  check(
    "macOS OBS Browser Source port is valid",
    portOk,
    `port=${browserSource?.port ?? "default 1421"}`,
  );
  if (!portOk) return;

  const health = await waitFor(
    async () => {
      try {
        const result = await fetchWithTimeout(`http://127.0.0.1:${port}/health`, 1200);
        return result.response.ok && result.body.trim() === "ok" ? result : null;
      } catch {
        return null;
      }
    },
    10_000,
    250,
  );
  check(
    "macOS OBS Browser Source health endpoint responds",
    Boolean(health),
    `http://127.0.0.1:${port}/health`,
  );

  const feed = await waitFor(
    async () => {
      try {
        const result = await fetchWithTimeout(`http://127.0.0.1:${port}/captions.json`, 1200);
        const body = result.json;
        return result.response.ok && body && typeof body.overlay === "object" ? result : null;
      } catch {
        return null;
      }
    },
    10_000,
    250,
  );
  check(
    "macOS OBS Browser Source serves the caption feed",
    Boolean(feed),
    `http://127.0.0.1:${port}/captions.json`,
  );
};

const copyProcessSnapshot = (name) => {
  const rows = exactProcessRows()
    .filter(({ command }) =>
      /kotoba-(beacon|parapper|inference-gateway|llama-server|zenz-server)/i.test(command),
    )
    .map(({ pid, command }) => `${pid} ${command}`)
    .join("\n");
  fs.writeFileSync(path.join(outDir, name), `${rows}\n`);
};

const runSwift = async (source, args = []) => {
  const child = spawn("/usr/bin/swift", ["-", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(source);
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
  const code = await new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) {
    note(`Swift window probe failed: ${stderr.trim() || `exit ${code}`}`);
    return null;
  }
  return stdout.trim();
};

const windowInfoSource = `
import CoreGraphics
import Foundation
let wanted = (CommandLine.arguments.dropFirst().first ?? "Kotoba Beacon").lowercased()
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
var rows: [[String: Any]] = []
if let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] {
  for item in list {
    let owner = (item[kCGWindowOwnerName as String] as? String) ?? ""
    let title = (item[kCGWindowName as String] as? String) ?? ""
    if !owner.lowercased().contains(wanted) && !title.lowercased().contains(wanted) { continue }
    let raw = item[kCGWindowBounds as String] as? NSDictionary
    let number = (item[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
    let pid = (item[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
    let layer = (item[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
    let value = { (key: String) -> Double in (raw?[key] as? NSNumber)?.doubleValue ?? 0 }
    rows.append(["owner": owner, "title": title, "windowNumber": number, "pid": pid,
                 "layer": layer, "x": value("X"), "y": value("Y"),
                 "width": value("Width"), "height": value("Height")])
  }
}
let data = try! JSONSerialization.data(withJSONObject: rows)
print(String(data: data, encoding: .utf8)!)
`;

const listWindows = async (wanted = "Kotoba Beacon") => {
  const raw = await runSwift(windowInfoSource, [wanted]);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const captureWindow = async (name, wanted = "Kotoba Beacon") => {
  const windows =
    (await waitFor(
      async () => {
        const next = await listWindows(wanted);
        return next.some((window) => window.layer === 0 && window.windowNumber > 0) ? next : null;
      },
      15_000,
      250,
    )) ?? (await listWindows(wanted));
  const candidate = windows.find((window) => window.layer === 0 && window.windowNumber > 0);
  const file = path.join(outDir, name);
  const result = candidate
    ? await runShell("/usr/sbin/screencapture", ["-x", "-l", String(candidate.windowNumber), file])
    : await runShell("/usr/sbin/screencapture", ["-x", file]);
  const exists = fs.existsSync(file) && fs.statSync(file).size > 0;
  check(`capture ${name}`, result.ok && exists, result.ok ? file : result.stderr.trim());
  return { windows, candidate, file };
};

const fetchWithTimeout = async (url, timeoutMs = 5000, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      // Keep text for diagnostics; not every native endpoint returns JSON.
    }
    return { response, body, json };
  } finally {
    clearTimeout(timer);
  }
};

const writeWav = (seconds = 0.9) => {
  const sampleRate = 16_000;
  const samples = Math.max(1, Math.round(sampleRate * seconds));
  const bytes = Buffer.alloc(44 + samples * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.write("RIFF", 0, "ascii");
  view.setUint32(4, 36 + samples * 2, true);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.write("data", 36, "ascii");
  view.setUint32(40, samples * 2, true);
  // PCM payload is intentionally zeroed (silence). The native path should
  // return a soft empty transcript rather than a fatal transport failure.
  return bytes;
};

const nativeSmoke = async (logFile) => {
  let health = null;
  let healthError = "";
  try {
    health = await fetchWithTimeout("http://127.0.0.1:8765/health", 5000);
  } catch (error) {
    healthError = error instanceof Error ? error.message : String(error);
  }
  check(
    "inference gateway /health",
    Boolean(
      health &&
        health.response.status >= 200 &&
        health.response.status < 300 &&
        health.json?.status === "ok",
    ),
    health
      ? `${health.response.status} ${health.body.slice(0, 240)}`
      : healthError || "request failed",
  );

  let modelHealth = null;
  let modelHealthError = "";
  try {
    modelHealth = await fetchWithTimeout("http://127.0.0.1:8083/health", 5000);
  } catch (error) {
    modelHealthError = error instanceof Error ? error.message : String(error);
  }
  check(
    "llama model server /health",
    Boolean(modelHealth && modelHealth.response.status >= 200 && modelHealth.response.status < 300),
    modelHealth
      ? `${modelHealth.response.status} ${modelHealth.body.slice(0, 240)}`
      : modelHealthError || "request failed",
  );

  const parapperWindow = await listWindows("kotoba-parapper");
  check(
    "headless Parapper has no visible application window",
    parapperWindow.filter((window) => window.layer === 0).length === 0,
    parapperWindow.map((window) => `${window.title || "(untitled)"}:${window.layer}`).join(", "),
  );

  const bundledSidecars = exactProcessRows()
    .filter(
      ({ command }) =>
        command.startsWith(`${path.dirname(executable)}/`) &&
        /kotoba-(parapper|inference-gateway|llama-server|zenz-server)/u.test(command),
    )
    .map(({ pid, command }) => ({ pid, command }));
  writeJson("bundled-sidecars.json", bundledSidecars);
  check(
    "running sidecars are the bundled Kotoba binaries",
    bundledSidecars.some(({ command }) => command.includes("kotoba-parapper")) &&
      bundledSidecars.some(({ command }) => command.includes("kotoba-inference-gateway")),
    bundledSidecars.map(({ pid, command }) => `${pid} ${command}`).join("\n") || "none",
  );

  const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").length : 0;
  // Deliberately reject one malformed request before the valid silence probe.
  // This proves a bad chunk does not wedge the serial ASR gate or prevent the
  // following healthy request from completing. It never reaches the model.
  try {
    const malformed = await fetchWithTimeout(
      "http://127.0.0.1:8765/v1/audio/transcriptions",
      5000,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "parapper-ja", file: "not-a-wav" }),
      },
    );
    check(
      "gateway rejects malformed audio with a client error",
      malformed.response.status >= 400 && malformed.response.status < 500,
      `${malformed.response.status} ${malformed.body.slice(0, 240)}`,
    );
  } catch (error) {
    check(
      "gateway rejects malformed audio with a client error",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  const form = new FormData();
  form.append("model", "parapper-ja");
  form.append("language", "ja");
  form.append("file", new Blob([writeWav()], { type: "audio/wav" }), "tauri-smoke-silence.wav");
  let validRequestOk = false;
  try {
    const transcription = await fetchWithTimeout(
      "http://127.0.0.1:8765/v1/audio/transcriptions",
      25_000,
      {
        method: "POST",
        body: form,
      },
    );
    validRequestOk = transcription.response.status >= 200 && transcription.response.status < 300;
    check(
      "gateway accepts a native WAV request",
      validRequestOk,
      `${transcription.response.status} ${transcription.body.slice(0, 240)}`,
    );
  } catch (error) {
    check(
      "gateway accepts a native WAV request",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  check(
    "gateway recovers after malformed audio",
    validRequestOk,
    validRequestOk ? "valid silence request completed after 4xx" : "follow-up request failed",
  );
  if (fs.existsSync(logFile)) {
    const afterBody = fs.readFileSync(logFile, "utf8");
    const delta = afterBody.slice(before);
    fs.writeFileSync(path.join(outDir, "native-request-log.txt"), delta);
    check(
      "native request emitted gateway/Parapper session evidence",
      /session start|session completed|Streaming recognition client connected|sidecar stdout event=(?:session-start|session-completed|no-final-transcript|recognition-connected)/.test(
        delta,
      ),
      `log delta ${delta.length} bytes`,
    );
  } else {
    check("native log file exists for request evidence", false, logFile);
  }
};

const axProbeSource = `
tell application "System Events"
  set matches to (every process whose name is "kotoba-beacon")
  if (count of matches is 0) then error "Kotoba Beacon process is not visible to System Events"
  set p to first item of matches
  set frontmost of p to true
  if (count of windows of p) is 0 then error "Kotoba Beacon has no visible window"
  set windowRole to role of front window of p
  set elementCount to count of UI elements of front window of p
  return "AX probe ok: " & (name of p) & " role=" & windowRole & " elements=" & elementCount
end tell
`;

const axSnapshotSource = `
tell application "System Events"
  set matches to (every process whose name is "kotoba-beacon")
  if (count of matches) is 0 then error "Kotoba Beacon process is not visible to System Events"
  set p to first item of matches
  set frontmost of p to true
  if (count of windows of p) is 0 then error "Kotoba Beacon has no visible window"
  set values to {}
  repeat with candidate in (entire contents of front window of p)
    try
      set candidateName to (name of candidate) as text
      if candidateName is not "" then set end of values to candidateName
    end try
  end repeat
  return values as text
end tell
`;

const uiAppleScript = `
on clickNamed(targets)
  tell application "System Events"
    set appProcess to first process whose name is "kotoba-beacon"
    set frontmost of appProcess to true
    if (count of windows of appProcess) is 0 then error "Kotoba Beacon has no window"
    set wanted to every item of targets
    repeat with candidate in (entire contents of front window of appProcess)
      try
        set candidateName to (name of candidate) as text
        repeat with targetName in wanted
          if candidateName contains ((targetName as text)) then
            try
              perform action "AXPress" of candidate
              return candidateName
            on error
              try
                click candidate
                return candidateName
              end try
            end try
          end if
        end repeat
      end try
    end repeat
    error "No AX element matched " & (wanted as text)
  end tell
end clickNamed

set actionName to (system attribute "SMOKE_ACTION")
if actionName is "settings" then
  return clickNamed({"設定", "Settings"})
else if actionName is "live" then
  return clickNamed({"配信表示", "Live"})
else if actionName is "debug" then
  return clickNamed({"デバッグ", "Debug"})
else if actionName is "overlay" then
  return clickNamed({"オーバーレイを開く", "Open overlay", "Overlay"})
else if actionName is "stop" then
  return clickNamed({"停止", "Stop"})
else if actionName is "start" then
  return clickNamed({"開始", "Start", "字幕生成を開始"})
else if actionName is "save" then
  return clickNamed({"設定を保存", "Save settings", "Save"})
else
  error "Unknown smoke action " & actionName
end if
`;

const pressAx = async (action) => {
  const result = await runShell("/usr/bin/osascript", ["-e", uiAppleScript], {
    env: { ...process.env, SMOKE_ACTION: action },
  });
  if (result.ok) {
    check(`AX UI action ${action}`, true, result.stdout.trim());
    return true;
  }
  check(`AX UI action ${action}`, false, result.stderr.trim() || result.stdout.trim());
  return false;
};

const dumpAxSnapshot = async (name, expected = []) => {
  const result = await runShell("/usr/bin/osascript", ["-e", axSnapshotSource]);
  const text = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  fs.writeFileSync(path.join(outDir, name), `${text}\n`);
  if (!result.ok) {
    blocked(`AX tree snapshot ${name}`, text || "osascript failed");
    return false;
  }
  const missing = expected.filter((pattern) => !new RegExp(pattern, "iu").test(text));
  check(
    `AX tree exposes ${name}`,
    missing.length === 0,
    missing.length
      ? `missing: ${missing.join(", ")}`
      : `matched ${text.split(/[,\n]/u).filter(Boolean).length} names`,
  );
  return missing.length === 0;
};

const uiSmoke = async () => {
  const probe = await runShell("/usr/bin/osascript", ["-e", axProbeSource]);
  if (!probe.ok) {
    blocked(
      "macOS Accessibility permission for System Events",
      probe.stderr.trim() || probe.stdout.trim() || "osascript failed",
    );
    note(
      "UI controls were not pressed because macOS TCC denied System Events. Enable Accessibility for the calling terminal/runner, then rerun with --ui.",
    );
    return false;
  }
  check("macOS Accessibility permission for System Events", true, probe.stdout.trim());
  // Keep each action independent: a missing WebKit accessibility node should
  // be reported while the remaining actions still get attempted.
  const settingsPressed = await pressAx("settings");
  await sleep(500);
  await captureWindow("ui-settings.png");
  await dumpAxSnapshot("ui-settings-ax.txt", [
    "AzooKey",
    "無音ゲート|Silence gate",
    "字幕チャンク|Caption chunk",
  ]);
  const settingsSaved = settingsPressed && (await pressAx("save"));
  await sleep(1000);
  check(
    "Settings Save action was verified",
    settingsSaved,
    settingsSaved ? "config persisted through the native UI" : "AX Save control was not reachable",
  );
  const debugPressed = await pressAx("debug");
  await sleep(500);
  await captureWindow("ui-debug.png");
  await dumpAxSnapshot("ui-debug-ax.txt", ["デバッグ|Debug", "ASR|Parapper"]);
  const livePressed = await pressAx("live");
  await sleep(500);
  const overlayPressed = await pressAx("overlay");
  await sleep(900);
  const overlayCapture = await captureWindow("ui-overlay.png");
  const overlayWindows = overlayCapture.windows.filter(
    (window) => window.layer === 0 && window.title.toLowerCase().includes("overlay"),
  );
  check(
    "overlay opened as a second same-process window",
    overlayPressed && overlayWindows.length >= 1,
    overlayPressed ? JSON.stringify(overlayWindows) : "AX overlay action was not verified",
  );
  if (exerciseCapture) {
    const stopped = await pressAx("stop");
    await sleep(500);
    await captureWindow("ui-stopped.png");
    const started = await pressAx("start");
    await sleep(2500);
    await captureWindow("ui-started.png");
    const stoppedFinal = await pressAx("stop");
    await sleep(500);
    await captureWindow("ui-stopped-final.png");
    check(
      "capture stop/start/stop sequence was attempted",
      stopped && started && stoppedFinal,
      `stop=${stopped} start=${started} finalStop=${stoppedFinal}`,
    );
  }
  check(
    "AX navigation reached Settings, Debug, and Live",
    settingsPressed && debugPressed && livePressed,
    `settings=${settingsPressed} debug=${debugPressed} live=${livePressed}`,
  );
  return settingsSaved;
};

const childPidsForApp = (appPid) => {
  const rows = exactProcessRows();
  const executableDirectory = path.dirname(executable);
  return rows
    .filter(
      ({ pid, ppid, command }) =>
        pid !== appPid &&
        ppid === appPid &&
        command.startsWith(`${executableDirectory}/kotoba-`) &&
        /kotoba-(parapper|inference-gateway|llama-server|zenz-server)/u.test(command),
    )
    .map(({ pid }) => pid);
};

const gracefulStop = async (pid, childPids = []) => {
  if (!pid || !processExists(pid)) return;
  note(`requesting graceful exit for smoke-launched app pid ${pid}`);
  if (flavor === "release") {
    const quit = await runShell("/usr/bin/osascript", [
      "-e",
      'tell application "Kotoba Beacon" to quit',
    ]);
    if (quit.ok) note("requested release bundle quit through LaunchServices");
  }
  await sleep(500);
  try {
    if (processExists(pid)) process.kill(pid, "SIGTERM");
  } catch (error) {
    note(
      `could not send SIGTERM to ${pid}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  await waitFor(() => !processExists(pid), 10_000, 250);
  check("smoke-launched app exited", !processExists(pid), `pid=${pid}`);
  for (const childPid of childPids) {
    if (!processExists(childPid)) continue;
    try {
      process.kill(childPid, "SIGTERM");
    } catch {
      // The sidecar may have exited between the process snapshot and cleanup.
    }
  }
  await waitFor(() => childPids.every((childPid) => !processExists(childPid)), 8_000, 250);
  for (const childPid of childPids) {
    if (!processExists(childPid)) continue;
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // Best effort; never widen this to a pattern kill.
    }
  }
  await sleep(300);
  const liveRows = new Map(exactProcessRows().map(({ pid, command }) => [pid, command]));
  const survivors = childPids.filter((childPid) => liveRows.has(childPid));
  check("smoke-launched sidecars exited", survivors.length === 0, survivors.join(", "));
  const ports = [8765, 18082, 8083];
  const listening = (
    await Promise.all(ports.map(async (port) => ((await portIsListening(port)) ? port : null)))
  ).filter((port) => port !== null);
  check("smoke-launched sidecar ports closed", listening.length === 0, listening.join(", "));
};

const main = async () => {
  report.launchTarget = launchTarget;
  check("running on macOS", process.platform === "darwin", process.platform);
  if (process.platform !== "darwin") {
    if (buildRequested) {
      note("Native Tauri smoke is macOS-only; use the browser screenshot harness on this host.");
    }
    report.finishedAt = new Date().toISOString();
    report.failedChecks = checks.filter(({ ok }) => !ok).map(({ name }) => name);
    report.blockedChecks = checks
      .filter(({ status }) => status === "blocked")
      .map(({ name }) => name);
    report.requiredFailures = checks
      .filter(({ ok, required }) => !ok && required !== false)
      .map(({ name }) => name);
    writeJson("report.json", report);
    process.exitCode = 1;
    return;
  }

  if (!(await buildTauriBundle())) {
    report.finishedAt = new Date().toISOString();
    report.failedChecks = checks.filter(({ ok }) => !ok).map(({ name }) => name);
    report.blockedChecks = checks
      .filter(({ status }) => status === "blocked")
      .map(({ name }) => name);
    report.requiredFailures = checks
      .filter(({ ok, required }) => !ok && required !== false)
      .map(({ name }) => name);
    writeJson("report.json", report);
    process.exitCode = 1;
    return;
  }

  check("selected executable exists", fs.existsSync(executable), executable);
  if (!fs.existsSync(executable)) {
    report.finishedAt = new Date().toISOString();
    report.failedChecks = checks.filter(({ ok }) => !ok).map(({ name }) => name);
    report.blockedChecks = checks
      .filter(({ status }) => status === "blocked")
      .map(({ name }) => name);
    report.requiredFailures = checks
      .filter(({ ok, required }) => !ok && required !== false)
      .map(({ name }) => name);
    writeJson("report.json", report);
    process.exitCode = 1;
    return;
  }
  if (flavor === "debug") {
    check(
      "debug Tauri binary is executable",
      Boolean(fs.statSync(executable).mode & 0o111),
      executable,
    );
  } else if (!buildRequested) {
    await inspectReleaseBundle();
  }

  copyProcessSnapshot("processes-before.txt");
  let pid = pidForExecutable(executable);
  // macOS enforces one foreground instance through the app-data flock.  A
  // second `open -n` of this bundle therefore exits immediately and activates
  // whichever Kotoba Beacon is already registered with LaunchServices (often
  // `/Applications/Kotoba Beacon.app`).  Do not mistake that existing window
  // and its sidecars for the exact release bundle under test.
  if (!pid && !noLaunch) {
    const preexistingWindows = (await listWindows("Kotoba Beacon")).filter(
      (window) => window.layer === 0 && window.windowNumber > 0,
    );
    if (preexistingWindows.length > 0) {
      blocked(
        "no conflicting Kotoba Beacon instance before launch",
        `existing foreground pid(s): ${preexistingWindows
          .map(
            (window) =>
              `${window.pid ?? "unknown"} ${window.owner || window.title || "Kotoba Beacon"}`,
          )
          .join(", ")}`,
      );
      note(
        "A different Kotoba Beacon instance is already running. Close it and rerun native smoke so LaunchServices cannot route the test to the installed bundle.",
      );
      report.finishedAt = new Date().toISOString();
      report.failedChecks = checks.filter(({ ok }) => !ok).map(({ name }) => name);
      report.blockedChecks = checks
        .filter(({ status }) => status === "blocked")
        .map(({ name }) => name);
      report.requiredFailures = checks
        .filter(({ ok, required }) => !ok && required !== false)
        .map(({ name }) => name);
      writeJson("report.json", report);
      process.exitCode = 1;
      return;
    }
  }
  let launchedByUs = false;
  if (!pid && !noLaunch) {
    note(`launching ${launchTarget}`);
    const child =
      flavor === "release"
        ? spawn("/usr/bin/open", ["-n", launchTarget], { detached: true, stdio: "ignore" })
        : spawn(launchTarget, [], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    startedProcesses.push(child.pid);
    launchedByUs = true;
    pid = await waitFor(() => pidForExecutable(executable), 20_000, 250);
  }
  check("Tauri app process is running", Boolean(pid) && processExists(pid), `pid=${pid ?? "none"}`);
  if (pid) report.appPid = pid;
  if (!pid) {
    note("No app process was available; native sidecar checks were skipped.");
  } else {
    const windowCapture = await captureWindow("ui-initial.png");
    check(
      "main app window is visible",
      Boolean(windowCapture.candidate),
      JSON.stringify(windowCapture.candidate ?? {}),
    );
    const configEvidence = await nativeConfigEvidence();
    await browserSourceEvidence(configEvidence);
    const logFile = path.join(
      os.homedir(),
      "Library",
      "Logs",
      "com.kotobabeacon.desktop",
      "kotoba-beacon.log",
    );
    await waitFor(
      async () => {
        try {
          const result = await fetchWithTimeout("http://127.0.0.1:8765/health", 1200);
          return result.response.status >= 200 && result.response.status < 300;
        } catch {
          return false;
        }
      },
      90_000,
      1000,
    );
    await waitFor(
      async () => {
        try {
          const result = await fetchWithTimeout("http://127.0.0.1:8083/health", 1200);
          return result.response.status >= 200 && result.response.status < 300;
        } catch {
          return false;
        }
      },
      90_000,
      1000,
    );
    await nativeSmoke(logFile);
    if (useUi) {
      const uiCompleted = await uiSmoke();
      // Saving through AX is the only in-scope native path that can create the
      // user's main config without writing into app-data behind their back.
      if (uiCompleted) {
        const updatedConfigEvidence = await nativeConfigEvidence();
        await browserSourceEvidence(updatedConfigEvidence);
      }
    }
    copyProcessSnapshot("processes-after.txt");
    if (fs.existsSync(logFile)) {
      const logBody = fs.readFileSync(logFile, "utf8");
      fs.writeFileSync(path.join(outDir, "kotoba-beacon-log-tail.txt"), logBody.slice(-120_000));
    }
    if (launchedByUs && !keepAlive) {
      const sidecarPids = childPidsForApp(pid);
      report.sidecarPids = sidecarPids;
      await gracefulStop(pid, sidecarPids);
    }
  }
  report.finishedAt = new Date().toISOString();
  report.startedProcessPids = startedProcesses;
  report.failedChecks = checks.filter(({ ok }) => !ok).map(({ name }) => name);
  report.blockedChecks = checks
    .filter(({ status }) => status === "blocked")
    .map(({ name }) => name);
  report.requiredFailures = checks
    .filter(({ ok, required }) => !ok && required !== false)
    .map(({ name }) => name);
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  log(`REPORT ${path.join(outDir, "report.json")}`);
  if (report.failedChecks.length > 0) process.exitCode = 1;
};

await main();
