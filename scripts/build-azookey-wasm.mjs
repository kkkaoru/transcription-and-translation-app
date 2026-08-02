import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPortableDictionaryArchive } from "./build-azookey-dictionary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = resolve(root, "packages/azookey-wasm/Cargo.toml");
const source = resolve(
  root,
  "packages/azookey-wasm/target/wasm32-unknown-unknown/release/caption_bridge_azookey_wasm.wasm",
);
const destination = resolve(root, "apps/cloudflare-worker-server/wasm/azookey.wasm");

execFileSync(
  "cargo",
  ["build", "--manifest-path", manifest, "--target", "wasm32-unknown-unknown", "--release"],
  { cwd: root, stdio: "inherit" },
);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`Built ${destination}`);
const dictionary = buildPortableDictionaryArchive();
console.log(
  `Built ${dictionary.destination} (${dictionary.compressedBytes} bytes, sha256=${dictionary.sha256})`,
);
