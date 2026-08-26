# Kotoba Beacon Mobile Companion architecture

## Scope and invariants

The companion is a Flutter application for Android and iOS. The phone and Kotoba Beacon Native desktop are on the same trusted local network. The desktop remains the microphone owner and subtitle renderer. Processing ownership is independently selectable for ASR, AzooKey, and Japanese-to-English translation, producing exactly eight routes.

The default route is `mobile/mobile/mobile`: desktop PCM is streamed to the phone; the phone publishes ASR updates, AzooKey updates, and translation updates back as soon as each stage produces them. Source captions must never wait for translation. Every message carries a session ID, turn ID, and monotonically increasing revision so delayed results cannot overwrite newer captions.

Building, testing, packaging, pairing, and metrics must not launch or foreground Native. LAN support stays in-process and bounded. No cloud relay or account is required.

## Route matrix

| Route ID | ASR | AzooKey | Translation |
| --- | --- | --- | --- |
| `ddd` | Desktop | Desktop | Desktop |
| `ddm` | Desktop | Desktop | Mobile |
| `dmd` | Desktop | Mobile | Desktop |
| `dmm` | Desktop | Mobile | Mobile |
| `mdd` | Mobile | Desktop | Desktop |
| `mdm` | Mobile | Desktop | Mobile |
| `mmd` | Mobile | Mobile | Desktop |
| `mmm` | Mobile | Mobile | Mobile |

A stage is run exactly once by its selected owner. The output of one stage is forwarded to the owner of the next stage. A newer revision cancels or supersedes obsolete mobile work.

## LAN protocol

- Desktop listens on an explicitly enabled LAN WebSocket endpoint.
- Desktop advertises `_kotobabeacon._tcp` through Bonjour and also answers nonce-scoped UDP discovery requests on port `18184`; both mechanisms provide the current endpoint and high-entropy token.
- Binding beyond loopback requires a generated, high-entropy pairing token.
- A phone authenticates in its first JSON control frame. The token is never logged.
- One authenticated phone owns one capture session. Additional peers are rejected while capture is active.
- Control/results are UTF-8 JSON. Audio is binary, headerless signed 16-bit little-endian mono PCM at 16 kHz.
- Audio frames are bounded to 32 ms (1,024 bytes). A bounded queue drops the session with an explicit overrun error rather than growing memory.
- LAN disconnect cancels pending stage work and desktop falls back to local processing only after starting a new revision/session; outputs from the disconnected session are stale.

The production phone app first discovers Native on the trusted LAN, opens the returned WebSocket endpoint, then probes its platform APIs. iOS/iPadOS use `NetServiceBrowser` with the declared `_kotobabeacon._tcp` service, so they do not depend on the restricted multicast/broadcast entitlement. Manual endpoint and token entry remains available when automatic discovery is unavailable. Authentication carries a stable platform device ID and a typed capability report. A requested route is constrained to Desktop for every unavailable Mobile stage before the session is configured. Route toggles remain disabled until this post-connect capability probe finishes. During an idle session either UI can request a new route. `route.configure` from Native is the authoritative acknowledgement: Mobile keeps its prior route and disables further changes until that acknowledgement arrives. Desktop-originated changes use the same message, so both UIs converge on one accepted route before capture can use it.

Core control/result messages:

- `pair.request`, `pair.accepted`, `pair.rejected`
- `session.configure`, `session.ready`, `session.stop`
- `route.request`, `route.configure`
- `audio.start`, binary PCM frames, `audio.end`
- `asr.update` (`partial` or `final`)
- `azookey.request`, `azookey.result`
- `translation.request`, `translation.result`
- `stage.error`, `ping`, `pong`

The canonical route and protocol domain types live in Rust and are exposed to Flutter by generated `flutter_rust_bridge` bindings. Dart must not duplicate those enums or payload structures.

## Mobile stage implementations

### Android

- UI: Flutter Material 3 application shell, Scaffold, text fields, buttons, cards, and segmented controls.
- ASR: ML Kit GenAI Speech Recognition `com.google.mlkit:genai-speech-recognition:1.0.0-alpha1`, Basic mode, `ja-JP` by default. Basic mode requires Android API 31+. Desktop PCM is fed through a `ParcelFileDescriptor` pipe as raw mono PCM16 at 16 kHz. Streaming responses are forwarded through an EventChannel.
- Translation: ML Kit on-device Translation with Japanese source and English target. Required models are checked/downloaded explicitly and translators are closed on session stop.
- The app reports `unsupported` instead of silently changing providers when the API/device/model is unavailable.

### iOS

- UI: Flutter Cupertino application shell, navigation bar, text fields, buttons, inset list sections, and sliding segmented controls. iPadOS follows the same Cupertino branch.
- ASR: SpeechAnalyzer with a SpeechTranscriber configured for Japanese. PCM16 frames are converted to the analyzer-compatible `AVAudioFormat` and supplied as `AnalyzerInput`; volatile and final results are forwarded independently.
- Translation: TranslationSession for Japanese to English. Model availability/download UI remains system-owned. Translation results include the originating revision.
- Deployment target is the first iOS version that ships SpeechAnalyzer; earlier systems report `unsupported` rather than using a different recognizer.

### AzooKey

The Flutter native library depends directly on `caption-bridge-azookey-rust`. It loads the same portable system dictionary used by the browser Worker and calls the existing Rust conversion API. Flutter Rust Bridge generates Dart bindings from Rust declarations. Conversion domain types are not manually redefined in Dart.

## Desktop integration

1. A bounded LAN sender is attached immediately after desktop PCM normalization. It is active only when mobile ASR is selected.
2. Desktop ASR events enter a stage router instead of directly scheduling every downstream stage.
3. Mobile ASR events enter the same revision-aware router as desktop ASR events.
4. Desktop AzooKey uses the same Rust AzooKey crate as mobile. Mobile AzooKey results are accepted only for the active session/turn/revision.
5. Desktop translation continues to use QuickMT. Mobile translation results enter the existing `WorkerEvent::Translation` path, preserving immediate source display and paired expiry.
6. GPUI settings expose three independent Desktop/Mobile toggles, authenticated connection state, synchronized route, session, pairing token rotation, and phone capability diagnostics. Mobile shows the corresponding authenticated state, Desktop endpoint, synchronized route, and API availability.
7. Native persists ASR, AzooKey, and translation ownership by stable mobile device ID. Reconnecting a known phone restores its saved route, constrained by the phone's current capability report.

## Verification

- Rust route tests enumerate all eight unique combinations and all stage handoffs.
- Protocol tests reject missing authentication, oversized PCM frames, unknown versions, stale revisions, and malformed messages.
- Flutter unit tests cover all eight route labels, revision rejection, immediate ASR publication, and stage ordering.
- Android JVM/instrumentation tests use fake ML Kit adapters; a physical API 31+ device is required for provider validation.
- iOS tests use fake SpeechAnalyzer/Translation adapters; simulator validation is attempted when Xcode license and simulator runtimes are available. Provider availability may still require supported Apple hardware/language assets.
- Deterministic integration fixtures stream repository PCM without opening a microphone or launching Native.
