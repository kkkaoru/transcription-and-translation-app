import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/src/companion_connection.dart';
import 'package:kotoba_beacon_companion/src/companion_controller.dart';
import 'package:kotoba_beacon_companion/src/native_processing.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';

import 'rust_test_library.dart';

const _testCapabilities = MobileCapabilities(
  deviceId: 'android-test-1',
  deviceName: 'Flutter E2E',
  platform: 'android',
  asrAvailable: true,
  azookeyAvailable: true,
  translationAvailable: true,
);

void main() {
  setUpAll(_initializeEndToEndTest);
  test(
    'WebSocket transport rejects non-LAN endpoint schemes',
    _testInvalidEndpoint,
  );
  test('UDP discovery returns matching authenticated data', _testDiscovery);
  test(
    'real loopback WebSocket completes the mobile-owned pipeline',
    _testLoopbackPipeline,
  );
}

Future<void> _initializeEndToEndTest() async {
  await initializeRustTestLibrary();
  await initializeAzookeyDictionary(
    bytes: await File('assets/azookey/system.azkdict.gz').readAsBytes(),
  );
}

Future<void> _testInvalidEndpoint() async {
  final transport = WebSocketCompanionTransport();

  expect(
    () => transport.sendText('{"version":1,"type":"ping","nonce":1}'),
    throwsStateError,
  );
  await expectLater(
    transport.open(
      endpoint: Uri.parse('https://example.com/companion'),
    ),
    throwsA(
      isA<FormatException>().having(
        (error) => error.message,
        'message',
        'Use a ws:// LAN endpoint',
      ),
    ),
  );

  await transport.dispose();
}

Future<void> _testDiscovery() async {
  final server = await RawDatagramSocket.bind(InternetAddress.loopbackIPv4, 0);
  final subscription = server.listen((event) async {
    if (event != RawSocketEvent.read) return;
    final datagram = server.receive();
    if (datagram == null) return;
    final nonce = await decodeDiscoveryRequest(
      json: utf8.decode(datagram.data),
    );
    final response = await encodeDiscoveryResponse(
      nonce: nonce,
      endpoint: 'ws://127.0.0.1:18183/companion',
      token: '0123456789abcdef0123456789abcdef',
    );
    server.send(utf8.encode(response), datagram.address, datagram.port);
  });

  final discovered = await discoverCompanion(
    broadcastAddress: InternetAddress.loopbackIPv4,
    port: server.port,
    timeout: const Duration(seconds: 1),
  );

  expect(discovered.endpoint, 'ws://127.0.0.1:18183/companion');
  expect(discovered.token, '0123456789abcdef0123456789abcdef');
  await subscription.cancel();
  server.close();
}

