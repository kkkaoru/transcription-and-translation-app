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

/// Platform provider contract used by the route controller.
abstract interface class ProcessingBackend {
  /// Ordered ASR and error events from the platform provider.
  Stream<ProcessingEvent> get events;

  /// Returns explicit provider and model availability.
  Future<MobileCapabilities> capabilities();

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

  /// Cancels active work and releases provider sessions.
  Future<void> cancel();
}

/// Method-channel adapter for Android ML Kit and iOS native providers.
final class NativeProcessingBackend implements ProcessingBackend {
  /// Starts listening for native ASR and provider-error events.
  NativeProcessingBackend() {
    _subscription = _eventChannel.receiveBroadcastStream().listen(
      _handlePlatformEvent,
      onError: (Object error) => _events.add(
        ProcessingErrorEvent(stage: 'platform', message: error.toString()),
      ),
    );
  }

  static const _methodChannel = MethodChannel('kotoba_beacon/processing');
  static const _eventChannel = EventChannel('kotoba_beacon/processing_events');

  final _events = StreamController<ProcessingEvent>.broadcast();
  StreamSubscription<Object?>? _subscription;

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
    if (deviceId is! String ||
        deviceName is! String ||
        platform is! String ||
        asrAvailable is! bool ||
        translationAvailable is! bool) {
      throw StateError('Platform capabilities are malformed');
    }
    return MobileCapabilities(
      deviceId: deviceId,
      deviceName: deviceName,
      platform: platform,
      asrAvailable: asrAvailable,
      azookeyAvailable: true,
      translationAvailable: translationAvailable,
    );
  }

  @override
  Future<void> prepareAsr(String locale) => _methodChannel.invokeMethod<void>(
    'prepareAsr',
    <String, String>{'locale': locale},
  );

  @override
  Future<void> prepareTranslation({
    required String sourceLanguage,
    required String targetLanguage,
  }) =>
      _methodChannel.invokeMethod<void>('prepareTranslation', <String, String>{
        'sourceLanguage': sourceLanguage,
        'targetLanguage': targetLanguage,
      });

  @override
  Future<void> startAsr({
    required String sessionId,
    required BigInt turnId,
    required BigInt revision,
    required String locale,
  }) => _methodChannel.invokeMethod<void>('startAsr', <String, Object>{
    'sessionId': sessionId,
    'turnId': turnId.toString(),
    'revision': revision.toString(),
    'locale': locale,
  });

  @override
  Future<void> appendPcm(Uint8List pcm16) =>
      _methodChannel.invokeMethod<void>('appendPcm', pcm16);

  @override
  Future<void> finishAsr() => _methodChannel.invokeMethod<void>('finishAsr');

  @override
  Future<String> translate({
    required String text,
    required String sourceLanguage,
    required String targetLanguage,
  }) async {
    final result = await _methodChannel.invokeMethod<String>(
      'translate',
      <String, String>{
        'text': text,
        'sourceLanguage': sourceLanguage,
        'targetLanguage': targetLanguage,
      },
    );
    if (result == null || result.trim().isEmpty) {
      throw StateError('The platform translator returned no text');
    }
    return result;
  }

  @override
  Future<void> cancel() => _methodChannel.invokeMethod<void>('cancel');

  /// Stops platform events and closes the local event stream.
  Future<void> dispose() async {
    await _subscription?.cancel();
    _subscription = null;
    await _events.close();
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
