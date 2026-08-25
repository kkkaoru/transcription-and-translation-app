#!/usr/bin/env bun
// This file runs with bun.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

import { parseDarwinTime, parseGnuTime } from "./benchmark-native-runtime.mjs";

const MANIFEST = "apps/native/Cargo.toml";
const EXAMPLE_BINARY = resolve(
  `apps/native/target/release/examples/translation_runtime_metrics${platform() === "win32" ? ".exe" : ""}`,
);
const DEFAULT_ITERATIONS = 3;

export const positiveIterations = (value) => {
  if (value === undefined) return DEFAULT_ITERATIONS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("iterations must be a positive integer");
  }
  return parsed;
};

export const percentSaved = (before, after) =>
  before === null || after === null || before === 0 ? null : ((before - after) / before) * 100;

export const defaultModelsRoot = (environment = process.env) => {
  if (platform() === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "com.kotobabeacon.native",
      "parapper",
      "models",
    );
  }
  if (platform() === "win32") {
    const appData = environment.APPDATA;
    if (!appData) throw new Error("APPDATA is required to locate Native models");
    return join(appData, "com.kotobabeacon.native", "parapper", "models");
  }
  const dataHome = environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "com.kotobabeacon.native", "parapper", "models");
};

const buildFixture = () => {
  const result = spawnSync(
    "cargo",
    [
      "build",
      "--release",
      "--manifest-path",
      MANIFEST,
      "--no-default-features",
      "--features",
      "translation-comparison",
      "--example",
      "translation_runtime_metrics",
    ],
    { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || !existsSync(EXAMPLE_BINARY)) {
    throw new Error("could not build the Native translation comparison fixture");
  }
};

const runBackend = (backend, modelsRoot, iterations) => {
  const arguments_ = [backend, modelsRoot, String(iterations)];
  if (platform() === "win32") {
    const result = spawnSync(EXAMPLE_BINARY, arguments_, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `${backend} fixture failed`);
    return {
      workload: JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),
      process: { wallSeconds: null, cpuSeconds: null, maxRssBytes: null },
    };
  }
  const timeArguments =
    platform() === "darwin"
      ? ["-l", EXAMPLE_BINARY, ...arguments_]
      : ["-v", EXAMPLE_BINARY, ...arguments_];
  const result = spawnSync("/usr/bin/time", timeArguments, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${backend} fixture failed`);
  return {
    workload: JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),
    process: platform() === "darwin" ? parseDarwinTime(result.stderr) : parseGnuTime(result.stderr),
  };
};

export const compareResults = (lfm2, quickmt) => ({
  maxRssPercentSaved: percentSaved(lfm2.process.maxRssBytes, quickmt.process.maxRssBytes),
  loadPercentSaved: percentSaved(lfm2.workload.loadMs, quickmt.workload.loadMs),
  latencyP50PercentSaved: percentSaved(lfm2.workload.latencyMs.p50, quickmt.workload.latencyMs.p50),
  latencyP95PercentSaved: percentSaved(lfm2.workload.latencyMs.p95, quickmt.workload.latencyMs.p95),
  chrf2Delta: quickmt.workload.quality.score - lfm2.workload.quality.score,
});

const main = () => {
  const options = Object.fromEntries(
    process.argv.slice(2).map((argument) => {
      const separator = argument.indexOf("=");
      if (!argument.startsWith("--") || separator < 3) {
        throw new Error("arguments must use --models-root=PATH or --iterations=N");
      }
      return [argument.slice(2, separator), argument.slice(separator + 1)];
    }),
  );
  const unknown = Object.keys(options).find(
    (name) => name !== "models-root" && name !== "iterations",
  );
  if (unknown) throw new Error(`unknown option: ${unknown}`);
  const modelsRoot = options["models-root"] ?? defaultModelsRoot();
  const iterations = positiveIterations(options.iterations);
  buildFixture();
  const lfm2 = runBackend("lfm2-q4", modelsRoot, iterations);
  const quickmt = runBackend("quickmt-int8", modelsRoot, iterations);
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        benchmark: "native-translation-comparison",
        iterations,
        lfm2,
        quickmt,
        improvement: compareResults(lfm2, quickmt),
      },
      null,
      2,
    ),
  );
};

if (import.meta.main) main();
