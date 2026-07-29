# Native development and verification

The repository fixes Rust at 1.88 through `rust-toolchain.toml`. Node.js 20+
and pnpm 10+ are also required.

## macOS

Install Xcode Command Line Tools, Node/pnpm, and Rust, then install
`Syphon.framework` to `/Library/Frameworks` or `~/Library/Frameworks` for a
native-output build.

```bash
xcode-select --install
pnpm install
pnpm tauri build -- --features native-output
```

Open the application, configure a numeric shared-output resolution, open the
overlay, and select the `Caption Bridge` Syphon server in the Syphon-capable
OBS source. Verify that the main settings window is not visible in OBS.

## Windows

Install Visual Studio Build Tools with **Desktop development with C++**, the
MSVC Rust target, Node/pnpm, CMake, and Ninja. Build from an x64 Native Tools
or PowerShell environment:

```powershell
pnpm install
pnpm tauri build -- --features native-output
```

Spout2 is compiled through `spout2-rs`' DirectX sender; no UI toggle or
runtime DLL path is exposed. In OBS, select the `Caption Bridge` sender in a
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
pnpm install
pnpm check:all
pnpm tauri:dev
```

After the system libraries above are installed, run `pnpm rust:lint` as the
full Tauri/Rust Clippy check. It is intentionally separate from `check:all` so
the dependency-free conversion test suite can still run in minimal CI images.

The standalone `azookey-rust` target lets CI and minimal Linux containers run
the dictionary/Viterbi tests without GTK/WebKit:

```bash
pnpm rust:azookey:test
pnpm rust:azookey:lint
```

For an optional upstream-data integration test, clone
`azooKey_dictionary_storage` and pass its `Dictionary` directory:

```bash
AZOOKEY_DICTIONARY_ROOT=/path/to/azooKey_dictionary_storage/Dictionary \
  cargo test --manifest-path azookey-rust/Cargo.toml
```
