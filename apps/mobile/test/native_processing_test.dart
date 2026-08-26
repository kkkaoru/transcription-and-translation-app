import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/src/native_processing.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';

const _processingChannel = MethodChannel('kotoba_beacon/processing');
const _eventControlChannel = MethodChannel('kotoba_beacon/processing_events');

TestDefaultBinaryMessenger get _messenger =>
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  tearDown(_resetPlatformChannels);
  test(
    'native backend sends typed platform requests and validates translation',
    _testTypedPlatformRequests,
  );
  test(
    'native backend validates platform ASR and error events',
    _testPlatformEvents,
  );
  test(
    'native backend rejects absent and malformed capabilities',
    _testInvalidCapabilities,
  );
}

void _resetPlatformChannels() {
  _messenger
    ..setMockMethodCallHandler(_processingChannel, null)
    ..setMockMethodCallHandler(_eventControlChannel, null);
}

Future<void> _testTypedPlatformRequests() async {
  final calls = <MethodCall>[];
  var translationResult = 'Hello';
  _messenger
    ..setMockMethodCallHandler(_processingChannel, (call) async {
      calls.add(call);
      if (call.method == 'capabilities') {
        return <String, Object?>{
          'deviceId': 'android-native-1',
          'deviceName': 'Native test',
          'platform': 'android',
          'asrAvailable': true,
          'translationAvailable': true,
        };
      }
      if (call.method == 'translate') return translationResult;
      return null;
    })
    ..setMockMethodCallHandler(_eventControlChannel, (_) async => null);
  final backend = NativeProcessingBackend();

  expect(
    await backend.capabilities(),
    const MobileCapabilities(
      deviceId: 'android-native-1',
      deviceName: 'Native test',
      platform: 'android',
      asrAvailable: true,
      azookeyAvailable: true,
      translationAvailable: true,
    ),
  );
  await backend.prepareAsr('ja-JP');
  await backend.prepareTranslation(
    sourceLanguage: 'ja',
    targetLanguage: 'en',
  );
  await backend.startAsr(
    sessionId: 'session-1',
    turnId: BigInt.from(3),
    revision: BigInt.from(7),
    locale: 'ja-JP',
  );
  await backend.appendPcm(Uint8List.fromList([1, 0, 2, 0]));
  await backend.finishAsr();
  expect(
    await backend.translate(
      text: 'こんにちは',
      sourceLanguage: 'ja',
      targetLanguage: 'en',
    ),
    'Hello',
  );
  await backend.cancel();

  expect(calls[0].method, 'capabilities');
  expect(calls[0].arguments, isNull);
  expect(calls[1].method, 'prepareAsr');
  expect(calls[1].arguments, {'locale': 'ja-JP'});
  expect(calls[2].method, 'prepareTranslation');
  expect(calls[2].arguments, {
    'sourceLanguage': 'ja',
    'targetLanguage': 'en',
  });
  expect(calls[3].method, 'startAsr');
  expect(calls[3].arguments, {
    'sessionId': 'session-1',
    'turnId': '3',
    'revision': '7',
    'locale': 'ja-JP',
  });
  expect(calls[4].method, 'appendPcm');
  expect(calls[4].arguments, Uint8List.fromList([1, 0, 2, 0]));
  expect(calls[5].method, 'finishAsr');
  expect(calls[5].arguments, isNull);
  expect(calls[6].method, 'translate');
  expect(calls[6].arguments, {
    'text': 'こんにちは',
    'sourceLanguage': 'ja',
    'targetLanguage': 'en',
  });
  expect(calls[7].method, 'cancel');
  expect(calls[7].arguments, isNull);

  translationResult = '   ';
  await expectLater(
    backend.translate(
      text: '空',
      sourceLanguage: 'ja',
      targetLanguage: 'en',
    ),
    throwsA(
      isA<StateError>().having(
        (error) => error.message,
        'message',
        'The platform translator returned no text',
      ),
    ),
  );
  await backend.dispose();
}

Future<void> _testInvalidCapabilities() async {
  _messenger
    ..setMockMethodCallHandler(_processingChannel, (_) async => null)
    ..setMockMethodCallHandler(_eventControlChannel, (_) async => null);
  final absentBackend = NativeProcessingBackend();
  await expectLater(absentBackend.capabilities(), throwsStateError);
  await absentBackend.dispose();

  _messenger.setMockMethodCallHandler(
    _processingChannel,
    (_) async => <String, Object?>{
      'deviceId': 7,
      'deviceName': 'Broken',
      'platform': 'android',
      'asrAvailable': true,
      'translationAvailable': true,
    },
  );
  final malformedBackend = NativeProcessingBackend();
  await expectLater(malformedBackend.capabilities(), throwsStateError);
  await malformedBackend.dispose();
}

Future<void> _testPlatformEvents() async {
  _messenger
    ..setMockMethodCallHandler(_processingChannel, (_) async => null)
    ..setMockMethodCallHandler(_eventControlChannel, (_) async => null);
  final backend = NativeProcessingBackend();
  final events = <ProcessingEvent>[];
  final subscription = backend.events.listen(events.add);
  await Future<void>.delayed(Duration.zero);

  await _sendPlatformEvent(<String, Object?>{
    'type': 'asr',
    'sessionId': 'session-2',
    'turnId': '9',
    'revision': '14',
    'text': 'こんにちは',
    'isFinal': true,
  });
  await _sendPlatformEvent(<String, Object?>{
    'type': 'asr',
    'sessionId': 'session-2',
    'turnId': 'not-a-number',
    'revision': '14',
    'text': 'invalid numeric value',
    'isFinal': true,
  });
  await _sendPlatformEvent(<String, Object?>{
    'type': 'error',
    'stage': 'translation',
    'message': 'model unavailable',
  });
  await _sendPlatformEvent(<String, Object?>{
    'type': 'error',
    'stage': 3,
    'message': false,
  });
  await Future<void>.delayed(Duration.zero);

  expect(events.length, 3);
  expect(
    events[0],
    isA<AsrProcessingEvent>()
        .having((event) => event.sessionId, 'sessionId', 'session-2')
        .having((event) => event.turnId, 'turnId', BigInt.from(9))
        .having((event) => event.revision, 'revision', BigInt.from(14))
        .having((event) => event.text, 'text', 'こんにちは')
        .having((event) => event.isFinal, 'isFinal', true),
  );
  expect(
    events[1],
    isA<ProcessingErrorEvent>()
        .having((event) => event.stage, 'stage', 'translation')
        .having((event) => event.message, 'message', 'model unavailable'),
  );
  expect(
    events[2],
    isA<ProcessingErrorEvent>()
        .having((event) => event.stage, 'stage', 'platform')
        .having((event) => event.message, 'message', 'Unknown error'),
  );

  await subscription.cancel();
  await backend.dispose();
}

Future<void> _sendPlatformEvent(Map<String, Object?> event) =>
    _messenger.handlePlatformMessage(
      'kotoba_beacon/processing_events',
      const StandardMethodCodec().encodeSuccessEnvelope(event),
      (_) {},
    );
