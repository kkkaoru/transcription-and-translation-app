import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = resolve(root, "packages/vibrato-wasm/Cargo.toml");
const source = resolve(
  root,
  "packages/vibrato-wasm/target/wasm32-unknown-unknown/release/caption_bridge_vibrato_wasm.wasm",
);
const bindgenRequested = process.argv.includes("--bindgen");
const destinationDir = resolve(
  root,
  process.env.VIBRATO_WASM_OUT_DIR ??
    (bindgenRequested ? "packages/vibrato-wasm/pkg-web" : "packages/vibrato-wasm/pkg"),
);
const rawDestination = resolve(destinationDir, "vibrato_wasm_bg.wasm");
const rawFallbackDestination = resolve(root, "packages/vibrato-wasm/pkg/vibrato_wasm_bg.wasm");
let bindgenProduced = false;
const vibratoAssetDirectory = resolve(root, "assets/vibrato/ipadic-mecab-2_7_0");
const publicVibratoDirectories = [
  resolve(root, "apps/azookey-compare/public/vibrato"),
  resolve(root, "apps/cloudflare-worker-server/public/vibrato"),
];
const rawWasmDestinations = [
  resolve(root, "apps/azookey-compare/public/vibrato/vibrato_wasm_bg.wasm"),
  resolve(root, "apps/cloudflare-worker-server/wasm/vibrato_wasm_bg.wasm"),
];
const generatedGlueDestinations = {
  "vibrato_wasm.js": [resolve(root, "apps/azookey-compare/public/vibrato/vibrato_wasm.js")],
  "vibrato_wasm.d.ts": [resolve(root, "apps/azookey-compare/public/vibrato/vibrato_wasm.d.ts")],
};

const copyVibratoAssets = () => {
  for (const name of ["system.dic.zst", "COPYING", "NOTICE"]) {
    const source = resolve(vibratoAssetDirectory, name);
    if (!existsSync(source)) {
      throw new Error(`Vibrato source asset is missing: ${source}`);
    }
    for (const directory of publicVibratoDirectories) {
      mkdirSync(directory, { recursive: true });
      copyFileSync(source, resolve(directory, name));
    }
  }
};

const syncGeneratedVibratoOutputs = () => {
  if (!bindgenProduced) {
    return;
  }
  for (const destination of rawWasmDestinations) {
    mkdirSync(resolve(destination, ".."), { recursive: true });
    copyFileSync(rawDestination, destination);
  }
  for (const [name, destinations] of Object.entries(generatedGlueDestinations)) {
    const source = resolve(destinationDir, name);
    if (!existsSync(source)) {
      throw new Error(`wasm-bindgen did not produce ${source}`);
    }
    for (const destination of destinations) {
      copyFileSync(source, destination);
    }
  }
  const workerGlueDirectory = resolve(root, "apps/cloudflare-worker-server/src");
  for (const name of Object.keys(generatedGlueDestinations)) {
    copyFileSync(resolve(destinationDir, name), resolve(workerGlueDirectory, name));
  }
};

execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--manifest-path",
    manifest,
    "--target",
    "wasm32-unknown-unknown",
    "--release",
  ],
  { cwd: root, stdio: "inherit" },
);

if (!existsSync(source)) {
  throw new Error(`Vibrato WASM build did not produce ${source}`);
}

mkdirSync(destinationDir, { recursive: true });

if (bindgenRequested) {
  try {
    execFileSync(
      process.env.WASM_BINDGEN_BIN ?? "wasm-bindgen",
      [source, "--target", "web", "--out-dir", destinationDir, "--out-name", "vibrato_wasm"],
      { cwd: root, stdio: "inherit" },
    );
    bindgenProduced = true;
    console.log(`Built wasm-bindgen package in ${destinationDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    mkdirSync(dirname(rawFallbackDestination), { recursive: true });
    copyFileSync(source, rawFallbackDestination);
    console.warn(
      "wasm-bindgen CLI is not installed; copied only the raw module. " +
        "Install wasm-bindgen-cli and rerun with --bindgen for JavaScript glue.",
    );
  }
} else {
  copyFileSync(source, rawDestination);
  console.log(`Built raw Vibrato WASM: ${rawDestination}`);
  console.log("Pass --bindgen after installing wasm-bindgen-cli to emit JS glue.");
}

copyVibratoAssets();
syncGeneratedVibratoOutputs();
console.log("Copied Vibrato IPADIC dictionary, COPYING, and NOTICE to public assets.");
