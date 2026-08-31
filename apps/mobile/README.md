# Kotoba Beacon Companion

Flutter companion for Kotoba Beacon Native on the same local network.

## Processing routes

ASR, AzooKey, and translation each select `Desktop` or `Mobile`, yielding eight synchronized execution routes. The Mobile UI additionally selects the concrete implementation within each Mobile stage. The preferred default is `mmm`. Standard display mode switches each stage between Desktop Native and Mobile Rust, and Mobile Rust AzooKey uses the Small dictionary. Detailed display mode keeps the current per-provider list, including SpeechAnalyzer, SFSpeechRecognizer, ML Kit, AzooKey XSmall, and TranslationSession. Visual tokens for color, type, weight, and spacing live in `lib/src/companion_style.dart`. Capability detection runs before pairing, visibly disables only unavailable implementations, and constrains only an unavailable Mobile stage to Desktop. Available providers remain selectable before connection and during recognition; changes made during an active recognition session are retained and applied safely after that session stops. Rust owns the route/protocol types, Desktop-equivalent Mobile ASR, AzooKey, and QuickMT; Flutter Rust Bridge generates the Dart declarations under `lib/src/rust/`.

Route controls stay disabled until the LAN WebSocket is open and Android/iOS reports the actual ASR and translation API availability. Unsupported Mobile choices are disabled and constrained to Desktop. Native stores the accepted route by the platform's stable device ID and restores it when that phone reconnects. Every Mobile route change remains pending until Native returns `route.configure`; that acknowledgement is the authoritative synchronized setting. Native-originated changes use the same message, so either app can change the route without leaving the two UIs in different states.

Both apps show the authenticated connection state and synchronized three-letter route. Mobile also shows the Desktop endpoint and detected Mobile API availability. Native shows the connected device, platform, session, endpoint, capabilities, and saved per-device route count.

Native advertises `_kotobabeacon._tcp` with Bonjour and also provides a bounded UDP discovery fallback on port `18184`. iOS/iPadOS use the platform `NetServiceBrowser`, avoiding multicast/broadcast entitlements; other platforms use a nonce-scoped UDP request and unicast response. Discovery returns the current endpoint and high-entropy pairing token, then the app performs the normal authenticated WebSocket first frame on port `18183`. When Mobile companion is enabled, Native shows a camera-readable `kotobabeacon://pair` QR code under the toggle, with copy actions side by side below the QR and the current connection status in that section. Scanning the QR with the device camera opens the installed companion app and completes pairing. Unpaired Mobile screens show Connect and Open Camera; both hide after authentication. Manual endpoint/token fields remain available in detailed display mode. Discovery is restricted to the trusted LAN and never accepts PCM or route configuration.

- Android ASR: ML Kit GenAI Speech Recognition Basic mode (`ja-JP`, API 31+), fed with raw PCM16/16 kHz/mono through a `ParcelFileDescriptor` pipe.
- Android translation: the same bundled QuickMT Japanese-to-English CTranslate2 INT8 model and beam-two configuration used by Desktop Native.
- iOS ASR: selectable real-time SpeechAnalyzer with the progressive SpeechTranscriber preset, on-device SFSpeechRecognizer partial/final recognition, or Mobile Rust sherpa-onnx 1.13.3 + ONNX Runtime 1.26.0 + the Desktop ReazonSpeech K2 v2 encoder/joiner INT8 model. SpeechAnalyzer is disabled when `SpeechTranscriber.isAvailable` is false.
- iOS/iPadOS translation: selectable TranslationSession low-latency strategy, TranslationSession high-fidelity strategy, or the same QuickMT Japanese-to-English CTranslate2 INT8/beam-two implementation used by Desktop Native.
- AzooKey: Desktop Native or Mobile Rust `caption-bridge-azookey-rust` with the canonical portable dictionary plus selectable Zenz v3.2 Small/XSmall Q5_K_M GGUF verification.

The desktop microphone remains the audio source. The phone sends every volatile/final ASR update to Desktop before starting Mobile AzooKey, then publishes AzooKey and translation results independently as soon as each stage completes. Desktop owns session, turn, revision, stale-result rejection, and source/translation pairing.

## Pairing

1. Start Native and the mobile companion on the same trusted LAN.
2. Mobile automatically discovers and authenticates to Native.
3. If discovery is unavailable, open Native Settings, copy the LAN endpoint and generated pairing token, enter both in the companion, and connect before starting capture.

The endpoint binds only for the companion feature. Authentication is required before route configuration or PCM is accepted. The token is not logged. Audio and result queues are bounded. Disconnect notifications carry the authenticated session ID, so an old connection cannot abort a later capture. Production auto-discovery reconnects after an unexpected transport failure while retaining prepared AzooKey resources; manual connections return to enabled connection controls.

The UI uses one system font family, two sizes (16 pt content/control text and 20 pt navigation titles), two weights (regular and semibold), 8/16 pt vertical rhythm, and two action treatments (primary and secondary). Controls remain at least 48 pt high and preserve Dynamic Type scaling. iPhone and compact iPad widths use one centered pane; wide iPads (including 13-inch portrait) and landscape iPads use two bounded panes so configuration and live results remain visible together. iOS/iPadOS use Flutter Cupertino widgets; Android uses Material 3 widgets.

