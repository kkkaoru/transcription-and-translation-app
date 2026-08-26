import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/main.dart' as app;
import 'package:kotoba_beacon_companion/src/companion_connection.dart';
import 'package:kotoba_beacon_companion/src/native_processing.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';

import 'rust_test_library.dart';

const _testCapabilities = MobileCapabilities(
  deviceId: 'android-widget-1',
  deviceName: 'Widget test',
  platform: 'android',
  asrAvailable: true,
  azookeyAvailable: true,
  translationAvailable: true,
);

void main() {
  setUpAll(initializeRustTestLibrary);
  setUp(_initializeWidgetDictionary);
  testWidgets('boots through the production entrypoint', _testProductionMain);
  testWidgets(
    'connects, publishes all mobile results, and disconnects',
    _testMobileConnectionLifecycle,
  );
  testWidgets(
    'keeps route toggles disabled until capabilities are detected',
    _testMobileDefaults,
  );
  testWidgets(
    'disables unsupported mobile APIs after capability detection',
    _testUnsupportedCapabilities,
  );
  testWidgets(
    'reports a desktop-only connection failure and restores controls',
    _testConnectionFailure,
  );
  testWidgets(
    'releases a prepared dictionary when AzooKey moves to Desktop',
    _testPreparedDictionaryRelease,
  );
}

Future<void> _testProductionMain(WidgetTester tester) async {
  await app.startCompanion(
    initializeRust: () async {},
    root: const MaterialApp(
      home: app.CompanionHomePage(
        initialRoute: PipelineRoute(
          asr: ExecutionDevice.desktop,
          azookey: ExecutionDevice.desktop,
          translation: ExecutionDevice.desktop,
        ),
      ),
    ),
  );
  await tester.pump();

  expect(find.byType(app.CompanionHomePage), findsOneWidget);
  await tester.enterText(
    find.widgetWithText(TextField, 'Desktop WebSocket endpoint'),
    'https://invalid.example/companion',
  );
  final connectButton = find.widgetWithText(
    FilledButton,
    'デスクトップへ接続',
  );
  await tester.ensureVisible(connectButton);
  tester.widget<FilledButton>(connectButton).onPressed?.call();
  await tester.pump();

  expect(find.byType(app.CompanionHomePage), findsOneWidget);
}

Future<void> _initializeWidgetDictionary() async {
  await initializeAzookeyDictionary(
    bytes: await File('assets/azookey/system.azkdict.gz').readAsBytes(),
  );
}

Future<void> _testMobileDefaults(WidgetTester tester) async {
  await tester.pumpWidget(const app.KotobaBeaconCompanionApp());

  expect(find.text('Kotoba Beacon Companion'), findsOneWidget);
  expect(find.text('処理場所 (mmm)'), findsOneWidget);
  expect(find.text('ASR'), findsAtLeastNWidgets(1));
  expect(find.text('AzooKey'), findsAtLeastNWidgets(1));
  expect(find.text('翻訳'), findsOneWidget);
  expect(find.text('Mobile'), findsNWidgets(3));

  await _selectEveryDesktopStage(tester);
  expect(find.text('処理場所 (mmm)'), findsOneWidget);
}

