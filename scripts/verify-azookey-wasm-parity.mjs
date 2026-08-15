#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  AZOOKEY_DICTIONARY_ARCHIVE_BYTES,
  AZOOKEY_DICTIONARY_ARCHIVE_SHA256,
} from "./build-azookey-dictionary.mjs";

export const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const WORKER_WASM_RELATIVE_PATH = "apps/cloudflare-worker-server/wasm/azookey.wasm";
export const WORKER_DICT_RELATIVE_PATH =
  "apps/cloudflare-worker-server/public/azookey/system.azkdict.gz";
export const INFERENCE_WRANGLER_RELATIVE_PATH = "apps/cloudflare-worker-server/wrangler.jsonc";
export const COMPARE_WRANGLER_RELATIVE_PATH = "apps/azookey-compare/wrangler.jsonc";
export const EXPECTED_DICT_SHA256 = AZOOKEY_DICTIONARY_ARCHIVE_SHA256;
export const REQUIRED_WASM_EXPORTS = [
  "memory",
  "azookey_abi_version",
  "azookey_alloc",
  "azookey_dealloc",
  "azookey_convert",
  "azookey_convert_n_best",
  "azookey_dictionary_init_owned",
  "azookey_lattice_open",
  "azookey_lattice_search_output_prefix",
  "azookey_lattice_close",
  "azookey_lattice_live_count",
  "azookey_lattice_opened_count",
  "azookey_lattice_closed_count",
];
export const SPOT_CHECK_CASES = [
  ["きょうはいいてんき", "今日はいい天気"],
  ["きょうのてんきはあつい", "今日の天気は暑い"],
  ["すーぷがあつい", "スープが熱い"],
  ["きょうははいしんです", "今日は配信です"],
  ["あしたのてんきははれ", "明日の天気は晴れ"],
];
export const COMPARE_MUST_NOT_SHIP = [
  "apps/azookey-compare/public/azookey/azookey.wasm",
  "apps/azookey-compare/public/azookey/system.azkdict.gz",
  "apps/azookey-compare/wasm/azookey.wasm",
];

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const wasmMagic = (bytes) =>
  bytes.byteLength >= 4 &&
  bytes[0] === 0x00 &&
  bytes[1] === 0x61 &&
  bytes[2] === 0x73 &&
  bytes[3] === 0x6d;

export const workerAssetPaths = (root = repositoryRoot) => ({
  wasmPath: resolve(root, WORKER_WASM_RELATIVE_PATH),
  dictPath: resolve(root, WORKER_DICT_RELATIVE_PATH),
  inferenceWranglerPath: resolve(root, INFERENCE_WRANGLER_RELATIVE_PATH),
  compareWranglerPath: resolve(root, COMPARE_WRANGLER_RELATIVE_PATH),
});

export const loadWorkerAzookeyAssets = (root = repositoryRoot) => {
  const { wasmPath, dictPath } = workerAssetPaths(root);
  if (!existsSync(wasmPath)) {
    throw new Error(`WASM missing: ${wasmPath}`);
  }
  if (!existsSync(dictPath)) {
    throw new Error(`dict missing: ${dictPath}`);
  }
  const wasmBytes = readFileSync(wasmPath);
  const dictGz = readFileSync(dictPath);
  if (!wasmMagic(wasmBytes)) {
    throw new Error(`not a real Wasm module: ${wasmPath}`);
  }
  return {
    wasmPath,
    dictPath,
    wasmBytes,
    dictGz,
    wasmSha256: sha256(wasmBytes),
    dictSha256: sha256(dictGz),
  };
};

export const assertPinnedDictionary = (assets) => {
  if (assets.dictGz.byteLength !== AZOOKEY_DICTIONARY_ARCHIVE_BYTES) {
    throw new Error(
      `dict size mismatch: ${assets.dictGz.byteLength} !== ${AZOOKEY_DICTIONARY_ARCHIVE_BYTES}`,
    );
  }
  if (assets.dictSha256 !== EXPECTED_DICT_SHA256) {
    throw new Error(`dict hash mismatch: ${assets.dictSha256}`);
  }
};

export const assertPortableAbi = (wasmBytes) => {
  const module = new WebAssembly.Module(wasmBytes);
  const exportNames = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
  const missing = REQUIRED_WASM_EXPORTS.filter((name) => !exportNames.has(name));
  if (missing.length > 0) {
    throw new Error(`missing ABI exports: ${missing.join(",")}`);
  }
  return module;
};

