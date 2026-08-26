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
  deviceId: 'android-controller-1',
  deviceName: 'Controller test',
  platform: 'android',
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
    'mobile default publishes ASR, AzooKey, and translation as each completes',
    () async {
      final transport = _FakeTransport();
      final processing = _FakeProcessing();
      final source = <String>[];
      final azookey = <String>[];
      final translation = <String>[];
      final controller = CompanionController(
        route: defaultPipelineRoute(),
        transport: transport,
        processing: processing,
        onStatus: (_) {},
        onSource: source.add,
        onAzooKey: azookey.add,
        onTranslation: translation.add,
      );

      transport.addText(
        '{"version":1,"type":"audio.start","session_id":"s",'
        '"turn_id":1,"revision":4}',
      );
      await processing.started.future;
      processing.emit(
        AsrProcessingEvent(
          sessionId: 's',
          turnId: BigInt.one,
          revision: BigInt.from(4),
          text: 'こんにちは',
          isFinal: true,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 100));

      expect(source, ['こんにちは']);
      expect(azookey, ['こんにちは']);
      expect(translation, ['Hello']);
      expect(transport.sent[0], contains('"type":"asr.update"'));
      expect(transport.sent[0], contains('"revision":5'));
      expect(transport.sent[1], contains('"type":"azookey.result"'));
      expect(transport.sent[1], contains('"revision":5'));
      expect(transport.sent[2], contains('"type":"translation.result"'));
      expect(transport.sent[2], contains('"revision":5'));
      await controller.dispose();
    },
  );

  test(
    'desktop translation toggle stops mobile translation without stopping ASR',
    () async {
      final transport = _FakeTransport();
      final processing = _FakeProcessing();
      final translation = <String>[];
      final controller = CompanionController(
        route: defaultPipelineRoute(),
        transport: transport,
        processing: processing,
        onStatus: (_) {},
        onSource: (_) {},
        onAzooKey: (_) {},
        onTranslation: translation.add,
      );

      transport
        ..addText(
          '{"version":1,"type":"translation.enabled",'
          '"session_id":"s","enabled":false}',
        )
        ..addText(
          '{"version":1,"type":"audio.start","session_id":"s",'
          '"turn_id":3,"revision":1}',
        );
      await processing.started.future;
      processing.emit(
        AsrProcessingEvent(
          sessionId: 's',
          turnId: BigInt.from(3),
          revision: BigInt.one,
          text: 'こんにちは',
          isFinal: true,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(
        transport.sent.where(
          (message) => message.contains('translation.result'),
        ),
        isEmpty,
      );
      expect(translation, ['']);
      await controller.dispose();
    },
  );

  test('buffers bounded PCM while the native ASR model is preparing', () async {
    final transport = _FakeTransport();
    final processing = _FakeProcessing(blockStart: true);
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
      '"turn_id":2,"revision":1}',
    );
    await processing.startEntered.future;
    transport.addPcm(Uint8List.fromList([1, 0, 2, 0]));
    processing.allowStart.complete();
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(processing.pcmFrames, [
      Uint8List.fromList([1, 0, 2, 0]),
    ]);
    await controller.dispose();
  });
}

final class _FakeTransport implements CompanionTransport {
  final _messages = StreamController<Object>.broadcast();
  final sent = <String>[];

  @override
  Stream<Object> get messages => _messages.stream;

  void addText(String value) => _messages.add(value);

  void addPcm(Uint8List value) => _messages.add(value);

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

final class _FakeProcessing implements ProcessingBackend {
  _FakeProcessing({this.blockStart = false});

  final bool blockStart;
  final _events = StreamController<ProcessingEvent>.broadcast();
  final started = Completer<void>();
  final startEntered = Completer<void>();
  final allowStart = Completer<void>();
  final pcmFrames = <Uint8List>[];

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
    if (!startEntered.isCompleted) startEntered.complete();
    if (blockStart) await allowStart.future;
    if (!started.isCompleted) started.complete();
  }

  @override
  Future<void> appendPcm(Uint8List pcm16) async =>
      pcmFrames.add(Uint8List.fromList(pcm16));

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
  }) async => 'Hello';
}
