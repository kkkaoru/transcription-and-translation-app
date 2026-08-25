# Architecture and output boundaries

## Native

```text
CPAL microphone
  → bounded PCM channel
  → parapper-engine
      Silero VAD
      segmentation / turn detection
      sherpa-onnx ASR
      correction
  → bounded translation channel
  → caption state
      ├─ GPUI Caption Output
      ├─ Browser Source :1521
      ├─ Syphon (macOS)
      └─ Spout (Windows)
```

Native recognition and translation execute inside one OS process. There is no sidecar,
internal WebSocket IPC, or Tauri runtime. Threads communicate through bounded channels;
stale translation and caption revisions are rejected before publication.

`caption-bridge-render` owns the shared RGBA raster used by GPUI, Syphon, and Spout.
`caption-bridge-browser-source` applies the persisted style contract to HTML/CSS.

## Browser and Cloudflare

```text
Browser microphone
  → Web Audio / 16 kHz mono PCM
  → browser utterance segmentation
  → Cloudflare Worker ASR route
  → transcript revision fence
  → browser caption state
```

The Worker owns provider calls, request validation, size/time bounds, and normalized
inference responses. Presentation and caption styling remain browser responsibilities.
Native-only libraries such as sherpa-onnx and OS font enumeration are not bundled into
the Worker.

## Shared Japanese normalization

`caption-bridge-japanese-text` is the allocation-free source of truth for Japanese
script ranges, kana scalar conversion, IPADIC/UniDic POS-head parsing, and ASR turn
surface normalization. Native `parapper-engine`, portable `azookey-rust`, and
`vibrato-core`/`vibrato-wasm` depend on that crate rather than carrying equivalent
local definitions. Target-specific orchestration remains separate: Native owns audio
turn state, while WASM owns ABI memory and lattice handles.

## Layer ownership

- `apps/native`: audio capture, in-process recognition/translation, GPUI windows
- `apps/desktop/src`: browser capture, settings, captions, and browser rendering
- `apps/cloudflare-worker-server`: Workers AI ASR and AzooKey HTTP/WS endpoints
- `apps/inference-gateway`: portable inference HTTP boundary
- `crates/parapper-engine`: reusable Native VAD/ASR/turn/translation engine
- `crates/caption-bridge-japanese-text`: shared no-allocation Japanese text primitives
- `crates/caption-bridge-render`: platform-neutral RGBA caption rendering
- `crates/caption-bridge-browser-source`: localhost OBS Browser Source
- `packages/azookey-rust`: AzooKey dictionary reader and Viterbi converter

## Output isolation

Settings and previews never enter shared caption frames. GPUI output uses a dedicated
caption window, while Syphon and Spout receive only the renderer RGBA buffer. Browser
Source serves only caption markup and its JSON/style state.
