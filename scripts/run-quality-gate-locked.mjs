#!/usr/bin/env node

/**
 * Prevent multiple worktrees or agents from running the complete quality gate
 * at the same time. Individual checks remain in package.json so this resource
 * guard cannot silently change the gate's contents.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockExitCode = 75;
const invalidLockGraceMs = 5_000;

const readFileSnapshot = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

export const processStartTime = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`ps was interrupted by ${result.signal}`);
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value || null;
};

export const isCurrentOwner = (owner) => {
  if (!Number.isSafeInteger(owner?.pid) || typeof owner?.processStartedAt !== "string") {
    return false;
  }
  try {
    return processStartTime(owner.pid) === owner.processStartedAt;
  } catch {
    // Under severe memory pressure even `ps` can fail. Conservatively retain
    // the lock rather than launching a second quality gate.
    return true;
  }
};

const gitCommonDirectory = () => {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "unable to resolve the Git common directory");
  }
  const commonDirectory = result.stdout.trim();
  const absoluteDirectory = isAbsolute(commonDirectory)
    ? commonDirectory
    : resolve(repositoryRoot, commonDirectory);
  return realpathSync(absoluteDirectory);
};

export const lockPathForCommonDirectory = (commonDirectory) => {
  const key = createHash("sha256").update(resolve(commonDirectory)).digest("hex").slice(0, 16);
  return resolve(tmpdir(), `caption-bridge-quality-gate-${key}.lock`);
};

export const createOwner = ({
  pid = process.pid,
  cwd = repositoryRoot,
  command = "bun run check:all:unlocked",
  startedAt = new Date().toISOString(),
  processStartedAt,
  token = randomUUID(),
} = {}) => {
  const ownerProcessStartedAt = processStartedAt ?? processStartTime(pid);
  if (!ownerProcessStartedAt) throw new Error(`unable to determine start time for PID ${pid}`);
  return { pid, processStartedAt: ownerProcessStartedAt, startedAt, cwd, command, token };
};

const parseOwner = (snapshot) => {
  try {
    return JSON.parse(snapshot);
  } catch {
    return null;
  }
};

const reclaimSnapshot = (lockPath, expectedSnapshot) => {
  if (readFileSnapshot(lockPath) !== expectedSnapshot) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
};

/**
 * Atomically acquire the quality-gate lock. A PID is only considered live when
 * its OS process start time also matches, preventing PID reuse from preserving
 * an abandoned lock forever.
 */
export const acquireLock = ({
  lockPath,
  owner = createOwner(),
  ownerIsCurrent = isCurrentOwner,
  now = Date.now,
} = {}) => {
  if (!lockPath) throw new Error("lockPath is required");
  const ownerContent = `${JSON.stringify(owner)}\n`;

  while (true) {
    try {
      writeFileSync(lockPath, ownerContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return { acquired: true, lockPath, ownerContent, owner };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const snapshot = readFileSnapshot(lockPath);
    if (snapshot === null) continue;
    const existingOwner = parseOwner(snapshot);
    if (existingOwner && ownerIsCurrent(existingOwner)) {
      return { acquired: false, owner: existingOwner };
    }

    if (!existingOwner) {
      try {
        if (now() - statSync(lockPath).mtimeMs < invalidLockGraceMs) {
          return { acquired: false, owner: null };
        }
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
    }

    if (reclaimSnapshot(lockPath, snapshot)) continue;
  }
};

export const releaseLock = (lock) => {
  if (!lock?.lockPath || typeof lock.ownerContent !== "string") return false;
  return reclaimSnapshot(lock.lockPath, lock.ownerContent);
};

const formatOwner = (owner) => {
  if (!owner) return "  owner: metadata is unavailable (a new lock may still be initializing)";
  return `  owner: PID ${owner.pid}, cwd ${owner.cwd}, started ${owner.startedAt}, command ${owner.command}`;
};

const runUnlockedGate = () =>
  new Promise((resolvePromise) => {
    let child = null;
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
      resolvePromise(exitCode);
    };
    const forwardSignal = (signal) => {
      if (child && !child.killed) child.kill(signal);
    };
    const handleSigint = () => forwardSignal("SIGINT");
    const handleSigterm = () => forwardSignal("SIGTERM");
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);

    child = spawn("bun", ["run", "check:all:unlocked"], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", (error) => {
      console.error(`[quality-gate] unable to start checks: ${error.message}`);
      finish(1);
    });
    child.once("exit", (code, signal) => {
      if (Number.isInteger(code)) {
        finish(code);
        return;
      }
      const signalNumber = signal ? osConstants.signals[signal] : undefined;
      finish(signalNumber ? 128 + signalNumber : 1);
    });
  });

export async function main({
  env = process.env,
  commonDirectory,
  execute = runUnlockedGate,
  stderr = console.error,
} = {}) {
  if (env.QUALITY_GATE_NO_LOCK === "1") return execute();

  const lockPath = lockPathForCommonDirectory(commonDirectory ?? gitCommonDirectory());
  const lock = acquireLock({ lockPath });
  if (!lock.acquired) {
    stderr("[quality-gate] 別プロセスが実行中のため開始しません（検査は実行されていません）");
    stderr(formatOwner(lock.owner));
    stderr("  retry: 実行中のgate完了後に再実行（緊急時のみ QUALITY_GATE_NO_LOCK=1）");
    return lockExitCode;
  }

  try {
    return await execute();
  } finally {
    releaseLock(lock);
  }
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) process.exitCode = await main();