export const createPortableConverter = (wasmBytes, dictGz) => {
  const dictRaw = gunzipSync(dictGz);
  const module = assertPortableAbi(wasmBytes);
  const instance = new WebAssembly.Instance(module, {});
  const exports = instance.exports;
  if (typeof exports.azookey_dictionary_init_owned !== "function") {
    throw new Error("missing azookey_dictionary_init_owned");
  }
  if (exports.azookey_abi_version() !== 2) {
    throw new Error(`ABI mismatch: ${exports.azookey_abi_version()}`);
  }
  const initPtr = exports.azookey_alloc(dictRaw.length);
  if (!initPtr) {
    throw new Error("dictionary allocation failed");
  }
  new Uint8Array(exports.memory.buffer, initPtr, dictRaw.length).set(dictRaw);
  const status = exports.azookey_dictionary_init_owned(initPtr, dictRaw.length);
  if (status !== 0) {
    throw new Error(`dictionary init failed ${status}`);
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return (input) => {
    const bytes = encoder.encode(input);
    const pointer = exports.azookey_alloc(bytes.length);
    new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
    const packed = exports.azookey_convert(pointer, bytes.length);
    exports.azookey_dealloc(pointer, bytes.length);
    if (packed === 0 || packed === 0n) {
      throw new Error("convert alloc failed");
    }
    const value = typeof packed === "bigint" ? packed : BigInt(packed);
    const outputPtr = Number((value >> 32n) & 0xffffffffn);
    const outputLen = Number(value & 0xffffffffn);
    const output = decoder.decode(new Uint8Array(exports.memory.buffer, outputPtr, outputLen));
    exports.azookey_dealloc(outputPtr, outputLen);
    return output;
  };
};

export const convertSpotChecks = (convert, cases = SPOT_CHECK_CASES) =>
  cases.map(([input, expected]) => {
    const output = convert(input);
    if (output !== expected) {
      throw new Error(
        `conversion mismatch ${JSON.stringify(input)} -> ${JSON.stringify(output)} expected ${JSON.stringify(expected)}`,
      );
    }
    return { input, output, expected };
  });

const trackedCompareAzookeyAssets = (root = repositoryRoot) => {
  const listed = execFileSync("git", ["-C", root, "ls-files", "-z", "--", ...COMPARE_MUST_NOT_SHIP], {
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return COMPARE_MUST_NOT_SHIP.filter((relativePath) => listed.includes(relativePath));
};

export const assertCompareDoesNotShipAzookeyAssets = (root = repositoryRoot) => {
  const tracked = trackedCompareAzookeyAssets(root);
  if (tracked.length > 0) {
    throw new Error(`compare must not ship AzooKey wasm/dict copies: ${tracked.join(", ")}`);
  }
};

export const assertInferenceCompareShareWorkerAssets = (root = repositoryRoot) => {
  const { inferenceWranglerPath, compareWranglerPath } = workerAssetPaths(root);
  const inferenceConfig = readFileSync(inferenceWranglerPath, "utf8");
  const compareConfig = readFileSync(compareWranglerPath, "utf8");
  if (!inferenceConfig.includes('"name": "kotoba-beacon-inference"')) {
    throw new Error("inference wrangler is not kotoba-beacon-inference");
  }
  if (!inferenceConfig.includes('"AZOOKEY_DICTIONARY_URL": "/azookey/system.azkdict.gz"')) {
    throw new Error("inference wrangler does not pin the worker-server portable dictionary");
  }
  if (!inferenceConfig.includes('"globs": ["wasm/*.wasm"]')) {
    throw new Error("inference wrangler does not compile worker-server wasm/*.wasm");
  }
  if (!compareConfig.includes('"binding": "INFERENCE"')) {
    throw new Error("compare wrangler is missing INFERENCE binding");
  }
  if (!compareConfig.includes('"service": "kotoba-beacon-inference"')) {
    throw new Error("compare wrangler does not bind the inference worker");
  }
  assertCompareDoesNotShipAzookeyAssets(root);
};

export const verifyAzookeyWasmParity = ({ root = repositoryRoot } = {}) => {
  const assets = loadWorkerAzookeyAssets(root);
  assertPinnedDictionary(assets);
  assertInferenceCompareShareWorkerAssets(root);
  const convert = createPortableConverter(assets.wasmBytes, assets.dictGz);
  const reread = loadWorkerAzookeyAssets(root);
  if (reread.wasmSha256 !== assets.wasmSha256 || reread.dictSha256 !== assets.dictSha256) {
    throw new Error("worker-server wasm/dict changed during verification");
  }
  const conversions = convertSpotChecks(convert);
  return {
    ok: true,
    wasmPath: assets.wasmPath,
    dictPath: assets.dictPath,
    wasmBytes: assets.wasmBytes.byteLength,
    wasmSha256: assets.wasmSha256,
    dictBytes: assets.dictGz.byteLength,
    dictSha256: assets.dictSha256,
    conversions,
  };
};

export const main = () => {
  try {
    const result = verifyAzookeyWasmParity();
    console.log("=== Worker AzooKey portable ABI parity (Node WebAssembly) ===");
    console.log(`wasm: ${result.wasmPath} ${result.wasmBytes} bytes sha256=${result.wasmSha256}`);
    console.log(
      `dict: ${result.dictPath} ${result.dictBytes} bytes sha256=${result.dictSha256} OK`,
    );
    console.log(
      "shared artifacts: inference wrangler ships wasm+dict; compare binds INFERENCE and does not copy them",
    );
    for (const { input, output } of result.conversions) {
      console.log(`  ${JSON.stringify(input)} -> ${JSON.stringify(output)} OK`);
    }
    console.log("Done. exitCode=0");
    process.exitCode = 0;
    return 0;
  } catch (error) {
    console.error(`azookey wasm parity failed: ${error.message}`);
    process.exitCode = 1;
    return 1;
  }
};

const isMainModule =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
