import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';

const _discoveryPort = 18184;
const _discoveryTimeout = Duration(seconds: 3);
const _processingChannel = MethodChannel('kotoba_beacon/processing');

/// Platform-native trusted-LAN discovery callback.
typedef NativeCompanionDiscovery = Future<Map<String, Object?>> Function(
  Duration timeout,
);

/// Discovers Native on the trusted LAN and returns authenticated connection
/// data.
Future<DiscoveryResponse> discoverCompanion({
  InternetAddress? broadcastAddress,
  int port = _discoveryPort,
  Duration timeout = _discoveryTimeout,
  NativeCompanionDiscovery? nativeDiscovery,
  bool? useNativeDiscovery,
}) async {
  if ((useNativeDiscovery ?? Platform.isIOS) || nativeDiscovery != null) {
    return _discoverWithBonjour(
      timeout,
      nativeDiscovery ?? _invokeNativeDiscovery,
    );
  }
  final socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
  final nonce = BigInt.from(Random.secure().nextInt(0x7fffffff));
  final completion = Completer<DiscoveryResponse>();
  socket.broadcastEnabled = true;
  final subscription = socket.listen((event) {
    if (event != RawSocketEvent.read || completion.isCompleted) return;
    final datagram = socket.receive();
    if (datagram == null) return;
    try {
      final response = decodeDiscoveryResponse(
        json: utf8.decode(datagram.data),
      );
      if (response.nonce == nonce) completion.complete(response);
    } on Object {
      // Ignore unrelated LAN datagrams until the bounded timeout expires.
    }
  });
  try {
    final request = encodeDiscoveryRequest(nonce: nonce);
    socket.send(
      utf8.encode(request),
      broadcastAddress ?? InternetAddress('255.255.255.255'),
      port,
    );
    return await completion.future.timeout(timeout);
  } finally {
    await subscription.cancel();
    socket.close();
  }
}

Future<Map<String, Object?>> _invokeNativeDiscovery(Duration timeout) async {
  final response = await _processingChannel.invokeMapMethod<String, Object?>(
    'discoverCompanion',
    {
      'timeoutMillis': timeout.inMilliseconds,
    },
  );
  if (response == null) {
    throw StateError('Native companion discovery returned no result');
  }
  return response;
}

Future<DiscoveryResponse> _discoverWithBonjour(
  Duration timeout,
  NativeCompanionDiscovery discovery,
) async {
  final response = await discovery(timeout).timeout(timeout);
  final endpoint = response['endpoint'];
  final token = response['token'];
  if (endpoint is! String || token is! String) {
    throw const FormatException('Invalid Bonjour companion response');
  }
  return decodeDiscoveryResponse(
    json: jsonEncode({
      'version': 1,
      'type': 'discovery.response',
      'nonce': 0,
      'endpoint': endpoint,
      'token': token,
    }),
  );
}

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
