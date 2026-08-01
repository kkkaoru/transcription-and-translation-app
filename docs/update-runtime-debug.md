# Update and runtime diagnostics

The Settings → Debug info panel includes a read-only snapshot of the native
updater and every bundled inference sidecar. The snapshot is refreshed with the
other diagnostics and receives `update:status` events while the panel is open.

The updater state is one of `idle`, `checking`, `available`, `downloading`,
`ready`, `installed`, `failed`, or `unsupported`. It includes the current and
available application versions, check time, byte progress, and a safe error
summary. `Check for updates` and `Install update` call the native bridge
commands; browser preview reports `unsupported` and never performs network
requests.

Sidecar rows report the bundled identifier, version (or `unknown` when the
binary does not expose one), health, loopback port, active state, and the last
model switch result. Health URLs are displayed without query strings.

Updater transitions and failures are mirrored into the structured log ring
buffer and native log targets. The logger redacts bearer/basic credentials,
API/access/refresh tokens, passwords, cookies, JWTs, private keys, and secret
query parameters before they are retained or printed. Stage logs contain byte
counts rather than raw audio/caption samples in native log files; verbose text
samples remain available only in the in-memory Debug panel feed.

For support, export JSONL from the Debug panel. The export contains diagnostic
metadata and redacted updater/sidecar state; it does not include updater tokens
or credentials.

## Signed release feed

`bun run build:app:release` requires `TAURI_SIGNING_PRIVATE_KEY` and enables
Tauri's updater artifacts through `tauri.release.conf.json`. Publish the
generated archive and its `.sig` alongside a signed `latest.json` whose target
entries match the Tauri platform names (for example `darwin-aarch64`), for
example:

```json
{
  "version": "0.1.1",
  "notes": "Bug fixes",
  "pub_date": "2026-08-01T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://example.invalid/Kotoba_Beacon_0.1.1_aarch64.app.tar.gz",
      "signature": "<contents of the matching .sig file>"
    }
  }
}
```

Never replace the archive without replacing its signature. Tauri verifies the
signature against the public key embedded in `tauri.conf.json` before stopping
sidecars or replacing the bundle. The app checks on startup in release builds,
installs by default when idle, and defers the install until `stop_capture` when
the microphone is active. Set `KOTOBA_BEACON_AUTO_UPDATE=0` only for a
diagnostic session that must not install updates.
