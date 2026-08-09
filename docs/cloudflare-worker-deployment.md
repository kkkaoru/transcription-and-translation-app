# Cloudflare Worker deployment

This runbook keeps the AzooKey Worker usable by the comparison app without
turning the public deployment into an anonymous conversion service. The
checked-in config contains only public defaults. `AZOOKEY_API_TOKEN` and any
upstream token are Cloudflare secrets, not Wrangler variables.

The read-only audit immediately before this config change reported
`auth.configured=false` and the old `https://example.invalid` CORS value on the
live Worker. Treat that deployment as remediation-pending until the post-deploy
checks below report the expected secret and origin.

## Cursor Cloudflare MCP (agent / CLI)

Do not add Code Mode (`https://mcp.cloudflare.com/mcp`) to `.cursor/mcp.json`
or Cursor `settings.json`. That endpoint errors in this setup.

Use the **Cursor Cloudflare plugin** instead and authenticate these servers in
**Settings → MCP**:

- `plugin-cloudflare-cloudflare-docs` (public)
- `plugin-cloudflare-cloudflare-bindings`
- `plugin-cloudflare-cloudflare-builds`
- `plugin-cloudflare-cloudflare-observability`

`bun run mcp:cloudflare` keeps mcp.json empty of Code Mode. Wrangler still
uses `CLOUDFLARE_API_TOKEN` from the gitignored `.env`.

## Configuration posture

- Production traffic reaches AzooKey through the compare Worker, not the
  inference `workers.dev` URL. Browser path:
  `https://azookey-compare.kaoru.workers.dev` → service binding `INFERENCE` →
  `kotoba-beacon-inference`. Same-origin WebSocket:
  `wss://azookey-compare.kaoru.workers.dev/ws/azookey`.
- Inference sets `workers_dev: false` so the public
  `kotoba-beacon-inference.kaoru.workers.dev` hostname is removed. Direct
  `curl` should 404; health and conversion stay on compare.
- `CORS_ORIGIN` in `apps/cloudflare-worker-server/wrangler.jsonc` is pinned to
  that compare origin (`https://azookey-compare.kaoru.workers.dev`). CORS is a
  backup for any direct HTTP adapter call; Access plus the service-binding path
  are the real controls. Do not treat CORS as authentication.
- Never set CORS to `*`, `null`, a comma-separated list, or an origin reflected
  from the request. `example.invalid` and other placeholders are not deployment
  values.
- `MODEL_ROUTES={}` keeps optional chat routing disabled by default. Add only
  owned HTTPS upstreams; keep their credentials in secrets.
- `secrets.required` names `AZOOKEY_API_TOKEN` without embedding its value.
  Wrangler may warn during local development when the loopback-only secret is
  absent; production still requires the interactive secret setup below.
- `AZOOKEY_DICTIONARY_URL` defaults to `/azookey/system.azkdict.gz`, a static
  official LOUDS/MM/CID archive generated from the pinned AzooKey submodule and
  served through the `ASSETS` binding. It is not a phrase table. The deploy
  preflight rebuilds it deterministically. The source is Apache-2.0 revision
  `4d418525b090cf49c219819d05a7e3cc2a4346eb` (`v3.1.0-beta.15`); the expected
  gzip SHA-256 is
  `84f605a5c76e09480ef1a0a02d91982fb8c9426a8a7a18fb64d9f27210641b22`.
- `VIBRATO_UPSTREAM_URL` is the optional HTTP adapter for a real server-side
  Vibrato pre-pass. Its bearer, when required, belongs in the
  `VIBRATO_API_TOKEN` secret. Worker public assets intentionally omit the IPADIC
  dictionary because it exceeds the Workers 128 MiB isolate limit; configure
  `VIBRATO_UPSTREAM_URL` (and its optional `VIBRATO_DICTIONARY_URL`) for a
  server-side dictionary, or use the browser Vibrato WASM when no upstream is
  configured.
- `.dev.vars.example` is a template. Copy it to the git-ignored `.dev.vars`
  for local work, and do not commit token assignments.

## First deployment or secret rotation

Run these commands from the repository root. The secret command prompts without
printing the value; enter a long random token using your password manager or a
local generator. Do not put the token in a command argument or shell history.
`wrangler.jsonc` intentionally does not contain an `account_id`; select the
Cloudflare account through `CLOUDFLARE_ACCOUNT_ID` so a public checkout never
publishes an account identifier. Set it in the shell that performs the deploy,
then pass the checked-in config explicitly:

```sh
export CLOUDFLARE_ACCOUNT_ID="<your-cloudflare-account-id>"
wrangler deploy --config apps/cloudflare-worker-server/wrangler.jsonc
```

The same environment variable is inherited by `bun run worker:deploy` and
`bun run azookey-compare:deploy` below. Keep the value in your shell/CI secret
store, not in `wrangler.jsonc`. A gitignored `.env` may hold it locally.

```sh
git submodule update --init submodules/azooKey_dictionary_storage
bun run assets:verify
cd apps/cloudflare-worker-server && bun run build:wasm && cd ../..
wrangler secret put AZOOKEY_API_TOKEN --config apps/cloudflare-worker-server/wrangler.jsonc
bun run worker:deploy
bun run azookey-compare:deploy
bun run access:setup
```

The checked-in archive is content-addressed, so a clean clone may run
`build:wasm` before initializing the dictionary submodule; it will verify and
reuse that archive. Initialize the pinned submodule as shown above whenever
the archive itself must be regenerated.

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

These checks reveal status and headers only; none prints a secret. After Access
is enabled, unauthenticated `curl` to compare should be `302` or
`401` with `WWW-Authenticate` (Managed OAuth). Authenticated browser checks use
the Access session cookie or `cloudflared access`.

```sh
curl -sS -D - -o /dev/null https://azookey-compare.kaoru.workers.dev/
curl -sS -D - -o /dev/null https://kotoba-beacon-inference.kaoru.workers.dev/v1/azookey
```

The inference public URL should be denied by Access (or otherwise unreachable).
Health and conversion go through compare after login:

```sh
# After authenticating in a browser, or via cloudflared access:
curl -fsS https://azookey-compare.kaoru.workers.dev/v1/azookey \
  | jq '{authConfigured: .auth.configured, websocketPath: .websocketPath}'
```

Confirm `authConfigured` is `true`. A `false` auth value means the inference
secret still needs remediation. Production WebSocket is
`wss://azookey-compare.kaoru.workers.dev/ws/azookey`.

For a browser WebSocket, select **Bearer token** in the comparison app and
enter the same token. The browser sends it in the first JSON frame because the
WebSocket API cannot attach an arbitrary `Authorization` header. Native clients
may send the header during the upgrade instead. Tokens must never be appended
to the `ws:`/`wss:` URL.

`bun run access:setup` creates OTP (and Google only when
`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` are set) plus
self-hosted apps with `oauth_configuration.enabled`. Allow lists default to
`kaoru@teadea.net` and `@teadea.net`. IdP write needs
`Access: Organizations, Identity Providers, and Groups Edit`; app write needs
`Access: Apps and Policies Edit`.

## Local development

```sh
cp apps/cloudflare-worker-server/.dev.vars.example apps/cloudflare-worker-server/.dev.vars
bun run worker:dev
```

The local template allows the comparison app origin
`http://127.0.0.1:3000`. If you set a local `AZOOKEY_API_TOKEN`, keep the file
untracked and select Bearer auth in the app; leaving it unset is acceptable for
loopback-only development.
