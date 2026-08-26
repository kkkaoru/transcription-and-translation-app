import 'dart:async';
import 'dart:typed_data';

import 'package:kotoba_beacon_companion/src/companion_connection.dart';
import 'package:kotoba_beacon_companion/src/native_processing.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';

Future<void> _acceptRoute(PipelineRoute route) async {}

void _ignoreRouteControlState({required bool enabled}) {}

/// Reports whether the authenticated session is idle enough to change routes.
typedef RouteControlsChanged = void Function({required bool enabled});

/// Routes revision-scoped commands and stage results between Native and Mobile.
final class CompanionController {
  /// Starts listening to [transport] and [processing] immediately.
  CompanionController({
    required this.route,
    required this.transport,
    required this.processing,
    required this.onStatus,
    required this.onSource,
    required this.onAzooKey,
    required this.onTranslation,
    this.onRouteRequested = _acceptRoute,
    this.onRouteControlsEnabled = _ignoreRouteControlState,
  }) {
    _transportSubscription = transport.messages.listen(
      _handleTransportMessage,
      onError: (Object error) => onStatus('接続エラー: $error'),
    );
    _processingSubscription = processing.events.listen(_handleProcessingEvent);
  }

  /// Rust-owned assignment of ASR, AzooKey, and translation stages.
  PipelineRoute route;

  /// Authenticated LAN transport used for Native messages.
  final CompanionTransport transport;

  /// Platform-native ASR and translation provider.
  final ProcessingBackend processing;

  /// Receives connection, protocol, and provider status messages.
  final void Function(String status) onStatus;

  /// Prepares resources before a desktop-selected route becomes active.
  final Future<void> Function(PipelineRoute route) onRouteRequested;

  /// Enables route changes only while the authenticated session is idle.
  final RouteControlsChanged onRouteControlsEnabled;

  /// Receives accepted ASR source text immediately.
  final void Function(String text) onSource;

  /// Receives accepted AzooKey conversion text immediately.
  final void Function(String text) onAzooKey;

  /// Receives accepted translation text immediately.
  final void Function(String text) onTranslation;

  static const _maxPendingPcmFrames = 64;

  final Map<BigInt, BigInt> _latestRevisionByTurn = <BigInt, BigInt>{};
  final Map<BigInt, BigInt> _asrBaseRevisionByTurn = <BigInt, BigInt>{};
  final List<Uint8List> _pendingPcm = <Uint8List>[];
  StreamSubscription<Object>? _transportSubscription;
  StreamSubscription<ProcessingEvent>? _processingSubscription;
  Future<void> _commandTail = Future<void>.value();
  bool _mobileAsrStarting = false;
  bool _mobileAsrActive = false;
  bool _translationEnabled = true;

  /// Stops subscriptions, platform processing, and the transport session.
  Future<void> dispose() async {
    await _transportSubscription?.cancel();
    await _processingSubscription?.cancel();
    await processing.cancel();
    await transport.close();
  }

  void _handleTransportMessage(Object message) {
    switch (message) {
      case final Uint8List pcm16:
        _handlePcm(pcm16);
      case final String json:
        _handleJsonCommand(json);
    }
  }

  void _handlePcm(Uint8List pcm16) {
    if (route.asr != ExecutionDevice.mobile) return;
    if (_mobileAsrActive) {
      unawaited(
        processing.appendPcm(pcm16).catchError(_reportProcessingError),
      );
      return;
    }
    if (!_mobileAsrStarting || _pendingPcm.length >= _maxPendingPcmFrames) {
      return;
    }
    _pendingPcm.add(Uint8List.fromList(pcm16));
  }

  void _handleJsonCommand(String json) {
    try {
      final command = decodeDesktopCommand(json: json);
      _observeCommand(command);
      _commandTail = _commandTail
          .then((_) => _handleCommand(command))
          .catchError((Object error) => onStatus('コマンドエラー: $error'));
    } on Object catch (error) {
      onStatus('プロトコルエラー: $error');
    }
  }

  void _observeCommand(DesktopCommand command) {
    switch (command) {
      case DesktopCommand_StartAudio():
        if (route.asr != ExecutionDevice.mobile) return;
        _mobileAsrStarting = true;
        _mobileAsrActive = false;
        _pendingPcm.clear();
      case DesktopCommand_RunAzookey(:final turnId, :final revision):
        if (route.azookey == ExecutionDevice.mobile) {
          _acceptRevision(turnId, revision);
        }
      case DesktopCommand_RunTranslation(:final turnId, :final revision):
        if (route.translation == ExecutionDevice.mobile) {
          _acceptRevision(turnId, revision);
        }
      default:
        break;
    }
  }

