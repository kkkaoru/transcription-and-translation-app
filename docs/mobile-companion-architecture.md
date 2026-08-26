# Kotoba Beacon Mobile Companion architecture

## Scope and invariants

The companion is a Flutter application for Android and iOS. The phone and Kotoba Beacon Native desktop are on the same trusted local network. The desktop remains the microphone owner and subtitle renderer. Processing ownership is independently selectable for ASR, AzooKey, and Japanese-to-English translation, producing exactly eight routes.

The preferred default route is `mobile/mobile/mobile`: Mobile ASR publishes volatile and final results, Mobile AzooKey returns converted source text with the bundled Small GGUF, and Mobile QuickMT publishes Japanese-to-English text. Each Mobile stage has a separately selectable concrete implementation while the authenticated Desktop protocol continues to synchronize only its execution owner. Capability detection disables unavailable implementations and constrains only unavailable Mobile stages to Desktop. Users can select Desktop Native, iOS SpeechAnalyzer/SpeechTranscriber, iOS SFSpeechRecognizer, or Mobile Rust sherpa-onnx/ReazonSpeech ASR; Desktop Native or either Mobile Zenz model; and Desktop Native, TranslationSession lowLatency/highFidelity, or Mobile Rust QuickMT. Source captions never wait for AzooKey or translation. Every Mobile ASR update is sent to Desktop immediately, while Mobile AzooKey and translation start only from the finalized turn so raw ASR, converted source, and translation do not oscillate on the Desktop subtitle surface. Every message carries a session ID, turn ID, and monotonically increasing revision. Desktop is authoritative for stale-result rejection and source/translation pairing.

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

A stage is run exactly once by its selected owner. Mobile ASR implements the same volatile/final revision-scoped stage contract as Desktop Native ASR, and Mobile translation uses the same Japanese-to-English QuickMT model and revision-paired stage contract as Desktop Native. The output of one stage is forwarded to the owner of the next stage. A newer revision cancels or supersedes obsolete mobile work.

## LAN protocol

- Desktop listens on an explicitly enabled LAN WebSocket endpoint.
- Desktop advertises `_kotobabeacon._tcp` through Bonjour and also answers nonce-scoped UDP discovery requests on port `18184`; both mechanisms provide the current endpoint and high-entropy token.
- Binding beyond loopback requires a generated, high-entropy pairing token.
- A phone authenticates in its first JSON control frame. The token is never logged.
- One authenticated phone owns one capture session. Additional peers are rejected while capture is active.
- Control/results are UTF-8 JSON. Audio is binary, headerless signed 16-bit little-endian mono PCM at 16 kHz.
- Audio frames are bounded to 32 ms (1,024 bytes). A bounded queue drops the session with an explicit overrun error rather than growing memory.
- LAN disconnect cancels pending stage work and desktop falls back to local processing only after starting a new revision/session; outputs from the disconnected session are stale. Auto-discovered companions detach the failed subscription without awaiting cancellation from its own error callback, preserve prepared AzooKey resources, and reconnect through a fresh authenticated session.

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

- UI: Flutter Material 3 application shell with a shared compact vocabulary: one system font, 16/20 pt sizes, regular/semibold weights, 8/16 pt rhythm, two action treatments, and minimum 48 pt controls.
- ASR: ML Kit GenAI Speech Recognition `com.google.mlkit:genai-speech-recognition:1.0.0-alpha1`, Basic mode, `ja-JP` by default. Basic mode requires Android API 31+. Desktop PCM is fed through a `ParcelFileDescriptor` pipe as raw mono PCM16 at 16 kHz. Streaming responses are forwarded through an EventChannel.
- Translation: the bundled `quickmt/quickmt-ja-en` CTranslate2 model used by Desktop Native, with CPU INT8, one replica, one queued batch, batch size one, and beam size two. It does not depend on ML Kit Translation availability.
- The app reports `unsupported` instead of silently changing providers when the API/device/model is unavailable.

### iOS

