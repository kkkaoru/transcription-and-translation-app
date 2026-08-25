#!/usr/bin/env node

/**
 * Bun/Node-compatible current-RSS probe for the Native QuickMT on/off lifecycle.
 * The output contains process/resource data only, never translation input/output.
 */

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SETTLE_MS = 2_000;

export const parseProcessSample = (stdout) => {
  const [rssRaw, cpuRaw] = stdout.trim().split(/\s+/u);
  const rssKiB = Number.parseInt(rssRaw ?? "", 10);
  const cpuPercent = Number.parseFloat(cpuRaw ?? "");
  if (!Number.isFinite(rssKiB) || !Number.isFinite(cpuPercent)) {
    throw new Error("could not parse process RSS/CPU sample");
  }
  return { rssBytes: rssKiB * 1_024, cpuPercent };
};

const sampleProcess = (pid) => {
  const result = spawnSync("ps", ["-o", "rss=", "-o", "%cpu=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`ps failed with exit ${result.status}`);
  }
  return parseProcessSample(result.stdout);
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const nextEvent = (events) =>
  new Promise((resolve, reject) => {
    events.once("line", (line) => {
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
  });

export const measureTranslationToggle = async ({ binary, modelsRoot }) => {
  const child = spawn(binary, [modelsRoot], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, MallocLargeCache: "0" },
  });
  const events = createInterface({ input: child.stdout });
  const initialEvent = await nextEvent(events);
  const offBefore = sampleProcess(initialEvent.pid);

  child.stdin.write("on\n");
  const onEvent = await nextEvent(events);
  const onImmediate = sampleProcess(onEvent.pid);
  await delay(SETTLE_MS);
  const onSettled = sampleProcess(onEvent.pid);
  child.stdin.write("on\n");
  const warmInferenceEvent = await nextEvent(events);

  child.stdin.write("off\n");
  const offEvent = await nextEvent(events);
  const offImmediate = sampleProcess(offEvent.pid);
  await delay(SETTLE_MS);
  const offSettled = sampleProcess(offEvent.pid);

  child.stdin.end("quit\n");
  await new Promise((resolve, reject) => {
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`translation toggle probe exited with ${code}`));
    });
  });

  return {
    schemaVersion: 1,
    metric: "native-translation-toggle-current-rss",
    translationBackend: "quickmt-ja-en-int8",
    modelDirectionsLoaded: 1,
    offBefore,
    on: {
      ...onSettled,
      transitionMs: onEvent.elapsedMs,
      warmInferenceMs: warmInferenceEvent.elapsedMs,
      immediateRssBytes: onImmediate.rssBytes,
    },
    offAfter: {
      ...offSettled,
      transitionMs: offEvent.elapsedMs,
      immediateRssBytes: offImmediate.rssBytes,
    },
    retainedRssDeltaBytes: offSettled.rssBytes - offBefore.rssBytes,
    activeRssDeltaBytes: onSettled.rssBytes - offBefore.rssBytes,
  };
};

const main = async () => {
  const [binary, modelsRoot] = process.argv.slice(2);
  if (!binary || !modelsRoot) {
    throw new Error("usage: measure-native-translation-toggle.mjs BINARY MODELS_ROOT");
  }
  console.log(JSON.stringify(await measureTranslationToggle({ binary, modelsRoot })));
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
