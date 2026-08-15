#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AZOOKEY_DICTIONARY_ARCHIVE_BYTES,
  AZOOKEY_DICTIONARY_ARCHIVE_SHA256,
  AZOOKEY_DICTIONARY_REVISION,
} from "./build-azookey-dictionary.mjs";
import { REQUIRED_WASM_EXPORTS } from "./verify-azookey-wasm-parity.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXPECTED_VIBRATO_DICTIONARY_SHA256 =
  "82a6da70bb4a17be70f20ff44f650f9ad1d2b0b4fcb2f39c17fc797f92d0ab75";
const EXPECTED_VIBRATO_WASM_SHA256 =
  "334375e6442c3be496a9cf90c21c59fcdbd4ff96560805341333ba1b881c969b";
const EXPECTED_VIBRATO_COPYING_SHA256 =
  "81266cd4d1808e259b468c7488d658d733c089d4c346a48b9876fa2504a23b46";
const EXPECTED_VIBRATO_NOTICE_SHA256 =
  "8f76551acd5ba10116d61a2fea60bcc484906c836e86b7846cb175d1492a086b";
const EXPECTED_SUBMODULE_GITLINKS = {
  "submodules/AzooKeyKanaKanjiConverter": "8e3a6eb89e088efd868aa28dadb74c697df4e6fb",
  "submodules/Parapper-ASR": "a01922f0383214e01a3875ec673fa1c316cdeb36",
  "submodules/azooKey-Desktop": "7702e190a498841d05de6384c9eea127ab13e370",
  "submodules/azooKey_dictionary_storage": AZOOKEY_DICTIONARY_REVISION,
};
const VIBRATO_DICTIONARY_PATHS = [
  "assets/vibrato/ipadic-mecab-2_7_0/system.dic.zst",
  "apps/azookey-compare/public/vibrato/system.dic.zst",
];
const WORKER_VIBRATO_DICTIONARY_PATH =
  "apps/cloudflare-worker-server/public/vibrato/system.dic.zst";
const VIBRATO_COPYING_PATHS = [
  "assets/vibrato/ipadic-mecab-2_7_0/COPYING",
  "apps/azookey-compare/public/vibrato/COPYING",
  "apps/cloudflare-worker-server/public/vibrato/COPYING",
];
const VIBRATO_NOTICE_PATHS = [
  "assets/vibrato/ipadic-mecab-2_7_0/NOTICE",
  "apps/azookey-compare/public/vibrato/NOTICE",
  "apps/cloudflare-worker-server/public/vibrato/NOTICE",
];
const VIBRATO_WASM_PATHS = [
  "apps/azookey-compare/public/vibrato/vibrato_wasm_bg.wasm",
  "apps/cloudflare-worker-server/wasm/vibrato_wasm_bg.wasm",
  "packages/vibrato/wasm/pkg-web/vibrato_wasm_bg.wasm",
];
const VIBRATO_GLUE_JS_PATHS = [
  "apps/azookey-compare/public/vibrato/vibrato_wasm.js",
  "apps/cloudflare-worker-server/src/vibrato_wasm.js",
  "packages/vibrato/wasm/pkg-web/vibrato_wasm.js",
];
const VIBRATO_GLUE_DTS_PATHS = [
  "apps/azookey-compare/public/vibrato/vibrato_wasm.d.ts",
  "apps/cloudflare-worker-server/src/vibrato_wasm.d.ts",
  "packages/vibrato/wasm/pkg-web/vibrato_wasm.d.ts",
];
const VIBRATO_GLUE_BG_DTS_PATH = "packages/vibrato/wasm/pkg-web/vibrato_wasm_bg.wasm.d.ts";
const AZOOKEY_DICTIONARY_PATH = "apps/cloudflare-worker-server/public/azookey/system.azkdict.gz";
const AZOOKEY_WASM_PATH = "apps/cloudflare-worker-server/wasm/azookey.wasm";
const COMPARE_AZOOKEY_DIR = "apps/azookey-compare/public/azookey";
const COMPARE_AZOOKEY_WASM_PATH = `${COMPARE_AZOOKEY_DIR}/azookey.wasm`;
const COMPARE_AZOOKEY_DICTIONARY_PATH = `${COMPARE_AZOOKEY_DIR}/system.azkdict.gz`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const readAsset = (root, path) => {
  const absolutePath = resolve(root, path);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`generated asset is missing: ${path}`);
  }
  return readFileSync(absolutePath);
};

