import 'dart:async';

import 'package:flutter/services.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';

/// Base event emitted by a platform-native processing provider.
sealed class ProcessingEvent {
  /// Creates a processing event.
  const ProcessingEvent();
}

/// Volatile or final ASR text associated with a protocol revision.
final class AsrProcessingEvent extends ProcessingEvent {
  /// Creates an ASR provider event.
  const AsrProcessingEvent({
    required this.sessionId,
    required this.turnId,
    required this.revision,
    required this.text,
    required this.isFinal,
  });

  /// Authenticated companion session that owns this result.
  final String sessionId;

  /// Desktop turn receiving this result.
  final BigInt turnId;

  /// Base revision supplied when platform ASR started.
  final BigInt revision;

  /// Recognized source text.
  final String text;

  /// Whether the provider finalized this recognition result.
  final bool isFinal;
}

/// Actionable failure emitted by a processing stage.
final class ProcessingErrorEvent extends ProcessingEvent {
  /// Creates a processing failure event.
  const ProcessingErrorEvent({required this.stage, required this.message});

  /// Stage or platform boundary that failed.
  final String stage;

  /// Provider-supplied diagnostic message.
  final String message;
}

/// Selectable Mobile ASR implementation.
enum MobileAsrProvider {
  /// iOS SpeechAnalyzer with progressive SpeechTranscriber results.
  platformSpeechAnalyzer,

  /// iOS SFSpeechRecognizer with on-device partial results.
  platformSFSpeechRecognizer,

  /// Android ML Kit GenAI Speech Recognition.
  androidMlKit,

  /// Rust sherpa-onnx with the Desktop ReazonSpeech K2 v2 INT8 model.
  rustSherpaOnnxReazonSpeech,
}

/// Selectable Mobile translation implementation.
enum MobileTranslationProvider {
  /// Platform TranslationSession using its standard low-latency strategy.
  platformTranslationSession,

  /// iOS TranslationSession using the high-fidelity strategy.
  platformTranslationSessionHighFidelity,

  /// Rust QuickMT/CTranslate2 CPU INT8 with beam size two.
  rustQuickMt,
}

/// Availability of concrete processing implementations on this device.
final class ProcessingProviderAvailability {
  /// Creates immutable implementation availability.
  const ProcessingProviderAvailability({
    required this.speechAnalyzer,
    required this.sfSpeechRecognizer,
    required this.rustSherpaOnnx,
    required this.translationSession,
  });

  /// Whether SpeechAnalyzer and SpeechTranscriber are available.
  final bool speechAnalyzer;

  /// Whether on-device SFSpeechRecognizer is available.
  final bool sfSpeechRecognizer;

  /// Whether the bundled Rust sherpa-onnx runtime is configured.
  final bool rustSherpaOnnx;

  /// Whether the platform TranslationSession API is available.
  final bool translationSession;
}

/// Platform provider contract used by the route controller.
abstract interface class ProcessingBackend {
  /// Ordered ASR and error events from the platform provider.
  Stream<ProcessingEvent> get events;

  /// Returns explicit provider and model availability.
  Future<MobileCapabilities> capabilities();

  /// Returns concrete implementation availability after capability probing.
  Future<ProcessingProviderAvailability> providerAvailability();

  /// Selects the concrete Mobile ASR implementation.
  Future<void> configureAsrProvider(MobileAsrProvider provider);

  /// Selects the concrete Mobile translation implementation.
  Future<void> configureTranslationProvider(
    MobileTranslationProvider provider,
  );

  /// Downloads or prepares ASR resources for [locale].
  Future<void> prepareAsr(String locale);

  /// Downloads or prepares an on-device translation pair.
  Future<void> prepareTranslation({
    required String sourceLanguage,
    required String targetLanguage,
  });

  /// Starts revision-scoped streaming ASR.
  Future<void> startAsr({
    required String sessionId,
    required BigInt turnId,
    required BigInt revision,
    required String locale,
  });

  /// Appends one PCM16, 16 kHz, mono audio frame.
  Future<void> appendPcm(Uint8List pcm16);

  /// Ends audio input and requests the provider's final result.
  Future<void> finishAsr();

  /// Translates [text] with the prepared on-device language pair.
  Future<String> translate({
    required String text,
    required String sourceLanguage,
    required String targetLanguage,
  });

  /// Releases the translation model when translation moves to Desktop.
  Future<void> releaseTranslation();

  /// Cancels active work and releases provider sessions.
  Future<void> cancel();
}

