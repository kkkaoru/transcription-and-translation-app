.DEFAULT_GOAL := help

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

FLUTTER ?= flutter
DART ?= dart
CARGO ?= cargo
NODE ?= node
FRB_CODEGEN ?= flutter_rust_bridge_codegen
RUST_MANIFEST := rust/Cargo.toml
COVERAGE_CHECK := ../../scripts/verify-mobile-coverage.mjs
DART_SOURCES := lib test integration_test
ANDROID_TARGET := android-arm64
IOS_DEVICE ?=
IOS_DEVICE_RUSTFLAGS := -C target-feature=+fp16
IOS_BUNDLE_ID := com.kotobabeacon.companion
IOS_DEVICE_APP := build/ios/iphoneos/Runner.app

.PHONY: help doctor setup generate format format-check analyze lint \
	rust-format rust-lint rust-test rust-build rust-verify test coverage \
	verify android ios ios-device install-ios-device run-ios-device \
	build-android build-ios build-ios-simulator build-ios-device build clean

help:
	@printf '%s\n' \
		'Kotoba Beacon Flutter companion targets:' \
		'  make doctor              Validate Flutter, Android, Xcode, and connected tooling' \
		'  make setup               Resolve Flutter and locked Rust dependencies' \
		'  make generate            Regenerate Flutter Rust Bridge bindings' \
		'  make format              Format hand-written and generated Dart sources' \
		'  make format-check        Check Dart formatting without changing files' \
		'  make analyze             Run Flutter analyzer with warnings treated as errors' \
		'  make lint                Run strict Dart code metrics' \
		'  make rust-verify         Run Rust format, Clippy, tests, and host dylib build' \
		'  make test                Build the host Rust dylib and run all Flutter tests' \
		'  make coverage            Run Flutter tests and enforce per-file 95% coverage' \
		'  make verify              Run every non-packaging Rust and Flutter quality gate' \
		'  make android             Build the supported ARM64 release APK' \
		'  make ios                 Build the unsigned debug iOS Simulator app' \
		'  make ios-device IOS_DEVICE=<udid> Build the signed release app for a physical iPhone' \
		'  make install-ios-device IOS_DEVICE=<udid> Build and install the release app' \
		'  make run-ios-device IOS_DEVICE=<udid> Build, install, and launch the release app' \
		'  make build-android       Explicit alias for make android' \
		'  make build-ios           Explicit alias for make ios' \
		'  make build-ios-device    Explicit alias for make ios-device' \
		'  make build               Build Android ARM64 and iOS Simulator artifacts' \
		'  make clean               Remove Flutter build, coverage, and generated caches'

doctor:
	@command -v $(FLUTTER)
	@command -v $(DART)
	@command -v $(FRB_CODEGEN)
	$(FLUTTER) doctor -v

setup:
	$(FLUTTER) pub get
	$(CARGO) fetch --locked --manifest-path $(RUST_MANIFEST)

generate:
	$(FRB_CODEGEN) generate

format:
	$(DART) format $(DART_SOURCES)

format-check:
	$(DART) format --output=none --set-exit-if-changed $(DART_SOURCES)

analyze:
	$(FLUTTER) analyze --fatal-infos --fatal-warnings

lint:
	$(DART) run dart_code_linter:metrics analyze $(DART_SOURCES) \
		--exclude='lib/src/rust/**' \
		--maximum-nesting-level=3 \
		--set-exit-on-violation-level=warning \
		--fatal-style \
		--fatal-performance

rust-format:
	$(CARGO) fmt --manifest-path $(RUST_MANIFEST) --all -- --check

rust-lint:
	$(CARGO) clippy --locked --manifest-path $(RUST_MANIFEST) --all-targets -- -D warnings

rust-test:
	$(CARGO) test --locked --manifest-path $(RUST_MANIFEST)

rust-build:
	$(CARGO) build --locked --manifest-path $(RUST_MANIFEST)

rust-verify:
	$(MAKE) rust-format
	$(MAKE) rust-lint
	$(MAKE) rust-test
	$(MAKE) rust-build

test: rust-build
	$(FLUTTER) test

coverage: rust-build
	$(FLUTTER) test --coverage
	$(NODE) $(COVERAGE_CHECK)

verify:
	$(MAKE) format-check
	$(MAKE) analyze
	$(MAKE) lint
	$(MAKE) rust-verify
	$(MAKE) coverage

android:
	$(FLUTTER) build apk --release --target-platform $(ANDROID_TARGET)

build-android: android

ios:
	$(FLUTTER) build ios --simulator --debug --no-codesign

ios-device:
	@test -n "$(IOS_DEVICE)" || { echo 'IOS_DEVICE is required; run flutter devices to find the physical iPhone UDID' >&2; exit 2; }
	CARGO_TARGET_AARCH64_APPLE_IOS_RUSTFLAGS="$(IOS_DEVICE_RUSTFLAGS)" \
		$(FLUTTER) build ios --release --device-id "$(IOS_DEVICE)"
	codesign --verify --deep --strict "$(IOS_DEVICE_APP)"

install-ios-device: ios-device
	xcrun devicectl device install app --device "$(IOS_DEVICE)" "$(IOS_DEVICE_APP)"

run-ios-device: install-ios-device
	xcrun devicectl device process launch --terminate-existing --device "$(IOS_DEVICE)" "$(IOS_BUNDLE_ID)"

build-ios: ios

build-ios-simulator: ios

build-ios-device: ios-device

build:
	$(MAKE) android
	$(MAKE) ios

clean:
	$(FLUTTER) clean
	rm -rf coverage .dart_tool/build .dart_tool/flutter_build \
		.dart_tool/hooks_runner .dart_tool/pub
