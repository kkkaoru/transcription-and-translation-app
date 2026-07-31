#!/usr/bin/env bash
# Runtime verification for in-app model download (individual + batch + cancel).
# Uses the public ~21 MiB zenz-v3.2-xsmall-gguf artifact from Hugging Face.
# Batch path seeds the large translator as size-ready so only xsmall is fetched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/desktop/src-tauri"

echo "== unit (offline) =="
cargo test --lib model_download -- --nocapture

echo "== individual download (~21 MiB) =="
cargo test --lib model_download::tests::downloads_xsmall_with_progress_callback -- --ignored --nocapture

echo "== batch quick-start (missing xsmall + ready hy) =="
cargo test --lib model_download::tests::batch_quick_start_downloads_missing_xsmall_and_skips_ready_hy -- --ignored --nocapture

echo "== cancel mid-download =="
cargo test --lib model_download::tests::cancel_aborts_in_flight_xsmall_download -- --ignored --nocapture

echo "== ensure_downloaded layout path =="
cargo test --lib model_runtime::tests::downloads_the_pinned_xsmall_model_into_app_data_layout -- --ignored --nocapture

echo "All model-download runtime checks passed."
