# AzooKey Compare

An independent Next.js comparison surface for checking the browser's Web Speech
recognition against an asynchronous AzooKey Worker WebSocket response. It is
deliberately separate from `apps/desktop`; no desktop settings are read or
written.

## Run

Start the local Worker first (serves `/ws/azookey` on port 8787):

```sh
bun run --cwd apps/cloudflare-worker-server dev
```

Then start the comparison UI:

```sh
bun install
bun --cwd apps/azookey-compare dev
```

### WebSocket endpoint

Without any env override, the page defaults to the local wrangler endpoint:

`ws://127.0.0.1:8787/ws/azookey`

Set `NEXT_PUBLIC_AZOO_KEY_WORKER_WS_URL` to point at a deployed Worker instead.
There is no checked-in production hostname; the Worker is not deployed by
default.

### Conversion modes (UI labels vs wire values)

The UI toggle chooses **where** work runs. Neither mode runs Vibrato or UniDic:

| UI label | What actually runs | Wire `mode` sent to Worker |
| --- | --- | --- |
| Worker 上の AzooKey WASM | Server-side AzooKey WASM kana→kanji only | `worker-vibrato` (kept for Worker compatibility) |
| ブラウザ WASM プリパス → Worker | Optional browser `convert`/`transform` pre-pass, then Worker AzooKey WASM | still wire `worker-vibrato`, plus `comparisonMode: "browser-vibrato"` |

For the browser pre-pass, set `NEXT_PUBLIC_AZOO_KEY_VIBRATO_WASM_URL` to a
browser-loadable JS/WASM glue module, or inject
`globalThis.__AZOOKEY_VIBRATO_WASM__` (name overridable via
`NEXT_PUBLIC_AZOO_KEY_VIBRATO_WASM_GLOBAL`). The glue must export
`convert(text)` or `transform(text)` and return a string (sync or async).
If neither a module URL nor an injected global is available, browser mode
fails explicitly — it does not silently fall back to Worker-only conversion.

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
browser pre-pass mode (`browser-vibrato` internal value), `vibratoInput` is the
browser WASM result and the client still sends the Worker-compatible wire mode
`worker-vibrato` with `comparisonMode: "browser-vibrato"` and
`vibratoExecution: "browser-wasm"`. The Worker therefore performs AzooKey
conversion only; it never runs Vibrato. Bearer tokens are sent in the JSON auth
field and are never appended to the WebSocket URL; use `wss://` for real
credentials.
