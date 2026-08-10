#!/usr/bin/env node
/**
 * Next may still emit onnxruntime-web jsep/jspi/asyncify wasm under
 * `_next/static/media/` (over Cloudflare Workers' 25 MiB asset cap).
 * Runtime loads `/ort/ort-wasm-simd-threaded.wasm` via wasmPaths.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const compareOut = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/azookey-compare/out");

const isOversizedOrtVariant = (name, bytes) =>
  /ort-wasm-simd-threaded\.(jsep|jspi|asyncify)\./u.test(name) ||
  (/ort-wasm.*\.wasm$/u.test(name) && bytes >= MAX_ASSET_BYTES);

const walk = (dir) => {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    const bytes = statSync(path).size;
    if (isOversizedOrtVariant(entry.name, bytes)) {
      rmSync(path, { force: true });
      console.log(`Removed oversized ORT asset (${bytes} bytes) → ${path}`);
    }
  }
};

walk(compareOut);