Future<void> _testLoopbackPipeline() async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  final peer = _LoopbackPeer();
  server.listen(peer.handleRequest);
  final transport = WebSocketCompanionTransport();
  final processing = _EndToEndProcessing();
  final source = <String>[];
  final azookey = <String>[];
  final translation = <String>[];
  final statuses = <String>[];
  final controller = CompanionController(
    route: defaultPipelineRoute(),
    transport: transport,
    processing: processing,
    onStatus: statuses.add,
    onSource: source.add,
    onAzooKey: azookey.add,
    onTranslation: translation.add,
  );

  await transport.open(
    endpoint: Uri.parse('ws://127.0.0.1:${server.port}/companion'),
  );
  transport
    ..authenticate(
      token: '0123456789abcdef0123456789abcdef',
      capabilities: _testCapabilities,
    )
    ..configure(
      route: defaultPipelineRoute(),
      capabilities: _testCapabilities,
    );
  await Future.any<void>([
    peer.pipelineCompleted.future,
    peer.serverFailure.future,
  ]).timeout(const Duration(seconds: 3));

  expect(
    peer.received[0],
    const [
      '{"version":1,"type":"pair.request",',
      '"token":"0123456789abcdef0123456789abcdef",',
      '"device_name":"Flutter E2E",',
      '"device_id":"android-test-1"}',
    ].join(),
  );
  final configuration = decodeSessionConfiguration(json: peer.received[1]);
  expect(configuration.sessionId, isNotEmpty);
  expect(configuration.route, defaultPipelineRoute());
  expect(
    decodeMobileStageResult(json: peer.received[2]).messageType,
    'asr.update',
  );
  expect(
    decodeMobileStageResult(json: peer.received[3]).messageType,
    'azookey.result',
  );
  expect(
    decodeMobileStageResult(json: peer.received[4]),
    MobileStageResult(
      messageType: 'translation.result',
      sessionId: configuration.sessionId,
      turnId: BigInt.from(12),
      revision: BigInt.from(61),
      text: 'Hello, can you hear me?',
      isFinal: true,
    ),
  );
  expect(processing.pcmFrames, [
    Uint8List.fromList([1, 0, 2, 0]),
  ]);
  expect(source, ['こんにちはきこえますか']);
  expect(azookey.length, 1);
  expect(translation, ['Hello, can you hear me?']);
  expect(statuses, isEmpty);

  await controller.dispose();
  await transport.dispose();
  await processing.dispose();
  await server.close(force: true);
}

final class _LoopbackPeer {
  final received = <String>[];
  final pipelineCompleted = Completer<void>();
  final serverFailure = Completer<void>();

  Future<void> handleRequest(HttpRequest request) async {
    try {
      final socket = await WebSocketTransformer.upgrade(request);
      socket.listen((message) => _handleMessage(socket, message));
    } on Object catch (error, stackTrace) {
      if (serverFailure.isCompleted) return;
      serverFailure.completeError(error, stackTrace);
    }
  }

  void _handleMessage(WebSocket socket, Object? message) {
    if (message is! String) return;
    received.add(message);
    if (received.length == 2) _startAudio(socket, message);
    if (received.length != 5 || pipelineCompleted.isCompleted) return;
    pipelineCompleted.complete();
  }

  void _startAudio(WebSocket socket, String message) {
    final session = decodeSessionConfiguration(json: message);
    socket
      ..add(
        '{"version":1,"type":"audio.start",'
        '"session_id":"${session.sessionId}",'
        '"turn_id":12,"revision":60}',
      )
      ..add(Uint8List.fromList([1, 0, 2, 0]));
  }
}

final class _EndToEndProcessing implements ProcessingBackend {
  final _events = StreamController<ProcessingEvent>.broadcast();
  final pcmFrames = <Uint8List>[];
  late String _sessionId;
  late BigInt _turnId;
  late BigInt _revision;

  @override
  Stream<ProcessingEvent> get events => _events.stream;

  @override
  Future<void> prepareAsr(String locale) async {}

  @override
  Future<void> prepareTranslation({
    required String sourceLanguage,
    required String targetLanguage,
  }) async {}

  @override
  Future<void> startAsr({
    required String sessionId,
    required BigInt turnId,
    required BigInt revision,
    required String locale,
  }) async {
    _sessionId = sessionId;
    _turnId = turnId;
    _revision = revision;
  }

  @override
  Future<void> appendPcm(Uint8List pcm16) async {
    pcmFrames.add(Uint8List.fromList(pcm16));
    _events.add(
      AsrProcessingEvent(
        sessionId: _sessionId,
        turnId: _turnId,
        revision: _revision,
        text: 'こんにちはきこえますか',
        isFinal: true,
      ),
    );
  }

  @override
  Future<MobileCapabilities> capabilities() async => _testCapabilities;

  @override
  Future<void> cancel() async {}

  @override
  Future<void> finishAsr() async {}

  @override
  Future<String> translate({
    required String text,
    required String sourceLanguage,
    required String targetLanguage,
  }) async => 'Hello, can you hear me?';

  Future<void> dispose() => _events.close();
}