Future<void> _testMobileConnectionLifecycle(WidgetTester tester) async {
  final transport = _WidgetTransport();
  final processing = _WidgetProcessing();
  var dictionaryCalls = 0;
  await tester.pumpWidget(
    MaterialApp(
      home: app.CompanionHomePage(
        key: UniqueKey(),
        createTransport: () => transport,
        createProcessing: () => processing,
        prepareAzooKeyDictionary: () async => dictionaryCalls += 1,
      ),
    ),
  );
  final connectButton = find.widgetWithText(
    FilledButton,
    'デスクトップへ接続',
  );
  await tester.ensureVisible(connectButton);
  final connectAction = tester.widget<FilledButton>(connectButton).onPressed;
  expect(connectAction, isNotNull);
  connectAction?.call();
  await tester.pump();
  await tester.runAsync(() => _waitForConnection(transport));
  await tester.pump();

  expect(dictionaryCalls, 1);
  expect(processing.preparedAsrLocales, ['ja-JP']);
  expect(processing.preparedTranslationPairs, ['ja->en']);
  expect(transport.connectCalls, 1);
  expect(find.textContaining('認証応答を待っています / route mmm'), findsOneWidget);

  transport.addText(
    '{"version":1,"type":"session.ready",'
    '"session_id":"widget-session",'
    '"route":{"asr":"mobile","azookey":"mobile",'
    '"translation":"mobile"}}',
  );
  await tester.pump(const Duration(milliseconds: 20));
  expect(find.textContaining('接続済み: widget-session / mmm'), findsOneWidget);

  transport.addText(
    '{"version":1,"type":"audio.start","session_id":"widget-session",'
    '"turn_id":4,"revision":9}',
  );
  await processing.started.future;
  processing.emit(
    AsrProcessingEvent(
      sessionId: 'widget-session',
      turnId: BigInt.from(4),
      revision: BigInt.from(9),
      text: 'きょう',
      isFinal: true,
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));

  expect(find.text('きょう'), findsOneWidget);

  transport.addText(
    '{"version":1,"type":"translation.request",'
    '"session_id":"widget-session","turn_id":4,'
    '"revision":10,"source_text":"今日"}',
  );
  await tester.runAsync(() => _waitForTranslation(processing));
  await tester.pump();
  expect(find.text('Today'), findsOneWidget);

  transport.addText(
    '{"version":1,"type":"session.stop",'
    '"session_id":"widget-session"}',
  );
  await tester.pump(const Duration(milliseconds: 20));

  final routeControls = tester.widgetList<SegmentedButton<ExecutionDevice>>(
    find.byType(SegmentedButton<ExecutionDevice>),
  );
  routeControls.elementAt(2).onSelectionChanged?.call({
    ExecutionDevice.desktop,
  });
  await tester.pump();
  expect(
    decodeMobileRouteRequest(json: transport.sentTexts.last),
    const PipelineRoute(
      asr: ExecutionDevice.mobile,
      azookey: ExecutionDevice.mobile,
      translation: ExecutionDevice.desktop,
    ),
  );

  var sentCount = transport.sentTexts.length;
  routeControls.elementAt(0).onSelectionChanged?.call({
    ExecutionDevice.desktop,
  });
  await tester.runAsync(() => _waitForSentCount(transport, sentCount + 1));
  sentCount = transport.sentTexts.length;
  routeControls.elementAt(0).onSelectionChanged?.call({ExecutionDevice.mobile});
  await tester.runAsync(() => _waitForSentCount(transport, sentCount + 1));
  sentCount = transport.sentTexts.length;
  routeControls.elementAt(2).onSelectionChanged?.call({ExecutionDevice.mobile});
  await tester.runAsync(() => _waitForSentCount(transport, sentCount + 1));
  await tester.pump();
  expect(
    decodeMobileRouteRequest(json: transport.sentTexts.last),
    defaultPipelineRoute(),
  );

  final disconnectButton = find.widgetWithText(FilledButton, '切断');
  await tester.ensureVisible(disconnectButton);
  final disconnectAction = tester
      .widget<FilledButton>(disconnectButton)
      .onPressed;
  expect(disconnectAction, isNotNull);
  disconnectAction?.call();
  await tester.runAsync(() => _waitForDisconnect(processing));
  await tester.pump();

  expect(find.text('切断しました'), findsOneWidget);
  expect(processing.cancelCalls, greaterThanOrEqualTo(1));
}

