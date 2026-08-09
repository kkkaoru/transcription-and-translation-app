# AzooKey Cloudflare Worker API

Standalone Cloudflare Worker for AzooKey text conversion (and optional HTTP
inference adapters). It does not require the Kotoba Beacon desktop app.

Local comparison stack (Worker + Next.js only):

```sh
bun run worker:dev
bun run azookey-compare:dev
```

`worker:dev` uses `wrangler.dev.jsonc` (no Workers AI remote session) so AzooKey
WebSocket on `:8787` stays up even when `api.cloudflare.com` is unreachable.
Production deploy still uses `wrangler.jsonc` with the optional AI binding.

This Worker keeps the existing inference HTTP adapter and adds a dedicated
AzooKey text conversion endpoint:

- `GET /v1/azookey` — capability/health metadata (does not reveal the secret).
- `GET /ws/azookey` — JSON-text WebSocket conversion session (Bearer-authenticated
  in production).

The standard AzooKey WebSocket path never invokes speech recognition. ASR stays
on `POST /v1/audio/transcriptions`; it keeps the existing `parapper-ja` upstream
or 503 behavior unless `ASR_PROVIDER=workers-ai` is explicitly configured. That
opt-in uses the Worker AI binding and `@cf/deepgram/nova-3` with `language: "ja"`
for comparison/fallback requests. It is metered and sends audio through
Cloudflare/Deepgram, so enable it only after reviewing cost and privacy. Set
`WORKERS_AI_ASR_TIMEOUT_MS` (100–30,000 ms, default 15,000) when needed.

## WebSocket contract (`azookey.text.v1`)

The comparison app sends one text frame per conversion.

Wire labels `worker-vibrato` and `vibratoInput` are historical names only.
AzooKey conversion always runs with the official portable LOUDS/MM/CID
dictionary in the Worker when `AZOOKEY_DICTIONARY_URL` is configured, using
`vibratoInput` as its conversion input. Worker and HTTP Vibrato adapters match
Tauri: pure kana passes through unchanged, and only kanji-bearing text is
tokenized with IPADIC F[7]. In worker comparison mode, a
`vibratoExecution: "worker"` frame uses the configured HTTP Vibrato adapter
when `VIBRATO_UPSTREAM_URL` is set. Without that adapter the ready frame reports
`workerStage: "passthrough"`; the comparison UI then runs browser Vibrato for
kanji-bearing Web Speech before AzooKey. Browser comparison mode performs the
real Vibrato WASM pre-pass in the client and sends `vibratoExecution: "browser-wasm"`.

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

The checked-in Wrangler default pins `CORS_ORIGIN` to the hosted compare UI
(`https://azookey-compare.kaoru.workers.dev`). Browser conversion should use that
origin; the inference `workers.dev` URL is not a public client endpoint. Do not
use `*`, `null`, an `Origin` reflection, comma-separated origins, or a
placeholder such as `example.invalid`. The browser WebSocket endpoint does not
use CORS, but HTTP preflight and error responses still receive the configured
allow-list origin.

To check the deployed auth posture without exposing a token, call health through
compare after Access login (inference direct `curl` should be denied):

```sh
curl -fsS https://azookey-compare.kaoru.workers.dev/v1/azookey \
  | jq '{authConfigured: .auth.configured}'
```

The expected production value is `true`. A `false` value means the deployment
is still anonymous and must not be advertised as a public service.

`sourceText` and `vibratoInput` are each limited to 4,096 UTF-8 bytes. A JSON
frame is limited to 8,192 bytes. Conversion timeout defaults to 2,000 ms and can
be tuned with `AZOOKEY_TIMEOUT_MS` (25–2,000 ms). Invalid, oversized, binary,
unauthenticated, and timed-out messages receive explicit error codes without
closing a healthy session.

## WASM conversion path and Vibrato pre-pass

`packages/azookey-wasm` is a raw ABI wrapper around the existing
`packages/azookey-rust` converter. It intentionally does not require WASI,
filesystem access, or `wasm-bindgen`, so the Worker can import one small
`wasm/azookey.wasm` module. `build:wasm` also packs the pinned official
`louds/**`, `mm.binary`, and `cb/*.binary` files into
`public/azookey/system.azkdict.gz`; it does not replace the dictionary with a
phrase-specific table or custom homonym rules. `dev`, `typecheck`, `test`, and
`deploy` build or verify this deterministic asset automatically.

Before publishing or reviewing a clean checkout, run
`bun run assets:verify`. It checks the pinned submodule gitlinks, the archive
hash, and byte-identical Vibrato dictionary/WASM copies. If the AzooKey source
submodule is not initialized, `build:wasm` verifies and reuses the checked-in
archive rather than silently producing a different dictionary; initialize the
submodule with `git submodule update --init submodules/azooKey_dictionary_storage`
when a source rebuild is required.

The browser comparison app bundles the IPADIC dictionary with its upstream
`COPYING` and `NOTICE` files. The Worker keeps only those attribution notices;
its public assets deliberately omit the memory-heavy dictionary. To restore
the browser dictionary after cleaning generated assets, run
`node scripts/build-vibrato-wasm.mjs --bindgen`.

The asset is pinned to `azooKey_dictionary_storage` revision
`4d418525b090cf49c219819d05a7e3cc2a4346eb` (`v3.1.0-beta.15`) and its checked-in
gzip SHA-256 is
`84f605a5c76e09480ef1a0a02d91982fb8c9426a8a7a18fb64d9f27210641b22`.
The upstream data is Apache-2.0; the build copies its license to
`public/azookey/LICENSE` from `submodules/azooKey_dictionary_storage/LICENSE`.
The archive contains the 2,063
files used by current Rust caption conversion. It intentionally excludes
`p/*.csv`, which upstream uses for keyboard zero-hint prediction rather than
ASR caption conversion, so this is caption-conversion parity rather than a
claim of full keyboard-app feature parity.

The Wrangler default loads the official AzooKey archive through `ASSETS`,
lazily and once per Worker isolate. The initialized AzooKey memory is about
26.5 MiB. The Vibrato IPADIC dictionary is about 7.7 MiB compressed and is not
packaged in Worker assets because its expanded form exceeds the Workers 128
MiB isolate limit when combined with the portable AzooKey dictionary. For a
server-side Vibrato pre-pass, configure `VIBRATO_UPSTREAM_URL` (or an external
`VIBRATO_DICTIONARY_URL`); otherwise choose the browser Vibrato WASM mode in
the comparison app.

Wire field names such as `vibratoInput` and mode value `worker-vibrato` are
historical protocol labels. `vibratoExecution` identifies whether a real
pre-pass ran in the Worker or in the browser. The ready metadata and result
metadata also identify the effective stage and explicitly mark the
mixed-input passthrough path; a passthrough result must never be interpreted
as evidence that Vibrato ran.

## Deploy and local environment

See [the deployment runbook](../../docs/cloudflare-worker-deployment.md) for
the secret, CORS, and post-deploy checks. For local overrides, copy
`.dev.vars.example` to `.dev.vars`; the latter is git-ignored. Keep model route
URLs public and put any upstream bearer value in the untracked file locally or
in a Cloudflare secret in production.