const assertWorkerVibratoDictionaryAbsent = (root) => {
  if (existsSync(resolve(root, WORKER_VIBRATO_DICTIONARY_PATH))) {
    throw new Error(
      `Worker Vibrato dictionary must not be bundled: ${WORKER_VIBRATO_DICTIONARY_PATH}`,
    );
  }
};

const assertSameBytes = (root, paths, expectedHash, label) => {
  const bytes = paths.map((path) => readAsset(root, path));
  const hashes = bytes.map(sha256);
  if (hashes.some((hash) => hash !== expectedHash) || new Set(hashes).size !== 1) {
    throw new Error(`${label} hash mismatch: ${hashes.join(", ")}`);
  }
  return { bytes: bytes[0], sha256: expectedHash, paths };
};

const trackedFiles = (root) =>
  new Set(
    execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "buffer" })
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );

const isIgnored = (root, path) => {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "--quiet", "--", path]);
    return true;
  } catch {
    return false;
  }
};

const verifyTracked = (root, tracked, paths, { requireTracked = false } = {}) => {
  const missing = paths.filter((path) => !tracked.has(path));
  if (missing.length === 0) {
    return;
  }
  const ignored = missing.filter((path) => isIgnored(root, path));
  if (ignored.length > 0) {
    throw new Error(`generated asset is ignored by git: ${ignored.join(", ")}`);
  }
  if (requireTracked) {
    throw new Error(`generated asset is not tracked: ${missing.join(", ")}`);
  }
  console.warn(
    `Generated assets are present but unstaged; stage them before publishing: ${missing.join(", ")}`,
  );
};

const verifySubmoduleGitlinks = (root) => {
  const gitmodules = readFileSync(resolve(root, ".gitmodules"), "utf8");
  if (/\b(?:git@|ssh:\/\/)/.test(gitmodules)) {
    throw new Error("submodule URLs must use HTTPS so clean CI checkouts need no SSH key");
  }
  for (const [path, revision] of Object.entries(EXPECTED_SUBMODULE_GITLINKS)) {
    const line = execFileSync("git", ["-C", root, "ls-tree", "HEAD", path], {
      encoding: "utf8",
    }).trim();
    if (!new RegExp(`\\b${revision}\\b`).test(line)) {
      throw new Error(`submodule gitlink drifted at ${path}: expected ${revision}`);
    }
  }
};

const assertCompareAzookeyIgnored = (root) => {
  if (
    !isIgnored(root, COMPARE_AZOOKEY_WASM_PATH) ||
    !isIgnored(root, COMPARE_AZOOKEY_DICTIONARY_PATH)
  ) {
    throw new Error(
      `compare AzooKey browser assets must be gitignored (build-time copy): ${COMPARE_AZOOKEY_DIR}`,
    );
  }
};

const assertCompareAzookeyCopiesMatchWhenPresent = (root, workerWasmHash, workerDictHash) => {
  const wasmPath = resolve(root, COMPARE_AZOOKEY_WASM_PATH);
  const dictPath = resolve(root, COMPARE_AZOOKEY_DICTIONARY_PATH);
  const wasmExists = existsSync(wasmPath);
  const dictExists = existsSync(dictPath);
  if (!wasmExists && !dictExists) {
    return;
  }
  if (!wasmExists || !dictExists) {
    throw new Error("compare AzooKey browser assets are incomplete; copy both wasm and dictionary");
  }
  if (sha256(readFileSync(wasmPath)) !== workerWasmHash) {
    throw new Error("compare AzooKey wasm copy drifted from worker source");
  }
  if (sha256(readFileSync(dictPath)) !== workerDictHash) {
    throw new Error("compare AzooKey dictionary copy drifted from worker source");
  }
};

const verifyAzookeyWasm = (root) => {
  const bytes = readAsset(root, AZOOKEY_WASM_PATH);
  let module;
  try {
    module = new WebAssembly.Module(bytes);
  } catch (error) {
    throw new Error(`AzooKey WASM is not a valid module: ${error.message}`);
  }
  const exports = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
  for (const name of REQUIRED_WASM_EXPORTS) {
    if (!exports.has(name)) {
      throw new Error(`AzooKey WASM export is missing: ${name}`);
    }
  }
  return { bytes, sha256: sha256(bytes), paths: [AZOOKEY_WASM_PATH] };
};

/**
 * Verify every checked-in runtime asset that is copied between app packages.
 *
 * This intentionally checks bytes rather than timestamps or filesystem mtime:
 * generated files remain reproducible across clean clones and platform builds.
 */