Mobile AzooKey defaults to Small and can switch to XSmall while idle. Model SHA-256 values are `29c223d4c23327b80fd13ebb5ab2555057a46317997d5da391584ffbef0db673` (Small) and `00c64b3d318045a708d0cad5434faccab10f5481a49e6362864551fd0995fa58` (XSmall).

Mobile Rust ASR bundles ReazonSpeech K2 v2 under Apache-2.0 and executes its character RNN-T Zipformer through sherpa-onnx and ONNX Runtime. Its concrete Mobile label names all three technologies; the implementation uses one CPU thread and the same greedy-search model configuration as Desktop Native. Exact model hashes are recorded in `assets/asr/SHA256SUMS` (the INT8 encoder is `2c7bd08a8a99f9ddd0d9e458456577b1f6279214e51426f114f9eced44c54e1d`). The app copies packaged model files once on Android-compatible storage and directly resolves them from an Apple application bundle. The Rust implementation is currently enabled on iOS; Android exposes its existing ML Kit provider while the Rust choice remains disabled.

Mobile translation bundles the published `quickmt/quickmt-ja-en` CTranslate2 model under CC BY 4.0. Reproducible mobile builds use vendored `ct2rs` 0.10.0 and `sentencepiece-sys` 0.13.2 sources with narrowly scoped iOS/Android CMake fixes for position-independent static linking, Android ABI/toolchain selection, and removal of unsupported mobile command-line tools/thread affinity. Its `model.bin` SHA-256 is `d11276f68986d951edc1e5b4b634e00f1f9c493eb14519598be975630965eb47`. The runtime uses CPU INT8, one replica, one queued batch, batch size one, and beam size two, matching Desktop Native. Moving translation to Desktop or disconnecting releases the Mobile model and inference workspace.

## Make targets

The Mobile `Makefile` is the command source of truth. Run targets inside
`apps/mobile`, or use the `mobile-*` forwarding targets from the repository
root. Before the first packaging build, prepare the ignored model weights with
the repository script. It downloads revision-pinned Hugging Face artifacts and
rejects every file that does not match its recorded SHA-256. CI caches only
files that pass the same verification.

```sh
# repository root; required once before a packaging build
node scripts/prepare-mobile-model-assets.mjs

# apps/mobile
make setup
make generate
make verify
make test
make coverage
make android
make ios
make ios-device IOS_DEVICE=<physical-iphone-udid>
make install-ios-device IOS_DEVICE=<physical-iphone-udid>
make run-ios-device IOS_DEVICE=<physical-iphone-udid>
make build
make clean

# repository root equivalents
make mobile-setup
make mobile-generate
make mobile-check
make mobile-test
make mobile-coverage
make mobile-build-android
make mobile-build-ios
make mobile-build-ios-device IOS_DEVICE=<physical-iphone-udid>
make mobile-install-ios-device IOS_DEVICE=<physical-iphone-udid>
make mobile-run-ios-device IOS_DEVICE=<physical-iphone-udid>
make mobile-build
make mobile-clean
```

`make android` builds only the supported ARM64 release APK. `make ios` builds
only the unsigned debug iOS Simulator app. Physical-iPhone targets build the
signed **release** app with the same bundle ID, display name, and app icon as the
product: `make ios-device IOS_DEVICE=<udid>` builds it, while
`install-ios-device` and `run-ios-device` also install and launch it. They never
install a Flutter debug app. `make build` keeps its CI-safe Android plus
Simulator behavior and never deploys to a connected phone. Run `make help` or
`make mobile-help` for the complete target list. Generated Dart definitions
produced by `make generate` must not be edited manually.

## Verify

`make verify` runs Dart formatting checks, Flutter analysis, strict Dart code
metrics, Rust formatting/Clippy/tests/build, Flutter tests with coverage, and
the per-file 95% coverage enforcement. Packaging builds remain separate so
Android and iOS can be selected independently:

```sh
make verify
make android # Android ARM64 release only
make ios     # iOS Simulator debug only
make run-ios-device IOS_DEVICE=<udid> # signed physical-device release app
make build   # Android ARM64 plus iOS Simulator
```

Host Flutter tests load `rust/target/debug/librust_lib_kotoba_beacon_companion.dylib`; the `test`, `coverage`, and `verify` Make targets build it automatically. Every hand-written Dart source uses strict casts, strict inference, strict raw types, Very Good Analysis, an 80-column formatter, and a maximum control-flow nesting depth of three. Generated Flutter Rust Bridge sources retain their generator-owned analyzer contract. CI enforces at least 95% line coverage for every hand-written file under `lib/`. The suite includes protocol validation, all route handoff boundaries, stale-revision rejection, bounded PCM buffering, mocked platform-channel contracts, and a real loopback WebSocket pipeline through ASR, AzooKey, and translation. CI additionally builds an iOS 26 simulator app on the pinned macOS 26/Xcode 26.6 runner without launching it.

Android release artifacts target ARM64/API 31+ because the shared CTranslate2/Ruy QuickMT runtime is built for modern ARM64 devices. Android provider validation requires an API 31+ device with the ML Kit speech feature available. Advanced mode is intentionally not selected because its current device coverage is narrower. iOS simulator builds require an accepted Xcode license and installed iOS 26 simulator runtime. Provider/model behavior should still be validated on supported physical hardware.
