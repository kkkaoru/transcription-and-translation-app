#!/usr/bin/env node
/**
 * Static single-application guarantees for Kotoba Beacon.
 *
 * Verifies, without launching anything, that:
 *   1. The Tauri app declares exactly ONE launch window (a single app identity at startup).
 *   2. The on-demand overlay window is an auxiliary same-process window that skips the
 *      taskbar/Dock, so it can never register as a second application.
 *   3. The launch scripts expose a single application entry point (`bun run dev`), with
 *      `tauri:dev` kept as an alias and `dev:web` clearly demoted to a browser-only preview.
 *   4. `beforeDevCommand` resolves to the desktop Vite preview, so the unified `dev`
 *      command cannot recurse into a second `tauri dev`.
 *
 * Run: node scripts/check-single-app.mjs   (exits non-zero on any violation)
 *
 * NOTE: A static check cannot see a SIDECAR registering itself as a separate macOS app at
 * runtime. The Parapper sidecar (packages/parapper-asr) is itself a Tauri app; when run with
 * --headless it must lower its macOS activation policy (ActivationPolicy::Accessory) or it
 * shows a second Dock icon. Verify at runtime with:
 *   osascript -e 'tell application "System Events" to get name of every application process whose background only is false'
 * It must print exactly one Kotoba entry (kotoba-beacon), not kotoba-parapper.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

/** @type {string[]} */
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

// --- 1. Exactly one launch window in the Tauri config -------------------------
const tauriConf = readJson("apps/desktop/src-tauri/tauri.conf.json");
const windows = tauriConf?.app?.windows ?? [];
check(
  "tauri.conf.json declares exactly one launch window",
  windows.length === 1,
  `found ${windows.length}: ${windows.map((w) => w.label ?? w.title).join(", ")}`,
);
check(
  "the single launch window is the main app window",
  windows[0]?.label === "main",
  `label=${windows[0]?.label}`,
);

