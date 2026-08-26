.DEFAULT_GOAL := help

PARAPPER_MANIFEST := packages/parapper-asr/Cargo.toml
NATIVE_MANIFEST := apps/native/Cargo.toml
NATIVE_BINARY := apps/native/target/release/kotoba-beacon-native

.PHONY: help build native-release native-package native-install native-replace parapper-fetch parapper-check

help:
	@printf '%s\n' \
		'Kotoba Beacon development targets:' \
		'  make build           Build and package the macOS Native app without touching the running app' \
		'  make native-release  Build the locked optimized Native executable only' \
		'  make native-package  Build and package the app without installing or launching it' \
		'  make native-install  Explicitly replace the installed app; refuses while it is running' \
		'  make native-replace  Alias for native-install' \
		'  make parapper-fetch  Fetch locked Parapper Rust dependencies once' \
		'  make parapper-check  Check Parapper with locked, offline dependencies'

# Normal builds must never stop, launch, activate, or replace the installed app.
build: native-package

native-release:
	cargo build --locked --release --manifest-path $(NATIVE_MANIFEST)

native-package: native-release
	bun run package:native

native-install: native-package
	@if pgrep -x kotoba-beacon-native >/dev/null 2>&1; then \
		echo 'Kotoba Beacon Native is running; quit it before make native-install.' >&2; \
		exit 1; \
	fi
	node --input-type=module -e 'import { assembleNativeApp } from "./scripts/install-macos-native-app.mjs"; const result = assembleNativeApp({ sourceBinary: "$(NATIVE_BINARY)" }); console.log("Replaced " + result.installApp + " without launching it");'
	codesign --verify --deep --strict "$$HOME/Applications/Kotoba Beacon Native.app"

native-replace: native-install

# Run once after Cargo.lock changes or on a machine without the locked dependencies.
parapper-fetch:
	cargo fetch --locked --manifest-path $(PARAPPER_MANIFEST)

# Offline mode avoids Cargo package-cache/network stalls during repeat validation.
parapper-check:
	cargo check --locked --offline --manifest-path $(PARAPPER_MANIFEST) -p parapper
