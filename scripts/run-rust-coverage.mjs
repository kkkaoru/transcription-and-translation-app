#!/usr/bin/env node

/**
 * Run cargo-llvm-cov through one serialized, disk-bounded entry point.
 *
 * The runner removes rebuildable caches before compilation, requires at least
 * 12 GiB free on the repository volume, places instrumentation artifacts in a
 * temporary target, and deletes that target on every normal success/failure
 * path. Optional changed-line gates consume an LCOV report inside that same
 * temporary target, so coverage reports cannot accumulate in the worktree.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanBuildArtifacts } from "./clean-build-artifacts.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryTargetPrefix = join(tmpdir(), "kotoba-rust-coverage-");
const coverageLockDirectory = join(tmpdir(), "kotoba-rust-coverage.lock");
const coverageLockRetryMs = 1_000;
const coverageLockTimeoutMs = 2 * 60 * 60 * 1_000;
export const MINIMUM_FREE_BYTES = 12 * 1024 * 1024 * 1024;

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const readLockOwner = async (lockDirectory) => {
  try {
    return JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
  } catch {
    return null;
  }
};

/** Serialize Rust coverage across agents and worktrees on this machine. */
export async function acquireCoverageLock(
  lockDirectory = coverageLockDirectory,
  timeoutMs = coverageLockTimeoutMs,
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockDirectory);
      await writeFile(
        join(lockDirectory, "owner.json"),
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        "utf8",
      );
      return async () => rm(lockDirectory, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readLockOwner(lockDirectory);
      if (owner && !processIsAlive(Number(owner.pid))) {
        const staleDirectory = `${lockDirectory}.stale-${process.pid}-${Date.now()}`;
        try {
          await rename(lockDirectory, staleDirectory);
          await rm(staleDirectory, { recursive: true, force: true });
        } catch (staleError) {
          if (staleError?.code !== "ENOENT") throw staleError;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the shared Rust coverage lock");
      }
      await sleep(coverageLockRetryMs);
    }
  }
}

const isWithinRepository = (path) => {
  const pathRelative = relative(repositoryRoot, path);
  return (
    pathRelative.length > 0 &&
    pathRelative !== ".." &&
    !pathRelative.startsWith(`..${sep}`) &&
    !isAbsolute(pathRelative)
  );
};

export const resolveManifestPath = (manifestArgument) => {
  if (typeof manifestArgument !== "string" || manifestArgument.length === 0) {
    throw new Error("a Cargo manifest path is required");
  }
  const manifestPath = resolve(repositoryRoot, manifestArgument);
  if (!isWithinRepository(manifestPath) || !existsSync(manifestPath)) {
    throw new Error(`coverage manifest must exist inside the repository: ${manifestArgument}`);
  }
  return manifestPath;
};

const resolveChangedPath = (pathArgument) => {
  const path = resolve(repositoryRoot, pathArgument);
  if (!isWithinRepository(path)) {
    throw new Error(`changed coverage path must be inside the repository: ${pathArgument}`);
  }
  return relative(repositoryRoot, path);
};

export function parseRunnerArguments(argv) {
  const [manifestArgument, ...argumentsAfterManifest] = argv;
  const cargoArguments = [];
  const changedPaths = [];
  let changedLinesMinimum = null;
  let coverageBase = process.env.RUST_COVERAGE_BASE?.trim() || null;

  for (let index = 0; index < argumentsAfterManifest.length; index += 1) {
    const argument = argumentsAfterManifest[index];
    if (argument === "--changed-lines") {
      changedLinesMinimum = Number(argumentsAfterManifest[++index]);
    } else if (argument.startsWith("--changed-lines=")) {
      changedLinesMinimum = Number(argument.slice("--changed-lines=".length));
    } else if (argument === "--changed-path") {
      changedPaths.push(resolveChangedPath(argumentsAfterManifest[++index]));
    } else if (argument.startsWith("--changed-path=")) {
      changedPaths.push(resolveChangedPath(argument.slice("--changed-path=".length)));
    } else if (argument === "--coverage-base") {
      coverageBase = argumentsAfterManifest[++index];
    } else if (argument.startsWith("--coverage-base=")) {
      coverageBase = argument.slice("--coverage-base=".length);
    } else {
      cargoArguments.push(argument);
    }
  }

  if (
    changedLinesMinimum !== null &&
    (!Number.isFinite(changedLinesMinimum) || changedLinesMinimum < 0 || changedLinesMinimum > 100)
  ) {
    throw new Error("--changed-lines must be a percentage from 0 through 100");
  }
  if (changedLinesMinimum !== null && changedPaths.length === 0) {
    throw new Error("--changed-lines requires at least one --changed-path");
  }

  return {
    manifestPath: resolveManifestPath(manifestArgument),
    cargoArguments,
    changedLinesMinimum,
    changedPaths,
    coverageBase,
  };
}

