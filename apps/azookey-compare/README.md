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
The deployed Worker answers at
`wss://kotoba-beacon-inference.kaoru.workers.dev/ws/azookey`; the default stays
local so the app never talks to production unless you ask it to.

### Conversion modes (UI labels vs wire values)

The UI toggle chooses **where** the required real Vibrato pre-pass runs. Both
routes then send the resulting hiragana to the Worker-side AzooKey WASM:

| UI label | What actually runs | Wire `mode` sent to Worker |
| --- | --- | --- |
| Worker 上の Vibrato → AzooKey WASM | `VIBRATO_UPSTREAM_URL` を設定した Worker の Vibrato HTTP adapter、then server-side AzooKey WASM。未設定時は公式 AzooKey の mixed-input passthrough（ready frame に明示） | `worker-vibrato` plus `vibratoExecution: "worker"` |
| ブラウザ Vibrato WASM → Worker | Generated `VibratoTokenizer` + IPADIC dictionary (F[7]) pre-pass, then Worker AzooKey WASM | `worker-vibrato` plus `comparisonMode: "browser-vibrato"` and `vibratoExecution: "browser-wasm"` |

The checked-in browser defaults use `/vibrato/vibrato_wasm.js` and
`/vibrato/system.dic.zst`. Override them with
`NEXT_PUBLIC_AZOO_KEY_VIBRATO_WASM_URL` and
`NEXT_PUBLIC_AZOO_KEY_VIBRATO_DICTIONARY_URL` when hosting a different
wasm-bindgen module/dictionary. The generated module exports `initSync` and
`VibratoTokenizer`; the loader initializes it and extracts IPADIC reading F[7]
(UniDic CWJ uses F[20]). A custom wrapper/global may instead expose
`globalThis.__AZOOKEY_VIBRATO_WASM__` (name overridable via
`NEXT_PUBLIC_AZOO_KEY_VIBRATO_WASM_GLOBAL`). A custom wrapper may export
`convert(text)`, `transform(text)`, or `tokenize(text)` and return a string
(sync or async); a module whose default export is the function itself also
works.
If the module, dictionary, or injected global is unavailable, browser mode
fails explicitly — it does not silently fall back to Worker-only conversion.

The checked-in IPADIC dictionary is accompanied by `public/vibrato/COPYING` and
`public/vibrato/NOTICE`. These files are copied from the source asset directory
by `node scripts/build-vibrato-wasm.mjs` and are checked by
`bun run assets:verify`.

## Worker frame contract

The comparison client sends one JSON text frame for each final Web Speech
utterance that reaches the Worker. A setup failure (for example, a missing
Bearer token) or a failed browser pre-pass aborts the request before any frame
is sent:

```json
{
  "type": "azookey.convert",
  "requestId": "uuid",
  "source": "web-speech",
  "language": "ja-JP",
  "sourceText": "きょうのてんき",
  "vibratoInput": "きょうのてんき",
  "mode": "worker-vibrato",
  "vibratoExecution": "worker",
  "auth": { "scheme": "none" }
}
```

The Worker should reply with the same `requestId` and either
`convertedText` (or the `text` alias) or an `error` object. Responses may arrive
out of order; the UI keeps each request in its own timeline row. In the UI's
browser pre-pass mode (`browser-vibrato` internal value), `vibratoInput` is the
browser WASM result and the client still sends the Worker-compatible wire mode
`worker-vibrato` with `comparisonMode: "browser-vibrato"` and
`vibratoExecution: "browser-wasm"`. The Worker performs AzooKey conversion
only for that browser-prepass frame; worker-mode frames invoke the configured
HTTP Vibrato stage before AzooKey, or use the official mixed-input AzooKey path
when no server-side Vibrato adapter is configured. The ready frame distinguishes
these stages. Bearer tokens are sent in the JSON auth field and are never
appended to the WebSocket URL; use `wss://` for real credentials.
