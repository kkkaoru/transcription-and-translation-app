#!/usr/bin/env node
/**
 * Copy the Worker-hosted portable AzooKey wasm + dictionary into compare
 * `public/azookey/` for Next static export. These copies are gitignored and
 * must not be committed; the Worker paths remain the source of truth.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerWasm = resolve(root, "apps/cloudflare-worker-server/wasm/azookey.wasm");
const workerDict = resolve(root, "apps/cloudflare-worker-server/public/azookey/system.azkdict.gz");
const workerLicense = resolve(root, "apps/cloudflare-worker-server/public/azookey/LICENSE");
const compareDir = resolve(root, "apps/azookey-compare/public/azookey");

if (!existsSync(workerWasm) || !existsSync(workerDict)) {
  throw new Error(
    "AzooKey Worker assets are missing; build wasm/dictionary before copying into compare public/azookey",
  );
}

mkdirSync(compareDir, { recursive: true });
copyFileSync(workerWasm, resolve(compareDir, "azookey.wasm"));
copyFileSync(workerDict, resolve(compareDir, "system.azkdict.gz"));
if (existsSync(workerLicense)) {
  copyFileSync(workerLicense, resolve(compareDir, "LICENSE"));
}
console.log(`Copied AzooKey browser assets to ${compareDir}`);
