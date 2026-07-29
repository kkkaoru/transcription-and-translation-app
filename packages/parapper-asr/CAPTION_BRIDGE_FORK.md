# Caption Bridge Parapper fork

This directory vendors [Parakeet-Inc/Parapper-ASR](https://github.com/Parakeet-Inc/Parapper-ASR)
at `a01922f0383214e01a3875ec673fa1c316cdeb36` (`v0.4.0-beta`, 2026-07-11).

It remains a self-contained Node and Rust package. Its `package.json`,
`Cargo.toml`, and `Cargo.lock` retain their upstream package boundaries, while
the root Bun workspace resolves its JavaScript dependencies in `bun.lock`.
Install and run it through the root `parapper:*` commands or directly from this
directory with Bun.

## Caption Bridge changes

- Streaming recognition defaults to `"streaming_recognition_text_format": "hiragana"`.
  When UniDic can determine a surface-form reading, WebSocket `text` contains
  that hiragana string and `source_text` preserves the original ASR text.
  Unknown tokens are retained unchanged instead of being guessed.
- Hiragana output makes the UniDic/Vibrato dictionary a required model when
  Japanese streaming recognition is enabled. Parapper's model downloader
  obtains it together with the selected ASR model.
- The bounded WebSocket input source drains gracefully on `session.stop` so a
  completed turn is not lost when the sender is dropped.
- `parapper --headless --port 18082` starts just the streaming-recognition
  service for Kotoba Beacon. It requires an absolute `PARAPPER_RUNTIME_DIR`,
  stores its settings and models there instead of sharing an interactive
  Parapper installation, and uses the normal model downloader before accepting
  a WebSocket connection.
- The macOS headless binary searches both the Tauri debug-sidecar directory and
  the installed app's `Contents/Resources/macos-runtime` directory for the
  bundled Sherpa-ONNX dynamic libraries. Windows DLL copying is handled by the
  Kotoba Beacon sidecar build script.

Set `"streaming_recognition_text_format": "surface"` to keep upstream-style
surface text only. The desktop-output path remains surface text; the format is
specific to the streaming WebSocket contract used by Caption Bridge.
