# AzooKey Cloudflare Worker API

This Worker keeps the existing inference HTTP adapter and adds a dedicated
AzooKey text conversion endpoint:

- `GET /v1/azookey` — capability/health metadata (does not reveal the secret).
- `GET /ws/azookey` — JSON-text WebSocket conversion session (Bearer-authenticated
  in production).

## WebSocket contract (`azookey.text.v1`)

The comparison app sends one text frame per conversion.

Wire labels `worker-vibrato` and `vibratoInput` are historical names only.
AzooKey conversion always runs with the compact WASM module on this Worker,
using `vibratoInput` as its conversion input. In worker comparison mode, a
`vibratoExecution: "worker"` frame requests the bundled Vibrato WASM/IPADIC
pre-pass (or the optional HTTP adapter fallback); the Worker does not bundle
the large UniDic dictionary.
Browser comparison mode performs its pre-pass in the client and sends
`vibratoExecution: "browser-wasm"`.

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

In browser pre-pass UI mode it may also attach the observability-only field
`comparisonMode: "browser-vibrato"`. The client-side
`convert`/`transform`/`tokenize` step rewrites `vibratoInput` before send, and
the Worker then runs AzooKey WASM on that value. In worker mode, the optional
HTTP pre-pass receives `sourceText` and `language` and returns a bounded text
value before the same AzooKey conversion.

Errors stay on the socket and use a stable shape:

```json
{
  "type": "azookey.error",
  "requestId": "req-123",
  "error": { "code": "text_too_large", "message": "..." }
}
```

## Auth and limits

Production must have the `AZOOKEY_API_TOKEN` secret configured before it is
considered ready. The local/demo default intentionally leaves the secret unset,
so a local socket can be exercised without credentials; do not use that mode
for a public deployment. Set the encrypted Cloudflare secret interactively and
never put its value in `wrangler.jsonc`, `.dev.vars.example`, a URL, or logs:

```sh
wrangler secret put AZOOKEY_API_TOKEN
```

Native clients may use `Authorization: Bearer ...` during upgrade. Browser
WebSocket clients cannot set that header, so when auth is enabled they send the
same bearer token in the first `auth` field; the socket is upgraded first and
conversion is rejected until that frame authenticates. That successful first
frame authorizes the rest of the socket session. The token is compared without
including it in any response or diagnostic message.

The checked-in Wrangler default pins `CORS_ORIGIN` to the Worker's own HTTPS
origin. If a hosted comparison UI needs the HTTP adapter, deploy with one exact
origin that you control, for example:

```sh
wrangler deploy --var CORS_ORIGIN:https://captions.your-domain.example
```

Do not use `*`, `null`, an `Origin` reflection, comma-separated origins, or a
placeholder such as `example.invalid`. The browser WebSocket endpoint does not
use CORS, but HTTP preflight and error responses still receive the configured
allow-list origin.

To check the deployed auth posture without exposing a token, inspect only the
boolean capability field:

```sh
curl -fsS https://kotoba-beacon-inference.kaoru.workers.dev/v1/azookey \
  | jq '{authConfigured: .auth.configured}'
```

The expected production value is `true`. A `false` value means the deployment
is still anonymous and must not be advertised as a public service.

`sourceText` and `vibratoInput` are each limited to 4,096 UTF-8 bytes. A JSON
frame is limited to 8,192 bytes. Conversion timeout defaults to 250 ms and can
be tuned with `AZOOKEY_TIMEOUT_MS` (25–2,000 ms). Invalid, oversized, binary,
unauthenticated, and timed-out messages receive explicit error codes without
closing a healthy session.

## WASM conversion path and Vibrato pre-pass

`packages/azookey-wasm` is a raw ABI wrapper around the existing built-in
`packages/azookey-rust` lexicon. It intentionally does not require WASI,
filesystem access, or `wasm-bindgen`, so the Worker can import one small
`wasm/azookey.wasm` module. Run `cd apps/cloudflare-worker-server && bun run
build:wasm` to reproduce the binary; `dev`, `typecheck`, `test`, and `deploy`
run that step automatically.

AzooKey conversion runs in the Worker as raw WASM. Worker comparison mode runs
the checked-in `packages/vibrato-wasm` module with the standard IPADIC
`system.dic.zst` configured by `VIBRATO_DICTIONARY_URL` before AzooKey. The
default dictionary is a bundled static asset served through the `ASSETS`
binding, fetched lazily, and cached per isolate; it is not a fixed phrase
table. An HTTPS dictionary URL and the optional `VIBRATO_UPSTREAM_URL` HTTP
adapter remain available as deployment overrides. Wire field names such as
`vibratoInput` and mode value `worker-vibrato` are historical protocol labels;
`vibratoExecution` identifies whether the pre-pass ran in the Worker or in the
browser.

## Deploy and local environment

See [the deployment runbook](../../docs/cloudflare-worker-deployment.md) for
the secret, CORS, and post-deploy checks. For local overrides, copy
`.dev.vars.example` to `.dev.vars`; the latter is git-ignored. Keep model route
URLs public and put any upstream bearer value in the untracked file locally or
in a Cloudflare secret in production.
