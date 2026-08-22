# Kotoba Beacon Native

Cross-platform GPUI live-caption companion for OBS, TikTok LIVE Studio, and other streaming software.

## Runtime architecture

Kotoba Beacon Native performs capture and recognition in one OS process:

```text
Kotoba Beacon Native
├─ GPUI control window
├─ GPUI capture-output window
├─ CPAL microphone callback
├─ in-process Parapper engine
│  ├─ direct Silero VAD
│  ├─ segmentation
│  ├─ sherpa-onnx ASR
│  ├─ Namo turn detection
│  └─ full-turn rerecognition
├─ RGBA renderer / optional native outputs
└─ loopback Browser Source server
```

There is no Tauri runtime, Parapper executable, child-process supervisor, recognition WebSocket, or JSON IPC in the Native runtime. Threads communicate through bounded in-memory queues.

## Identity

| Field | Value |
|---|---|
| Product | `Kotoba Beacon Native` |
| Bundle ID | `com.kotobabeacon.native` |
| Binary | `kotoba-beacon-native` |
| Control window | `Kotoba Beacon Native` |
| Capture window | `Kotoba Beacon Caption Output` |

## Requirements

- Rust 1.97.1
- Installed Parapper model directory under the Native data directory
- A supported CPAL audio input

On macOS, the default model root is:

```text
~/Library/Application Support/com.kotobabeacon.native/parapper/models
```

Required Japanese model directories are currently:

```text
silero_vad_v6/
sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01/
namo-turn-detector-v1-japanese/
unidic-cwj-3_1_1/
```

`ul-unas/` is supported by the engine but noise cancellation is disabled by default until it wins the fixture quality benchmark.

## Run

```bash
cargo run --manifest-path apps/native/Cargo.toml
```

The application opens:

1. the control/settings window;
2. the always-available `Kotoba Beacon Caption Output` capture window;
3. the loopback Browser Source listener.

The capture window uses a green background for Window Capture plus chroma key. Browser Source is the preferred true-transparent path.

## OBS and TikTok LIVE Studio

Horizontal/default overlay:

```text
http://127.0.0.1:1521/
```

Vertical overlay for TikTok, YouTube, or any vertical stream:

```text
http://127.0.0.1:1521/?layout=vertical
```

Use:

- OBS: **Sources → Browser**
- TikTok LIVE Studio: **Add source → Link**

TikTok does not officially guarantee `127.0.0.1` support in every LIVE Studio version. If Link rejects it, use **Window capture → Kotoba Beacon Caption Output** and remove the green background with chroma key.

The server binds only `127.0.0.1`. With no request it blocks in the kernel and does not rasterize or serialize Browser Source frames. The page updates only the caption DOM and uses no external CDN.

Health check:

```bash
curl http://127.0.0.1:1521/health
# ok
```

## Optional native outputs

The existing debug/output flags remain available:

```bash
cargo run --manifest-path apps/native/Cargo.toml -- --overlay
cargo run --manifest-path apps/native/Cargo.toml -- --syphon  # macOS
cargo run --manifest-path apps/native/Cargo.toml -- --spout   # Windows
```

Syphon, Spout, and OS-specific transparent overlays are optional accelerators. Browser Source and the GPUI capture window are the portable baseline.

## Automated verification

```bash
cargo test --manifest-path crates/parapper-engine/Cargo.toml --lib
cargo test --manifest-path crates/caption-bridge-browser-source/Cargo.toml
cargo test --manifest-path apps/native/Cargo.toml --lib
cargo clippy --manifest-path crates/parapper-engine/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path apps/native/Cargo.toml --all-targets -- -D warnings
bun scripts/verify-native-asr.mjs
```

The ASR verifier loads the real Silero, sherpa-onnx, Namo, and dictionary resources in one process and replays the checked-in PCM16/16kHz fixture. Expected output resembles:

```json
{"result":"PASS","caption":"こんにちは聞こえますか。","processArchitecture":"in-process","childProcessRequired":false}
```

A physical microphone permission check remains an OS/hardware boundary.

## macOS installation

```bash
bun scripts/install-macos-native-app.mjs
```

Installed layout:

```text
~/Applications/Kotoba Beacon Native.app/
└─ Contents/
   ├─ MacOS/kotoba-beacon-native
   └─ Frameworks/
      ├─ Syphon.framework
      ├─ libsherpa-onnx-c-api.dylib
      ├─ libonnxruntime.dylib
      └─ libonnxruntime.1.24.4.dylib
```

No sidecar executable is packaged. The dylibs are loaded into the Native executable process.

## Audio backends

`caption-bridge-audio` uses CPAL:

| OS | Backend | Permission |
|---|---|---|
| macOS | Core Audio | TCC microphone permission |
| Windows | WASAPI | Windows microphone privacy settings |
| Linux | ALSA/Pulse/PipeWire through CPAL | User audio session |
