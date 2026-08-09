# AzooKey Compare

Standalone Next.js comparison UI for Web Speech recognition vs an asynchronous
AzooKey Cloudflare Worker WebSocket response. It does not talk to the Kotoba
Beacon desktop app and does not read or write desktop settings.

## Run (Worker + UI only)

Terminal 1 — local Worker (`/ws/azookey` on port 8787):

```sh
bun run worker:dev
```

Terminal 2 — comparison UI:

```sh
bun run azookey-compare:dev
```

Open `http://127.0.0.1:3000` (not `localhost`) so the Worker `CORS_ORIGIN`
(`http://127.0.0.1:3000` via `.dev.vars`) matches the page origin.

Local Wrangler uses `apps/cloudflare-worker-server/.dev.vars` (copy from
`.dev.vars.example` if missing). Auth may stay unset for local demos.

### Phonetic / fixture checks

The right-hand panel has a **読み入力** lane: phonetic text is sent straight to
the Worker AzooKey WASM (no browser Vibrato rewrite). Built-in fixtures cover
common conversion regressions. **全ケース実行** runs them in order.

### WebSocket endpoint

Default (no env override):

`ws://127.0.0.1:8787/ws/azookey`

Set `NEXT_PUBLIC_AZOO_KEY_WORKER_WS_URL` for a deployed Worker.
`bun run azookey-compare:deploy` bakes the production compare URL:

`wss://azookey-compare.kaoru.workers.dev/ws/azookey`

Do not point the hosted UI at the inference `workers.dev` WebSocket; that
origin is Access-denied (or closed) and conversion is proxied in-process.

Hosted compare is behind Cloudflare Access (OTP + Managed OAuth, teadea only).
Unauthenticated browsers `302` to Access login; API clients `401`. Production
Worker secrets `POLICY_AUD` and `TEAM_DOMAIN` enable `Cf-Access-Jwt-Assertion`
validation. Leave both unset for local `wrangler dev`.

### Conversion models

The configuration panel includes a **変換モデル** select:

| Option | When it works |
| --- | --- |
| AzooKey WASM（Worker 内蔵） | Default. No extra model server. |
| AzooKey Zenzai v3.2 xsmall | Worker `MODEL_ROUTES` must include `zenz-v3.2-xsmall-gguf` |
| AzooKey Zenzai v3.2 small | Worker `MODEL_ROUTES` must include `zenz-v3.2-small-gguf` |

### Conversion modes (UI labels vs wire values)

| UI label | What actually runs | Wire `mode` sent to Worker |
| --- | --- | --- |
| Worker 上の Vibrato → AzooKey WASM | Tauri と同じく漢字があるときだけ Vibrato（IPADIC F[7]）。Worker Vibrato 未設定時はブラウザ Vibrato で漢字読みを補い、その後 AzooKey WASM | `worker-vibrato` plus `vibratoExecution: "worker"` or `"browser-wasm"` when the client supplied the reading |
| ブラウザ Vibrato WASM → Worker | Generated `VibratoTokenizer` + IPADIC dictionary (F[7]) pre-pass（純かなはそのまま）、then Worker AzooKey WASM | `worker-vibrato` plus `comparisonMode: "browser-vibrato"` and `vibratoExecution: "browser-wasm"` |

Checked-in browser defaults: `/vibrato/vibrato_wasm.js` and
`/vibrato/system.dic.zst`. Override with
`NEXT_PUBLIC_AZOO_KEY_VIBRATO_WASM_URL` and
`NEXT_PUBLIC_AZOO_KEY_VIBRATO_DICTIONARY_URL` when needed.

If the module, dictionary, or injected global is unavailable, browser mode
fails explicitly — it does not silently fall back to Worker-only conversion.

IPADIC attribution: `public/vibrato/COPYING` and `public/vibrato/NOTICE`
(copied by `node scripts/build-vibrato-wasm.mjs`; verified by
`bun run assets:verify`).

## Worker frame contract

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

Responses share `requestId` and either `convertedText` (or `text`) or `error`.
Browser pre-pass mode still sends wire `mode: "worker-vibrato"` with
`comparisonMode: "browser-vibrato"` and `vibratoExecution: "browser-wasm"`.
Bearer tokens go in the JSON `auth` field, never in the WebSocket URL.
