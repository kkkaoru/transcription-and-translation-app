# Tauri runtime smoke (macOS)

`scripts/tauri-smoke.mjs` is the repeatable native smoke harness for Kotoba Beacon.
It launches the exact release `.app` (or the existing debug binary), captures the
main window, waits for the embedded Parapper/gateway/model sidecars, submits a
short silent WAV to the real `/v1/audio/transcriptions` endpoint, and records the
window/process/log evidence under `/tmp`.

```bash
# release bundle; smoke-launched app and sidecars are stopped at the end
node scripts/tauri-smoke.mjs

# build the unsigned release bundle first, then launch that exact bundle
node scripts/tauri-smoke.mjs --build

# debug binary
node scripts/tauri-smoke.mjs --flavor debug

# retain the app for manual inspection
node scripts/tauri-smoke.mjs --keep-alive
```

The equivalent package commands are `bun run verify:tauri` (use the existing
bundle), `bun run verify:tauri:build` (run `bun run build:app` first), and
`bun run verify:tauri:ui` (Accessibility UI attempt). For a full build → native
UI run, use `bun run verify:tauri:build:ui`. Build mode writes the
full Tauri output to `build.log`, then checks `Info.plist`, the bundle identity,
all five `kotoba-*` binaries, and the packaged runtime/notice directories before
launching. It never runs the signed updater build; use the explicit release
command only in a signing environment.

The harness also records `native-config.json` from Tauri's app-data directory.
That evidence contains only the selected model IDs, overlay dimensions (plus the
OBS Browser Source `enabled`/`port` pair), and audio/VAD fields (`chunkMs`,
`silenceGateDb`, `vadIntervalMs`, `vadThreshold`, `noiseSuppression`,
`adaptiveNoiseFloor`, and `sampleRate`); user dictionary paths are deliberately
omitted. Values are range-checked and can be asserted without editing a user's
configuration:

```bash
TAURI_SMOKE_EXPECT_CHUNK_MS=640 \
TAURI_SMOKE_EXPECT_SILENCE_GATE_DB=-50 \
TAURI_SMOKE_EXPECT_ADAPTIVE_NOISE_FLOOR=true \
TAURI_SMOKE_EXPECT_VAD_INTERVAL_MS=32 \
TAURI_SMOKE_EXPECT_VAD_THRESHOLD=0.5 \
node scripts/tauri-smoke.mjs --no-launch
```

On an Apple Silicon host the harness additionally probes the caption-only
loopback fallback: the configured port is range-checked and the live app must
answer `http://127.0.0.1:{port}/health` with `ok` and
`http://127.0.0.1:{port}/captions.json` with a feed carrying an `overlay`
object. A persisted `browserSource.enabled: false` is an intentional opt-out
and is reported as skipped rather than as a runtime failure. The probe runs
twice when `--ui` saves settings: once with the persisted config and once after
the save.

Set `TAURI_SMOKE_CONFIG_PATH` when a test account uses a non-default Tauri
app-data directory. A malformed multipart/JSON audio request is sent before the
valid silent WAV; the report requires a 4xx rejection followed by a successful
200 response, proving the gateway recovers rather than wedging its serial ASR
gate. `bundled-sidecars.json` and `native-request-log.txt` preserve the native
process/log evidence.

The native request is intentionally silence. A healthy response is HTTP 200 with
`{"text":""}` (the gateway's no-speech soft path), followed by a
`session start`/`session completed` entry in
`~/Library/Logs/com.kotobabeacon.desktop/kotoba-beacon.log`. The harness never
uses a broad `pkill`: when it launched the app, cleanup is scoped to the exact
foreground PID and the sidecar PIDs observed beneath that executable.

## Optional UI smoke

Add `--ui` to attempt Settings, Debug, Live, Overlay, and (with
`--exercise-capture`) Stop/Start/Stop through the macOS Accessibility tree:

```bash
node scripts/tauri-smoke.mjs --ui --exercise-capture
```

This requires Accessibility permission for the terminal/runner that invokes
`osascript` (System Settings → Privacy & Security → Accessibility). If TCC
returns `osascriptには補助アクセスは許可されません` / error `-25211`, the
harness records the denial, saves the initial screenshot, and does **not** claim
that the controls or overlay were pressed. This is expected on locked-down CI or
automation sessions; rerun after granting permission for a real UI click smoke.

When Accessibility is available, the harness dumps the AX names after Settings
and Debug navigation (`ui-settings-ax.txt` and `ui-debug-ax.txt`) and checks for
AzooKey, the caption-chunk/silence-gate fields, and ASR/Debug labels. Failed AX
presses are kept independent so one inaccessible WebKit node does not hide the
other attempted actions. It also presses the real Settings Save control before
re-reading `native-config.json`; when that control is reachable, the report can
prove the values persisted through the app rather than merely reading a stale
file. A blocked/TCC action is marked `status: "blocked"` in `report.json`; it
is never counted as a successful click.

Each run writes `report.json`, `smoke.log`, process snapshots, a log tail, and
window PNGs to `/tmp/kotoba-tauri-smoke-*` (or `TAURI_SMOKE_OUT_DIR`). A report
with the UI permission denial is still useful evidence for the native layer;
the exit status is non-zero because the requested UI actions were not verified.

## Browser visual and recovery evidence

For DOM-level screenshots (including AzooKey fields, Debug rows, and VAD/chunk
settings), run the browser-only server and capture harness:

```bash
bun run dev:web
bun run verify:ui
```

This intentionally does not claim Tauri, microphone, or overlay compositor
coverage. `--exercise-recovery` injects a deterministic browser
`NotAllowedError`, captures the resulting notice, and verifies that Start stays
enabled for a retry. Those entries are marked `synthetic: true` in
`capture-meta.json`; native TCC/microphone results come only from the Tauri
smoke. Visual debug rows are also explicitly marked synthetic because the
browser route has no native pipeline events.

## 2026-08-01 arm64 evidence

On macOS 26.5.1 arm64, the generated release bundle and debug binary both
passed the native smoke:

- main Tauri window was visible (release 1180×820; debug 1170×812 after native
  window placement);
- gateway `/health` and llama `/health` returned 200;
- Parapper was listening on loopback and had no visible application window;
- silent WAV POST returned `200 {"text":"","language":"ja"}` and emitted
  session evidence;
- scoped cleanup stopped the app and all three sidecars with ports 8765, 18082,
  and 8083 closed.

The UI attempt on this machine was blocked by macOS TCC (`-25211`), so Start /
Stop, Settings, DebugPanel, and Overlay were not represented as successful UI
actions. Screenshots and the exact error are retained in the run report.

Latest local reports: native
`/tmp/kotoba-tauri-smoke-release-report-final/report.json`; UI/TCC
`/tmp/kotoba-tauri-smoke-ui-final/report.json`.
