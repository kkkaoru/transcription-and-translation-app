#!/usr/bin/env node

/**
 * Run a vitest coverage command with mutex locking to prevent concurrent
 * writes to the same coverage directory.
 *
 * Usage: node run-coverage-locked.mjs <package-filter-or-cwd> [extra-args...]
 *
 * Examples:
 *   node run-coverage-locked.mjs "@caption-bridge/desktop"
 *   node run-coverage-locked.mjs "packages/inference-server-core" --reporter=dot
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultMaxWaitMs = 30_000;
const defaultRetryDelayMs = 100;

const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const readLockSnapshot = (lockFilePath) => {
  try {
    return readFileSync(lockFilePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const parseOwnerPid = (lockContent) => {
  const pid = Number.parseInt(lockContent.split("\n", 1)[0], 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Check whether a process is still running.
 *
 * EPERM means the process exists but this process is not allowed to signal it,
 * which still means that the lock is live. Every other failure is treated as
 * a dead or invalid owner.
 */
export const isProcessAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    return false;
  }
};

const reclaimStaleLock = (lockFilePath, expectedSnapshot) => {
  const currentSnapshot = readLockSnapshot(lockFilePath);
  if (currentSnapshot === null) return true;
  if (currentSnapshot !== expectedSnapshot) return false;

  try {
    unlinkSync(lockFilePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
};

/**
 * Acquire the per-package coverage lock.
 *
 * The lock contains the owner's PID on its first line and a unique token on
 * the second line. A dead owner is reclaimed; a live owner is never bypassed.
 *
 * @returns {Promise<{lockFilePath: string, ownerContent: string, pid: number}>}
 */
export async function acquireLock({
  lockFilePath,
  pid = process.pid,
  maxWaitMs = defaultMaxWaitMs,
  retryDelayMs = defaultRetryDelayMs,
  isOwnerAlive = isProcessAlive,
  now = Date.now,
  sleep = delay,
  signal,
} = {}) {
  if (!lockFilePath) throw new Error("lockFilePath is required");
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid lock owner PID: ${pid}`);
  }

  const ownerContent = `${pid}\n${randomUUID()}\n`;
  const startedAt = now();

  while (true) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Coverage lock acquisition interrupted");
    }

    try {
      writeFileSync(lockFilePath, ownerContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return { lockFilePath, ownerContent, pid };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const existingSnapshot = readLockSnapshot(lockFilePath);
    if (existingSnapshot === null) continue;

    const ownerPid = parseOwnerPid(existingSnapshot);
    const stale = ownerPid === null || !isOwnerAlive(ownerPid);
    if (stale && reclaimStaleLock(lockFilePath, existingSnapshot)) {
      continue;
    }

    const elapsed = now() - startedAt;
    if (elapsed >= maxWaitMs) {
      const ownerDescription = ownerPid === null ? "an unknown owner" : `owner PID ${ownerPid}`;
      throw new Error(
        `Coverage lock timeout after ${elapsed}ms waiting for ${lockFilePath}; ${ownerDescription} is still holding it. Refusing to run without the lock.`,
      );
    }

    await sleep(Math.max(0, Math.min(retryDelayMs, maxWaitMs - elapsed)));
  }
}

/**
 * Release a lock only when the lock file still contains this acquisition's
 * exact owner record. Re-reading immediately before unlinking prevents a
 * finished process from deleting a lock acquired by another process.
 */
export function releaseLock(lock) {
  if (!lock?.lockFilePath || typeof lock.ownerContent !== "string") return false;

  const currentSnapshot = readLockSnapshot(lock.lockFilePath);
  if (currentSnapshot === null || currentSnapshot !== lock.ownerContent) return false;

  try {
    unlinkSync(lock.lockFilePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

const workspaceRoots = ["apps", "packages"];

/**
 * Resolve a package filter to its directory.
 *
 * A scoped name says nothing about which workspace root holds the package
 * (`@caption-bridge/desktop` lives in `apps/`, `@caption-bridge/inference-server-core`
 * in `packages/`), so the bare name is looked up under every workspace root
 * rather than assumed. Returns null when nothing matches, which keeps a
 * mismatch visible instead of silently cleaning a path that does not exist.
 */
export const getPackageDir = (packageFilter) => {
  const parts = packageFilter.split("/").filter(Boolean);

  if (parts.length >= 2 && workspaceRoots.includes(parts[0])) {
    return join(repositoryRoot, parts[0], parts[1]);
  }

  const bareName = parts.length === 2 && parts[0].startsWith("@") ? parts[1] : parts[0];
  for (const workspaceRoot of workspaceRoots) {
    const candidate = join(repositoryRoot, workspaceRoot, bareName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }

  return null;
};

/**
 * Lock path keyed on the resolved package directory, so every spelling of a
 * filter (scoped name or workspace path) shares one lock for the coverage
 * directory it protects. A filter that resolves to nothing falls back to its
 * raw spelling, keeping unknown packages off the real locks.
 */
export const lockPathForPackage = (packageFilter) => {
  const packageDir = getPackageDir(packageFilter);
  const lockKey = packageDir ? relative(repositoryRoot, packageDir) : packageFilter;
  return join(tmpdir(), `coverage-lock-${lockKey.replace(/[^a-z0-9.-]/gi, "-")}.lock`);
};

export const COVERAGE_THRESHOLD_PERCENT = 95;

const ceilCoveredForThreshold = (total, percent = COVERAGE_THRESHOLD_PERCENT) =>
  Math.ceil((percent / 100) * total);

/** Numbers-only slack against the existing 95% floor. Does not change pass/fail. */
export const formatCoverageSlackLine = (metric, summary, percent = COVERAGE_THRESHOLD_PERCENT) => {
  const row = summary?.[metric];
  if (!row || typeof row.total !== "number" || typeof row.covered !== "number") {
    return `${metric} slack unknown (no ${metric} row in coverage-summary.json)`;
  }
  const need = ceilCoveredForThreshold(row.total, percent);
  const slack = row.covered - need;
  const pct = typeof row.pct === "number" ? row.pct.toFixed(2) : String(row.pct);
  const counts = `${row.covered}/${row.total} = ${pct}% need>=${need} slack=${slack}`;
  const fullyCovered = row.total > 0 && row.covered === row.total;
  if (fullyCovered) {
    return `${metric} slack ${counts}`;
  }
  if (slack <= 0) {
    return `${metric} SLACK EXHAUSTED ${counts} — next uncovered ${metric} fails ${percent}%`;
  }
  if (slack === 1) {
    return `${metric} SLACK LOW ${counts}`;
  }
  return `${metric} slack ${counts}`;
};

export const reportCoverageSlack = (packageFilter) => {
  const packageDir = getPackageDir(packageFilter);
  if (packageDir === null) {
    console.log("coverage slack unknown (package directory not resolved)");
    return;
  }
  const summaryPath = join(packageDir, "coverage", "coverage-summary.json");
  if (!existsSync(summaryPath)) {
    console.log(`coverage slack unknown (missing ${relative(repositoryRoot, summaryPath)})`);
    return;
  }
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8")).total;
  } catch (error) {
    console.log(`coverage slack unknown (could not read summary: ${error.message})`);
    return;
  }
  console.log(`coverage slack ${packageFilter}`);
  for (const metric of ["branches", "lines", "statements", "functions"]) {
    console.log(`  ${formatCoverageSlackLine(metric, summary)}`);
  }
};

const cleanCoverageDir = async (packageFilter) => {
  const packageDir = getPackageDir(packageFilter);
  if (packageDir === null) {
    console.warn(`Warning: no workspace directory found for ${packageFilter}; skipping cleanup`);
    return;
  }
  const coverageDir = join(packageDir, "coverage");

  try {
    await rm(coverageDir, { recursive: true, force: true });
  } catch (error) {
    // Not fatal if cleanup fails; vitest should handle it
    if (error.code !== "ENOENT") {
      console.warn(`Warning: Failed to clean ${coverageDir}: ${error.message}`);
    }
  }
};

/**
 * Command override used only by the lock tests, so they can exercise the
 * signal and release paths against a stub child instead of a real coverage
 * run. A real run would contend for this package's lock and coverage
 * directory, which is exactly what the lock is meant to serialize.
 */
const commandOverride = process.env.COVERAGE_LOCK_CHILD_COMMAND;

const runVitest = (packageFilter, extraArgs, onChild) =>
  new Promise((resolvePromise) => {
    const cmd = commandOverride ? process.execPath : "bun";
    const cmdArgs = commandOverride
      ? ["-e", commandOverride]
      : [`--filter=${packageFilter}`, "run", "test:coverage", "--", ...extraArgs];

    console.log(`Running: ${cmd} ${cmdArgs.join(" ")}`);

    const child = spawn(cmd, cmdArgs, {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    onChild(child);

    child.on("exit", (code) => {
      onChild(null);
      resolvePromise(code ?? 1);
    });

    child.on("error", (error) => {
      onChild(null);
      console.error(`Failed to spawn vitest: ${error.message}`);
      resolvePromise(1);
    });
  });

const signalExitCode = (signal) => (signal === "SIGINT" ? 130 : 143);

/**
 * Run the package coverage command while holding its lock.
 *
 * @returns {Promise<number>} the child exit code, or a signal exit code.
 */
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    console.error("Usage: node run-coverage-locked.mjs <package> [extra-args...]");
    return 1;
  }

  const [packageFilter, ...extraArgs] = argv;
  const lockFilePath = lockPathForPackage(packageFilter);
  const abortController = new AbortController();
  let lock = null;
  let child = null;
  let interruptedBy = null;

  // The lock is deliberately NOT released here. vitest is still alive at this
  // point and keeps writing coverage/.tmp until it actually exits, so releasing
  // now would let a second wrapper start against the same directory -- exactly
  // the overlap this lock exists to prevent. The `finally` below releases once
  // the child has exited.
  const handleSignal = (signal) => {
    interruptedBy = signal;
    abortController.abort(new Error(`Coverage run interrupted by ${signal}`));
    if (child && !child.killed) child.kill(signal);
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    lock = await acquireLock({ lockFilePath, signal: abortController.signal });
    if (interruptedBy) return signalExitCode(interruptedBy);

    // Clean coverage directory to ensure a fresh baseline before running vitest.
    // This is critical when the lock times out or a prior run is killed,
    // leaving behind stale v8 JSON that would corrupt the next run's coverage numbers.
    await cleanCoverageDir(packageFilter);
    if (interruptedBy) return signalExitCode(interruptedBy);

    const exitCode = await runVitest(packageFilter, extraArgs, (runningChild) => {
      child = runningChild;
    });
    if (!commandOverride) {
      reportCoverageSlack(packageFilter);
    }
    return interruptedBy ? signalExitCode(interruptedBy) : exitCode;
  } catch (error) {
    if (!interruptedBy) {
      console.error(`Coverage lock error: ${error.message}`);
    }
    return interruptedBy ? signalExitCode(interruptedBy) : 1;
  } finally {
    if (lock) releaseLock(lock);
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  process.exitCode = await main();
}