const runChild = (manifestPath, cargoArguments, targetDirectory, commandOverride) =>
  new Promise((resolvePromise) => {
    const command = commandOverride ? process.execPath : "cargo";
    const childArguments = commandOverride
      ? ["-e", commandOverride]
      : ["llvm-cov", "--manifest-path", manifestPath, ...cargoArguments];
    const child = spawn(command, childArguments, {
      cwd: repositoryRoot,
      env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
      stdio: "inherit",
    });
    child.once("error", () => resolvePromise(1));
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });

export function parseLcovLineCoverage(content) {
  const coverage = new Map();
  let sourcePath = null;
  for (const line of content.split(/\r?\n/u)) {
    if (line.startsWith("SF:")) {
      sourcePath = resolve(line.slice(3));
      if (!coverage.has(sourcePath)) coverage.set(sourcePath, new Map());
      continue;
    }
    if (!sourcePath || !line.startsWith("DA:")) continue;
    const [lineNumberText, hitsText] = line.slice(3).split(",", 2);
    const lineNumber = Number(lineNumberText);
    const hits = Number(hitsText);
    if (!Number.isInteger(lineNumber) || !Number.isFinite(hits)) continue;
    const sourceCoverage = coverage.get(sourcePath);
    sourceCoverage.set(lineNumber, Math.max(sourceCoverage.get(lineNumber) ?? 0, hits));
  }
  return coverage;
}

export function parseChangedLines(diffContent) {
  const changed = new Map();
  let sourcePath = null;
  for (const line of diffContent.split(/\r?\n/u)) {
    if (line.startsWith("+++ ")) {
      const relativePath = line.slice(4);
      sourcePath = relativePath === "/dev/null" ? null : resolve(repositoryRoot, relativePath);
      if (sourcePath && !changed.has(sourcePath)) changed.set(sourcePath, new Set());
      continue;
    }
    if (!sourcePath || !line.startsWith("@@")) continue;
    const hunk = line.match(/\+(\d+)(?:,(\d+))?/u);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = Number(hunk[2] ?? 1);
    for (let offset = 0; offset < count; offset += 1) {
      changed.get(sourcePath).add(start + offset);
    }
  }
  return changed;
}

const mergeChangedLines = (target, source) => {
  for (const [path, lines] of source) {
    const targetLines = target.get(path) ?? new Set();
    for (const line of lines) targetLines.add(line);
    target.set(path, targetLines);
  }
};

const gitOutput = (arguments_) =>
  execFileSync("git", arguments_, { cwd: repositoryRoot, encoding: "utf8" });

const effectiveCoverageBase = (coverageBase) => {
  if (coverageBase && !/^0+$/u.test(coverageBase)) return coverageBase;
  if (process.env.CI) return "HEAD^";
  return null;
};

export function collectChangedLines(changedPaths, coverageBase) {
  const base = effectiveCoverageBase(coverageBase);
  const diffArguments = ["diff", "--no-ext-diff", "--no-prefix", "--unified=0"];
  if (base) diffArguments.push(`${base}...HEAD`);
  else diffArguments.push("HEAD");
  diffArguments.push("--", ...changedPaths);
  const changed = parseChangedLines(gitOutput(diffArguments));

  if (!base) {
    const untracked = gitOutput([
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ...changedPaths,
    ])
      .split(/\r?\n/u)
      .filter(Boolean);
    for (const relativePath of untracked) {
      const sourcePath = resolve(repositoryRoot, relativePath);
      const lineCount = readFileSync(sourcePath, "utf8").split(/\r?\n/u).length;
      const lines = new Set(Array.from({ length: lineCount }, (_, index) => index + 1));
      mergeChangedLines(changed, new Map([[sourcePath, lines]]));
    }
  }
  return changed;
}

