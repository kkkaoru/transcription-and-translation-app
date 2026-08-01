# Native development and verification

The repository fixes Rust at 1.97.1 through `rust-toolchain.toml`. Bun 1.3.x is
required for the TypeScript workspace.

## macOS

Install Xcode Command Line Tools, Bun, and Rust. `Syphon.framework` is bundled
from the official Syphon SDK, so no system-wide framework installation is needed.

The transparent overlay uses Tauri's macOS private API. It is suitable for the
local/OBS distribution described here, but the resulting application is not
eligible for Mac App Store submission.

```bash
xcode-select --install
bun install --frozen-lockfile
bun run build:app
```

Open the application, configure a numeric shared-output resolution, open the
overlay, and select the `Kotoba Beacon` Syphon server in the Syphon-capable
OBS source. Verify that the main settings window is not visible in OBS.

### Update hand-off and single-instance behavior

The release bundle keeps one stable bundle identifier (`com.kotobabeacon.desktop`).
When an updater replaces that `.app` in place, the running process is still the
old executable image until it restarts. The `relaunch_to_updated_app` Tauri
command uses `AppHandle::request_restart`, so `RunEvent::Exit` shuts down the
Gateway and model sidecars before the executable is started again from the same
bundle path. This avoids stale listeners and ensures the new version is loaded.

If the runtime status is `starting` or `capturing`, the command records a
post-capture restart instead of interrupting the microphone. `stop_capture`
consumes that request after returning the backend to `idle`; a deferred
`update:relaunch-deferred` event is emitted for UI diagnostics.

The foreground app holds a kernel-backed `flock` in its app-local data
directory. A second launch activates the existing bundle with LaunchServices
(`open -a`) and exits before starting sidecars. The foreground activation policy
is restored to `Regular` with Dock visibility enabled. Headless Parapper remains
`Accessory`, so the update transition keeps exactly one Dock icon.

After building, run the read-only artifact inspection:

```bash
bun run check:single-app
bun run check:macos-autoswitch -- --app \
  "apps/desktop/src-tauri/target/release/bundle/macos/Kotoba Beacon.app"
```

To exercise LaunchServices and a graceful quit on a disposable local build,
opt in explicitly with `--launch`:

```bash
bash scripts/verify-macos-autoswitch.sh --launch --timeout 30 --app \
  "apps/desktop/src-tauri/target/release/bundle/macos/Kotoba Beacon.app"
```

The verifier reads `Info.plist`, launches only the supplied `.app` via `open -n`,
uses `osascript`/System Events to assert one matching non-background process,
then asks that bundle to quit. It never invokes `kill`, `killall`, or `pkill` and
does not touch unrelated applications.

## Windows

Install Visual Studio Build Tools with **Desktop development with C++**, the
MSVC Rust target, Bun, CMake, and Ninja. Build from an x64 Native Tools
or PowerShell environment:

```powershell
bun install --frozen-lockfile
bun run build:app
```

Spout2 is compiled through `spout2-rs`' DirectX sender; no UI toggle or
runtime DLL path is exposed. In OBS, select the `Kotoba Beacon` sender in a
Spout2-capable source and verify transparency and caption-only output.

## Linux debug environment

Linux is for browser/Tauri debugging rather than native shared output. On
Ubuntu/Debian install the Tauri WebKit prerequisites before building:

```bash
sudo apt update
sudo apt install -y build-essential pkg-config libwebkit2gtk-4.1-dev \
  libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev \
  libxdo-dev curl wget file
```

Then run:

```bash
bun install --frozen-lockfile
bun run check:all
bun run dev
```

`bun run dev` is the single application entry point (frontend + Tauri + embedded
sidecars). `bun run tauri:dev` remains as an alias. For a browser-only UI check
without the native app, use `bun run dev:web`.

`bun run build:app` is the production counterpart: it builds the sidecars first
and then invokes the Tauri release build for the `.app` bundle. The app-only
bundle keeps local and CI verification independent of DMG tooling; use
`bun run build:app:dmg` when a DMG is explicitly required. `bun run tauri:build`
remains an alias for compatibility. `bun run build` only produces the desktop
frontend `dist/` output and does not package a native application.

For a signed updater release, inject `TAURI_SIGNING_PRIVATE_KEY` (and, when
used, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) from the CI secret store and run
`bun run build:app:release`. This selects
`apps/desktop/src-tauri/tauri.release.conf.json`, which enables updater archive
generation. The normal `build:app` path deliberately does not require a key.
Publish the generated archive and signature together with a signed Tauri
`latest.json` feed; never commit the private key or put it in `.env`.

After the system libraries above are installed, run `bun run rust:lint` as the
full Tauri/Rust Clippy check. It is also included in `check:all`, so the shared
quality command fails on native warnings as well as frontend/test failures.
The desktop crate keeps its Clippy budget in
`apps/desktop/src-tauri/clippy.toml`: `cognitive-complexity-threshold = 17`,
`excessive-nesting-threshold = 3`, and `too-many-lines-threshold = 80`.
The command runs with `-D warnings`, so a warning is a failed native check.

The standalone `azookey-rust` target lets CI and minimal Linux containers run
the dictionary/Viterbi tests without GTK/WebKit:

```bash
bun run rust:azookey:test
bun run rust:azookey:lint
```

For an optional upstream-data integration test, clone
`azooKey_dictionary_storage` and pass its `Dictionary` directory:

```bash
AZOOKEY_DICTIONARY_ROOT=/path/to/azooKey_dictionary_storage/Dictionary \
  cargo test --manifest-path packages/azookey-rust/Cargo.toml
```

The desktop capture command keeps `azookey-rust` as the default normalizer.
When no system dictionary path is configured, the first capture downloads the
pinned public LOUDS archive into the app data directory and injects its
`Dictionary` root into the normalizer path.  The archive is bounded and
validated before installation; a network or disk failure is non-fatal and the
small built-in lexicon remains available for offline capture.  An explicit
`models.paths["azookey-rust"]` or a valid `AZOOKEY_DICTIONARY_ROOT` always takes
precedence.
