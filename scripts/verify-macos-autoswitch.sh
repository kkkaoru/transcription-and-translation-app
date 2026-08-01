#!/bin/bash
set -euo pipefail

# Read-only by default. --launch opts into opening only the requested bundle,
# checking its LaunchServices identity/Dock policy, then asking that bundle to
# quit through AppleScript. This script never terminates arbitrary processes.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH=""
DO_LAUNCH=0
TIMEOUT_SECONDS=20

usage() {
  cat <<'EOF'
Usage: scripts/verify-macos-autoswitch.sh [options]

  --app PATH       Built .app to inspect (defaults to target bundle)
  --launch         Run open/osascript lifecycle check (opt-in)
  --timeout SEC    Poll timeout for --launch (default: 20)
  --help           Show this help

The script never sends process signals. AppleScript is scoped to the bundle
identifier read from the inspected Info.plist.
EOF
}

while (($# > 0)); do
  case "$1" in
    --app)
      [[ $# -ge 2 ]] || { echo "--app requires a path" >&2; exit 2; }
      APP_PATH="$2"
      shift 2
      ;;
    --launch)
      DO_LAUNCH=1
      shift
      ;;
    --timeout)
      [[ $# -ge 2 ]] || { echo "--timeout requires seconds" >&2; exit 2; }
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "SKIP: macOS auto-switch verification requires Darwin (host=$(uname -s))."
  exit 0
fi

for command_name in open osascript plutil; do
  command -v "$command_name" >/dev/null || {
    echo "FAIL: required macOS command is unavailable: $command_name" >&2
    exit 1
  }
done

if [[ -z "$APP_PATH" ]]; then
  # Scope discovery to Tauri's generated output, never a user's Applications
  # directory.
  APP_PATH="$(find "$ROOT_DIR/apps/desktop/src-tauri/target" -type d -name '*.app' -path '*/bundle/macos/*.app' -print 2>/dev/null | sort | tail -n 1 || true)"
fi

[[ -n "$APP_PATH" ]] || { echo "FAIL: no .app found; pass --app PATH" >&2; exit 1; }
[[ -d "$APP_PATH" ]] || { echo "FAIL: app bundle does not exist: $APP_PATH" >&2; exit 1; }
[[ "$APP_PATH" == *.app ]] || { echo "FAIL: --app must point to a .app bundle: $APP_PATH" >&2; exit 1; }

INFO_PLIST="$APP_PATH/Contents/Info.plist"
[[ -f "$INFO_PLIST" ]] || { echo "FAIL: missing $INFO_PLIST" >&2; exit 1; }
BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$INFO_PLIST")"
BUNDLE_EXECUTABLE="$(plutil -extract CFBundleExecutable raw -o - "$INFO_PLIST")"
BUNDLE_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$INFO_PLIST" 2>/dev/null || plutil -extract CFBundleVersion raw -o - "$INFO_PLIST")"
EXECUTABLE="$APP_PATH/Contents/MacOS/$BUNDLE_EXECUTABLE"

[[ "$BUNDLE_ID" == com.kotobabeacon.* ]] || {
  echo "FAIL: unexpected bundle identifier: $BUNDLE_ID" >&2
  exit 1
}
[[ -x "$EXECUTABLE" ]] || { echo "FAIL: missing executable: $EXECUTABLE" >&2; exit 1; }

echo "PASS: bundle=$APP_PATH"
echo "PASS: bundle identifier=$BUNDLE_ID version=$BUNDLE_VERSION executable=$BUNDLE_EXECUTABLE"

# Read the identifier through printenv instead of interpolating plist content
# into AppleScript source.
process_count() {
  KOTOBA_VERIFY_BUNDLE_ID="$BUNDLE_ID" osascript <<'OSA'
set targetId to do shell script "/usr/bin/printenv KOTOBA_VERIFY_BUNDLE_ID"
tell application "System Events"
  return (count of (every application process whose bundle identifier is targetId)) as text
end tell
OSA
}

background_only() {
  KOTOBA_VERIFY_BUNDLE_ID="$BUNDLE_ID" osascript <<'OSA'
set targetId to do shell script "/usr/bin/printenv KOTOBA_VERIFY_BUNDLE_ID"
tell application "System Events"
  set matches to every application process whose bundle identifier is targetId
  if (count of matches) is 0 then return "none"
  set values to {}
  repeat with appProcess in matches
    set end of values to ((background only of appProcess) as text)
  end repeat
  return values as text
end tell
OSA
}

if [[ "$DO_LAUNCH" == 0 ]]; then
  count="$(process_count | tr -d '[:space:]')"
  echo "INFO: matching process count before launch=$count"
  if [[ "$count" != "0" ]]; then
    echo "INFO: background-only flags=$(background_only)"
  fi
  echo "PASS: read-only bundle inspection complete (use --launch for open/quit flow)."
  exit 0
fi

echo "INFO: launching only the requested bundle with open -n"
open -n "$APP_PATH" --args --kotoba-verify-launch

deadline=$((SECONDS + TIMEOUT_SECONDS))
count="0"
while ((SECONDS < deadline)); do
  count="$(process_count | tr -d '[:space:]' || true)"
  [[ "$count" == "1" ]] && break
  sleep 0.25
done

if [[ "$count" != "1" ]]; then
  echo "FAIL: expected one process for $BUNDLE_ID after launch, found $count" >&2
  exit 1
fi

flags="$(background_only)"
if [[ "$flags" != *"false"* ]]; then
  echo "FAIL: matching app process is background-only ($flags); Dock icon would be hidden" >&2
  exit 1
fi
echo "PASS: exactly one LaunchServices process and regular Dock activation ($flags)"

# Ask only this bundle to quit. Tauri's normal exit path then stops sidecars;
# this is intentionally not signal-based process termination.  LaunchServices
# can deliver the first quit event while the freshly-opened WebView is still
# activating, so retry the same scoped request until the process disappears.
request_quit() {
  KOTOBA_VERIFY_BUNDLE_ID="$BUNDLE_ID" osascript <<'OSA' >/dev/null 2>&1 || true
set targetId to do shell script "/usr/bin/printenv KOTOBA_VERIFY_BUNDLE_ID"
tell application id targetId to quit
OSA
}

request_quit

deadline=$((SECONDS + TIMEOUT_SECONDS))
while ((SECONDS < deadline)); do
  count="$(process_count | tr -d '[:space:]' || true)"
  [[ "$count" == "0" ]] && break
  request_quit
  sleep 0.25
done

if [[ "$count" != "0" ]]; then
  echo "FAIL: bundle process did not exit after scoped AppleScript quit (count=$count)" >&2
  exit 1
fi
echo "PASS: old process exited cleanly; no duplicate bundle process remains"
