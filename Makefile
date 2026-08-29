.DEFAULT_GOAL := help

PARAPPER_MANIFEST := packages/parapper-asr/Cargo.toml
NATIVE_MANIFEST := apps/native/Cargo.toml
NATIVE_BINARY := apps/native/target/release/kotoba-beacon-native
MOBILE_DIR := apps/mobile

.PHONY: help build native-release native-package native-install native-replace \
	parapper-fetch parapper-check mobile-help mobile-setup mobile-generate \
	mobile-check mobile-test mobile-coverage mobile-build mobile-build-android \
	mobile-build-ios mobile-clean

help:
	@printf '%s\n' \
		'Kotoba Beacon development targets:' \
		'  make build           Build, stop the running app, and replace it without relaunching' \
		'  make native-release  Build the locked optimized Native executable only' \
		'  make native-package  Build and package the app without installing or launching it' \
		'  make native-install  Stop the running app and replace it without relaunching' \
		'  make native-replace  Alias for native-install' \
		'  make parapper-fetch      Fetch locked Parapper Rust dependencies once' \
		'  make parapper-check      Check Parapper with locked, offline dependencies' \
		'  make mobile-help         List every Flutter companion target' \
		'  make mobile-setup        Resolve Flutter and locked Mobile Rust dependencies' \
		'  make mobile-generate     Regenerate Flutter Rust Bridge bindings' \
		'  make mobile-check        Run all Mobile Rust and Flutter quality gates' \
		'  make mobile-test         Run all Flutter tests' \
		'  make mobile-coverage     Run Flutter coverage and enforce the 95% floor' \
		'  make mobile-build        Build Android ARM64 and iOS Simulator artifacts' \
		'  make mobile-build-android Build only the Android ARM64 release APK' \
		'  make mobile-build-ios    Build only the iOS Simulator app' \
		'  make mobile-clean        Remove generated Mobile build and coverage caches'

# Normal builds terminate the installed app before replacement, but never relaunch or activate it.
build: native-install

native-release:
	cargo build --locked --release --manifest-path $(NATIVE_MANIFEST)

native-package: native-release
	bun run package:native

native-install: native-package
	node --input-type=module -e 'import { assembleNativeApp } from "./scripts/install-macos-native-app.mjs"; const result = assembleNativeApp({ sourceBinary: "$(NATIVE_BINARY)" }); console.log("Stopped any running Native app and replaced " + result.installApp + " without relaunching it");'
	codesign --verify --deep --strict "$$HOME/Applications/Kotoba Beacon Native.app"

native-replace: native-install

# Run once after Cargo.lock changes or on a machine without the locked dependencies.
parapper-fetch:
	cargo fetch --locked --manifest-path $(PARAPPER_MANIFEST)

# Offline mode avoids Cargo package-cache/network stalls during repeat validation.
parapper-check:
	cargo check --locked --offline --manifest-path $(PARAPPER_MANIFEST) -p parapper

mobile-help:
	$(MAKE) -C $(MOBILE_DIR) help

mobile-setup:
	$(MAKE) -C $(MOBILE_DIR) setup

mobile-generate:
	$(MAKE) -C $(MOBILE_DIR) generate

mobile-check:
	$(MAKE) -C $(MOBILE_DIR) verify

mobile-test:
	$(MAKE) -C $(MOBILE_DIR) test

mobile-coverage:
	$(MAKE) -C $(MOBILE_DIR) coverage

mobile-build:
	$(MAKE) -C $(MOBILE_DIR) build

mobile-build-android:
	$(MAKE) -C $(MOBILE_DIR) android

mobile-build-ios:
	$(MAKE) -C $(MOBILE_DIR) ios

mobile-clean:
	$(MAKE) -C $(MOBILE_DIR) clean