// --- 2. Overlay is an auxiliary, taskbar-skipping same-process window ---------
const commands = read("apps/desktop/src-tauri/src/commands.rs");
const builderCount = (commands.match(/WebviewWindowBuilder::new/g) ?? []).length;
check(
  "commands.rs builds exactly one runtime window (the overlay)",
  builderCount === 1,
  `found ${builderCount} WebviewWindowBuilder::new calls`,
);
check(
  'the overlay window is labelled "overlay"',
  /WebviewWindowBuilder::new\(\s*&?app,\s*"overlay"/.test(commands),
);
check("the overlay window skips the taskbar/Dock", /\.skip_taskbar\(true\)/.test(commands));

// --- 3. One unified launch entry point in the root scripts --------------------
const rootPkg = readJson("package.json");
const scripts = rootPkg.scripts ?? {};
check(
  "root `dev` is the full application launch (sidecars + tauri)",
  /sidecar:build/.test(scripts.dev ?? "") && /tauri:dev/.test(scripts.dev ?? ""),
  `dev=${scripts.dev}`,
);
check(
  "root `tauri:dev` is an alias of the unified `dev`",
  scripts["tauri:dev"] === "bun run dev",
  `tauri:dev=${scripts["tauri:dev"]}`,
);
check(
  "root `dev:web` is a browser-only preview (vite, no tauri)",
  /run dev/.test(scripts["dev:web"] ?? "") && !/tauri/.test(scripts["dev:web"] ?? ""),
  `dev:web=${scripts["dev:web"]}`,
);
check(
  "root `tauri:build` builds sidecars before the Tauri app",
  /sidecar:build/.test(scripts["tauri:build"] ?? "") &&
    (/desktop run tauri:build/.test(scripts["tauri:build"] ?? "") ||
      /run-tauri-build\.mjs/.test(scripts["tauri:build"] ?? "")),
  `tauri:build=${scripts["tauri:build"]}`,
);
check(
  "root `build:app` is the production Tauri build alias",
  scripts["build:app"] === "bun run tauri:build",
  `build:app=${scripts["build:app"]}`,
);
check(
  "signed updater builds require the explicit release script",
  scripts["build:app:release"] ===
    "bun run sidecar:build && node scripts/build-tauri-release.mjs" &&
    scripts["tauri:build:release"] === "bun run build:app:release",
  `build:app:release=${scripts["build:app:release"]}`,
);
check(
  "macOS release credentials have an explicit, non-secret preflight",
  scripts["check:macos-signing"] === "node scripts/check-macos-signing.mjs" &&
    /check-macos-signing\.mjs/.test(read("scripts/build-tauri-release.mjs")),
  "build-tauri-release.mjs must run check:macos-signing before invoking Tauri",
);
const updaterConfig = tauriConf?.plugins?.updater;
check(
  "Tauri updater has a signed HTTPS feed and public key",
  typeof updaterConfig?.pubkey === "string" &&
    updaterConfig.pubkey.length > 20 &&
    Array.isArray(updaterConfig.endpoints) &&
    updaterConfig.endpoints.length > 0 &&
    updaterConfig.endpoints.every(
      (endpoint) => /^https:\/\//.test(endpoint) && /\/latest\.json(?:$|[?#])/.test(endpoint),
    ),
  "plugins.updater must declare a public key and HTTPS latest.json endpoint",
);
const releaseConf = readJson("apps/desktop/src-tauri/tauri.release.conf.json");
const intelConf = readJson("apps/desktop/src-tauri/tauri.macos-intel.conf.json");
const intelReleaseConf = readJson("apps/desktop/src-tauri/tauri.release.macos-intel.conf.json");
const desktopPkg = readJson("apps/desktop/package.json");
const desktopTauriWrapper = read("scripts/run-desktop-tauri-build.mjs");
check(
  "release Tauri config enables updater artifacts",
  releaseConf?.bundle?.createUpdaterArtifacts === true,
);
check(
  "Apple Silicon base configs do not embed the x86_64-only Syphon framework",
  !tauriConf?.bundle?.macOS?.frameworks && !releaseConf?.bundle?.macOS?.frameworks,
  "tauri.conf.json and tauri.release.conf.json must stay framework-free for arm64 builds",
);
check(
  "Intel macOS overlays are the only configs that bundle Syphon",
  JSON.stringify(intelConf?.bundle?.macOS?.frameworks ?? []) ===
    JSON.stringify(["./frameworks/Syphon.framework"]) &&
    JSON.stringify(intelReleaseConf?.bundle?.macOS?.frameworks ?? []) ===
      JSON.stringify(["./frameworks/Syphon.framework"]),
  "Intel overlays must carry the legacy Syphon framework explicitly",
);
check(
  "desktop Tauri scripts select architecture-specific config overlays",
  /run-desktop-tauri-build\.mjs/.test(desktopPkg.scripts?.["tauri:dev"] ?? "") &&
    /run-desktop-tauri-build\.mjs/.test(desktopPkg.scripts?.["tauri:build"] ?? "") &&
    /run-desktop-tauri-build\.mjs/.test(desktopPkg.scripts?.["tauri:build:release"] ?? "") &&
    /isIntelMacBuild/.test(desktopTauriWrapper),
  "desktop Tauri dev/build/release scripts must use the architecture-aware wrapper",
);
const rootVersion = rootPkg.version;
const desktopVersion = desktopPkg.version;
const tauriCargo = read("apps/desktop/src-tauri/Cargo.toml");
const tauriVersion = tauriConf?.version;
const cargoVersion = tauriCargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
check(
  "root, desktop package, Tauri config, and Cargo versions stay aligned",
  typeof rootVersion === "string" &&
    rootVersion === desktopVersion &&
    rootVersion === tauriVersion &&
    rootVersion === cargoVersion,
  `root=${rootVersion} desktop=${desktopVersion} tauri=${tauriVersion} cargo=${cargoVersion}`,
);
check(
  "desktop version is a bumped semver release rather than the initial placeholder",
  typeof rootVersion === "string" && /^\d+\.\d+\.\d+$/.test(rootVersion) && rootVersion !== "0.1.0",
  `version=${rootVersion}`,
);
const entitlements = read("apps/desktop/src-tauri/Entitlements.plist");
check(
  "macOS bundle declares microphone/audio-input entitlement",
  /com\.apple\.security\.device\.audio-input/.test(entitlements) &&
    /<true\s*\/?\s*>/.test(entitlements),
  "Entitlements.plist must grant com.apple.security.device.audio-input",
);
check(
  "macOS bundle includes the usage-description Info.plist",
  /NSMicrophoneUsageDescription/.test(read("apps/desktop/src-tauri/Info.plist")) &&
    /NSAudioCaptureUsageDescription/.test(read("apps/desktop/src-tauri/Info.plist")) &&
    releaseConf?.bundle?.macOS?.infoPlist === "Info.plist",
  "Info.plist must be merged into release bundles",
);
check(
  "release config carries macOS entitlements",
  releaseConf?.bundle?.macOS?.entitlements === "Entitlements.plist",
  "tauri.release.conf.json must reference Entitlements.plist",
);
check(
  "macOS release bundles request hardened runtime",
  tauriConf?.bundle?.macOS?.hardenedRuntime === true &&
    releaseConf?.bundle?.macOS?.hardenedRuntime === true,
  "hardenedRuntime must stay enabled for Developer ID/notarized bundles",
);
const clippyConfig = read("apps/desktop/src-tauri/clippy.toml");
check(
  "Clippy complexity budget is checked in",
  /^cognitive-complexity-threshold\s*=\s*17\s*$/m.test(clippyConfig) &&
    /^excessive-nesting-threshold\s*=\s*3\s*$/m.test(clippyConfig) &&
    /^too-many-lines-threshold\s*=\s*80\s*$/m.test(clippyConfig),
  "clippy.toml must define cognitive=17, nesting=3, lines=80",
);

// --- 4. beforeDevCommand cannot recurse into the unified launcher -------------
check(
  "beforeDevCommand runs the desktop preview script",
  tauriConf?.build?.beforeDevCommand === "bun run dev:web",
  `beforeDevCommand=${tauriConf?.build?.beforeDevCommand}`,
);
check(
  "beforeBuildCommand runs the desktop production frontend build",
  tauriConf?.build?.beforeBuildCommand === "bun run build",
  `beforeBuildCommand=${tauriConf?.build?.beforeBuildCommand}`,
);
check(
  "desktop `dev` is Vite (so beforeDevCommand never re-enters tauri)",
  /^vite\b/.test(desktopPkg.scripts?.dev ?? ""),
  `desktop dev=${desktopPkg.scripts?.dev}`,
);
// `tauri dev` resolves `beforeDevCommand` with its cwd set to the directory
// holding src-tauri (apps/desktop), NOT the repo root — so the script name it
// invokes must exist in apps/desktop/package.json, not only the root one.
// This exact mismatch previously made a real `bun run tauri:dev` launch fail
// with `error: Script not found "dev:web"` even though every root-level and
// JSON-shape check passed.
check(
  "desktop package.json defines the script beforeDevCommand actually runs (its cwd, not root)",
  typeof desktopPkg.scripts?.[
    (tauriConf?.build?.beforeDevCommand ?? "").replace(/^bun run /, "")
  ] === "string",
  `beforeDevCommand=${tauriConf?.build?.beforeDevCommand} must resolve inside apps/desktop/package.json scripts`,
);
check(
  "desktop `dev:web` is Vite (matches root's browser-only preview)",
  /^vite\b/.test(desktopPkg.scripts?.["dev:web"] ?? ""),
  `desktop dev:web=${desktopPkg.scripts?.["dev:web"]}`,
);
check(
  "desktop `build` is the frontend production build",
  /tsc -b/.test(desktopPkg.scripts?.build ?? "") &&
    /vite build/.test(desktopPkg.scripts?.build ?? ""),
  `desktop build=${desktopPkg.scripts?.build}`,
);

// --- 5. Single native binary entry point --------------------------------------
const mainRs = read("apps/desktop/src-tauri/src/main.rs");
const fnMainCount = (mainRs.match(/fn main\b/g) ?? []).length;
check("desktop has a single fn main entry point", fnMainCount === 1, `found ${fnMainCount}`);

// --- 6. Sidecars must not register as separate macOS applications --------------
// The Parapper sidecar is itself a Tauri app. Hiding its window is NOT enough:
// without an Accessory activation policy it appears in the Dock as a second
// application and steals focus from Kotoba Beacon.
const parapperLib = read("packages/parapper-asr/src-tauri/src/lib.rs");
const headlessStart = parapperLib.indexOf("pub fn run_headless");
check("Parapper exposes a headless sidecar entry point", headlessStart >= 0);
const headlessBody = headlessStart >= 0 ? parapperLib.slice(headlessStart) : "";
check(
  "Parapper headless sidecar lowers its macOS activation policy to Accessory",
  /#\[cfg\(target_os = "macos"\)\][\s\S]*?set_activation_policy\(tauri::ActivationPolicy::Accessory\)/.test(
    headlessBody,
  ),
  "run_headless() must call set_activation_policy(ActivationPolicy::Accessory) on macOS",
);
check(
  "Parapper headless sidecar skips the Windows taskbar",
  /#\[cfg\(target_os = "windows"\)\][\s\S]*?set_skip_taskbar\(true\)/.test(headlessBody),
  "run_headless() must mark its hidden window as auxiliary on Windows",
);

