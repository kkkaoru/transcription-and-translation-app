import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';

/// Transport boundary between Flutter processing and Native on the trusted LAN.
abstract interface class CompanionTransport {
  /// Ordered text commands and binary PCM frames received from Native.
  Stream<Object> get messages;

  /// Opens the LAN WebSocket before platform capability detection.
  Future<void> open({required Uri endpoint});

  /// Authenticates the opened socket with the stable platform identity.
  void authenticate({
    required String token,
    required MobileCapabilities capabilities,
  });

  /// Configures the session after required mobile resources are ready.
  void configure({
    required PipelineRoute route,
    required MobileCapabilities capabilities,
  });

  /// Sends one encoded protocol message to Native.
  void sendText(String text);

  /// Closes the active transport session.
  Future<void> close();
}

/// Authenticated WebSocket implementation of [CompanionTransport].
final class WebSocketCompanionTransport implements CompanionTransport {
  final _messages = StreamController<Object>.broadcast();
  WebSocket? _socket;
  StreamSubscription<Object?>? _subscription;

  @override
  Stream<Object> get messages => _messages.stream;

  @override
  Future<void> open({required Uri endpoint}) async {
    if (endpoint.scheme != 'ws' || endpoint.host.isEmpty) {
      throw const FormatException('Use a ws:// LAN endpoint');
    }
    await close();
    final socket = await WebSocket.connect(endpoint.toString())
        .timeout(const Duration(seconds: 8));
    socket.pingInterval = const Duration(seconds: 15);
    _socket = socket;
    _subscription = socket.listen(
      (value) {
        if (value is String) _messages.add(value);
        if (value is List<int>) _messages.add(Uint8List.fromList(value));
      },
      onError: _messages.addError,
      onDone: () => _messages.addError(StateError('Desktop disconnected')),
      cancelOnError: true,
    );
  }

  @override
  void authenticate({
    required String token,
    required MobileCapabilities capabilities,
  }) {
    sendText(
      encodePairRequest(
        token: token,
        deviceId: capabilities.deviceId,
        deviceName: capabilities.deviceName,
      ),
    );
  }

  @override
  void configure({
    required PipelineRoute route,
    required MobileCapabilities capabilities,
  }) {
    sendText(
      encodeSessionConfigure(
        sessionId: DateTime.now().microsecondsSinceEpoch.toString(),
        route: route,
        capabilities: capabilities,
      ),
    );
  }

  @override
  void sendText(String text) {
    final socket = _socket;
    if (socket == null || socket.readyState != WebSocket.open) {
      throw StateError('Desktop is not connected');
    }
    socket.add(text);
  }

  @override
  Future<void> close() async {
    await _subscription?.cancel();
    _subscription = null;
    final socket = _socket;
    _socket = null;
    await socket?.close(
      WebSocketStatus.normalClosure,
      'mobile companion closed',
    );
  }

  /// Releases the socket and message stream owned by this transport.
  Future<void> dispose() async {
    await close();
    await _messages.close();
  }
}