  Future<void> _handleCommand(DesktopCommand command) async {
    switch (command) {
      case DesktopCommand_SessionReady(:final sessionId, :final route):
        await _configureRoute(route);
        onRouteControlsEnabled(enabled: true);
        onStatus('接続済み: $sessionId / ${pipelineRouteId(route: route)}');
      case DesktopCommand_ConfigureRoute(:final route):
        await _configureRoute(route);
        onStatus('デスクトップ設定を適用: ${pipelineRouteId(route: route)}');
      case DesktopCommand_StartAudio(
        :final sessionId,
        :final turnId,
        :final revision,
      ):
        onRouteControlsEnabled(enabled: false);
        if (route.asr != ExecutionDevice.mobile) return;
        if (!_acceptRevision(turnId, revision)) {
          _mobileAsrStarting = false;
          _pendingPcm.clear();
          return;
        }
        _asrBaseRevisionByTurn[turnId] = revision;
        try {
          await processing.startAsr(
            sessionId: sessionId,
            turnId: turnId,
            revision: revision,
            locale: 'ja-JP',
          );
          _mobileAsrActive = true;
          for (final frame in _pendingPcm) {
            await processing.appendPcm(frame);
          }
        } finally {
          _pendingPcm.clear();
          _mobileAsrStarting = false;
        }
      case DesktopCommand_EndAudio(:final turnId, :final revision):
        if (route.asr != ExecutionDevice.mobile ||
            _asrBaseRevisionByTurn[turnId] != revision) {
          return;
        }
        _mobileAsrActive = false;
        await processing.finishAsr();
      case DesktopCommand_RunAzookey(
        :final sessionId,
        :final turnId,
        :final revision,
        :final text,
        :final isFinal,
      ):
        onRouteControlsEnabled(enabled: false);
        if (route.azookey != ExecutionDevice.mobile ||
            !_acceptRevision(turnId, revision)) {
          return;
        }
        await _runAzooKey(
          sessionId: sessionId,
          turnId: turnId,
          revision: revision,
          text: text,
          isFinal: isFinal,
        );
      case DesktopCommand_RunTranslation(
        :final sessionId,
        :final turnId,
        :final revision,
        :final sourceText,
      ):
        onRouteControlsEnabled(enabled: false);
        if (!_translationEnabled ||
            route.translation != ExecutionDevice.mobile ||
            !_acceptRevision(turnId, revision)) {
          return;
        }
        await _runTranslation(
          sessionId: sessionId,
          turnId: turnId,
          revision: revision,
          text: sourceText,
        );
      case DesktopCommand_SetTranslationEnabled(:final enabled):
        _translationEnabled = enabled;
        if (!enabled) onTranslation('');
      case DesktopCommand_StopSession():
        onRouteControlsEnabled(enabled: true);
        _mobileAsrStarting = false;
        _mobileAsrActive = false;
        _pendingPcm.clear();
        _latestRevisionByTurn.clear();
        _asrBaseRevisionByTurn.clear();
        await processing.cancel();
        onStatus('デスクトップがセッションを停止しました');
      case DesktopCommand_Ping():
        // WebSocket ping/pong already keeps the connection alive. The control
        // ping is accepted so older desktop builds do not terminate a session.
        break;
    }
  }

  void _handleProcessingEvent(ProcessingEvent event) {
    switch (event) {
      case AsrProcessingEvent(
        :final sessionId,
        :final turnId,
        :final revision,
        :final text,
        :final isFinal,
      ):
        if (route.asr != ExecutionDevice.mobile ||
            _asrBaseRevisionByTurn[turnId] != revision) {
          return;
        }
        final outputRevision =
            (_latestRevisionByTurn[turnId] ?? revision) + BigInt.one;
        _latestRevisionByTurn[turnId] = outputRevision;
        onSource(text);
        transport.sendText(
          encodeStageResult(
            stage: ProcessingStage.asr,
            sessionId: sessionId,
            turnId: turnId,
            revision: outputRevision,
            text: text,
            isFinal: isFinal,
          ),
        );
        if (shouldContinueOnMobile(
          route: route,
          completedStage: ProcessingStage.asr,
        )) {
          unawaited(
            _runAzooKey(
              sessionId: sessionId,
              turnId: turnId,
              revision: outputRevision,
              text: text,
              isFinal: isFinal,
            ),
          );
        }
      case ProcessingErrorEvent(:final stage, :final message):
        onStatus('$stage エラー: $message');
    }
  }

  Future<void> _runAzooKey({
    required String sessionId,
    required BigInt turnId,
    required BigInt revision,
    required String text,
    required bool isFinal,
  }) async {
    try {
      final output = await convertAzookey(reading: text);
      if (!_isCurrent(turnId, revision)) return;
      onAzooKey(output.text);
      transport.sendText(
        encodeStageResult(
          stage: ProcessingStage.azookey,
          sessionId: sessionId,
          turnId: turnId,
          revision: revision,
          text: output.text,
          isFinal: isFinal,
        ),
      );
      if (_translationEnabled &&
          shouldContinueOnMobile(
            route: route,
            completedStage: ProcessingStage.azookey,
          )) {
        await _runTranslation(
          sessionId: sessionId,
          turnId: turnId,
          revision: revision,
          text: output.text,
        );
      }
    } on Object catch (error) {
      onStatus('AzooKey エラー: $error');
    }
  }

  Future<void> _runTranslation({
    required String sessionId,
    required BigInt turnId,
    required BigInt revision,
    required String text,
  }) async {
    try {
      final translated = await processing.translate(
        text: text,
        sourceLanguage: 'ja',
        targetLanguage: 'en',
      );
      if (!_isCurrent(turnId, revision)) return;
      onTranslation(translated);
      transport.sendText(
        encodeStageResult(
          stage: ProcessingStage.translation,
          sessionId: sessionId,
          turnId: turnId,
          revision: revision,
          text: translated,
          isFinal: true,
        ),
      );
    } on Object catch (error) {
      onStatus('翻訳エラー: $error');
    }
  }

  Future<void> _configureRoute(PipelineRoute nextRoute) async {
    if (route == nextRoute) return;
    await processing.cancel();
    _mobileAsrStarting = false;
    _mobileAsrActive = false;
    _pendingPcm.clear();
    await onRouteRequested(nextRoute);
    route = nextRoute;
  }

  bool _acceptRevision(BigInt turnId, BigInt revision) {
    final current = _latestRevisionByTurn[turnId];
    if (current != null && revision < current) return false;
    _latestRevisionByTurn[turnId] = revision;
    return true;
  }

  bool _isCurrent(BigInt turnId, BigInt revision) =>
      _latestRevisionByTurn[turnId] == revision;

  void _reportProcessingError(Object error) {
    onStatus('音声処理エラー: $error');
  }
}
