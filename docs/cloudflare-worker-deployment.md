# Cloudflare Worker deployment

This runbook keeps the AzooKey Worker usable by the comparison app without
turning the public deployment into an anonymous conversion service. The
checked-in config contains only public defaults. `AZOOKEY_API_TOKEN` and any
upstream token are Cloudflare secrets, not Wrangler variables.

The read-only audit immediately before this config change reported
`auth.configured=false` and the old `https://example.invalid` CORS value on the
live Worker. Treat that deployment as remediation-pending until the post-deploy
checks below report the expected secret and origin.

## Configuration posture

- `CORS_ORIGIN` is one explicit HTTPS origin in `wrangler.jsonc`, currently the
  Worker's own origin (`https://kotoba-beacon-inference.kaoru.workers.dev`). If
  the HTTP adapter is called from a hosted UI, override it at deploy time with
  `--var CORS_ORIGIN:https://<owned-origin>`.
- Never set CORS to `*`, `null`, a comma-separated list, or an origin reflected
  from the request. `example.invalid` and other placeholders are not deployment
  values.
- `MODEL_ROUTES={}` keeps optional chat routing disabled by default. Add only
  owned HTTPS upstreams; keep their credentials in secrets.
- `secrets.required` names `AZOOKEY_API_TOKEN` without embedding its value.
  Wrangler may warn during local development when the loopback-only secret is
  absent; production still requires the interactive secret setup below.
- `VIBRATO_UPSTREAM_URL` is an optional public URL for the Worker-side
  pre-pass. Its bearer, when required, belongs in the `VIBRATO_API_TOKEN`
  secret. `VIBRATO_DICTIONARY_URL` is the alternative public URL for a
  zstd-compressed system dictionary consumed by the checked-in Vibrato WASM;
  the checked-in config points to the repository's public default. Leave both
  URLs unset only for local/demo requests that explicitly use a browser pre-pass.
- `.dev.vars.example` is a template. Copy it to the git-ignored `.dev.vars`
  for local work, and do not commit token assignments.

## First deployment or secret rotation

Run these commands from the repository root. The secret command prompts without
printing the value; enter a long random token using your password manager or a
local generator. Do not put the token in a command argument or shell history.

```sh
bun run --cwd apps/cloudflare-worker-server build:wasm
wrangler secret put AZOOKEY_API_TOKEN --config apps/cloudflare-worker-server/wrangler.jsonc
bun run worker:deploy
```

If a remote ASR service is enabled, set its URL as a non-secret variable and
its bearer separately:

```sh
wrangler secret put ASR_API_TOKEN --config apps/cloudflare-worker-server/wrangler.jsonc
```

For a Worker-side Vibrato service, set `VIBRATO_UPSTREAM_URL` as a non-secret
deploy variable and its bearer separately as `VIBRATO_API_TOKEN`. Requests from
the comparison app send the first-frame bearer for the Worker itself; that is a
different secret from the upstream credential.

The existing Worker name and URL stay unchanged. A deploy without the
`AZOOKEY_API_TOKEN` secret is intentionally treated as an anonymous local/demo
mode; do not promote it or share the WebSocket URL.

## Post-deploy checks

These checks reveal status and headers only; none prints a secret:

```sh
curl -fsS https://kotoba-beacon-inference.kaoru.workers.dev/v1/azookey \
  | jq '{authConfigured: .auth.configured, websocketPath: .websocketPath}'
curl -fsS -D - -o /dev/null -X OPTIONS \
  https://kotoba-beacon-inference.kaoru.workers.dev/v1/azookey \
  -H 'Origin: https://<owned-origin>' \
  -H 'Access-Control-Request-Method: GET'
```

Confirm `authConfigured` is `true` and the `access-control-allow-origin`
header is the single configured origin. A `false` auth value or an old
`example.invalid` header means the deployment still needs remediation.

For a browser WebSocket, select **Bearer token** in the comparison app and
enter the same token. The browser sends it in the first JSON frame because the
WebSocket API cannot attach an arbitrary `Authorization` header. Native clients
may send the header during the upgrade instead. Tokens must never be appended
to the `ws:`/`wss:` URL.

## Local development

```sh
cp apps/cloudflare-worker-server/.dev.vars.example apps/cloudflare-worker-server/.dev.vars
bun run worker:dev
```

The local template allows the comparison app origin
`http://127.0.0.1:3000`. If you set a local `AZOOKEY_API_TOKEN`, keep the file
untracked and select Bearer auth in the app; leaving it unset is acceptable for
loopback-only development.
