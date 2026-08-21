# Kotoba Beacon Native

A minimal GPUI skeleton for the native Kotoba Beacon application.

## Identity

| Field | Value |
|-------|-------|
| Product name | `Kotoba Beacon Native` |
| Bundle id | `com.kotobabeacon.native` |
| Binary name | `kotoba-beacon-native` |
| Window title | `Kotoba Beacon Native` |

Product name and bundle id come from `caption-bridge-identity::AppIdentity::native()`.

This is intentionally split from the Tauri app:

- `apps/desktop/` (`bun run tauri:dev`) is **Kotoba Beacon** with identifier `com.kotobabeacon.desktop`.
- `apps/native/` is **Kotoba Beacon Native** with identifier `com.kotobabeacon.native`.

## Requirements

Rust 1.97.1 (pinned in `rust-toolchain.toml`).

This crate is **not** part of a Cargo workspace; it is a standalone package under `apps/native/`.

## Running

Default build attempts GPUI with the pinned Zed git revision:

```bash
cargo build --manifest-path apps/native/Cargo.toml
```

Run the binary:

```bash
cargo run --manifest-path apps/native/Cargo.toml
```

If the GPUI fetch or compile is too heavy or fails, the `gpui` feature is default-on but can be disabled to get a CLI stub that prints identity and the fixture caption:

```bash
cargo run --manifest-path apps/native/Cargo.toml --no-default-features
```

Expected stub output includes `fixture caption: こんにちは。` and `raster: 1280x720`.

The window and the stub both ingest one bundled Parapper `turn.final` through `caption-bridge-session` (no microphone, no sidecar).

## Debug overlay, Syphon, and Spout

Flags work with or without the GPUI feature. They are OS-specific:

| Flag | macOS | Windows | Linux |
|------|-------|---------|-------|
| `--overlay` | Live AppKit window: **Kotoba Beacon Native Transparent Capture**, click-through, not always-on-top | Layered Win32 chrome (`WS_EX_LAYERED` + `WS_EX_TRANSPARENT`, never `HWND_TOPMOST`). Live `CreateWindowExW` is completed on a Windows host; this Mac tests the contract. | Error: use Native browser-source `http://127.0.0.1:1521` |
| `--syphon` | Live Syphon server **Kotoba Beacon Native** | Helpful error: Syphon is macOS-only; use `--spout` | Error: use browser-source `http://127.0.0.1:1521` |
| `--spout` | Helpful error: Spout2 does not run on macOS; use `--syphon` | Spout2 share **Kotoba Beacon Native** via `spout2-rs` (same crate as desktop). Validation + BGRA swap compile on this Mac. | Error: use browser-source `http://127.0.0.1:1521` |

```bash
# macOS (this development host)
cargo run --manifest-path apps/native/Cargo.toml -- --overlay
cargo run --manifest-path apps/native/Cargo.toml -- --syphon
cargo run --manifest-path apps/native/Cargo.toml -- --overlay --syphon

# Windows
cargo run --manifest-path apps/native/Cargo.toml -- --overlay
cargo run --manifest-path apps/native/Cargo.toml -- --spout
# --syphon prints: Syphon is macOS-only; use --spout …

# Linux
# --overlay / --syphon / --spout all fail with a pointer at:
# http://127.0.0.1:1521  (PortMap::native().browser_source)
```

- macOS `--overlay` opens **Kotoba Beacon Native Transparent Capture** (1280×720, click-through, not always-on-top, `NSWindowSharingReadOnly`). You should see a teal plate and magenta corner marks; clicks pass through. In OBS on this Mac (macOS 13+): **Sources → + → macOS Screen Capture → Window**, then pick `[Kotoba Beacon Native] Kotoba Beacon Native Transparent Capture`. Leave **Show windows with empty names** off (the title is non-empty) and **Show hidden windows** off (the window is on-screen). Do not expect per-pixel alpha from this source: current OBS Screen Capture uses FourCC `l10r` (no alpha). For a guaranteed alpha plate use `--syphon` and **Syphon Client → Kotoba Beacon Native**. The Window Capture title must not collide with Tauri's `Kotoba Beacon Transparent Capture`.
- On macOS 12.6 and earlier the same window appears under legacy **Window Capture** (CGWindowList, on-screen only, empty titles hidden). That path emits BGRA but still does not document preserving a clear `NSWindow` alpha.
- macOS `--syphon` publishes **Kotoba Beacon Native** to the Syphon directory. In OBS, add a Syphon Client and pick that server. It must not collide with Tauri's `Kotoba Beacon`.
- Windows `--spout` publishes **Kotoba Beacon Native** as a Spout2 sender. In OBS, add a Spout source and pick that name. Desktop Tauri still uses `Kotoba Beacon`.
- Linux has neither Syphon nor Spout. The current capture fallback is the Native browser-source on port **1521**. PipeWire is not in v1.

Without those flags the app only shows the main window / CLI fixture.

## Per-OS verify

### macOS (this Mac)

```bash
cargo test --manifest-path crates/caption-bridge-overlay/Cargo.toml
cargo test --manifest-path crates/caption-bridge-syphon/Cargo.toml
cargo test --manifest-path crates/caption-bridge-spout/Cargo.toml
cargo test --manifest-path crates/caption-bridge-sidecar/Cargo.toml
cargo test --manifest-path apps/native/Cargo.toml --no-default-features
cargo check --manifest-path apps/native/Cargo.toml --no-default-features
```

Live surfaces (needs a display):

