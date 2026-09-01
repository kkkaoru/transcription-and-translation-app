.DEFAULT_GOAL := help

PARAPPER_MANIFEST := packages/parapper-asr/Cargo.toml
NATIVE_MANIFEST := apps/native/Cargo.toml
NATIVE_BINARY := apps/native/target/release/kotoba-beacon-native
MOBILE_DIR := apps/mobile
RUST_COVERAGE_RUNNER := node scripts/run-rust-coverage.mjs
RUST_COVERAGE_ARGS ?=

.PHONY: help build native-release native-package native-install native-replace \
	parapper-fetch parapper-check setup-git-hooks rust-native-coverage \
	rust-parapper-engine-coverage clean-build-artifacts mobile-help mobile-setup \
	mobile-generate mobile-check \
	mobile-test mobile-coverage mobile-build mobile-build-android mobile-build-ios \
	mobile-build-ios-device mobile-install-ios-device mobile-run-ios-device \
	mobile-install-ios-simulator mobile-run-ios-simulator mobile-test-ios-simulator mobile-clean

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
		'  make setup-git-hooks     Enable the tracked pre-push coverage gate' \
		'  make rust-native-coverage Run serialized Native Rust coverage with automatic disk cleanup' \
		'  make rust-parapper-engine-coverage Run serialized engine coverage with automatic disk cleanup' \
		'  make clean-build-artifacts Remove rebuildable Rust, Flutter, and coverage artifacts' \
		'  make mobile-help         List every Flutter companion target' \
		'  make mobile-setup        Resolve Flutter and locked Mobile Rust dependencies' \
		'  make mobile-generate     Regenerate Flutter Rust Bridge bindings' \
		'  make mobile-check        Run all Mobile Rust and Flutter quality gates' \
		'  make mobile-test         Run all Flutter tests' \
		'  make mobile-coverage     Run Flutter coverage and enforce the 95% floor' \
		'  make mobile-build        Build Android ARM64 and iOS Simulator artifacts' \
		'  make mobile-build-android Build only the Android ARM64 release APK' \
		'  make mobile-build-ios    Build only the iOS Simulator app' \
		'  make mobile-build-ios-device IOS_DEVICE=<udid> Build the physical-iPhone release app' \
		'  make mobile-install-ios-device IOS_DEVICE=<udid> Install the release app' \
		'  make mobile-run-ios-device IOS_DEVICE=<udid> Install and launch the release app' \
		'  make mobile-run-ios-simulator IOS_SIMULATOR=<udid> Build and launch the Simulator app' \
		'  make mobile-test-ios-simulator IOS_SIMULATOR=<udid> Verify the Mobile HTML host on Simulator' \
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

setup-git-hooks:
	git config --local core.hooksPath .githooks
	@test "$$(git config --get core.hooksPath)" = .githooks

# Rust coverage is intentionally routed through one disk-bounded runner. The
# runner serializes agents, removes stale/rebuildable caches before compiling,
# requires 12 GiB free, and deletes the instrumented target on every exit.
rust-native-coverage:
	$(RUST_COVERAGE_RUNNER) $(NATIVE_MANIFEST) \
		--changed-lines=95 \
		--changed-path=apps/native/src/capture.rs \
		--changed-path=apps/native/src/pipeline_diagnostics.rs \
		$(RUST_COVERAGE_ARGS)

rust-parapper-engine-coverage:
	$(RUST_COVERAGE_RUNNER) crates/parapper-engine/Cargo.toml \
		--changed-lines=95 \
		--changed-path=crates/parapper-engine/src \
		$(RUST_COVERAGE_ARGS)

clean-build-artifacts:
	node scripts/clean-build-artifacts.mjs --prune-rust

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

mobile-build-ios-device:
	$(MAKE) -C $(MOBILE_DIR) ios-device

mobile-install-ios-device:
	$(MAKE) -C $(MOBILE_DIR) install-ios-device

mobile-run-ios-device:
	$(MAKE) -C $(MOBILE_DIR) run-ios-device

mobile-install-ios-simulator:
	$(MAKE) -C $(MOBILE_DIR) install-ios-simulator

mobile-run-ios-simulator:
	$(MAKE) -C $(MOBILE_DIR) run-ios-simulator

mobile-test-ios-simulator:
	$(MAKE) -C $(MOBILE_DIR) test-ios-simulator

mobile-clean:
	$(MAKE) -C $(MOBILE_DIR) clean