/// Mobile Rust ASR callbacks shared with the Desktop Native ASR engine.
final class MobileRustAsrBackend {
  /// Creates the ReazonSpeech lifecycle boundary.
  const MobileRustAsrBackend({
    required this.prepare,
    required this.transcribe,
    required this.release,
  });

  /// Loads the bundled ReazonSpeech K2 v2 INT8 model.
  final Future<void> Function() prepare;

  /// Recognizes one bounded little-endian PCM16 buffer.
  final Future<String> Function(Uint8List pcm16) transcribe;

  /// Releases the recognizer and ONNX Runtime workspace.
  final Future<void> Function() release;
}

/// Mobile QuickMT callbacks shared with the Desktop Native translation engine.
final class QuickMtTranslationBackend {
  /// Creates the QuickMT lifecycle boundary.
  const QuickMtTranslationBackend({
    required this.prepare,
    required this.translate,
    required this.release,
  });

  /// Loads the bundled INT8 Japanese-to-English model.
  final Future<void> Function() prepare;

  /// Translates one Japanese source string with batch size one.
  final Future<String> Function(String text) translate;

  /// Releases the active model and inference workspace.
  final Future<void> Function() release;
}

final class _RustAsrMetadata {
  const _RustAsrMetadata({
    required this.sessionId,
    required this.turnId,
    required this.revision,
    required this.generation,
  });

  final String sessionId;
  final BigInt turnId;
  final BigInt revision;
  final int generation;
}

/// Method-channel adapter for selectable Mobile ASR and translation engines.
final class NativeProcessingBackend implements ProcessingBackend {
  /// Starts listening for native ASR and provider-error events.
  NativeProcessingBackend({this.mobileRustAsr, this.quickMtTranslation}) {
    if (quickMtTranslation == null) {
      _translationProvider =
          MobileTranslationProvider.platformTranslationSession;
    }
    _subscription = _eventChannel.receiveBroadcastStream().listen(
      _handlePlatformEvent,
      onError: (Object error) => _events.add(
        ProcessingErrorEvent(stage: 'platform', message: error.toString()),
      ),
    );
  }

  static const _methodChannel = MethodChannel('kotoba_beacon/processing');
  static const _eventChannel = EventChannel('kotoba_beacon/processing_events');

  static const int _maxRustAsrPcmBytes = 20 * 60 * 16000 * 2;
  static const int _rustAsrPartialIntervalBytes = 16000 * 2;

  final _events = StreamController<ProcessingEvent>.broadcast();

  /// Bundled Rust ASR runtime equivalent to the Desktop ASR engine.
  final MobileRustAsrBackend? mobileRustAsr;

  /// Bundled translation runtime used alongside platform Translation APIs.
  final QuickMtTranslationBackend? quickMtTranslation;

  StreamSubscription<Object?>? _subscription;
  MobileAsrProvider _asrProvider = MobileAsrProvider.platformSpeechAnalyzer;
  MobileTranslationProvider _translationProvider =
      MobileTranslationProvider.rustQuickMt;
  final List<int> _rustAsrPcm = <int>[];
  _RustAsrMetadata? _rustAsrMetadata;
  Uint8List? _pendingRustAsrPartial;
  Future<void>? _rustAsrDrain;
  int _rustAsrGeneration = 0;
  int _lastRustAsrPartialBytes = 0;
  ProcessingProviderAvailability? _providerAvailability;

  @override
  Stream<ProcessingEvent> get events => _events.stream;

  @override
  Future<MobileCapabilities> capabilities() async {
    final value = await _methodChannel.invokeMapMethod<String, Object?>(
      'capabilities',
    );
    if (value == null) {
      throw StateError('Platform capabilities are unavailable');
    }
    final deviceId = value['deviceId'];
    final deviceName = value['deviceName'];
    final platform = value['platform'];
    final asrAvailable = value['asrAvailable'];
    final translationAvailable = value['translationAvailable'];
    final speechAnalyzerAvailable = value['speechTranscriberAvailable'];
    final sfSpeechRecognizerAvailable = value['sfSpeechRecognizerAvailable'];
    if (deviceId is! String ||
        deviceName is! String ||
        platform is! String ||
        asrAvailable is! bool ||
        translationAvailable is! bool) {
      throw StateError('Platform capabilities are malformed');
    }
    _providerAvailability = ProcessingProviderAvailability(
      speechAnalyzer: speechAnalyzerAvailable is bool
          ? speechAnalyzerAvailable
          : asrAvailable,
      sfSpeechRecognizer:
          sfSpeechRecognizerAvailable is bool && sfSpeechRecognizerAvailable,
      rustSherpaOnnx: mobileRustAsr != null && platform == 'ios',
      translationSession: translationAvailable,
    );
    return MobileCapabilities(
      deviceId: deviceId,
      deviceName: deviceName,
      platform: platform,
      asrAvailable:
          asrAvailable || (mobileRustAsr != null && platform == 'ios'),
      azookeyAvailable: true,
      translationAvailable: quickMtTranslation != null || translationAvailable,
    );
  }

