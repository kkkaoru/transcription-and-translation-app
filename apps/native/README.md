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

There is no recognition sidecar, child-process supervisor, recognition WebSocket, or JSON IPC. Threads communicate through bounded in-memory queues.

The hot capture loop reuses one PCM16-to-f32 normalization buffer across every
32 ms microphone frame instead of allocating roughly 31 vectors per second.
The 32 ms active UI poll also borrows the current caption and clones caption
strings/style only when output actually changes; unchanged polls do not create
Browser Source, native-output, or output-window handoff copies. These changes
mirror the browser pipeline's single-parse and changed-value-only resource
policy without importing its HTTP, Durable Object, or GGUF-specific layers.
Unchanged caption-output window checks are limited to four per second while
caption changes still publish immediately.

## Runtime metrics

Run the deterministic production-helper A/B fixture:

```bash
bun run native:metrics
```

It builds `native_runtime_metrics` in release mode, runs baseline and optimized
workloads five million times, and reports wall time, PCM buffer allocations,
caption clones, and output-window checks as privacy-safe JSON. macOS/Linux also
report process CPU time and maximum RSS through `/usr/bin/time`; those two
fields are `null` for the Windows fixture. The fixture calls the same normalization, caption-change, and output-check helpers
used by the app. A representative macOS ARM64 five-run median reduced the
expanded CPU-bound workload from 596 ms to 227 ms (62%), process CPU time from
0.59 s to 0.23 s (61%), PCM allocations from 5,000,000 to one, ASR VAD-frame
allocations from 5,000,000 to one, caption clone operations from 25,322,582 to
1,129,037, and output-window checks from 5,000,000 to 645,162. Peak RSS was
essentially flat at about 11 MiB because the allocator reused
released blocks; the improvement is reduced allocation churn rather than a
large retained-memory change.

Sample an actual running Native process while idle or capturing:

```bash
bun scripts/benchmark-native-runtime.mjs sample --pid PID --seconds 10
```

The sampler supports macOS/Linux `ps` and Windows PowerShell, and reports
average/p50/p95/max CPU and resident memory without recording captions or
audio. A representative idle macOS run after the second optimization pass used
about 78.6 MiB maximum RSS and reported 0% CPU across 48 samples. Active-capture
numbers remain dependent on the selected microphone, models, and OS audio
permissions.

### Evaluated resource changes

- The ASR VAD-frame queue now drains completed 512-sample frames while retaining
  its allocation. A real-model fixture still recognizes the expected Japanese
  caption, so this change is enabled.
- Microphone discovery now refreshes before capture, when opening the selector,
  and every 30 seconds as a fallback. This removes repeated device-list clones
  and most idle OS enumeration without weakening capture or hot-plug recovery.
- Syphon and Spout already share one 1280x720 raster and retain their GPU sender
  resources. The GPUI output can require a different HiDPI raster, so forcing it
  to share would reduce output quality and was not adopted.
- Unchanged captions already skip rasterization, texture upload, and GPUI atlas
  growth. GPUI does not expose a safe in-place `RenderImage` texture update in
  the pinned revision, so a private GPU implementation was not adopted.
- Event-driven GPUI replacement was not adopted: the measured idle loop rounded
  to 0% CPU, while cross-thread wakeup changes would add shutdown and missed-wake
  risk. Recognition events remain polled at 32 ms for predictable latency.
- The 462 MiB-on-disk translation model reached about 781 MiB process RSS and
  took 2.7 seconds to load in a cold standalone measurement. It is still loaded
  lazily, released immediately when capture stops, and released after ten idle
  minutes. Shortening that timeout would save RAM but add visible latency to the
  next translation, so the quality-preserving policy remains unchanged.
- Direct macOS GPU power sampling requires privileged `powermetrics`. GPU work
  is therefore guarded by behavioral tests that prove unchanged captions do not
  rasterize or upload; use a privileged Metal trace for hardware-specific power
  figures.

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

Japanese-to-English translation additionally uses:

```text
lfm2-350m-enjp-mt-onnx-q4/
├─ tokenizer.json
└─ onnx/
   ├─ model_q4.onnx
   └─ model_q4.onnx_data
```

`ul-unas/` is supported by the engine but noise cancellation is disabled by default until it wins the fixture quality benchmark.

## Run

```bash
cargo run --manifest-path apps/native/Cargo.toml
```

The application opens:

1. the control/settings window;
2. `Kotoba Beacon Caption Output`, when enabled for startup;
3. the loopback Browser Source listener, when enabled.

The capture window uses a green background for Window Capture plus chroma key. Browser Source is the preferred true-transparent path.

## OBS and TikTok LIVE Studio

Horizontal output:

```text
http://127.0.0.1:1521/
```

Vertical output for TikTok, YouTube, or any vertical stream:

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
cargo run --manifest-path apps/native/Cargo.toml -- --syphon  # macOS
cargo run --manifest-path apps/native/Cargo.toml -- --spout   # Windows
```

Syphon and Spout publish the same shared RGBA caption raster used by the GPUI capture window. Browser Source receives the same persisted font, color, plate, shadow, and outline values. The Style tab keeps its HiDPI preview and editable recognition/translation sample text fixed above a scrollable, grouped editor. It uses continuous range controls, expandable saturation/brightness color squares with hue bars, an isolated scrollable font list sourced from the caption renderer, and configurable antialiased shadow quality. Native outlines use an antialiased continuous glyph stroke painted before the fill, matching `-webkit-text-stroke` with `paint-order: stroke fill`. The GPUI Caption Output raster follows the display scale factor so Retina/HiDPI windows receive device-resolution text.

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
