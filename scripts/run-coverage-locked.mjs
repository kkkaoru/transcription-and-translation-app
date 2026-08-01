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
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node run-coverage-locked.mjs <package> [extra-args...]");
  process.exit(1);
}

const packageFilter = args[0];
const extraArgs = args.slice(1);

// Create a unique lock file path based on the package filter
const lockDir = tmpdir();
const lockFile = join(lockDir, `coverage-lock-${packageFilter.replace(/[^a-z0-9]/gi, "-")}.lock`);

/**
 * Acquire a lock by creating a lock file. Wait if it exists.
 * @returns {Promise<void>}
 */
async function acquireLock() {
  const startTime = Date.now();
  const maxWaitMs = 300_000; // 5 minutes max wait

  while (true) {
    try {
      // Try to write atomically - if file exists, this will fail
      const pidContent = `${process.pid}\n`;
      writeFileSync(lockFile, pidContent, { flag: "wx" });
      return; // Lock acquired
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      // Lock exists; check if it's stale
      const elapsed = Date.now() - startTime;
      if (elapsed > maxWaitMs) {
        console.warn(`Lock timeout after ${elapsed}ms; proceeding anyway`);
        return;
      }

      // Wait a bit before retrying
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Release the lock by deleting the lock file.
 */
function releaseLock() {
  try {
    unlinkSync(lockFile);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Failed to release lock: ${error.message}`);
    }
  }
}

/**
 * Run the vitest command with the given filter.
 * @returns {Promise<number>} exit code
 */
function runVitest() {
  return new Promise((resolve) => {
    const cmd = "bun";
    const cmdArgs = [`--filter=${packageFilter}`, "run", "test:coverage", "--", ...extraArgs];

    console.log(`Running: ${cmd} ${cmdArgs.join(" ")}`);

    const child = spawn(cmd, cmdArgs, {
      cwd: repositoryRoot,
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      resolve(code ?? 1);
    });

    child.on("error", (error) => {
      console.error(`Failed to spawn vitest: ${error.message}`);
      resolve(1);
    });
  });
}

try {
  await acquireLock();
  const exitCode = await runVitest();
  releaseLock();
  process.exit(exitCode);
} catch (error) {
  console.error(`Coverage lock error: ${error.message}`);
  releaseLock();
  process.exit(1);
}