// --- 7. macOS update hand-off -----------------------------------------------
const macosLifecycle = read("apps/desktop/src-tauri/src/macos.rs");
const appState = read("apps/desktop/src-tauri/src/state.rs");
check(
  "macOS lifecycle holds a kernel-backed single-instance flock",
  /flock\([\s\S]*?LOCK_EX\s*\|\s*libc::LOCK_NB/.test(macosLifecycle),
  "macos.rs must use a non-blocking exclusive flock rather than a stale marker file",
);
check(
  "macOS relaunch uses Tauri's restart/exit path",
  /request_restart\(\)/.test(macosLifecycle),
  "macos.rs must call AppHandle::request_restart",
);
check(
  "foreground app restores regular activation and Dock visibility",
  /ActivationPolicy::Regular/.test(macosLifecycle) &&
    /set_dock_visibility\(true\)/.test(macosLifecycle),
);
check(
  "relaunch command defers while capture is active",
  /relaunch_to_updated_app/.test(commands) &&
    /relaunch_after_capture/.test(commands) &&
    /update:relaunch-deferred/.test(commands),
);
check(
  "AppState carries the post-capture relaunch flag",
  /relaunch_after_capture:\s*Mutex<bool>/.test(appState),
);
check(
  "macOS artifact verifier is present and signal-safe",
  fs.existsSync(path.join(repoRoot, "scripts/verify-macos-autoswitch.sh")) &&
    !read("scripts/verify-macos-autoswitch.sh").match(/^\s*(kill|killall|pkill)\b/m),
);

console.log("");
if (failures.length) {
  console.error(`${failures.length} single-application check(s) failed.`);
  process.exit(1);
}
console.log("All single-application checks passed.");
