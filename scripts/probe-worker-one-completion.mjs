#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const workerRoot = resolve(root, "apps/cloudflare-worker-server");
const { convertAzookeyMessage, createWasmConverter, parseAzookeyMessage } = await import(
  pathToFileURL(resolve(workerRoot, "src/azookey.ts")).href
);

const wasmBytes = readFileSync(resolve(workerRoot, "wasm/azookey.wasm"));
const dictionaryGzip = readFileSync(resolve(workerRoot, "public/azookey/system.azkdict.gz"));
const module = new WebAssembly.Module(wasmBytes);
const fetcher = async (input, init) => {
  if (typeof input === "string" && input.endsWith("/azookey/system.azkdict.gz")) {
    return new Response(dictionaryGzip, {
      status: 200,
      headers: { "content-length": String(dictionaryGzip.byteLength) },
    });
  }
  return fetch(input, init);
};
const converter = createWasmConverter(module, "/azookey/system.azkdict.gz", fetcher);
await converter.warmup?.();
if (typeof converter.openLattice !== "function") {
  throw new Error("lazy converter wrapper is missing openLattice");
}

const convert = async ({ model, leftContext, zenzUrl }) => {
  const message = parseAzookeyMessage(
    JSON.stringify({
      type: "azookey.convert",
      requestId: "probe-1",
      source: "web-speech",
      language: "ja",
      sourceText: "かんじ",
      vibratoInput: "かんじ",
      mode: "worker-vibrato",
      model,
      ...(leftContext ? { leftContext } : {}),
    }),
  );
  const started = performance.now();
  const result = await convertAzookeyMessage(message, {
    timeoutMs: 2000,
    converter,
    modelRoutes: zenzUrl ? { [model]: { baseUrl: zenzUrl } } : {},
    fetcher,
  });
  return { elapsedMs: Math.round(performance.now() - started), result };
};

const measureLatticeCpu = (text, searches) => {
  const started = process.cpuUsage();
  const wallStarted = performance.now();
  const lattice = converter.openLattice?.(text);
  if (!lattice) {
    throw new Error("openLattice is unavailable");
  }
  try {
    for (let index = 0; index < searches; index += 1) {
      lattice.searchOutputPrefix(new Uint8Array());
    }
  } finally {
    lattice.close();
  }
  const cpu = process.cpuUsage(started);
  return {
    wallMs: Number((performance.now() - wallStarted).toFixed(1)),
    cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(1)),
    searches,
  };
};

const noContext = await convert({
  model: "zenz-v3.2-small-gguf",
  zenzUrl: "http://127.0.0.1:8082",
});
const withContext = await convert({
  model: "zenz-v3.2-small-gguf",
  leftContext: "子供がお菓子を食べています。",
  zenzUrl: "http://127.0.0.1:8082",
});
const failOpen = await convert({
  model: "zenz-v3.2-small-gguf",
  leftContext: "子供がお菓子を食べています。",
  zenzUrl: "http://127.0.0.1:18082",
});
const cpuShort = measureLatticeCpu("かんじ", 10);
const cpuLong = measureLatticeCpu("きょうのてんきははれのちくもりです", 10);

console.log(
  JSON.stringify(
    {
      noContext: {
        elapsedMs: noContext.elapsedMs,
        model: noContext.result.model,
        modelFallback: noContext.result.modelFallback ?? null,
        convertedText: noContext.result.convertedText,
      },
      withContext: {
        elapsedMs: withContext.elapsedMs,
        model: withContext.result.model,
        modelFallback: withContext.result.modelFallback ?? null,
        convertedText: withContext.result.convertedText,
      },
      failOpen: {
        elapsedMs: failOpen.elapsedMs,
        model: failOpen.result.model,
        modelFallback: failOpen.result.modelFallback ?? null,
        convertedText: failOpen.result.convertedText,
      },
      latticeCpu: { short: cpuShort, long: cpuLong, budgetMs: 2000 },
    },
    null,
    2,
  ),
);
