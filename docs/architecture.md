# Architecture and OBS output boundary

```text
Main window (settings + preview)        Overlay window (caption only)
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ microphone / models / layout │       │ Japanese transcription       │
│ inference endpoint selection │       │ English translation          │
│ never publishes native frame │       │ transparent RGBA canvas      │
└──────────────┬───────────────┘       └───────────────┬──────────────┘
               │                                       │
               └── Rust application state ─────────────┤
                                                       ├─ OBS Window Capture
                                                       ├─ Spout2 (Windows)
                                                       └─ Syphon (macOS)
```

The Tauri overlay is opened at `?overlay=1`; that route does not mount the
main workspace or settings components. `NativeFramePublisher` also exists only
on that route. Before Rust accepts a native frame it verifies both of the
following:

1. the invoking webview label is exactly `overlay`;
2. the frame width and height exactly match the configured shared-output
   resolution.

Consequently Spout2/Syphon can only receive the caption canvas. Settings,
buttons, previews, and window chrome cannot enter their shared frames. The
overlay has a transparent background, no decorations, and is non-resizable;
saving the numeric width/height re-creates the native sender and updates the
overlay dimensions atomically.

## Layer ownership

- `src/live`, `src/settings`, `src/components`: operator UI only
- `src/overlay`: transparent rendering and RGBA frame generation only
- `src/core`: browser audio capture, configuration, and Tauri bridge
- `src-tauri`: persistence, validation, pipeline, native window, and native
  sender enforcement
- `gateway`: HTTP/WS model boundary, usable locally or remotely
- `src-tauri/src/kana_kanji` / `azookey-rust`: dependency-free AzooKey binary
  dictionary reader and Viterbi converter, separately testable without GTK

## AzooKey input scope

The converter reads the public dictionary's `charID.chid`, LOUDS trie,
`loudstxt3` shards, MID matrix (`mm.binary`), and CID connection costs
(`cb/*.binary`). It also accepts upstream `user`/`memory` LOUDS directories or
portable TSV dictionaries. That covers the conversion path relevant to an ASR
caption string, including user dictionary and learning-memory candidates.

Keyboard-specific upstream features such as Custard key layouts, live
`ComposingText` editing, keyboard prediction UI, and iOS persistence are not
part of an ASR caption input and are intentionally not brought into the Tauri
process. Neural Zenzai-style conversion is offered through the selectable zenz
GGUF gateway models instead of duplicating a model runtime in Rust.
