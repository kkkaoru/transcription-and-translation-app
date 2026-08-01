# Recognition integration verification

`scripts/recognition-integration.mjs` is the single entry point for the
recognition regression lanes. It runs the deterministic checks concurrently and
keeps optional machine-dependent checks explicit in the JSON report.

```sh
# Desktop + Worker + inference gateway tests/typechecks
node scripts/recognition-integration.mjs

# Include all package coverage gates (desktop, Worker, and AzooKey compare)
# and the real Parapper session.ready → session.stop → session.done probe
node scripts/recognition-integration.mjs --ws --coverage

# Capture browser UI evidence (Vite must already be running on :1420)
node scripts/recognition-integration.mjs --ui

# Build and operate the packaged macOS Tauri app, including screenshots
node scripts/recognition-integration.mjs --tauri

# Probe a deployed Cloudflare Worker health endpoint
node scripts/recognition-integration.mjs --worker-url https://example.workers.dev
```

The report directory is printed at the end and can be overridden with
`--out-dir` or `RECOGNITION_INTEGRATION_OUT_DIR`. Each command has a separate
`.log` file. A missing `apps/azookey-compare` directory is reported as
`skipped`; once that app exists, its `typecheck` and `test` package scripts are
discovered and included automatically. With `--coverage`, the report stores
the desktop, Worker, and comparison-app `coverage-summary.json` values under
`report.coverage` and keeps the command's threshold result as the gate.
