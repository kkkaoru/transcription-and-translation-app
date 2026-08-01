# AzooKey Cloudflare Worker API

This Worker keeps the existing inference HTTP adapter and adds a dedicated
AzooKey text conversion endpoint:

- `GET /v1/azookey` — capability/health metadata (does not reveal the secret).
- `GET /ws/azookey` — authenticated JSON-text WebSocket conversion session.

## WebSocket contract (`azookey.text.v1`)

The comparison app sends one text frame per conversion:

```json
{
  "type": "azookey.convert",
  "requestId": "req-123",
  "source": "web-speech",
  "language": "ja",
  "sourceText": "きょうははいしんです",
  "vibratoInput": "きょうははいしんです",
  "mode": "worker-vibrato",
  "auth": { "scheme": "bearer", "token": "..." }
}
```

The Worker sends an `azookey.ready` frame after upgrade and returns:

```json
{
  "type": "azookey.result",
  "requestId": "req-123",
  "sourceText": "きょうははいしんです",
  "convertedText": "今日は配信です",
  "mode": "worker-vibrato",
  "elapsedMs": 2,
  "model": "azookey-rust-wasm"
}
```

`browser-vibrato` is a client-only comparison mode. Sending it to this Worker
returns `unsupported_mode`; the browser implementation remains responsible for
loading its own Vibrato WASM module.

Errors stay on the socket and use a stable shape:

```json
{
  "type": "azookey.error",
  "requestId": "req-123",
  "error": { "code": "text_too_large", "message": "..." }
}
```

## Auth and limits

For a deployed endpoint, set the `AZOOKEY_API_TOKEN` secret to require auth.
When the secret is unset (the local/demo default), the socket accepts requests
without credentials. Native clients may use `Authorization: Bearer ...` during
upgrade. Browser WebSocket clients cannot set that header, so when auth is
enabled they send the same bearer token in the first `auth` field; the socket
is upgraded first and conversion is rejected until the frame authenticates.
That successful first frame authorizes the rest of the socket session.

`sourceText` and `vibratoInput` are each limited to 4,096 UTF-8 bytes. A JSON
frame is limited to 8,192 bytes. Conversion timeout defaults to 250 ms and can
be tuned with `AZOOKEY_TIMEOUT_MS` (25–2,000 ms). Invalid, oversized, binary,
unauthenticated, and timed-out messages receive explicit error codes without
closing a healthy session.

## WASM and Vibrato decision

`packages/azookey-wasm` is a raw ABI wrapper around the existing built-in
`packages/azookey-rust` lexicon. It intentionally does not require WASI,
filesystem access, or `wasm-bindgen`, so the Worker can import one small
`wasm/azookey.wasm` module. Run `bun run --cwd apps/cloudflare-worker-server
build:wasm` to reproduce the binary; `dev`, `typecheck`, `test`, and `deploy`
run that step automatically.

The desktop's `vibrato-rkyv` path depends on filesystem/mmap dictionary loading
and a large UniDic resource, so it is not a practical Worker bundle. The
existing third-party `vibrato-wasm` builds are useful tokenizers but do not
provide AzooKey kana→kanji conversion. The Worker therefore uses the compact
AzooKey WASM path, while `browser-vibrato` remains an explicitly separate mode.
