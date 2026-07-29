# Caption Bridge Parapper fork

This directory vendors [Parakeet-Inc/Parapper-ASR](https://github.com/Parakeet-Inc/Parapper-ASR)
at `a01922f0383214e01a3875ec673fa1c316cdeb36` (`v0.4.0-beta`, 2026-07-11).

It remains a self-contained Node and Rust workspace. Its `package.json`,
`pnpm-lock.yaml`, `Cargo.toml`, and `Cargo.lock` deliberately do not join the
root Caption Bridge workspace. Install and run it through the root
`parapper:*` commands or directly from this directory.

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

Set `"streaming_recognition_text_format": "surface"` to keep upstream-style
surface text only. The desktop-output path remains surface text; the format is
specific to the streaming WebSocket contract used by Caption Bridge.
