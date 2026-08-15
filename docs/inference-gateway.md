# Inference gateway

`apps/inference-gateway/` is the executable boundary between the Tauri application and model
runtimes. It gives the app one HTTP endpoint while keeping the bundled
Parapper and GGUF servers on loopback. The same executable can also be used
against explicitly configured remote services during development.

```text
Caption Bridge (Tauri)
  └─ http://gateway:8765
       ├─ ws://parapper:18082/ws/recognition
       ├─ llama-server: zenz xsmall
       ├─ llama-server: zenz small
       └─ llama-server: one Hy-MT2 server per selectable model
```

The gateway serializes Parapper sessions because its streaming protocol permits
one active recognition session. It validates 16 kHz mono PCM WAV input, sends
raw PCM16LE chunks of at most 100 ms to Parapper, and exposes the final result
as OpenAI-shaped `POST /v1/audio/transcriptions`.

For text models it exposes `POST /v1/chat/completions`. Model IDs are mapped to
trusted server URLs in `gateway.config.json`; the app-supplied `model_path` is
deliberately discarded so a remote client cannot make the gateway load an
arbitrary local file. Hy-MT2 receives its documented `top_k=20` and
`repetition_penalty=1.05` defaults unless the caller explicitly supplies them.

## Start the gateway

```bash
cp apps/inference-gateway/config.example.json apps/inference-gateway/gateway.config.json
bun run gateway:build
bun run gateway:start

# separate terminal
curl http://127.0.0.1:8765/health
```

Use `bun run gateway:dev` while editing. Set
`CAPTION_BRIDGE_GATEWAY_CONFIG` to an absolute JSON path when the configuration
lives outside `apps/inference-gateway/`. Bind the gateway to `127.0.0.1` by default; when
putting it on another PC, bind to the LAN interface, use a private network or a
reverse proxy with TLS/authentication, and set Caption Bridge's inference URL
to that PC's HTTPS/HTTP URL.

## Parapper

Kotoba Beacon bundles a headless build of its compatible Parapper-ASR fork and
starts it before the gateway. The headless service listens only on
`127.0.0.1:18082`, receives `PARAPPER_RUNTIME_DIR=<app data>/parapper`, and
keeps its configuration and downloaded ASR assets separate from a user's
interactive Parapper installation. The first launch downloads the selected
VAD, Japanese dictionary, and ASR model, so an Internet connection and several
hundred MiB of free disk space are required before transcription is ready.

For standalone development, install the fork dependencies with
`bun run parapper:install`, then run its UI with `bun run parapper:tauri` or
the service directly with an explicit absolute runtime directory:

```bash
PARAPPER_RUNTIME_DIR="/absolute/path/to/kotoba-parapper" \
  packages/parapper-asr/target/release/parapper --headless --port 18082
```

The fork defaults its Japanese streaming `text` to a hiragana reading and
keeps the original ASR surface in optional `source_text`; the desktop bridge
uses the separate `azookey_input_text` field for kana-kanji normalization, while
the HTTP gateway prefers `source_text` for standard Parapper transcript output
and falls back to `text` for older/Surface sidecars. Configure its streaming endpoint in
`parapper.url`. The default is
`ws://127.0.0.1:18082/ws/recognition`. If the runtime needs authorization, set
`apiKeyEnv` to the name of an environment variable (never put a token in the
JSON configuration); the gateway sends it as a Bearer token.

The implementation follows Parapper's `session.start` → `session.ready` →
binary PCM frames → `session.stop` → `turn.final`/`session.done` protocol.

When a short live-caption window contains no usable speech, Parapper may finish
with `session.done` and no non-empty `turn.final`. The gateway treats that as an
empty transcript (`200` + `{ "text": "" }`) rather than HTTP `422
transcript_missing`, so continuous capture can soft-skip ambient chunks without
surfacing a hard audio-processing failure. Real protocol/timeout failures still
return `502`/`504`.

## Bundled zenz and Hy-MT2 servers

The desktop app packages two pinned `llama-server` builds and creates its
gateway route table on every launch. On local mode it downloads each selected
GGUF to app-data, checks the expected file size, starts the correct server on
loopback, and waits for `/health` before capture begins. The app never accepts
an arbitrary GGUF path from its UI or HTTP callers.

- zenz uses `kotoba-zenz-server`, built from the AzooKey llama.cpp fork because
  it recognizes zenz's Japanese character tokenizer.
- Hy-MT2 uses `kotoba-llama-server`, built from upstream llama.cpp with STQ
  support.

The seven fixed model IDs are mapped to ports `8081` through `8087`, but only
selected local models are downloaded and started. Model revisions, byte sizes,
licenses, source revisions, and the app-data layout are documented in
[llama-runtime.md](llama-runtime.md). `scripts/build-sidecar.ts` rebuilds both
server binaries after fetching their pinned source commits.

## Gateway HTTP contract

### `POST /v1/audio/transcriptions`

Multipart fields: `file` (16-bit PCM mono WAV), `model=parapper-ja`,
`language=ja`. The response is `{ "text": "..." }`.

### `POST /v1/chat/completions`

The request and response follow the OpenAI chat shape. zenz receives a
Japanese kana-kanji normalization prompt. Hy-MT2 receives a Japanese-to-English
translation prompt whose response is restricted to translated text.

The gateway has HTTP contract tests, a real local WebSocket fake for the
Parapper protocol, malformed-audio tests, model-routing tests, and 95% minimum
coverage thresholds.

## Bundle-size decision

A measured macOS arm64 release attributed almost all of the gateway executable
to Bun's statically embedded runtime, not to this repository's gateway code:

- the signed gateway was 63,113,408 bytes;
- an empty stripped Bun standalone executable was 62,954,328 bytes;
- the minified gateway payload added one 16,384-byte Mach-O page;
- `bun build --compile` already uses `--minify`, and the macOS finalizer already
  runs `strip -Sx`; stripping the installed gateway again removed zero bytes.

Cargo release-profile settings such as LTO and `codegen-units` cannot reduce
this executable because the gateway is a Bun standalone binary, not a Rust
binary. A material reduction requires replacing the Bun executable boundary
with a smaller runtime or reimplementing the gateway; sharing a Bun runtime
would not currently help because no other bundled sidecar uses Bun.

We also measured fat LTO plus one codegen unit for the Rust Parapper sidecar.
It reduced a controlled stripped release from 16,925,552 to 13,585,888 bytes
(19.7%), but increased the measured release build time from 65.7 to 172.6
seconds (about 2.6 times). After gzip, the reduction was only about 0.71 MB.
This tradeoff is intentionally not adopted: it materially slows release builds
without changing the bundle's dominant Bun-runtime cost.
