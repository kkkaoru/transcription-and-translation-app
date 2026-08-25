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
- Final-caption duplicate detection now compares the incoming suffix directly
  instead of materializing and scanning `existing + incoming` twice. A
  five-million-iteration release microbenchmark reduced temporary allocations
  from 25,000,000 to zero and wall time from 651 ms to 29 ms while preserving
  the existing completion regression corpus.
- Native keeps its current thin LTO and single codegen unit. Removing both
  increased the deterministic optimized hot-path p50 from 248 ms to 257 ms and
  the baseline p50 from 651 ms to 770 ms, so the WASM compiler-profile result
  does not transfer to the native target.
- Microphone discovery refreshes before capture, when opening the selector, and
  every 30 seconds only while idle. Active CoreAudio/WASAPI/ALSA streams are never
  re-enumerated, preventing the roughly one-minute live-caption stall while still
  retaining hot-plug recovery before the next capture.
- Syphon and Spout already share one 1280x720 raster and retain their GPU sender
  resources. The GPUI output can require a different HiDPI raster, so forcing it
  to share would reduce output quality and was not adopted.
- Unchanged captions already skip rasterization, texture upload, and GPUI atlas
  growth. GPUI does not expose a safe in-place `RenderImage` texture update in
  the pinned revision, so a private GPU implementation was not adopted.
- Event-driven GPUI replacement was not adopted: the measured idle loop rounded
  to 0% CPU, while cross-thread wakeup changes would add shutdown and missed-wake
  risk. Recognition events remain polled at 32 ms for predictable latency.
- Native translation uses only the Japanese-to-English QuickMT model through an
  in-process, statically linked CTranslate2 runtime. CTranslate2 converts the
  model to INT8 at load time, uses one CPU replica, accepts one translation per
  batch, and retains the model only while translation is active. The separate
  English-to-Japanese model is never loaded. Dropping the worker on capture stop
  fully unloads the translator; one idle minute also drops it. This replaces the
  previous 462 MiB LFM2 ONNX model, which reached about 781 MiB process RSS and
  took 2.7 seconds to load in a cold standalone measurement. Measure QuickMT RSS
  on each target because CTranslate2 activation and backend memory varies by CPU.
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

Japanese-to-English translation additionally uses the files from
`quickmt/quickmt-ja-en`. The opposite-direction model is intentionally absent:

```text
quickmt-ja-en/
├─ config.json
├─ model.bin
├─ source_vocabulary.json
├─ target_vocabulary.json
├─ src.spm.model
└─ tgt.spm.model
```

The model is loaded on CPU with `compute_type=INT8`, one replica, one queued
batch, and the model's default beam size of two. Keeping beam search preserves
translation quality while the single-item batch and single worker bound RAM.

The previous LFM2-350M ONNX implementation remains as a non-default comparison
module at `crates/parapper-engine/reference/lfm2_onnx_translation_engine.rs`.
Native no longer selects it because its 462 MiB Q4 model reached about 781 MiB
process RSS while active, whereas the Native requirement prioritizes lower
retained RAM. It is compiled only by the `translation-comparison` feature, so
its validated prompt, cache, tensor-shape, and output-cleanup definitions remain
available without linking it into the shipped translation path.

With both model directories installed, compare translation quality, model-load
latency, p50/p95 inference latency, and peak process RSS in separate processes:

```bash
bun scripts/benchmark-native-translation.mjs --iterations=3
```

The benchmark uses five fixed, non-sensitive Japanese fixtures and emits only
aggregate chrF2 quality scores and process metrics; it never emits the fixture
text or model output. Pass `--models-root=/absolute/path` when models are stored
outside the Native data directory. macOS and Linux report peak RSS through
`/usr/bin/time`; Windows currently reports latency and quality while peak RSS
remains `null`.

