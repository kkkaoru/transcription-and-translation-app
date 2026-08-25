.DEFAULT_GOAL := help

PARAPPER_MANIFEST := packages/parapper-asr/Cargo.toml
NATIVE_MANIFEST := apps/native/Cargo.toml
NATIVE_BINARY := apps/native/target/release/kotoba-beacon-native

.PHONY: help build native-release native-replace parapper-fetch parapper-check

help:
	@printf '%s\n' \
		'Kotoba Beacon development targets:' \
		'  make build           Build, package, and replace the installed macOS Native app' \
		'  make native-release  Build the locked optimized Native executable only' \
		'  make native-replace  Package and replace the installed app without launching it' \
		'  make parapper-fetch  Fetch locked Parapper Rust dependencies once' \
		'  make parapper-check  Check Parapper with locked, offline dependencies'

# The default developer build must leave Finder pointing at the new executable,
# rather than a previously installed bundle. It never launches the application.
build: native-replace

native-release:
	cargo build --locked --release --manifest-path $(NATIVE_MANIFEST)

native-replace: native-release
	@if pgrep -x kotoba-beacon-native >/dev/null 2>&1; then \
		echo 'Stopping the running Kotoba Beacon Native before replacement'; \
		pkill -TERM -x kotoba-beacon-native; \
		attempts=0; \
		while pgrep -x kotoba-beacon-native >/dev/null 2>&1 && [ $$attempts -lt 50 ]; do \
			sleep 0.1; \
			attempts=$$((attempts + 1)); \
		done; \
		if pgrep -x kotoba-beacon-native >/dev/null 2>&1; then \
			echo 'Kotoba Beacon Native did not stop; refusing to leave a stale running build.' >&2; \
			exit 1; \
		fi; \
	fi
	bun run package:native
	node --input-type=module -e 'import { assembleNativeApp } from "./scripts/install-macos-native-app.mjs"; const result = assembleNativeApp({ sourceBinary: "$(NATIVE_BINARY)" }); console.log("Replaced " + result.installApp + " without launching it");'
	codesign --verify --deep --strict "$$HOME/Applications/Kotoba Beacon Native.app"

# Run once after Cargo.lock changes or on a machine without the locked dependencies.
parapper-fetch:
	cargo fetch --locked --manifest-path $(PARAPPER_MANIFEST)

# Offline mode avoids Cargo package-cache/network stalls during repeat validation.
parapper-check:
	cargo check --locked --offline --manifest-path $(PARAPPER_MANIFEST) -p parapper
