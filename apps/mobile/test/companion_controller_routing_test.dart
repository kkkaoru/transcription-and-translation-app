import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/src/companion_connection.dart';
import 'package:kotoba_beacon_companion/src/companion_controller.dart';
import 'package:kotoba_beacon_companion/src/native_processing.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';

import 'rust_test_library.dart';

const _testCapabilities = MobileCapabilities(
  deviceId: 'ios-routing-1',
  deviceName: 'Routing test',
  platform: 'ios',
  asrAvailable: true,
  azookeyAvailable: true,
  translationAvailable: true,
);

void main() {
  setUpAll(() async {
    await initializeRustTestLibrary();
    await initializeAzookeyDictionary(
      bytes: await File('assets/azookey/system.azkdict.gz').readAsBytes(),
    );
  });

  test(
    'desktop ASR continues through mobile AzooKey and translation',
    () async {
      final transport = _RoutingTransport();
      final processing = _RoutingProcessing();
      final controller = CompanionController(
        route: const PipelineRoute(
          asr: ExecutionDevice.desktop,
          azookey: ExecutionDevice.mobile,
          translation: ExecutionDevice.mobile,
        ),
        transport: transport,
        processing: processing,
        onStatus: (_) {},
        onSource: (_) {},
        onAzooKey: (_) {},
        onTranslation: (_) {},
      );

      transport.addText(
        '{"version":1,"type":"azookey.request","session_id":"s",'
        '"turn_id":2,"revision":7,"text":"きょう","is_final":true}',
      );
      await Future<void>.delayed(const Duration(milliseconds: 100));

      expect(transport.sent.length, 2);
      expect(transport.sent[0], contains('"type":"azookey.result"'));
      expect(transport.sent[0], contains('"text":"今日"'));
      expect(transport.sent[1], contains('"type":"translation.result"'));
      expect(transport.sent[1], contains('"text":"Today"'));
      await controller.dispose();
    },
  );

  test('mobile ASR stops before desktop-owned AzooKey', () async {
    final transport = _RoutingTransport();
    final processing = _RoutingProcessing();
    final controller = CompanionController(
      route: const PipelineRoute(
        asr: ExecutionDevice.mobile,
        azookey: ExecutionDevice.desktop,
        translation: ExecutionDevice.desktop,
      ),
      transport: transport,
      processing: processing,
      onStatus: (_) {},
      onSource: (_) {},
      onAzooKey: (_) {},
      onTranslation: (_) {},
    );

    transport.addText(
      '{"version":1,"type":"audio.start","session_id":"s",'
      '"turn_id":8,"revision":20}',
    );
    await processing.asrStarted.future;
    transport
      ..addPcm(Uint8List.fromList([7, 0, 8, 0]))
      ..addText(
        '{"version":1,"type":"audio.end","session_id":"s",'
        '"turn_id":8,"revision":20}',
      );
    await Future<void>.delayed(const Duration(milliseconds: 20));
    processing.emit(
      AsrProcessingEvent(
        sessionId: 's',
        turnId: BigInt.from(8),
        revision: BigInt.from(20),
        text: 'こんにちは',
        isFinal: true,
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(processing.pcmFrames, [
      Uint8List.fromList([7, 0, 8, 0]),
    ]);
    expect(processing.finishCalls, 1);
    expect(transport.sent.length, 1);
    expect(transport.sent[0], contains('"type":"asr.update"'));
    expect(transport.sent[0], isNot(contains('azookey.result')));
    expect(processing.translateCalls, 0);
    await controller.dispose();
  });

  test('newer translation request suppresses a delayed stale result', () async {
    final transport = _RoutingTransport();
    final processing = _RoutingProcessing(blockTranslations: true);
    final controller = CompanionController(
      route: const PipelineRoute(
        asr: ExecutionDevice.desktop,
        azookey: ExecutionDevice.desktop,
        translation: ExecutionDevice.mobile,
      ),
      transport: transport,
      processing: processing,
      onStatus: (_) {},
      onSource: (_) {},
      onAzooKey: (_) {},
      onTranslation: (_) {},
    );

    transport.addText(
      '{"version":1,"type":"translation.request","session_id":"s",'
      '"turn_id":5,"revision":30,"source_text":"古い"}',
    );
    expect(await processing.translationStarted.stream.first, '古い');
    transport.addText(
      '{"version":1,"type":"translation.request","session_id":"s",'
      '"turn_id":5,"revision":31,"source_text":"新しい"}',
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final secondTranslationStarted = processing.translationStarted.stream.first;
    processing.translationCompletions[0].complete('Old');
    expect(await secondTranslationStarted, '新しい');
    expect(transport.sent, isEmpty);

    processing.translationCompletions[1].complete('New');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(transport.sent.length, 1);
    expect(transport.sent[0], contains('"revision":31'));
    expect(transport.sent[0], contains('"text":"New"'));
    await controller.dispose();
  });

  test('ASR preparation buffers at most 64 PCM frames', () async {
    final transport = _RoutingTransport();
    final processing = _RoutingProcessing(blockAsrStart: true);
    final controller = CompanionController(
      route: defaultPipelineRoute(),
      transport: transport,
      processing: processing,
      onStatus: (_) {},
      onSource: (_) {},
      onAzooKey: (_) {},
      onTranslation: (_) {},
    );

    transport.addText(
      '{"version":1,"type":"audio.start","session_id":"s",'
      '"turn_id":9,"revision":40}',
    );
    await processing.asrStartEntered.future;
    for (var index = 0; index < 65; index += 1) {
      transport.addPcm(Uint8List.fromList([index, 0]));
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
    processing.allowAsrStart.complete();
    await processing.asrStarted.future;
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(processing.pcmFrames.length, 64);
    expect(processing.pcmFrames.first, Uint8List.fromList([0, 0]));
    expect(processing.pcmFrames.last, Uint8List.fromList([63, 0]));
    await controller.dispose();
  });

  test('session readiness and transport errors are surfaced', () async {
    final transport = _RoutingTransport();
    final processing = _RoutingProcessing();
    final statuses = <String>[];
    final connectionStates = <bool>[];
    final routeControlStates = <bool>[];
    final controller = CompanionController(
      route: defaultPipelineRoute(),
      transport: transport,
      processing: processing,
      onStatus: statuses.add,
      onConnectionChanged: ({required connected}) {
        connectionStates.add(connected);
      },
      onRouteControlsEnabled: ({required enabled}) {
        routeControlStates.add(enabled);
      },
      onSource: (_) {},
      onAzooKey: (_) {},
      onTranslation: (_) {},
    );

    transport
      ..addText(
        '{"version":1,"type":"session.ready","session_id":"session-1",'
        '"route":{"asr":"mobile","azookey":"mobile",'
        '"translation":"mobile"}}',
      )
      ..addError(StateError('socket failed'));
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(statuses, contains('接続済み: session-1 / mmm'));
    expect(
      statuses,
      contains(contains('接続エラー: Bad state: socket failed')),
    );
    expect(connectionStates, containsAllInOrder([false, true]));
    expect(routeControlStates, containsAllInOrder([false, true]));
    transport.addText(
      '{"version":1,"type":"route.configure",'
      '"route":{"asr":"desktop","azookey":"mobile",'
      '"translation":"desktop"}}',
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(controller.route.asr, ExecutionDevice.desktop);
    expect(controller.route.azookey, ExecutionDevice.mobile);
    expect(controller.route.translation, ExecutionDevice.desktop);
    expect(statuses, contains('設定同期済み: dmd'));
    expect(routeControlStates.last, isTrue);
    await controller.dispose();
  });

  test('protocol and provider errors are surfaced without output', () async {
    final transport = _RoutingTransport();
    final processing = _RoutingProcessing();
    final statuses = <String>[];
    final controller = CompanionController(
      route: defaultPipelineRoute(),
      transport: transport,
      processing: processing,
      onStatus: statuses.add,
      onSource: (_) {},
      onAzooKey: (_) {},
      onTranslation: (_) {},
    );

    transport.addText('{"version":2,"type":"ping","nonce":1}');
    processing.emit(
      const ProcessingErrorEvent(stage: 'asr', message: 'model unavailable'),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(statuses.length, 2);
    expect(statuses[0], contains('unsupported companion protocol version: 2'));
    expect(statuses[1], 'asr エラー: model unavailable');
    expect(transport.sent, isEmpty);
    await controller.dispose();
  });

  test(
    'session stop clears ASR state and rejects a late provider event',
    () async {
      final transport = _RoutingTransport();
      final processing = _RoutingProcessing();
      final statuses = <String>[];
      final controller = CompanionController(
        route: defaultPipelineRoute(),
        transport: transport,
        processing: processing,
        onStatus: statuses.add,
        onSource: (_) {},
        onAzooKey: (_) {},
        onTranslation: (_) {},
      );

      transport.addText(
        '{"version":1,"type":"audio.start","session_id":"s",'
        '"turn_id":10,"revision":50}',
      );
      await processing.asrStarted.future;
      transport.addText('{"version":1,"type":"session.stop","session_id":"s"}');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      processing.emit(
        AsrProcessingEvent(
          sessionId: 's',
          turnId: BigInt.from(10),
          revision: BigInt.from(50),
          text: '遅延結果',
          isFinal: true,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(processing.cancelCalls, 1);
      expect(transport.sent, isEmpty);
      expect(statuses, ['デスクトップがセッションを停止しました']);
      await controller.dispose();
    },
  );
}

final class _RoutingTransport implements CompanionTransport {
  final _messages = StreamController<Object>.broadcast();
  final sent = <String>[];

  @override
  Stream<Object> get messages => _messages.stream;

  void addText(String value) => _messages.add(value);

  void addPcm(Uint8List value) => _messages.add(value);

  void addError(Object error) => _messages.addError(error);

  @override
  Future<void> open({required Uri endpoint}) async {}

  @override
  void authenticate({
    required String token,
    required MobileCapabilities capabilities,
  }) {}

  @override
  void configure({
    required PipelineRoute route,
    required MobileCapabilities capabilities,
  }) {}

  @override
  void sendText(String text) => sent.add(text);

  @override
  Future<void> close() async {}
}

final class _RoutingProcessing implements ProcessingBackend {
  _RoutingProcessing({
    this.blockAsrStart = false,
    this.blockTranslations = false,
  });

  final bool blockAsrStart;
  final bool blockTranslations;
  final _events = StreamController<ProcessingEvent>.broadcast();
  final asrStartEntered = Completer<void>();
  final asrStarted = Completer<void>();
  final allowAsrStart = Completer<void>();
  final translationStarted = StreamController<String>.broadcast();
  final translationCompletions = <Completer<String>>[];
  final pcmFrames = <Uint8List>[];
  int translateCalls = 0;
  int cancelCalls = 0;
  int finishCalls = 0;

  @override
  Stream<ProcessingEvent> get events => _events.stream;

  void emit(ProcessingEvent event) => _events.add(event);

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
    if (!asrStartEntered.isCompleted) asrStartEntered.complete();
    if (blockAsrStart) await allowAsrStart.future;
    if (!asrStarted.isCompleted) asrStarted.complete();
  }

  @override
  Future<void> appendPcm(Uint8List pcm16) async =>
      pcmFrames.add(Uint8List.fromList(pcm16));

  @override
  Future<MobileCapabilities> capabilities() async => _testCapabilities;

  @override
  Future<void> cancel() async => cancelCalls += 1;

  @override
  Future<void> finishAsr() async => finishCalls += 1;

  @override
  Future<String> translate({
    required String text,
    required String sourceLanguage,
    required String targetLanguage,
  }) async {
    translateCalls += 1;
    if (!blockTranslations) return 'Today';
    final completion = Completer<String>();
    translationCompletions.add(completion);
    translationStarted.add(text);
    return completion.future;
  }
}