/** Verify aggregate executable changed-line coverage for the selected paths. */
export function verifyChangedLineCoverage({ lcovContent, changedLines, minimum }) {
  const coverage = parseLcovLineCoverage(lcovContent);
  const results = [];
  let found = 0;
  let hit = 0;

  for (const [sourcePath, lines] of changedLines) {
    const sourceCoverage = coverage.get(sourcePath);
    if (!sourceCoverage) {
      const isTestModule = sourcePath.endsWith(`${sep}tests.rs`);
      if (sourcePath.endsWith(".rs") && lines.size > 0 && !isTestModule) {
        throw new Error(
          `Rust coverage is missing changed source ${relative(repositoryRoot, sourcePath)}`,
        );
      }
      continue;
    }
    const executableLines = [...lines].filter((line) => sourceCoverage.has(line));
    const hitLines = executableLines.filter((line) => sourceCoverage.get(line) > 0);
    found += executableLines.length;
    hit += hitLines.length;
    results.push({
      path: relative(repositoryRoot, sourcePath),
      found: executableLines.length,
      hit: hitLines.length,
      missed: executableLines.filter((line) => sourceCoverage.get(line) === 0),
    });
  }

  const percentage = found === 0 ? 100 : (hit / found) * 100;
  for (const result of results) {
    const filePercentage = result.found === 0 ? 100 : (result.hit / result.found) * 100;
    console.log(
      `changed-line coverage ${result.path}: ${result.hit}/${result.found} (${filePercentage.toFixed(2)}%)`,
    );
    if (result.missed.length > 0) console.log(`  missed lines: ${result.missed.join(", ")}`);
  }
  console.log(`changed-line coverage total: ${hit}/${found} (${percentage.toFixed(2)}%)`);
  if (percentage + Number.EPSILON < minimum) {
    throw new Error(
      `changed-line coverage ${percentage.toFixed(2)}% is below ${minimum.toFixed(2)}%`,
    );
  }
  return { found, hit, percentage, results };
}

const availableRepositoryBytes = async () => {
  const filesystem = await statfs(repositoryRoot, { bigint: true });
  return filesystem.bavail * filesystem.bsize;
};

/**
 * @param {string[]} argv
 * @param {{commandOverride?: string, onTargetDirectory?: (path: string) => void, cleanup?: typeof cleanBuildArtifacts, availableBytes?: bigint, lockDirectory?: string}} options
 */
export async function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseRunnerArguments(argv);
  const releaseCoverageLock = await acquireCoverageLock(options.lockDirectory);
  let targetDirectory = null;

  try {
    const cleanup = options.cleanup ?? cleanBuildArtifacts;
    const cleanupResult = await cleanup({ root: repositoryRoot, pruneRust: true });
    if (cleanupResult.skipped.some((entry) => entry.includes("Rust process"))) {
      throw new Error(cleanupResult.skipped.join("; "));
    }

    const availableBytes = BigInt(options.availableBytes ?? (await availableRepositoryBytes()));
    if (availableBytes < BigInt(MINIMUM_FREE_BYTES)) {
      const gibibytes = Number(availableBytes) / 1024 ** 3;
      throw new Error(
        `Rust coverage requires at least 12 GiB free before compilation; ${gibibytes.toFixed(2)} GiB available`,
      );
    }

    targetDirectory = await mkdtemp(temporaryTargetPrefix);
    options.onTargetDirectory?.(targetDirectory);
    const cargoArguments = [...parsed.cargoArguments];
    const reportPath = join(targetDirectory, "changed-lines.lcov");
    if (parsed.changedLinesMinimum !== null) {
      cargoArguments.push("--lcov", "--output-path", reportPath);
    }

    const exitCode = await runChild(
      parsed.manifestPath,
      cargoArguments,
      targetDirectory,
      options.commandOverride ?? process.env.RUST_COVERAGE_CHILD_COMMAND,
    );
    if (exitCode !== 0 || parsed.changedLinesMinimum === null) return exitCode;

    verifyChangedLineCoverage({
      lcovContent: await readFile(reportPath, "utf8"),
      changedLines: collectChangedLines(parsed.changedPaths, parsed.coverageBase),
      minimum: parsed.changedLinesMinimum,
    });
    return 0;
  } finally {
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
    await releaseCoverageLock();
  }
}

const isDirectInvocation =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      `Rust coverage failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
