#!/usr/bin/env node

/**
 * Replace `/Applications/Kotoba Beacon.app` with the just-built release bundle.
 *
 * Dock / Spotlight / `open -a` keep launching the LaunchServices copy. A local
 * `target/release/bundle` rebuild is invisible until that installed app is
 * swapped. Unsigned `bun run build:app` therefore installs in place after a
 * successful macOS bundle.
 *
 * Skip with `KOTOBA_BEACON_SKIP_INSTALL=1` or when `CI` is set. Override the
 * destination with `KOTOBA_BEACON_INSTALL_APP`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findMacosAppBundles } from "./restore-bundle-runtime-symlinks.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_INSTALL_APP = "/Applications/Kotoba Beacon.app";
export const BUNDLE_ID = "com.kotobabeacon.desktop";

export const defaultSourceApp = (
  tauriTargetDir = join(repoRoot, "apps", "desktop", "src-tauri", "target"),
) => {
  const bundles = findMacosAppBundles(tauriTargetDir);
  return bundles.find((path) => basename(path) === "Kotoba Beacon.app") ?? bundles[0] ?? null;
};

export const shouldInstallMacosApp = ({ platform = process.platform, env = process.env } = {}) => {
  if (platform !== "darwin") return false;
  if (env.KOTOBA_BEACON_SKIP_INSTALL === "1") return false;
  if (env.CI === "true" || env.CI === "1") return false;
  return true;
};

export const resolveInstallApp = (env = process.env) =>
  env.KOTOBA_BEACON_INSTALL_APP?.trim() || DEFAULT_INSTALL_APP;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const exactProcessRows = () => {
  try {
    const output = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => {
        const match = line.trimStart().match(/^(\d+)\s+(.*)$/u);
        return match ? { pid: Number(match[1]), command: match[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const pidsForExecutables = (executables) => {
  const prefixes = executables.filter(Boolean);
  if (prefixes.length === 0) return [];
  return exactProcessRows()
    .filter(({ command }) => prefixes.some((prefix) => command.startsWith(prefix)))
    .map(({ pid }) => pid);
};

const processExists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForPidsToExit = async (pids, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return true;
    await sleep(200);
  }
  return pids.every((pid) => !processExists(pid));
};

const signalPids = (pids, signal) => {
  for (const pid of pids) {
    if (!processExists(pid)) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // Process may have exited between the snapshot and the signal.
    }
  }
};

export const quitKotobaProcesses = async (appBundles) => {
  const executables = appBundles
    .filter((app) => app)
    .map((app) => join(app, "Contents", "MacOS", "kotoba-beacon"));
  const initial = pidsForExecutables(executables);
  if (initial.length === 0) return { quit: false, pids: [] };

  spawnSync("/usr/bin/osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`], {
    stdio: "ignore",
  });
  if (await waitForPidsToExit(initial, 8_000)) {
    return { quit: true, pids: initial };
  }

  const remaining = pidsForExecutables(executables);
  signalPids(remaining, "SIGTERM");
  if (await waitForPidsToExit(remaining, 5_000)) {
    return { quit: true, pids: remaining };
  }

  const stubborn = pidsForExecutables(executables);
  signalPids(stubborn, "SIGKILL");
  await waitForPidsToExit(stubborn, 2_000);
  return { quit: true, pids: stubborn };
};

const runChecked = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail || `exit ${result.status}`}`);
  }
  return result.stdout || "";
};

export const replaceMacosApp = (sourceApp, installApp) => {
  if (!sourceApp || !existsSync(sourceApp)) {
    throw new Error(`built Kotoba Beacon.app was not found: ${sourceApp || "(none)"}`);
  }
  if (!sourceApp.endsWith(".app")) {
    throw new Error(`source must be an .app bundle: ${sourceApp}`);
  }
  if (!installApp.endsWith(".app")) {
    throw new Error(`install destination must be an .app bundle: ${installApp}`);
  }
  if (resolve(sourceApp) === resolve(installApp)) {
    return { sourceApp, installApp, replaced: false, samePath: true };
  }

  const parent = dirname(installApp);
  const staging = join(
    parent === "/" ? tmpdir() : parent,
    `${basename(installApp)}.${process.pid}.new`,
  );
  rmSync(staging, { recursive: true, force: true });
  runChecked("/usr/bin/ditto", [sourceApp, staging]);
  rmSync(installApp, { recursive: true, force: true });
  runChecked("/bin/mv", [staging, installApp]);
  // Preserve microphone entitlement on the installed adhoc/local copy. A bare
  // `codesign -s -` without --entitlements drops audio-input and WKWebView can
  // deny getUserMedia without showing the OS permission dialog.
  const entitlements = join(repoRoot, "apps", "desktop", "src-tauri", "Entitlements.plist");
  if (existsSync(entitlements)) {
    const signAttempts = [
      [
        "--force",
        "--deep",
        "--sign",
        "-",
        "--entitlements",
        entitlements,
        "--options",
        "runtime",
        installApp,
      ],
      ["--force", "--deep", "--sign", "-", "--entitlements", entitlements, installApp],
    ];
    let signed = false;
    for (const args of signAttempts) {
      try {
        runChecked("/usr/bin/codesign", args);
        signed = true;
        break;
      } catch {
        // Try the next softer signing mode.
      }
    }
    if (!signed) {
      console.warn(
        "codesign with microphone entitlements failed; mic permission prompts may be suppressed",
      );
    }
  }
  try {
    runChecked(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", installApp],
    );
  } catch {
    // LaunchServices refresh is best-effort; the replaced bundle is still the Dock target.
  }
  return { sourceApp, installApp, replaced: true, samePath: false };
};

export const installMacosAppIfRequested = async ({
  sourceApp = defaultSourceApp(),
  installApp = resolveInstallApp(),
  platform = process.platform,
  env = process.env,
  quitRunning = true,
} = {}) => {
  if (!shouldInstallMacosApp({ platform, env })) {
    return { skipped: true, reason: "install disabled", sourceApp, installApp };
  }
  if (!sourceApp || !existsSync(sourceApp)) {
    throw new Error(`built Kotoba Beacon.app was not found: ${sourceApp || "(none)"}`);
  }
  if (quitRunning) {
    await quitKotobaProcesses([installApp, sourceApp]);
  }
  const replaced = replaceMacosApp(sourceApp, installApp);
  return { skipped: false, ...replaced };
};

const main = async () => {
  try {
    const result = await installMacosAppIfRequested();
    if (result.skipped) {
      console.log(`Skipped installing Kotoba Beacon.app (${result.reason})`);
      return;
    }
    if (result.samePath) {
      console.log(`Install destination is already the built bundle: ${result.installApp}`);
      return;
    }
    console.log(`Replaced ${result.installApp} with ${result.sourceApp}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