Future<void> _testUnsupportedCapabilities(WidgetTester tester) async {
  const capabilities = MobileCapabilities(
    deviceId: 'android-limited-1',
    deviceName: 'Limited Android',
    platform: 'android',
    asrAvailable: false,
    azookeyAvailable: true,
    translationAvailable: false,
  );
  final transport = _WidgetTransport();
  final processing = _WidgetProcessing(capabilityReport: capabilities);
  await tester.pumpWidget(
    MaterialApp(
      home: app.CompanionHomePage(
        createTransport: () => transport,
        createProcessing: () => processing,
        prepareAzooKeyDictionary: () async {},
      ),
    ),
  );
  final connectButton = find.widgetWithText(
    FilledButton,
    'デスクトップへ接続',
  );
  tester.widget<FilledButton>(connectButton).onPressed?.call();
  await tester.runAsync(() => _waitForConnection(transport));
  await tester.pump();

  expect(find.text('処理場所 (dmd)'), findsOneWidget);
  expect(transport.connectedRoute?.asr, ExecutionDevice.desktop);
  expect(transport.connectedRoute?.azookey, ExecutionDevice.mobile);
  expect(transport.connectedRoute?.translation, ExecutionDevice.desktop);
  expect(processing.preparedAsrLocales, isEmpty);
  expect(processing.preparedTranslationPairs, isEmpty);
  final controls = tester.widgetList<SegmentedButton<ExecutionDevice>>(
    find.byType(SegmentedButton<ExecutionDevice>),
  );
  expect(controls.elementAt(0).segments[1].enabled, isFalse);
  expect(controls.elementAt(1).segments[1].enabled, isTrue);
  expect(controls.elementAt(2).segments[1].enabled, isFalse);
}

Future<void> _testConnectionFailure(WidgetTester tester) async {
  final transport = _WidgetTransport(
    connectError: const SocketException('pairing rejected'),
  );
  final processing = _WidgetProcessing();
  await tester.pumpWidget(
    MaterialApp(
      home: app.CompanionHomePage(
        key: UniqueKey(),
        initialRoute: const PipelineRoute(
          asr: ExecutionDevice.desktop,
          azookey: ExecutionDevice.desktop,
          translation: ExecutionDevice.desktop,
        ),
        createTransport: () => transport,
        createProcessing: () => processing,
      ),
    ),
  );

  final connectButton = find.widgetWithText(
    FilledButton,
    'デスクトップへ接続',
  );
  await tester.ensureVisible(connectButton);
  tester.widget<FilledButton>(connectButton).onPressed?.call();
  await tester.pump();
  await tester.runAsync(() => _waitForConnection(transport));
  await tester.pump();

  expect(find.textContaining('接続失敗: SocketException'), findsOneWidget);
  expect(processing.preparedAsrLocales, isEmpty);
  expect(processing.preparedTranslationPairs, isEmpty);
  expect(find.widgetWithText(FilledButton, 'デスクトップへ接続'), findsOneWidget);
}

Future<void> _testPreparedDictionaryRelease(WidgetTester tester) async {
  final transport = _WidgetTransport();
  final processing = _WidgetProcessing();
  await tester.pumpWidget(
    MaterialApp(
      home: app.CompanionHomePage(
        key: UniqueKey(),
        createTransport: () => transport,
        createProcessing: () => processing,
        prepareAzooKeyDictionary: () async {},
      ),
    ),
  );
  final connectButton = find.widgetWithText(
    FilledButton,
    'デスクトップへ接続',
  );
  await tester.ensureVisible(connectButton);
  tester.widget<FilledButton>(connectButton).onPressed?.call();
  await tester.runAsync(() => _waitForConnection(transport));
  transport.addText(
    '{"version":1,"type":"session.ready",'
    '"session_id":"dictionary-session",'
    '"route":{"asr":"mobile","azookey":"mobile",'
    '"translation":"mobile"}}',
  );
  await tester.pumpAndSettle();

  final controls = tester.widgetList<SegmentedButton<ExecutionDevice>>(
    find.byType(SegmentedButton<ExecutionDevice>),
  );
  expect(controls.elementAt(1).onSelectionChanged, isNotNull);
  controls.elementAt(1).onSelectionChanged?.call({ExecutionDevice.desktop});
  await tester.runAsync(() => _waitForRouteRequest(transport));
  await tester.pump();

  expect(
    decodeMobileRouteRequest(json: transport.sentTexts.last).azookey,
    ExecutionDevice.desktop,
  );
}

