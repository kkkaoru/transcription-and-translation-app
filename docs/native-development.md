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
bun run tauri:build
```

Open the application, configure a numeric shared-output resolution, open the
overlay, and select the `Kotoba Beacon` Syphon server in the Syphon-capable
OBS source. Verify that the main settings window is not visible in OBS.

## Windows

Install Visual Studio Build Tools with **Desktop development with C++**, the
MSVC Rust target, Bun, CMake, and Ninja. Build from an x64 Native Tools
or PowerShell environment:

```powershell
bun install --frozen-lockfile
bun run tauri:build
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
bun run tauri:dev
```

After the system libraries above are installed, run `bun run rust:lint` as the
full Tauri/Rust Clippy check. It is intentionally separate from `check:all` so
the dependency-free conversion test suite can still run in minimal CI images.

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
