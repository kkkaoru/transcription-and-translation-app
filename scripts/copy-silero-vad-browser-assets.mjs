#!/usr/bin/env node
/**
 * Pin Silero VAD v6 ONNX + onnxruntime-web WASM into compare `public/`
 * for Next static export. Downloads are cached locally and gitignored.
 *
 * Source of truth (Parapper catalog):
 * https://github.com/snakers4/silero-vad/raw/refs/tags/v6.0/src/silero_vad/data/silero_vad.onnx
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SILERO_VAD_SOURCE_URL =
  "https://github.com/snakers4/silero-vad/raw/refs/tags/v6.0/src/silero_vad/data/silero_vad.onnx";
export const SILERO_VAD_PUBLIC_RELATIVE = "models/silero_vad_v6/silero_vad.onnx";

const MIN_ONNX_BYTES = 50_000;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compareRoot = resolve(root, "apps/azookey-compare");
const cacheDir = resolve(compareRoot, ".cache/silero-vad");
const cacheOnnx = resolve(cacheDir, "silero_vad.onnx");
const publicOnnx = resolve(compareRoot, "public", SILERO_VAD_PUBLIC_RELATIVE);
const publicOrt = resolve(compareRoot, "public/ort");

const ortDistCandidates = [
  resolve(compareRoot, "node_modules/onnxruntime-web/dist"),
  resolve(root, "node_modules/onnxruntime-web/dist"),
];

const isUsableOnnx = (path) =>
  existsSync(path) && statSync(path).isFile() && statSync(path).size >= MIN_ONNX_BYTES;

const ensureSileroOnnx = async () => {
  mkdirSync(dirname(publicOnnx), { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  if (!isUsableOnnx(cacheOnnx)) {
    const response = await fetch(SILERO_VAD_SOURCE_URL);
    if (!response.ok) {
      throw new Error(`Failed to download Silero VAD: ${response.status} ${SILERO_VAD_SOURCE_URL}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < MIN_ONNX_BYTES) {
      throw new Error(`Silero VAD download too small (${bytes.length} bytes)`);
    }
    writeFileSync(cacheOnnx, bytes);
    console.log(`Downloaded Silero VAD v6 (${bytes.length} bytes) → ${cacheOnnx}`);
  } else {
    console.log(`Using cached Silero VAD → ${cacheOnnx}`);
  }
  copyFileSync(cacheOnnx, publicOnnx);
};

/** WASM EP only. jsep/jspi/asyncify exceed Cloudflare Workers' 25 MiB asset limit. */
const isOrtRuntimeAsset = (name) => /^ort-wasm-simd-threaded\.(mjs|wasm)$/u.test(name);

const copyOrtWasm = () => {
  const dist = ortDistCandidates.find((dir) => existsSync(dir));
  if (!dist) {
    throw new Error("onnxruntime-web is not installed; add it to apps/azookey-compare");
  }
  mkdirSync(publicOrt, { recursive: true });
  for (const stale of readdirSync(publicOrt)) {
    if (!isOrtRuntimeAsset(stale)) {
      rmSync(join(publicOrt, stale), { force: true });
    }
  }
  const names = readdirSync(dist).filter(isOrtRuntimeAsset);
  if (names.length === 0) {
    throw new Error(`No ORT wasm assets found in ${dist}`);
  }
  for (const name of names) {
    copyFileSync(join(dist, name), join(publicOrt, name));
  }
  console.log(`Copied ${names.length} onnxruntime-web WASM EP assets → ${publicOrt}`);
};

const run = async () => {
  await ensureSileroOnnx();
  copyOrtWasm();
  console.log(`Silero VAD browser assets ready: /${SILERO_VAD_PUBLIC_RELATIVE} and /ort/`);
};

await run();

export { copyOrtWasm, ensureSileroOnnx, isOrtRuntimeAsset, run };
