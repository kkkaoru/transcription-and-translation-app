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

execFileSync(
  "cargo",
  ["build", "--manifest-path", manifest, "--target", "wasm32-unknown-unknown", "--release"],
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
    console.log(`Built wasm-bindgen package in ${destinationDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    copyFileSync(source, rawDestination);
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