  @override
  Future<ProcessingProviderAvailability> providerAvailability() async {
    final availability = _providerAvailability;
    if (availability != null) return availability;
    await capabilities();
    return _providerAvailability!;
  }

  @override
  Future<void> configureAsrProvider(MobileAsrProvider provider) async {
    if (_asrProvider == provider) return;
    await _cancelActiveAsr();
    if (_asrProvider == MobileAsrProvider.rustSherpaOnnxReazonSpeech) {
      await mobileRustAsr?.release();
    }
    _asrProvider = provider;
  }

  @override
  Future<void> configureTranslationProvider(
    MobileTranslationProvider provider,
  ) async {
    if (_translationProvider == provider) return;
    await releaseTranslation();
    _translationProvider = provider;
  }

  @override
  Future<void> prepareAsr(String locale) async {
    if (_asrProvider == MobileAsrProvider.rustSherpaOnnxReazonSpeech) {
      final rustAsr = mobileRustAsr;
      if (rustAsr == null) throw StateError('Mobile Rust ASR is unavailable');
      await rustAsr.prepare();
      return;
    }
    await _methodChannel.invokeMethod<void>(
      'prepareAsr',
      <String, String>{'locale': locale, 'provider': _asrProvider.name},
    );
  }

  @override
  Future<void> prepareTranslation({
    required String sourceLanguage,
    required String targetLanguage,
  }) async {
    _validateTranslationLanguages(sourceLanguage, targetLanguage);
    if (_translationProvider == MobileTranslationProvider.rustQuickMt) {
      final quickMt = quickMtTranslation;
      if (quickMt == null) throw StateError('Mobile QuickMT is unavailable');
      await quickMt.prepare();
      return;
    }
    await _methodChannel.invokeMethod<void>(
      'prepareTranslation',
      <String, String>{
        'sourceLanguage': sourceLanguage,
        'targetLanguage': targetLanguage,
        'provider': _translationProvider.name,
      },
    );
  }

  @override
  Future<void> startAsr({
    required String sessionId,
    required BigInt turnId,
    required BigInt revision,
    required String locale,
  }) async {
    if (_asrProvider == MobileAsrProvider.rustSherpaOnnxReazonSpeech) {
      await prepareAsr(locale);
      _rustAsrGeneration += 1;
      _rustAsrPcm.clear();
      _pendingRustAsrPartial = null;
      _lastRustAsrPartialBytes = 0;
      _rustAsrMetadata = _RustAsrMetadata(
        sessionId: sessionId,
        turnId: turnId,
        revision: revision,
        generation: _rustAsrGeneration,
      );
      return;
    }
    await _methodChannel.invokeMethod<void>('startAsr', <String, Object>{
      'sessionId': sessionId,
      'turnId': turnId.toString(),
      'revision': revision.toString(),
      'locale': locale,
      'provider': _asrProvider.name,
    });
  }

  @override
  Future<void> appendPcm(Uint8List pcm16) async {
    if (_asrProvider != MobileAsrProvider.rustSherpaOnnxReazonSpeech) {
      await _methodChannel.invokeMethod<void>('appendPcm', pcm16);
      return;
    }
    if (_rustAsrMetadata == null) {
      throw StateError('Mobile Rust ASR has not started');
    }
    if (_rustAsrPcm.length + pcm16.length > _maxRustAsrPcmBytes) {
      throw StateError('Mobile Rust ASR PCM input exceeded its bound');
    }
    _rustAsrPcm.addAll(pcm16);
    if (_rustAsrPcm.length - _lastRustAsrPartialBytes <
        _rustAsrPartialIntervalBytes) {
      return;
    }
    _lastRustAsrPartialBytes = _rustAsrPcm.length;
    _pendingRustAsrPartial = Uint8List.fromList(_rustAsrPcm);
    _rustAsrDrain ??= _drainRustAsrPartials();
  }

