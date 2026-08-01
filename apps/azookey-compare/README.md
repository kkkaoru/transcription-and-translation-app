# AzooKey Compare

An independent Next.js comparison surface for checking the browser's Web Speech
recognition against an asynchronous AzooKey Worker WebSocket response. It is
deliberately separate from `apps/desktop`; no desktop settings are read or
written.

## Run

```sh
bun install
bun --cwd apps/azookey-compare dev
```

The page defaults to a configurable `wss://` endpoint. Set
`NEXT_PUBLIC_AZOO_KEY_VIBRATO_WASM_URL` to a browser-loadable JS/WASM glue module,
or expose `globalThis.__AZOOKEY_VIBRATO_WASM__`, when using Browser Vibrato mode.
The glue module must export `convert(text)` or `transform(text)` and return a
string (synchronously or asynchronously).

## Worker frame contract

The comparison client sends one JSON text frame for every final Web Speech
utterance:

```json
{
  "type": "azookey.convert",
  "requestId": "uuid",
  "source": "web-speech",
  "language": "ja-JP",
  "sourceText": "きょうのてんき",
  "vibratoInput": "きょうのてんき",
  "mode": "worker-vibrato",
  "auth": { "scheme": "none" }
}
```

The Worker should reply with the same `requestId` and either
`convertedText` (or the `text` alias) or an `error` object. Responses may arrive
out of order; the UI keeps each request in its own timeline row. In the UI's
`browser-vibrato` mode, `vibratoInput` is the browser WASM result
and the client sends the Worker-compatible wire mode `worker-vibrato` with
`comparisonMode: "browser-vibrato"` and `vibratoExecution: "browser-wasm"`.
The Worker therefore performs the remaining AzooKey conversion without being
asked to run the client-only mode. Bearer tokens are sent in the JSON auth
field and are never appended to the WebSocket URL; use `wss://` for real
credentials.
