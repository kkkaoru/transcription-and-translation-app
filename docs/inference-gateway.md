# Inference gateway

`apps/inference-gateway/` is the executable boundary between the Tauri application and model
runtimes. It gives the app one HTTP endpoint while keeping Parapper and the
GGUF servers local or on another PC.

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
keeps the original ASR text in optional `source_text`; the existing gateway
continues to consume `text`. Configure its streaming endpoint in
`parapper.url`. The default is
`ws://127.0.0.1:18082/ws/recognition`. If the runtime needs authorization, set
`apiKeyEnv` to the name of an environment variable (never put a token in the
JSON configuration); the gateway sends it as a Bearer token.

The implementation follows Parapper's `session.start` → `session.ready` →
binary PCM frames → `session.stop` → `turn.final`/`session.done` protocol.

The gateway's GGUF routes are still external llama.cpp services. Bundling and
starting those model servers remains a separate, unfinished distribution task.

## zenz and Hy-MT2 with llama.cpp

Install a recent `ggml-org/llama.cpp` build that supports the GGUF architecture
of the selected model:

```bash
git clone https://github.com/ggml-org/llama.cpp.git
cmake -B llama.cpp/build -S llama.cpp -DCMAKE_BUILD_TYPE=Release
cmake --build llama.cpp/build --config Release

# zenz example
./llama.cpp/build/bin/llama-server \
  --model /absolute/path/zenz-v3.2-small.gguf \
  --alias zenz-v3.2-small-gguf --port 8082 --jinja

# Hy-MT2 1.8B example
./llama.cpp/build/bin/llama-server \
  --model /absolute/path/Hy-MT2-1.8B-GGUF.gguf \
  --alias hy-mt2-1.8b-gguf --port 8083 --jinja
```

Hy-MT2's GGUF guidance requires a llama.cpp version with its STQ kernel
support. If an upstream llama.cpp build rejects the selected Hy-MT2 GGUF, use
the official Hy-MT2 inference environment instead and place an
OpenAI-compatible adapter in front of it; no Caption Bridge source change is
needed because the gateway only requires `POST /v1/chat/completions`.

Each selectable GGUF model needs either its own running server/port or a model
server that can safely switch models. The example config assigns a route for
every model ID; only map a route to a running server with the matching alias.
This makes model switching in the Caption Bridge UI a real server selection,
not an unverified local-path switch.

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
