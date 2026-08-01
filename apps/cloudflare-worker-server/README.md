# AzooKey Cloudflare Worker API

This Worker keeps the existing inference HTTP adapter and adds a dedicated
AzooKey text conversion endpoint:

- `GET /v1/azookey` — capability/health metadata (does not reveal the secret).
- `GET /ws/azookey` — authenticated JSON-text WebSocket conversion session.

## WebSocket contract (`azookey.text.v1`)

The comparison app sends one text frame per conversion.

Wire labels `worker-vibrato` and `vibratoInput` are historical names only.
For AzooKey comparison, both UI modes always convert with AzooKey WASM on this
Worker using `vibratoInput` as the conversion input. Neither mode runs Vibrato
or UniDic on the Worker.

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

`vibratoInput` is the conversion input (historical name). Comparison worker-mode
sets it equal to `sourceText`; browser pre-pass mode sets it to the pre-pass string.

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

Wire `mode` must be `worker-vibrato`. The comparison UI value `browser-vibrato`
is client-only: if sent as wire `mode`, the Worker returns `unsupported_mode`.
The comparison app therefore always sends wire `mode: "worker-vibrato"`.

In browser pre-pass UI mode it may also attach observability-only fields
`comparisonMode: "browser-vibrato"` and `vibratoExecution: "browser-wasm"`.
The Worker ignores those fields and always runs AzooKey WASM on `vibratoInput`.
The optional browser pre-pass is a client-side `convert`/`transform`/`tokenize` step that
may rewrite `vibratoInput` before send — not Vibrato and not UniDic.

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
value `worker-vibrato` are historical protocol labels only. The runtime always
converts `vibratoInput` with the compact AzooKey converter alone (it does not
convert `sourceText`, and it never runs Vibrato).