Future<void> _selectEveryDesktopStage(WidgetTester tester) async {
  final controls = tester.widgetList<SegmentedButton<ExecutionDevice>>(
    find.byType(SegmentedButton<ExecutionDevice>),
  );
  controls.elementAt(0).onSelectionChanged?.call({ExecutionDevice.desktop});
  controls.elementAt(1).onSelectionChanged?.call({ExecutionDevice.desktop});
  controls.elementAt(2).onSelectionChanged?.call({ExecutionDevice.desktop});
  await tester.pump();
}

Future<void> _waitForSentCount(
  _WidgetTransport transport,
  int expectedCount,
) async {
  for (var attempt = 0; attempt < 1000; attempt += 1) {
    if (transport.sentTexts.length >= expectedCount) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('mobile transport did not send $expectedCount messages');
}

Future<void> _waitForRouteRequest(_WidgetTransport transport) async {
  for (var attempt = 0; attempt < 1000; attempt += 1) {
    if (transport.sentTexts.isNotEmpty) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('mobile route request did not complete');
}

Future<void> _waitForDisconnect(_WidgetProcessing processing) async {
  for (var attempt = 0; attempt < 1000; attempt += 1) {
    if (processing.cancelCalls > 0) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('companion session did not cancel platform processing');
}

Future<void> _waitForTranslation(_WidgetProcessing processing) async {
  for (var attempt = 0; attempt < 1000; attempt += 1) {
    if (processing.translateCalls > 0) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('mobile translation did not complete');
}

Future<void> _waitForConnection(_WidgetTransport transport) async {
  for (var attempt = 0; attempt < 1000; attempt += 1) {
    if (transport.openCalls > 0) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('connection attempt did not complete');
}

final class _WidgetTransport implements CompanionTransport {
  _WidgetTransport({this.connectError});

  final Exception? connectError;
  final _messages = StreamController<Object>.broadcast();
  int openCalls = 0;
  int connectCalls = 0;
  int closeCalls = 0;
  PipelineRoute? connectedRoute;
  final sentTexts = <String>[];

  @override
  Stream<Object> get messages => _messages.stream;

  void addText(String message) => _messages.add(message);

  @override
  Future<void> open({required Uri endpoint}) async {
    openCalls += 1;
    final error = connectError;
    if (error != null) throw error;
  }

  @override
  void authenticate({
    required String token,
    required MobileCapabilities capabilities,
  }) {}

  @override
  void configure({
    required PipelineRoute route,
    required MobileCapabilities capabilities,
  }) {
    connectCalls += 1;
    connectedRoute = route;
  }

  @override
  void sendText(String text) => sentTexts.add(text);

  @override
  Future<void> close() async => closeCalls += 1;
}

final class _WidgetProcessing implements ProcessingBackend {
  _WidgetProcessing({this.capabilityReport = _testCapabilities});

  final MobileCapabilities capabilityReport;
  final _events = StreamController<ProcessingEvent>.broadcast();
  final started = Completer<void>();
  final preparedAsrLocales = <String>[];
  final preparedTranslationPairs = <String>[];
  int cancelCalls = 0;
  int translateCalls = 0;

  @override
  Stream<ProcessingEvent> get events => _events.stream;

  void emit(ProcessingEvent event) => _events.add(event);

  @override
  Future<void> prepareAsr(String locale) async {
    preparedAsrLocales.add(locale);
  }

  @override
  Future<void> prepareTranslation({
    required String sourceLanguage,
    required String targetLanguage,
  }) async {
    preparedTranslationPairs.add('$sourceLanguage->$targetLanguage');
  }

  @override
  Future<void> startAsr({
    required String sessionId,
    required BigInt turnId,
    required BigInt revision,
    required String locale,
  }) async {
    if (!started.isCompleted) started.complete();
  }

  @override
  Future<void> appendPcm(Uint8List pcm16) async {}

  @override
  Future<MobileCapabilities> capabilities() async => capabilityReport;

  @override
  Future<void> cancel() async => cancelCalls += 1;

  @override
  Future<void> finishAsr() async {}

  @override
  Future<String> translate({
    required String text,
    required String sourceLanguage,
    required String targetLanguage,
  }) async {
    translateCalls += 1;
    return 'Today';
  }
}
