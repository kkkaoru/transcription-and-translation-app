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

`browser-vibrato` is a client-only comparison mode label. Sending it to this
Worker returns `unsupported_mode`. The comparison app therefore always sends the
wire value `worker-vibrato` for conversion; when the UI selected a browser
pre-pass it also attaches `comparisonMode: "browser-vibrato"` and
`vibratoExecution: "browser-wasm"` as metadata. That pre-pass is an optional
browser-side `convert`/`transform` module — not Vibrato or UniDic.

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

## WASM conversion path (not Vibrato)

`packages/azookey-wasm` is a raw ABI wrapper around the existing built-in
`packages/azookey-rust` lexicon. It intentionally does not require WASI,
filesystem access, or `wasm-bindgen`, so the Worker can import one small
`wasm/azookey.wasm` module. Run `bun run --cwd apps/cloudflare-worker-server
build:wasm` to reproduce the binary; `dev`, `typecheck`, `test`, and `deploy`
run that step automatically.

This endpoint runs **only** AzooKey WASM kana→kanji conversion. There is no
Vibrato stage and no UniDic dictionary in the Worker. The desktop's
`vibrato-rkyv` path depends on filesystem/mmap dictionary loading and a large
UniDic resource (~684 MB), which cannot fit a Cloudflare isolate. Existing
third-party `vibrato-wasm` builds are useful tokenizers but do not provide
AzooKey kana→kanji conversion. Wire field names such as `vibratoInput` and mode
value `worker-vibrato` are historical protocol labels only; the runtime still
calls the compact AzooKey converter alone.
