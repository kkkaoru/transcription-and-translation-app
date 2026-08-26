.DEFAULT_GOAL := help

PARAPPER_MANIFEST := packages/parapper-asr/Cargo.toml
NATIVE_MANIFEST := apps/native/Cargo.toml
NATIVE_BINARY := apps/native/target/release/kotoba-beacon-native

.PHONY: help build native-release native-package native-install native-replace parapper-fetch parapper-check

help:
	@printf '%s\n' \
		'Kotoba Beacon development targets:' \
		'  make build           Build, package, and replace the installed app without launching it' \
		'  make native-release  Build the locked optimized Native executable only' \
		'  make native-package  Build and package the app without installing or launching it' \
		'  make native-install  Replace the installed app without stopping or launching it' \
		'  make native-replace  Alias for native-install' \
		'  make parapper-fetch  Fetch locked Parapper Rust dependencies once' \
		'  make parapper-check  Check Parapper with locked, offline dependencies'

# Normal builds replace the installed bundle but never stop, launch, or activate the app.
build: native-install

native-release:
	cargo build --locked --release --manifest-path $(NATIVE_MANIFEST)

native-package: native-release
	bun run package:native

native-install: native-package
	node --input-type=module -e 'import { assembleNativeApp } from "./scripts/install-macos-native-app.mjs"; const result = assembleNativeApp({ sourceBinary: "$(NATIVE_BINARY)" }); console.log("Replaced " + result.installApp + " without launching it");'
	codesign --verify --deep --strict "$$HOME/Applications/Kotoba Beacon Native.app"

native-replace: native-install

# Run once after Cargo.lock changes or on a machine without the locked dependencies.
parapper-fetch:
	cargo fetch --locked --manifest-path $(PARAPPER_MANIFEST)

# Offline mode avoids Cargo package-cache/network stalls during repeat validation.
parapper-check:
	cargo check --locked --offline --manifest-path $(PARAPPER_MANIFEST) -p parapper
