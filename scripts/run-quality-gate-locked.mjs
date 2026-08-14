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
import { setTimeout as delay } from "node:timers/promises";
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

export const processGroupIsRunning = (processGroupId, kill = process.kill) => {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
};

export const residualProcessTreeIsRunning = (owner) => {
  if (!Number.isSafeInteger(owner?.childProcessGroupId) || owner.childProcessGroupId <= 0) {
    return false;
  }
  try {
    if (owner.childPlatform !== "win32") {
      return processGroupIsRunning(owner.childProcessGroupId);
    }
    process.kill(owner.childProcessGroupId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    // A permissions failure means the PID still exists. Retain the lock rather
    // than risk overlapping it with a new quality gate.
    if (error.code === "EPERM") return true;
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
  residualIsCurrent = residualProcessTreeIsRunning,
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
    if (existingOwner && (ownerIsCurrent(existingOwner) || residualIsCurrent(existingOwner))) {
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

export const updateLockOwner = (lock, updates) => {
  if (!lock?.lockPath || typeof lock.ownerContent !== "string" || !lock.owner) {
    throw new Error("an acquired lock is required");
  }
  if (readFileSnapshot(lock.lockPath) !== lock.ownerContent) {
    throw new Error("quality-gate lock changed before child metadata could be recorded");
  }
  const owner = { ...lock.owner, ...updates };
  const ownerContent = `${JSON.stringify(owner)}\n`;
  writeFileSync(lock.lockPath, ownerContent, { encoding: "utf8", mode: 0o600 });
  lock.owner = owner;
  lock.ownerContent = ownerContent;
};

export const releaseLock = (lock) => {
  if (!lock?.lockPath || typeof lock.ownerContent !== "string") return false;
  return reclaimSnapshot(lock.lockPath, lock.ownerContent);
};

const formatOwner = (owner) => {
  if (!owner) return "  owner: metadata is unavailable (a new lock may still be initializing)";
  const residual = owner.childProcessGroupId
    ? `, child process group ${owner.childProcessGroupId}`
    : "";
  return `  owner: PID ${owner.pid}${residual}, cwd ${owner.cwd}, started ${owner.startedAt}, command ${owner.command}`;
};

const waitForProcessGroupExit = async (
  processGroupId,
  { kill = process.kill, pollMs = 25, timeoutMs } = {},
) => {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  while (processGroupIsRunning(processGroupId, kill)) {
    if (deadline !== undefined && Date.now() >= deadline) return false;
    await delay(pollMs);
  }
  return true;
};

const sendToProcessTree = ({ child, platform, runSync, kill, signal }) => {
  if (!child?.pid) return;
  if (platform === "win32") {
    const result = runSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    // taskkill returns 128 when the process finished between the exit check and
    // this command. Any still-running tree is reported by a different status.
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 128) {
      throw new Error(result.stderr.trim() || `taskkill exited with status ${result.status}`);
    }
    return;
  }

  try {
    kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};

/**
 * Run the unlocked gate in its own process group. Signal handling targets the
 * whole group, and this promise does not settle until every descendant has
 * exited, so the caller cannot release the quality-gate lock prematurely.
 */
export const runUnlockedGate = ({
  command = "bun",
  args = ["run", "check:all:unlocked"],
  cwd = repositoryRoot,
  env = process.env,
  signalSource = process,
  platform = process.platform,
  spawnProcess = spawn,
  runSync = spawnSync,
  kill = process.kill,
  stderr = console.error,
  registerProcessTree = () => {},
  descendantGraceMs = 250,
  forceKillAfterMs = 5_000,
} = {}) =>
  new Promise((resolvePromise) => {
    let child = null;
    let forwardedSignal = null;
    let registrationFailed = false;
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      signalSource.removeListener("SIGINT", handleSigint);
      signalSource.removeListener("SIGTERM", handleSigterm);
      resolvePromise(exitCode);
    };
    const forwardSignal = (signal) => {
      if (!child?.pid) return;
      forwardedSignal = signal;
      try {
        sendToProcessTree({ child, platform, runSync, kill, signal });
      } catch (error) {
        stderr(`[quality-gate] unable to stop child process tree: ${error.message}`);
      }
    };
    const handleSigint = () => forwardSignal("SIGINT");
    const handleSigterm = () => forwardSignal("SIGTERM");
    signalSource.once("SIGINT", handleSigint);
    signalSource.once("SIGTERM", handleSigterm);

    child = spawnProcess(command, args, {
      cwd,
      env,
      stdio: "inherit",
      detached: true,
      windowsHide: true,
    });
    child.once("error", (error) => {
      stderr(`[quality-gate] unable to start checks: ${error.message}`);
      finish(1);
    });
    try {
      registerProcessTree({ processGroupId: child.pid, platform });
    } catch (error) {
      registrationFailed = true;
      stderr(`[quality-gate] unable to record child process tree: ${error.message}`);
      forwardSignal("SIGTERM");
    }
    child.once("exit", (code, signal) => {
      void (async () => {
        if (platform !== "win32" && child?.pid) {
          const exitedDuringGrace = await waitForProcessGroupExit(child.pid, {
            kill,
            timeoutMs: descendantGraceMs,
          });
          if (!exitedDuringGrace) {
            if (!forwardedSignal) {
              stderr(
                `[quality-gate] direct child exited but descendants remain in process group ${child.pid}; stopping them`,
              );
              sendToProcessTree({ child, platform, runSync, kill, signal: "SIGTERM" });
            }
            const exitedGracefully = await waitForProcessGroupExit(child.pid, {
              kill,
              timeoutMs: forceKillAfterMs,
            });
            if (!exitedGracefully) {
              stderr(
                `[quality-gate] process group ${child.pid} ignored termination; sending SIGKILL`,
              );
              sendToProcessTree({ child, platform, runSync, kill, signal: "SIGKILL" });
              // Deliberately wait without a timeout. Releasing the lock while a
              // known descendant remains would recreate the resource race this
              // wrapper exists to prevent.
              await waitForProcessGroupExit(child.pid, { kill });
            }
          }
        }

        if (registrationFailed) {
          finish(1);
          return;
        }
        if (Number.isInteger(code)) {
          finish(code);
          return;
        }
        const signalNumber = signal ? osConstants.signals[signal] : undefined;
        finish(signalNumber ? 128 + signalNumber : 1);
      })().catch((error) => {
        stderr(`[quality-gate] failed while collecting child processes: ${error.message}`);
        stderr("[quality-gate] lock retained because descendant shutdown could not be verified");
        // Do not settle: main must keep the lock while a descendant may still
        // be running. A second external signal can still stop this wrapper,
        // leaving the normal stale-owner recovery path for the next invocation.
      });
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
    return await execute({
      registerProcessTree: ({ processGroupId, platform }) =>
        updateLockOwner(lock, {
          childProcessGroupId: processGroupId,
          childPlatform: platform,
        }),
    });
  } finally {
    releaseLock(lock);
  }
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) process.exitCode = await main();
