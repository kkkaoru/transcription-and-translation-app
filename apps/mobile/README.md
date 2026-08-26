# Kotoba Beacon Companion

Flutter companion for Kotoba Beacon Native on the same local network.

## Processing routes

ASR, AzooKey, and translation each select `Desktop` or `Mobile`, yielding eight routes. The default is `mmm` (all processing on the phone). Rust owns the route/protocol types and AzooKey conversion; Flutter Rust Bridge generates the Dart declarations under `lib/src/rust/`.

Route controls stay disabled until the LAN WebSocket is open and Android/iOS reports the actual ASR and translation API availability. Unsupported Mobile choices are disabled and constrained to Desktop. Native stores the accepted route by the platform's stable device ID and restores it when that phone reconnects. Every Mobile route change remains pending until Native returns `route.configure`; that acknowledgement is the authoritative synchronized setting. Native-originated changes use the same message, so either app can change the route without leaving the two UIs in different states.

Both apps show the authenticated connection state and synchronized three-letter route. Mobile also shows the Desktop endpoint and detected Mobile API availability. Native shows the connected device, platform, session, endpoint, capabilities, and saved per-device route count.

Native advertises `_kotobabeacon._tcp` with Bonjour and also provides a bounded UDP discovery fallback on port `18184`. iOS/iPadOS use the platform `NetServiceBrowser`, avoiding multicast/broadcast entitlements; other platforms use a nonce-scoped UDP request and unicast response. Discovery returns the current endpoint and high-entropy pairing token, then the app performs the normal authenticated WebSocket first frame on port `18183`. Manual endpoint/token fields remain available as a fallback. Discovery is restricted to the trusted LAN and never accepts PCM or route configuration.

- Android ASR: ML Kit GenAI Speech Recognition Basic mode (`ja-JP`, API 31+), fed with raw PCM16/16 kHz/mono through a `ParcelFileDescriptor` pipe.
- Android translation: ML Kit on-device Japanese-to-English Translation.
- iOS ASR: SpeechAnalyzer/SpeechTranscriber (iOS 26+) with volatile and final results.
- iOS translation: TranslationSession using installed Japanese and English models.
- AzooKey: `caption-bridge-azookey-rust` with the canonical portable dictionary asset.

The desktop microphone remains the audio source. The phone publishes ASR, AzooKey, and translation results independently as soon as each stage completes. Session, turn, and revision identifiers prevent late output from replacing a newer caption.

## Pairing

1. Start Native and the mobile companion on the same trusted LAN.
2. Mobile automatically discovers and authenticates to Native.
3. If discovery is unavailable, open Native Settings, copy the LAN endpoint and generated pairing token, enter both in the companion, and connect before starting capture.

The endpoint binds only for the companion feature. Authentication is required before route configuration or PCM is accepted. The token is not logged. Audio and result queues are bounded. iOS/iPadOS use Flutter Cupertino widgets; Android uses Material 3 widgets.

## Generate Rust bindings

```sh
flutter_rust_bridge_codegen generate
```

Generated Dart definitions must not be edited manually.

## Verify

```sh
cargo fmt --manifest-path rust/Cargo.toml -- --check
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml
cargo build --manifest-path rust/Cargo.toml
dart format --output=none --set-exit-if-changed lib test integration_test
flutter analyze --fatal-infos --fatal-warnings
dart run dart_code_linter:metrics analyze lib test integration_test \
  --exclude='lib/src/rust/**' \
  --maximum-nesting-level=3 \
  --set-exit-on-violation-level=warning \
  --fatal-style \
  --fatal-performance
flutter test --coverage
node ../../scripts/verify-mobile-coverage.mjs
flutter build apk --release
flutter build ios --simulator --debug --no-codesign
```

Host Flutter tests load `rust/target/debug/librust_lib_kotoba_beacon_companion.dylib`, so run the Cargo build first. Every hand-written Dart source uses strict casts, strict inference, strict raw types, Very Good Analysis, an 80-column formatter, and a maximum control-flow nesting depth of three. Generated Flutter Rust Bridge sources retain their generator-owned analyzer contract. CI enforces at least 95% line coverage for every hand-written file under `lib/`. The suite includes protocol validation, all route handoff boundaries, stale-revision rejection, bounded PCM buffering, mocked platform-channel contracts, and a real loopback WebSocket pipeline through ASR, AzooKey, and translation. CI additionally builds an iOS 26 simulator app on the pinned macOS 26/Xcode 26.6 runner without launching it.

Android provider validation requires an API 31+ device with the ML Kit speech feature available. Advanced mode is intentionally not selected because its current device coverage is narrower. iOS simulator builds require an accepted Xcode license and installed iOS 26 simulator runtime. Provider/model behavior should still be validated on supported physical hardware.