- UI: Flutter Cupertino application shell with the same compact 16/20 pt, regular/semibold, 8/16 pt vocabulary and minimum 48 pt actions. Connection information and the single discovery/disconnect action precede the provider settings. All provider choices use high-contrast segmented controls that remain selectable before connection and while recognition is active; a busy-session change is applied after the current session stops. One default-collapsed `詳細情報を表示` section contains all connection and processing results. iPhone and compact iPad widths use one bounded pane; wide iPads (including 13-inch portrait) and landscape iPads use two panes so settings and real-time results remain visible together.
- ASR option 1: SpeechAnalyzer with a Japanese SpeechTranscriber using `.progressiveTranscription` for real-time volatile/final output. This option is disabled unless `SpeechTranscriber.isAvailable` is true. PCM16 frames are converted to the analyzer-compatible `AVAudioFormat` and supplied as `AnalyzerInput`.
- ASR option 2: SFSpeechRecognizer configured for Japanese, on-device recognition, and partial results. It is enabled only when the recognizer exists and `supportsOnDeviceRecognition` is true.
- ASR option 3: Mobile Rust sherpa-onnx 1.13.3 + ONNX Runtime 1.26.0 + ReazonSpeech K2 v2 character RNN-T Zipformer, using the same INT8 encoder/joiner, floating-point decoder, one CPU thread, CJK modeling unit, and greedy search as Desktop Native. Bounded latest-wins partial snapshots preserve real-time publication; final input is always recognized once.
- Translation options: TranslationSession `.lowLatency`, TranslationSession `.highFidelity`, or the bundled Desktop-equivalent `quickmt/quickmt-ja-en` CTranslate2 model with CPU INT8, one replica, one queued batch, batch size one, SentencePiece, and beam size two. Translation results retain their originating revision.
- Speech and Translation model preparation is deferred until the selected implementation is used; platform authorization and asset-download dialogs remain system-owned.

### AzooKey

The Flutter native library depends directly on `caption-bridge-azookey-rust` and the Candle-backed `caption-bridge-zenz-verifier`. It loads the same portable system dictionary used by the browser Worker and verifies candidates with a bundled Zenz v3.2 Q5_K_M GGUF. Small is the default; XSmall is selectable while idle. Model selection replaces the active verifier rather than retaining both models. Flutter Rust Bridge generates Dart bindings from Rust declarations. Conversion domain types are not manually redefined in Dart.

## Desktop integration

1. A bounded LAN sender is attached immediately after desktop PCM normalization. It is active only when mobile ASR is selected.
2. Desktop ASR events enter a stage router instead of directly scheduling every downstream stage.
3. Mobile ASR events enter the same revision-aware router as desktop ASR events.
4. Desktop AzooKey uses the same Rust AzooKey crate as mobile. Mobile AzooKey results are accepted only for the active session/turn/revision.
5. Desktop and Mobile translation use the same QuickMT model, SentencePiece tokenization, CTranslate2 CPU INT8 runtime, and beam-two quality configuration. Mobile results enter the existing `WorkerEvent::Translation` path, preserving immediate source display and paired expiry. Mobile releases QuickMT when translation moves to Desktop or the companion disconnects.
6. GPUI settings expose three independent Desktop/Mobile toggles, authenticated connection state, synchronized route, session, pairing token rotation, and phone capability diagnostics. Mobile shows the corresponding authenticated state, Desktop endpoint, synchronized route, and API availability.
7. Native persists ASR, AzooKey, and translation ownership by stable mobile device ID. Reconnecting a known phone restores its saved route, constrained by the phone's current capability report.

## Verification

- Rust route tests enumerate all eight unique combinations and all stage handoffs.
- Protocol tests reject missing authentication, oversized PCM frames, unknown versions, stale revisions, and malformed messages.
- Flutter unit tests cover all eight route labels, Small/XSmall selection, revision rejection, immediate ASR publication, stage ordering, and iPad portrait/landscape breakpoints.
- Android JVM/instrumentation tests use fake ML Kit adapters; a physical API 31+ device is required for provider validation.
- iOS tests use fake SpeechAnalyzer/Translation adapters; simulator validation is attempted when Xcode license and simulator runtimes are available. Provider availability may still require supported Apple hardware/language assets.
- Deterministic integration fixtures stream repository PCM without opening a microphone or launching Native.