A representative macOS ARM64 release comparison with three iterations per
fixture measured LFM2 Q4 at 852,393,984 bytes peak RSS and QuickMT INT8 at
715,358,208 bytes, a 16.1% reduction. QuickMT reduced p50 translation latency
from 236.7 ms to 60.3 ms and p95 from 280.1 ms to 83.4 ms while increasing the
fixed-corpus chrF2 score from 65.1 to 82.9. These figures validate the selected
backend on that corpus; repeat the command on each deployment CPU and with a
representative domain corpus before treating them as universal quality scores.

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

HTML output:

```text
http://127.0.0.1:1521/
```

The Output tab can copy this URL to the clipboard. Separate query-string layouts are not used;
select the appropriate Native style profile for horizontal or vertical production instead.

Use:

- OBS: **Sources → Browser**
- TikTok LIVE Studio: **Add source → Link**

TikTok does not officially guarantee `127.0.0.1` support in every LIVE Studio version. If Link rejects it, use **Window capture → Kotoba Beacon Caption Output** and remove the green background with chroma key.

The server binds only `127.0.0.1`. With no request it blocks in the kernel and does not rasterize or serialize Browser Source frames. The page updates only the caption DOM and uses no external CDN.

The Output tab can open the capture window while Native is already running. The HTML URL is a
clickable copy target and also has a dedicated copy button.

## Style profiles and custom dictionaries

Native persists multiple named style profiles in `caption-styles.json`. Horizontal and Vertical
profiles are created by default; the Style tab can add, select, edit, and delete profiles. The
selected profile is shared by the GPUI capture window, Browser Source, Syphon, and Spout.

Native also persists multiple selectable dictionary sets in `dictionary-catalog.json`. Each set
contains any number of reading/word entries and supports individual deletion, clearing the whole
selected dictionary, and deleting the selected dictionary set. Drop one or more UTF-8 `.csv` or
`.tsv` files on the Dictionary tab to append rows in `reading,word` or `reading<TAB>word` order.
CSV quoting and optional English or Japanese header rows are supported.

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

## Desktop platform builds

Native uses the same GPUI, CPAL, Silero VAD, sherpa-onnx, and Parapper pipeline on
macOS, Windows, and Linux. Platform-only outputs remain isolated: Syphon is macOS-only,
Spout is Windows-only, and Browser Source plus Caption Output are available everywhere.

```bash
# macOS, Windows, or Linux (run on the target operating system)
cargo build --locked --release --manifest-path apps/native/Cargo.toml
```

Windows requires the MSVC C++ Build Tools and Windows SDK. The release executable is
`apps/native/target/release/kotoba-beacon-native.exe`; microphone capture uses WASAPI.
The executable uses the Windows GUI subsystem, so launching it does not create a console window.

Linux requires ALSA, Vulkan, Wayland, and X11 development libraries. On Ubuntu/Debian:

```bash
sudo apt-get install build-essential clang cmake libasound2-dev libfontconfig-dev \
  libglib2.0-dev libssl-dev libvulkan1 libwayland-dev libx11-xcb-dev \
  libxkbcommon-x11-dev libzstd-dev
cargo build --locked --release --manifest-path apps/native/Cargo.toml
```

The Linux executable is `apps/native/target/release/kotoba-beacon-native`. GPUI selects
Wayland or X11 at runtime.

After building on any target OS, create a portable release without launching the app:

```bash
node scripts/package-native-release.mjs
```

Windows and Linux packages include the executable plus the ONNX Runtime and sherpa-onnx
libraries. macOS produces a signed local `.app` with the same in-process libraries. CI performs
Native format, Clippy, tests, release builds, packaging, and artifact upload on all three
operating systems so platform regressions cannot be hidden by a macOS-only gate.

## macOS installation

```bash
bun scripts/install-macos-native-app.mjs
```

Installed layout:

```text
~/Applications/Kotoba Beacon Native.app/
└─ Contents/
   ├─ MacOS/
   │  ├─ kotoba-beacon-native
   │  └─ libonnxruntime.dylib
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
