import 'dart:async';
import 'dart:typed_data';

import 'package:kotoba_beacon_companion/src/companion_connection.dart';
import 'package:kotoba_beacon_companion/src/native_processing.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';

Future<void> _acceptRoute(PipelineRoute route) async {}

void _ignoreRouteControlState({required bool enabled}) {}

void _ignoreConnectionState({required bool connected}) {}

String _defaultConnectedStatus(String sessionId, String routeId) =>
    '接続済み: $sessionId / $routeId';

String _defaultSyncedStatus(String routeId) => '設定同期済み: $routeId';

/// Reports whether the authenticated session is idle enough to change routes.
typedef RouteControlsChanged = void Function({required bool enabled});

final class _AzooKeyRequest {
  const _AzooKeyRequest({
    required this.sessionId,
    required this.turnId,
    required this.revision,
    required this.text,
    required this.isFinal,
  });

  final String sessionId;
  final BigInt turnId;
  final BigInt revision;
  final String text;
  final bool isFinal;
}

final class _TranslationRequest {
  const _TranslationRequest({
    required this.sessionId,
    required this.turnId,
    required this.revision,
    required this.text,
    required this.isFinal,
  });

  final String sessionId;
  final BigInt turnId;
  final BigInt revision;
  final String text;
  final bool isFinal;
}

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
    this.onConnectionChanged = _ignoreConnectionState,
    this.connectedStatus = _defaultConnectedStatus,
    this.syncedStatus = _defaultSyncedStatus,
  }) {
    _transportSubscription = transport.messages.listen(
      _handleTransportMessage,
      onError: _handleTransportError,
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

  /// Formats the authenticated connection status line.
  final String Function(String sessionId, String routeId) connectedStatus;

  /// Formats the synchronized-route status line.
  final String Function(String routeId) syncedStatus;

  /// Reports whether Native acknowledged the authenticated session.
  final void Function({required bool connected}) onConnectionChanged;

  /// Receives accepted ASR source text immediately.
  final void Function(String text) onSource;

  /// Receives accepted AzooKey conversion text immediately.
  final void Function(String text) onAzooKey;

  /// Receives accepted translation text immediately.
  final void Function(String text) onTranslation;

  static const _maxPendingPcmFrames = 64;

  final Map<BigInt, BigInt> _latestRevisionByTurn = <BigInt, BigInt>{};
  final Map<BigInt, BigInt> _asrBaseRevisionByTurn = <BigInt, BigInt>{};
  BigInt? _latestTurnId;
  final List<Uint8List> _pendingPcm = <Uint8List>[];
  StreamSubscription<Object>? _transportSubscription;
  StreamSubscription<ProcessingEvent>? _processingSubscription;
  Future<void> _commandTail = Future<void>.value();
  bool _mobileAsrStarting = false;
  bool _mobileAsrActive = false;
  bool _azooKeyRunning = false;
  bool _translationRunning = false;
  bool _translationEnabled = true;
  _AzooKeyRequest? _pendingAzooKey;
  _TranslationRequest? _pendingTranslation;

  /// Stops subscriptions after the transport has already failed.
  ///
  /// The transport cancellation is deliberately not awaited because this can
  /// be called from that subscription's own `onError` callback.
  void disposeAfterTransportFailure() {
    final transportSubscription = _transportSubscription;
    final processingSubscription = _processingSubscription;
    _transportSubscription = null;
    _processingSubscription = null;
    if (transportSubscription != null) {
      unawaited(transportSubscription.cancel());
    }
    if (processingSubscription != null) {
      unawaited(processingSubscription.cancel());
    }
    _pendingAzooKey = null;
    _pendingTranslation = null;
    unawaited(processing.cancel());
  }

  /// Stops subscriptions, platform processing, and the transport session.
  Future<void> dispose() async {
    _pendingAzooKey = null;
    _pendingTranslation = null;
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
        onConnectionChanged(connected: true);
        onRouteControlsEnabled(enabled: true);
        onStatus(connectedStatus(sessionId, pipelineRouteId(route: route)));
      case DesktopCommand_ConfigureRoute(:final route):
        await _configureRoute(route);
        onRouteControlsEnabled(enabled: true);
        onStatus(syncedStatus(pipelineRouteId(route: route)));
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
        _scheduleAzooKey(
          _AzooKeyRequest(
            sessionId: sessionId,
            turnId: turnId,
            revision: revision,
            text: text,
            isFinal: isFinal,
          ),
        );
      case DesktopCommand_RunTranslation(
        :final sessionId,
        :final turnId,
        :final revision,
        :final sourceText,
        :final isFinal,
      ):
        onRouteControlsEnabled(enabled: false);
        if (!_translationEnabled ||
            route.translation != ExecutionDevice.mobile ||
            !_acceptRevision(turnId, revision)) {
          return;
        }
        _scheduleTranslation(
          _TranslationRequest(
            sessionId: sessionId,
            turnId: turnId,
            revision: revision,
            text: sourceText,
            isFinal: isFinal,
          ),
        );
      case DesktopCommand_SetTranslationEnabled(:final enabled):
        _translationEnabled = enabled;
        if (!enabled) onTranslation('');
      case DesktopCommand_StopSession():
        _mobileAsrStarting = false;
        _mobileAsrActive = false;
        _pendingPcm.clear();
        _pendingAzooKey = null;
        _pendingTranslation = null;
        _latestRevisionByTurn.clear();
        _asrBaseRevisionByTurn.clear();
        _latestTurnId = null;
        await processing.cancel();
        onRouteControlsEnabled(enabled: true);
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
        if (isFinal &&
            shouldContinueOnMobile(
              route: route,
              completedStage: ProcessingStage.asr,
            )) {
          _scheduleAzooKey(
            _AzooKeyRequest(
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

  void _scheduleAzooKey(_AzooKeyRequest request) {
    _pendingAzooKey = request;
    if (_azooKeyRunning) return;
    _azooKeyRunning = true;
    unawaited(_drainAzooKey());
  }

  Future<void> _drainAzooKey() async {
    while (_pendingAzooKey != null) {
      final request = _pendingAzooKey!;
      _pendingAzooKey = null;
      await _runAzooKey(
        sessionId: request.sessionId,
        turnId: request.turnId,
        revision: request.revision,
        text: request.text,
        isFinal: request.isFinal,
      );
    }
    _azooKeyRunning = false;
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
          isFinal &&
          shouldContinueOnMobile(
            route: route,
            completedStage: ProcessingStage.azookey,
          )) {
        _scheduleTranslation(
          _TranslationRequest(
            sessionId: sessionId,
            turnId: turnId,
            revision: revision,
            text: output.text,
            isFinal: isFinal,
          ),
        );
      }
    } on Object catch (error) {
      onStatus('AzooKey エラー: $error');
    }
  }

  void _scheduleTranslation(_TranslationRequest request) {
    _pendingTranslation = request;
    if (_translationRunning) return;
    _translationRunning = true;
    unawaited(_drainTranslation());
  }

  Future<void> _drainTranslation() async {
    while (_pendingTranslation != null) {
      final request = _pendingTranslation!;
      _pendingTranslation = null;
      await _runTranslation(
        sessionId: request.sessionId,
        turnId: request.turnId,
        revision: request.revision,
        text: request.text,
        isFinal: request.isFinal,
      );
    }
    _translationRunning = false;
  }

  Future<void> _runTranslation({
    required String sessionId,
    required BigInt turnId,
    required BigInt revision,
    required String text,
    required bool isFinal,
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
          isFinal: isFinal,
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
    _pendingAzooKey = null;
    _pendingTranslation = null;
    _latestRevisionByTurn.clear();
    _asrBaseRevisionByTurn.clear();
    _latestTurnId = null;
    await onRouteRequested(nextRoute);
    route = nextRoute;
  }

  bool _acceptRevision(BigInt turnId, BigInt revision) {
    final latestTurn = _latestTurnId;
    if (latestTurn != null && turnId < latestTurn) return false;
    if (latestTurn == null || turnId > latestTurn) {
      _latestTurnId = turnId;
      _latestRevisionByTurn.removeWhere((key, _) => key < turnId);
      _asrBaseRevisionByTurn.removeWhere((key, _) => key < turnId);
    }
    final current = _latestRevisionByTurn[turnId];
    if (current != null && revision < current) return false;
    _latestRevisionByTurn[turnId] = revision;
    return true;
  }

  bool _isCurrent(BigInt turnId, BigInt revision) =>
      _latestTurnId == turnId && _latestRevisionByTurn[turnId] == revision;

  void _handleTransportError(Object error) {
    onConnectionChanged(connected: false);
    onRouteControlsEnabled(enabled: false);
    onStatus('接続エラー: $error');
  }

  void _reportProcessingError(Object error) {
    onStatus('音声処理エラー: $error');
  }
}
