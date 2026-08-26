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
    'native backend runs bounded latest-wins Rust ASR snapshots',
    _testMobileRustAsr,
  );
  test(
    'native backend uses bundled QuickMT when platform translation is absent',
    _testQuickMtTranslation,
  );
  test(
    'native backend selects TranslationSession high fidelity',
    _testHighFidelityTranslation,
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
          'speechTranscriberAvailable': false,
          'sfSpeechRecognizerAvailable': true,
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
  expect(
    await backend.providerAvailability(),
    isA<ProcessingProviderAvailability>()
        .having((value) => value.speechAnalyzer, 'speechAnalyzer', false)
        .having((value) => value.sfSpeechRecognizer, 'sfSpeechRecognizer', true)
        .having(
          (value) => value.translationSession,
          'translationSession',
          true,
        ),
  );
  await backend.configureAsrProvider(
    MobileAsrProvider.platformSFSpeechRecognizer,
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
  expect(calls[1].arguments, {
    'locale': 'ja-JP',
    'provider': 'platformSFSpeechRecognizer',
  });
  expect(calls[2].method, 'prepareTranslation');
  expect(calls[2].arguments, {
    'sourceLanguage': 'ja',
    'targetLanguage': 'en',
    'provider': 'platformTranslationSession',
  });
  expect(calls[3].method, 'startAsr');
  expect(calls[3].arguments, {
    'sessionId': 'session-1',
    'turnId': '3',
    'revision': '7',
    'locale': 'ja-JP',
    'provider': 'platformSFSpeechRecognizer',
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
    'provider': 'platformTranslationSession',
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

Future<void> _testMobileRustAsr() async {
  var prepareCalls = 0;
  var releaseCalls = 0;
  final inputs = <Uint8List>[];
  _messenger
    ..setMockMethodCallHandler(_processingChannel, (call) async {
      if (call.method == 'capabilities') {
        return <String, Object?>{
          'deviceId': 'ios-rust-asr',
          'deviceName': 'iPhone',
          'platform': 'ios',
          'asrAvailable': false,
          'speechTranscriberAvailable': false,
          'sfSpeechRecognizerAvailable': false,
          'translationAvailable': true,
        };
      }
      return null;
    })
    ..setMockMethodCallHandler(_eventControlChannel, (_) async => null);
  final backend = NativeProcessingBackend(
    mobileRustAsr: MobileRustAsrBackend(
      prepare: () async => prepareCalls += 1,
      transcribe: (pcm16) async {
        inputs.add(Uint8List.fromList(pcm16));
        return inputs.length == 1 ? 'きこえ' : 'きこえますか';
      },
      release: () async => releaseCalls += 1,
    ),
  );
  final events = <ProcessingEvent>[];
  final subscription = backend.events.listen(events.add);

  expect((await backend.capabilities()).asrAvailable, isTrue);
  expect((await backend.providerAvailability()).rustSherpaOnnx, isTrue);
  await backend.configureAsrProvider(
    MobileAsrProvider.rustSherpaOnnxReazonSpeech,
  );
  await backend.startAsr(
    sessionId: 'rust-session',
    turnId: BigInt.one,
    revision: BigInt.from(2),
    locale: 'ja-JP',
  );
  await backend.appendPcm(Uint8List(32000));
  await backend.finishAsr();
  await Future<void>.delayed(Duration.zero);

  expect(prepareCalls, 1);
  expect(inputs, hasLength(2));
  expect(
    events.whereType<AsrProcessingEvent>().map((event) => event.text),
    ['きこえ', 'きこえますか'],
  );
  expect(
    events.whereType<AsrProcessingEvent>().map((event) => event.isFinal),
    [false, true],
  );
  await backend.configureAsrProvider(
    MobileAsrProvider.platformSFSpeechRecognizer,
  );
  expect(releaseCalls, 1);
  await subscription.cancel();
  await backend.dispose();
}

Future<void> _testQuickMtTranslation() async {
  final platformCalls = <MethodCall>[];
  var prepareCalls = 0;
  var releaseCalls = 0;
  _messenger
    ..setMockMethodCallHandler(_processingChannel, (call) async {
      platformCalls.add(call);
      if (call.method == 'capabilities') {
        return <String, Object?>{
          'deviceId': 'ios-simulator-1',
          'deviceName': 'iPad Simulator',
          'platform': 'ios',
          'asrAvailable': true,
          'translationAvailable': false,
        };
      }
      return null;
    })
    ..setMockMethodCallHandler(_eventControlChannel, (_) async => null);
  final backend = NativeProcessingBackend(
    quickMtTranslation: QuickMtTranslationBackend(
      prepare: () async => prepareCalls += 1,
      translate: (text) async => text == 'こんにちは' ? 'Hello' : '',
      release: () async => releaseCalls += 1,
    ),
  );

  expect((await backend.capabilities()).translationAvailable, isTrue);
  await backend.prepareTranslation(
    sourceLanguage: 'ja',
    targetLanguage: 'en',
  );
  expect(
    await backend.translate(
      text: 'こんにちは',
      sourceLanguage: 'ja',
      targetLanguage: 'en',
    ),
    'Hello',
  );
  await expectLater(
    backend.prepareTranslation(
      sourceLanguage: 'en',
      targetLanguage: 'ja',
    ),
    throwsArgumentError,
  );
  await backend.releaseTranslation();
  expect(releaseCalls, 1);
  await backend.cancel();

  expect(prepareCalls, 1);
  expect(releaseCalls, 2);
  expect(platformCalls.map((call) => call.method), [
    'capabilities',
    'releaseTranslation',
    'cancel',
  ]);
  await backend.dispose();
}

Future<void> _testHighFidelityTranslation() async {
  final calls = <MethodCall>[];
  _messenger
    ..setMockMethodCallHandler(_processingChannel, (call) async {
      calls.add(call);
      if (call.method == 'translate') return 'High fidelity';
      return null;
    })
    ..setMockMethodCallHandler(_eventControlChannel, (_) async => null);
  final backend = NativeProcessingBackend();

  await backend.configureTranslationProvider(
    MobileTranslationProvider.platformTranslationSessionHighFidelity,
  );
  await backend.prepareTranslation(
    sourceLanguage: 'ja',
    targetLanguage: 'en',
  );
  expect(
    await backend.translate(
      text: '高品質',
      sourceLanguage: 'ja',
      targetLanguage: 'en',
    ),
    'High fidelity',
  );
  expect(calls.map((call) => call.method), [
    'releaseTranslation',
    'prepareTranslation',
    'translate',
  ]);
  expect(calls[1].arguments, {
    'sourceLanguage': 'ja',
    'targetLanguage': 'en',
    'provider': 'platformTranslationSessionHighFidelity',
  });
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