```bash
cargo run --manifest-path apps/native/Cargo.toml --no-default-features -- --overlay
cargo run --manifest-path apps/native/Cargo.toml --no-default-features -- --syphon
```

OBS picker on this Mac (macOS 13+): keep the overlay running, then **Sources → + → macOS Screen Capture → Window** and choose **Kotoba Beacon Native Transparent Capture** (OBS labels it `[app] title`). Confirm a 1280×720 teal plate with magenta corners. Do not enable invented flags. If the plate is there but the field around it is opaque black, that matches Screen Capture `l10r` (no alpha) — use `--syphon` for a true-alpha composite.

### Windows

Install the MSVC toolchain (`x86_64-pc-windows-msvc`). Then:

```bash
cargo test --manifest-path crates/caption-bridge-spout/Cargo.toml
cargo run --manifest-path apps/native/Cargo.toml --no-default-features -- --spout
```

`--overlay` should open a layered click-through window once the live Win32 path is completed on a Windows builder. Until then the chrome contract (`WS_EX_LAYERED | WS_EX_TRANSPARENT`, `HWND_NOTOPMOST`) is locked by unit tests.

### Linux

No `x86_64-unknown-linux-gnu` target is installed on this Mac and we do not install large cross toolchains here. Linux is covered by `#[cfg(target_os = "linux")]` stubs and unit-tested error strings. On a Linux host:

```bash
cargo test --manifest-path crates/caption-bridge-overlay/Cargo.toml
cargo run --manifest-path apps/native/Cargo.toml --no-default-features -- --overlay
# expect: overlay windows are not available on Linux; use … http://127.0.0.1:1521
```

Point OBS Browser Source at `http://127.0.0.1:1521`.

## Audio backends

`caption-bridge-audio` uses cpal on every OS:

| OS | Host | Permission |
|----|------|------------|
| macOS | Core Audio | TCC microphone prompt under `com.kotobabeacon.native` |
| Windows | WASAPI | Standard microphone privacy settings |
| Linux | ALSA / Pulse / PipeWire via cpal | Pulse/PipeWire user session |

## Sidecar port-kill

Unix supervisors still use `lsof -ti :PORT | kill -9`. Windows never calls `lsof`; `KillPlan::windows_kill_plan` constructs `netstat -ano -p TCP :PORT` then `taskkill /F /PID` and is tested as argv only.

## Testing

```bash
cargo test --manifest-path apps/native/Cargo.toml
```

With `--no-default-features` the tests cover identity, style persistence, dictionary, and sidecar-missing errors. With default features they also cover the GPUI window options builder.

## Window

The main window is 1180×820 px, titled `Kotoba Beacon Native`, with working tabs:

- **Live**: list/refresh mics, start/stop capture, caption preview, idle/capturing/error pill. Missing `kotoba-parapper` names the binary and port `18182` instead of no-op.
- **Style**: source/translation size, color, opacity, max chars, X/Y %. Preview updates with the same numbers. Saved to Native `config_dir/caption-style.json`.
- **Dictionary**: search/add/delete via `caption-bridge-dictionary`. Saved under Native `config_dir/dictionary`. Empty first load seeds the VRC sample.
- **Settings**: recognition mode `parapper-azookey`, open/hide overlay (`Kotoba Beacon Native Transparent Capture`), toggle Syphon (`Kotoba Beacon Native`), browser-source `http://127.0.0.1:1521`, identity strings.

Style and dictionary never write Tauri `com.kotobabeacon.desktop`. After changing the GUI, reinstall with `node scripts/install-macos-native-app.mjs` so `~/Applications/Kotoba Beacon Native.app` matches this tree.

## Build notes

- `gpui_platform` is enabled with `font-kit` and `runtime_shaders` so it builds on macOS without the Xcode `metal` command-line compiler.
- This crate pins Rust `1.97.1` in `rust-toolchain.toml` and is not added to any workspace.

## Install

On macOS, install a local `.app` into `~/Applications` (never `/Applications/Kotoba Beacon.app`, which is the Tauri app):

```bash
cargo build --manifest-path apps/native/Cargo.toml --release
node scripts/install-macos-native-app.mjs
```

The helper writes `$HOME/Applications/Kotoba Beacon Native.app` with this locked layout:

```
Contents/MacOS/kotoba-beacon-native
Contents/Frameworks/Syphon.framework
Contents/Resources/sidecars/kotoba-parapper
Contents/Resources/sidecars/kotoba-inference-gateway
Contents/Resources/sidecars/kotoba-zenz-server
Contents/Resources/sidecars/kotoba-llama-server
Contents/Resources/macos-runtime/
Contents/Resources/zenz-runtime/
Contents/Resources/llama-runtime/
Contents/Resources/parapper-runtime/   (copied when present)
Contents/Resources/vibrato/system.dic.zst
Contents/Resources/vibrato/COPYING
Contents/Resources/vibrato/NOTICE
Contents/Resources/input-lm-tokenizer/
```

Sidecars come from `apps/desktop/src-tauri/binaries/` (`bun run sidecar:build`). The installer fails if any required sidecar or runtime is missing; it never writes a hollow app. Relative `sidecars/<runtime>` links keep the existing `@executable_path/<runtime>` dylib rpaths working.

Override the destination with `KOTOBA_BEACON_NATIVE_INSTALL_APP`. Do not point that variable at `/Applications/Kotoba Beacon.app`.

## Future scripts

A future `native:dev` script can be added to `package.json` once the GPUI build is stable, but no root `package.json` scripts were changed for this skeleton.