  @override
  Future<void> finishAsr() async {
    if (_asrProvider != MobileAsrProvider.rustSherpaOnnxReazonSpeech) {
      await _methodChannel.invokeMethod<void>('finishAsr');
      return;
    }
    _pendingRustAsrPartial = null;
    await _rustAsrDrain;
    final metadata = _rustAsrMetadata;
    final rustAsr = mobileRustAsr;
    if (metadata == null || rustAsr == null) return;
    final text = await rustAsr.transcribe(Uint8List.fromList(_rustAsrPcm));
    _emitRustAsr(metadata, text, isFinal: true);
    _clearRustAsrSession();
  }

  @override
  Future<String> translate({
    required String text,
    required String sourceLanguage,
    required String targetLanguage,
  }) async {
    _validateTranslationLanguages(sourceLanguage, targetLanguage);
    final result = _translationProvider == MobileTranslationProvider.rustQuickMt
        ? await quickMtTranslation?.translate(text)
        : await _methodChannel.invokeMethod<String>(
            'translate',
            <String, String>{
              'text': text,
              'sourceLanguage': sourceLanguage,
              'targetLanguage': targetLanguage,
              'provider': _translationProvider.name,
            },
          );
    if (result == null || result.trim().isEmpty) {
      throw StateError('The platform translator returned no text');
    }
    return result;
  }

  @override
  Future<void> releaseTranslation() async {
    await quickMtTranslation?.release();
    await _methodChannel.invokeMethod<void>('releaseTranslation');
  }

  @override
  Future<void> cancel() async {
    await _cancelActiveAsr();
    await _methodChannel.invokeMethod<void>('cancel');
    await mobileRustAsr?.release();
    await quickMtTranslation?.release();
  }

  /// Stops platform events and closes the local event stream.
  Future<void> dispose() async {
    await _subscription?.cancel();
    _subscription = null;
    await _events.close();
  }

  Future<void> _cancelActiveAsr() async {
    _rustAsrGeneration += 1;
    _pendingRustAsrPartial = null;
    await _rustAsrDrain;
    _clearRustAsrSession();
  }

  Future<void> _drainRustAsrPartials() async {
    try {
      while (_pendingRustAsrPartial != null) {
        final pcm = _pendingRustAsrPartial!;
        final metadata = _rustAsrMetadata;
        _pendingRustAsrPartial = null;
        final rustAsr = mobileRustAsr;
        if (metadata == null || rustAsr == null) continue;
        final text = await rustAsr.transcribe(pcm);
        _emitRustAsr(metadata, text, isFinal: false);
      }
    } finally {
      _rustAsrDrain = null;
    }
  }

  void _emitRustAsr(
    _RustAsrMetadata metadata,
    String text, {
    required bool isFinal,
  }) {
    if (metadata.generation != _rustAsrGeneration || text.trim().isEmpty) {
      return;
    }
    _events.add(
      AsrProcessingEvent(
        sessionId: metadata.sessionId,
        turnId: metadata.turnId,
        revision: metadata.revision,
        text: text,
        isFinal: isFinal,
      ),
    );
  }

  void _clearRustAsrSession() {
    _rustAsrPcm.clear();
    _rustAsrMetadata = null;
    _pendingRustAsrPartial = null;
    _lastRustAsrPartialBytes = 0;
  }

  void _validateTranslationLanguages(String source, String target) {
    if (source != 'ja' || target != 'en') {
      throw ArgumentError('QuickMT supports only Japanese-to-English');
    }
  }

  void _handlePlatformEvent(Object? value) {
    if (value is! Map<Object?, Object?>) return;
    final type = value['type'];
    if (type == 'asr') {
      final sessionId = value['sessionId'];
      final turnId = value['turnId'];
      final revision = value['revision'];
      final text = value['text'];
      final isFinal = value['isFinal'];
      if (sessionId is! String ||
          turnId is! String ||
          revision is! String ||
          text is! String ||
          isFinal is! bool) {
        return;
      }
      final parsedTurnId = BigInt.tryParse(turnId);
      final parsedRevision = BigInt.tryParse(revision);
      if (parsedTurnId == null || parsedRevision == null) return;
      _events.add(
        AsrProcessingEvent(
          sessionId: sessionId,
          turnId: parsedTurnId,
          revision: parsedRevision,
          text: text,
          isFinal: isFinal,
        ),
      );
      return;
    }
    if (type == 'error') {
      _events.add(
        ProcessingErrorEvent(
          stage: value['stage'] is String
              ? value['stage']! as String
              : 'platform',
          message: value['message'] is String
              ? value['message']! as String
              : 'Unknown error',
        ),
      );
    }
  }
}
