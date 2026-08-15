import { spawnSync } from "node:child_process";

const desktopManifest = "apps/desktop/src-tauri/Cargo.toml";
const tauriLintConfig = JSON.stringify({
  bundle: {
    externalBin: null,
    resources: null,
  },
});
const includeCandle = process.env.CAPTION_BRIDGE_DESKTOP_CANDLE_LINT === "1";

// The desktop candle feature pulls in Candle and, through it, a C
// library. Linting with --all-features would add minutes to every gate
// run and would build a configuration no CI target builds today.
// Opt into that separate, non-gate check explicitly when needed.
const featureArgs = includeCandle ? ["--features", "candle"] : [];

const result = spawnSync(
  "cargo",
  [
    "clippy",
    "--manifest-path",
    desktopManifest,
    "--all-targets",
    ...featureArgs,
    "--",
    "-D",
    "warnings",
  ],
  {
    env: {
      ...process.env,
      // Tauri's build script validates bundled files even for `cargo clippy`.
      // Linting must not require platform-specific sidecars that are produced
      // by the release build pipeline; the real bundle path keeps the checked
      // in configuration and performs the full validation.
      TAURI_CONFIG: tauriLintConfig,
    },
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`Unable to start cargo clippy: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