export const verifyGeneratedAssets = ({ root = repositoryRoot, requireTracked = false } = {}) => {
  const tracked = trackedFiles(root);
  assertWorkerVibratoDictionaryAbsent(root);
  verifyTracked(
    root,
    tracked,
    [
      ...VIBRATO_DICTIONARY_PATHS,
      ...VIBRATO_COPYING_PATHS,
      ...VIBRATO_NOTICE_PATHS,
      ...VIBRATO_WASM_PATHS,
      ...VIBRATO_GLUE_JS_PATHS,
      ...VIBRATO_GLUE_DTS_PATHS,
      VIBRATO_GLUE_BG_DTS_PATH,
      AZOOKEY_DICTIONARY_PATH,
      AZOOKEY_WASM_PATH,
    ],
    { requireTracked },
  );
  verifySubmoduleGitlinks(root);

  const vibratoDictionary = assertSameBytes(
    root,
    VIBRATO_DICTIONARY_PATHS,
    EXPECTED_VIBRATO_DICTIONARY_SHA256,
    "Vibrato dictionary",
  );
  const vibratoWasm = assertSameBytes(
    root,
    VIBRATO_WASM_PATHS,
    EXPECTED_VIBRATO_WASM_SHA256,
    "Vibrato WASM",
  );
  const vibratoGlueJs = assertSameBytes(
    root,
    VIBRATO_GLUE_JS_PATHS,
    "e094326c1f0d142882da0a64b272adfc1e5b24eff9b91a02ab531ff9dba96b1e",
    "Vibrato JS glue",
  );
  const vibratoGlueDts = assertSameBytes(
    root,
    VIBRATO_GLUE_DTS_PATHS,
    "cea5a43822058c77e63b09820ea921acaad18efff5d23cc025bc43b1ef6f4aef",
    "Vibrato TypeScript glue",
  );
  const vibratoGlueBgDtsBytes = readAsset(root, VIBRATO_GLUE_BG_DTS_PATH);
  const vibratoGlueBgDtsHash = sha256(vibratoGlueBgDtsBytes);
  if (vibratoGlueBgDtsHash !== "6cf8b66a1bb3e1989bdd4a042f3f9d40a09f4523a3b08c600727e735a053bdea") {
    throw new Error(`Vibrato WASM TypeScript declaration hash mismatch: ${vibratoGlueBgDtsHash}`);
  }
  const vibratoCopying = assertSameBytes(
    root,
    VIBRATO_COPYING_PATHS,
    EXPECTED_VIBRATO_COPYING_SHA256,
    "Vibrato COPYING",
  );
  const vibratoNotice = assertSameBytes(
    root,
    VIBRATO_NOTICE_PATHS,
    EXPECTED_VIBRATO_NOTICE_SHA256,
    "Vibrato NOTICE",
  );
  const azookeyDictionary = readAsset(root, AZOOKEY_DICTIONARY_PATH);
  const azookeyDictionaryHash = sha256(azookeyDictionary);
  if (
    azookeyDictionary.byteLength !== AZOOKEY_DICTIONARY_ARCHIVE_BYTES ||
    azookeyDictionaryHash !== AZOOKEY_DICTIONARY_ARCHIVE_SHA256
  ) {
    throw new Error(`AzooKey dictionary hash mismatch: ${azookeyDictionaryHash}`);
  }
  const azookeyWasm = verifyAzookeyWasm(root);
  assertCompareAzookeyIgnored(root);
  assertCompareAzookeyCopiesMatchWhenPresent(root, azookeyWasm.sha256, azookeyDictionaryHash);
  return {
    vibratoDictionary,
    vibratoWasm,
    vibratoGlueJs,
    vibratoGlueDts,
    vibratoGlueBgDts: {
      bytes: vibratoGlueBgDtsBytes,
      sha256: vibratoGlueBgDtsHash,
      paths: [VIBRATO_GLUE_BG_DTS_PATH],
    },
    vibratoCopying,
    vibratoNotice,
    azookeyDictionary: {
      bytes: azookeyDictionary,
      sha256: azookeyDictionaryHash,
      paths: [AZOOKEY_DICTIONARY_PATH],
    },
    azookeyWasm,
  };
};

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    const result = verifyGeneratedAssets({
      requireTracked: process.argv.includes("--require-tracked"),
    });
    for (const [name, asset] of Object.entries(result)) {
      console.log(`${name}: ${asset.sha256} (${asset.bytes.byteLength} bytes)`);
    }
    console.log("Generated asset verification passed.");
  } catch (error) {
    console.error(`Generated asset verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
