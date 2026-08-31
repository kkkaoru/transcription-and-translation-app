import 'dart:async';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/main.dart' as app;
import 'package:kotoba_beacon_companion/src/companion_connection.dart';
import 'package:kotoba_beacon_companion/src/companion_l10n.dart';
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

Widget _japaneseShell({required Widget home}) => CompanionL10nScope(
  l10n: CompanionL10n.japanese,
  child: MaterialApp(home: home),
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
    'keeps available provider segments selectable before connection',
    _testMobileDefaults,
  );
  testWidgets(
    'uses a minimal readable type spacing and action vocabulary',
    _testVisualVocabulary,
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
    'reports a dictionary preparation failure in detailed mode',
    _testDictionaryPreparationFailure,
  );
  testWidgets(
    'reports a user-requested discovery timeout in detailed mode',
    _testUserRequestedDiscoveryTimeout,
  );
  testWidgets(
    'handles unavailable and failing system camera actions',
    _testSystemCameraFailures,
  );
  testWidgets(
    'automatically reconnects after an unexpected transport disconnect',
    _testAutomaticReconnect,
  );
  testWidgets(
    'restores manual connection controls after a disconnect',
    _testManualDisconnectRecovery,
  );
  testWidgets(
    'releases a prepared dictionary when AzooKey moves to Desktop',
    _testPreparedDictionaryRelease,
  );
  testWidgets(
    'disables SpeechAnalyzer when SpeechTranscriber is unavailable',
    _testUnavailableSpeechTranscriber,
  );
  testWidgets(
    'uses Cupertino controls and acknowledged routes on iOS and iPadOS',
    _testCupertinoInterface,
  );
  testWidgets(
    'uses two panes in iPad landscape and one pane in portrait',
    _testIPadResponsiveLayout,
  );
  testWidgets(
    'keeps standard mode to Desktop and Mobile Rust',
    _testStandardModeChoices,
  );
  testWidgets(
    'pairs from a camera QR link and hides connection actions',
    _testQrPairingLink,
  );
  testWidgets(
    'renders English copy when the locale is English',
    _testEnglishCopy,
  );
  testWidgets(
    'does not treat a missed desktop as an error in standard mode',
    _testStandardModeHidesDiscoveryFailure,
  );
  testWidgets(
    'uses tablet copy on a large Android screen',
    _testAndroidTabletNoun,
  );
}

Future<void> _testProductionMain(WidgetTester tester) async {
  await app.startCompanion(
    initializeRust: () async {},
    root: _japaneseShell(
      home: const app.CompanionHomePage(
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
  await _showDetailedMode(tester);
  await tester.enterText(
    find.widgetWithText(TextField, 'デスクトップのWebSocketエンドポイント'),
    'https://invalid.example/companion',
  );
  final connectButton = find.widgetWithText(
    FilledButton,
    '接続する',
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
  _setPhoneView(tester);
  await tester.pumpWidget(
    const app.KotobaBeaconCompanionApp(locale: Locale('ja')),
  );

  expect(find.byType(MaterialApp), findsOneWidget);
  expect(find.byType(CupertinoApp), findsNothing);
  expect(find.text('Kotoba Beacon Companion'), findsOneWidget);
  expect(find.byKey(const Key('menu-button')), findsOneWidget);
  expect(find.text('表示モード'), findsNothing);
  expect(find.text('連携機能'), findsOneWidget);
  expect(find.text('接続情報'), findsNothing);
  expect(find.text('エンドポイント'), findsNothing);
  expect(find.text('ペアリングトークン'), findsNothing);
  expect(find.text('文字起こし'), findsOneWidget);
  expect(find.text('日本語変換'), findsOneWidget);
  expect(find.text('翻訳'), findsOneWidget);
  expect(find.text('デスクトップ'), findsNWidgets(3));
  expect(find.text('スマホ'), findsNWidgets(3));
  expect(find.text('カメラでQRを読み取る'), findsOneWidget);
  expect(find.text('詳細情報を表示'), findsNothing);
  expect(find.byKey(const Key('processing-details')), findsNothing);
  expect(
    find.byKey(const Key('asr-provider-_AsrChoice.androidMlKit')),
    findsNothing,
  );
  expect(
    find.byKey(const Key('azookey-provider-_AzooKeyChoice.mobileXsmall')),
    findsNothing,
  );
  await _showDetailedMode(tester);
  expect(find.text('エンドポイント'), findsOneWidget);
  expect(find.text('ペアリングトークン'), findsWidgets);
  expect(
    tester.getTopLeft(find.textContaining('接続状態')).dy,
    lessThan(tester.getTopLeft(find.text('連携機能')).dy),
  );
  expect(
    tester.getTopLeft(find.textContaining('接続状態')).dy,
    lessThan(
      tester.getTopLeft(find.widgetWithText(FilledButton, '接続する')).dy,
    ),
  );
  expect(find.text('Android ML Kit Speech'), findsOneWidget);
  expect(find.text('Mobile Rust（QuickMT）'), findsOneWidget);
  expect(find.text('Mobile Rust（AzooKey Small）'), findsOneWidget);
  expect(find.text('Mobile Rust（AzooKey XSmall）'), findsOneWidget);
  expect(find.text('詳細情報を表示'), findsOneWidget);
  expect(find.byKey(const Key('processing-details')), findsOneWidget);
  expect(find.byKey(const Key('connection-details')), findsNothing);
  expect(find.byKey(const Key('asr-details')), findsNothing);
  expect(find.byKey(const Key('azookey-details')), findsNothing);
  expect(find.byKey(const Key('translation-details')), findsNothing);
  expect(find.text('同期済みルート: mmm'), findsNothing);
  expect(
    tester
        .widget<GestureDetector>(
          find.byKey(const Key('asr-provider-_AsrChoice.androidMlKit')),
        )
        .onTap,
    isNotNull,
  );
  expect(find.byIcon(Icons.radio_button_checked), findsNothing);
  expect(find.byIcon(Icons.radio_button_unchecked), findsNothing);
  await _tapVisible(
    tester,
    find.byKey(
      const Key('translation-provider-_TranslationChoice.desktopNative'),
    ),
  );
  await tester.pump();
  expect(find.textContaining('を選択しました'), findsNothing);
}

Future<void> _testVisualVocabulary(WidgetTester tester) async {
  await tester.pumpWidget(
    const app.KotobaBeaconCompanionApp(locale: Locale('ja')),
  );

  final materialApp = tester.widget<MaterialApp>(find.byType(MaterialApp));
  final theme = materialApp.theme!;
  expect(theme.textTheme.bodyMedium?.fontSize, 16);
  expect(theme.textTheme.bodyMedium?.fontWeight, FontWeight.w400);
  expect(theme.textTheme.labelLarge?.fontSize, 16);
  expect(theme.textTheme.labelLarge?.fontWeight, FontWeight.w600);
  expect(theme.textTheme.titleLarge?.fontSize, 20);
  expect(theme.textTheme.titleLarge?.fontWeight, FontWeight.w600);
  expect(find.byType(FilledButton), findsOneWidget);
  expect(find.byType(OutlinedButton), findsOneWidget);
  expect(
    tester.getSize(find.byType(FilledButton)).height,
    greaterThanOrEqualTo(48),
  );
  expect(
    tester.getSize(find.byType(OutlinedButton)).height,
    greaterThanOrEqualTo(48),
  );
  expect(
    tester.getSize(find.byKey(const Key('azookey-provider'))).height,
    greaterThanOrEqualTo(48),
  );
}

Future<void> _testMobileConnectionLifecycle(WidgetTester tester) async {
  final transport = _WidgetTransport();
  final processing = _WidgetProcessing();
  var dictionaryCalls = 0;
  final preparedModels = <AzooKeyModel>[];
  await tester.pumpWidget(
    _japaneseShell(
      home: app.CompanionHomePage(
        key: UniqueKey(),
        createTransport: () => transport,
        createProcessing: () => processing,
        prepareAzooKeyDictionary: () async => dictionaryCalls += 1,
        prepareAzooKeyModel: (model) async => preparedModels.add(model),
      ),
    ),
  );
  await _showDetailedMode(tester);
  await _tapVisible(
    tester,
    find.byKey(const Key('asr-provider-_AsrChoice.androidMlKit')),
  );
  await tester.pump();
  final connectButton = find.widgetWithText(
    FilledButton,
    '接続する',
  );
  await tester.ensureVisible(connectButton);
  final connectAction = tester.widget<FilledButton>(connectButton).onPressed;
  expect(connectAction, isNotNull);
  connectAction?.call();
  await tester.pump();
  await tester.runAsync(() => _waitForConnection(transport));
  await tester.pump();

  expect(dictionaryCalls, 1);
  expect(preparedModels, [AzooKeyModel.small]);
  expect(processing.preparedAsrLocales, isEmpty);
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
  expect(find.text('接続状態: 認証済み'), findsOneWidget);
  expect(find.text('同期済みルート: mmm'), findsNothing);
  await _tapVisible(tester, find.text('詳細情報を表示'));
  await tester.pump();
  expect(find.text('同期済みルート: mmm'), findsOneWidget);
  expect(find.textContaining('モバイルAPI'), findsOneWidget);
  final xsmallChoice = find.byKey(
    const Key('azookey-provider-_AzooKeyChoice.mobileXsmall'),
  );
  await tester.ensureVisible(xsmallChoice);
  await tester.pump();
  await tester.tap(xsmallChoice);
  await tester.pumpAndSettle();
  expect(preparedModels, [AzooKeyModel.small, AzooKeyModel.xsmall]);
  expect(find.text('Mobile Rust（AzooKey XSmall）'), findsOneWidget);

  transport.addText(
    '{"version":1,"type":"audio.start","session_id":"widget-session",'
    '"turn_id":4,"revision":9}',
  );
  await processing.started.future;
  final sentBeforeBusySelection = transport.sentTexts.length;
  await _tapVisible(
    tester,
    find.byKey(
      const Key(
        'translation-provider-_TranslationChoice.desktopNative',
      ),
    ),
  );
  await tester.pump();
  expect(transport.sentTexts.length, sentBeforeBusySelection);
  expect(find.textContaining('を選択しました'), findsNothing);

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
    '{"version":1,"type":"azookey.request",'
    '"session_id":"widget-session","turn_id":4,'
    '"revision":10,"text":"きょう","is_final":true}',
  );
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 100)),
  );
  await tester.pump();
  expect(find.text('今日'), findsOneWidget);

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
  await tester.runAsync(
    () => _waitForSentCount(transport, sentBeforeBusySelection + 1),
  );
  await tester.pump();
  expect(
    decodeMobileRouteRequest(json: transport.sentTexts.last),
    const PipelineRoute(
      asr: ExecutionDevice.mobile,
      azookey: ExecutionDevice.mobile,
      translation: ExecutionDevice.desktop,
    ),
  );
  expect(processing.releaseTranslationCalls, 1);
  expect(find.text('同期済みルート: mmm'), findsOneWidget);
  transport.addText(
    '{"version":1,"type":"route.configure",'
    '"route":{"asr":"mobile","azookey":"mobile",'
    '"translation":"desktop"}}',
  );
  await tester.pump(const Duration(milliseconds: 20));
  expect(find.text('同期済みルート: mmd'), findsOneWidget);
  expect(find.text('設定同期済み: mmd'), findsOneWidget);

  var sentCount = transport.sentTexts.length;
  await _tapVisible(
    tester,
    find.byKey(const Key('asr-provider-_AsrChoice.desktopNative')),
  );
  await tester.runAsync(() => _waitForSentCount(transport, sentCount + 1));
  transport.addText(
    '{"version":1,"type":"route.configure",'
    '"route":{"asr":"desktop","azookey":"mobile",'
    '"translation":"desktop"}}',
  );
  await tester.pump(const Duration(milliseconds: 20));

  sentCount = transport.sentTexts.length;
  await _tapVisible(
    tester,
    find.byKey(const Key('asr-provider-_AsrChoice.androidMlKit')),
  );
  await tester.runAsync(() => _waitForSentCount(transport, sentCount + 1));
  transport.addText(
    '{"version":1,"type":"route.configure",'
    '"route":{"asr":"mobile","azookey":"mobile",'
    '"translation":"desktop"}}',
  );
  await tester.pump(const Duration(milliseconds: 20));

  sentCount = transport.sentTexts.length;
  await _tapVisible(
    tester,
    find.byKey(
      const Key('translation-provider-_TranslationChoice.rustQuickMt'),
    ),
  );
  await tester.runAsync(() => _waitForSentCount(transport, sentCount + 1));
  expect(
    decodeMobileRouteRequest(json: transport.sentTexts.last),
    const PipelineRoute(
      asr: ExecutionDevice.mobile,
      azookey: ExecutionDevice.mobile,
      translation: ExecutionDevice.mobile,
    ),
  );
  transport.addText(
    '{"version":1,"type":"route.configure",'
    '"route":{"asr":"mobile","azookey":"mobile",'
    '"translation":"mobile"}}',
  );
  await tester.pump(const Duration(milliseconds: 20));
  expect(find.text('同期済みルート: mmm'), findsOneWidget);

  final disconnectButton = find.widgetWithText(OutlinedButton, '切断する');
  await tester.ensureVisible(disconnectButton);
  final disconnectAction = tester
      .widget<OutlinedButton>(disconnectButton)
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
    _japaneseShell(
      home: app.CompanionHomePage(
        createTransport: () => transport,
        createProcessing: () => processing,
        prepareAzooKeyDictionary: () async {},
        prepareAzooKeyModel: (_) async {},
      ),
    ),
  );
  final connectButton = find.widgetWithText(
    FilledButton,
    '接続する',
  );
  tester.widget<FilledButton>(connectButton).onPressed?.call();
  await tester.runAsync(() => _waitForConnection(transport));
  await tester.pump();
  await _showDetailedMode(tester);

  expect(find.text('連携機能'), findsOneWidget);
  expect(transport.connectedRoute?.asr, ExecutionDevice.desktop);
  expect(transport.connectedRoute?.azookey, ExecutionDevice.mobile);
  expect(transport.connectedRoute?.translation, ExecutionDevice.desktop);
  expect(processing.preparedAsrLocales, isEmpty);
  expect(processing.preparedTranslationPairs, isEmpty);
  expect(
    tester
        .widget<GestureDetector>(
          find.byKey(const Key('asr-provider-_AsrChoice.androidMlKit')),
        )
        .onTap,
    isNull,
  );
  expect(
    find.byKey(const Key('azookey-provider-_AzooKeyChoice.mobileSmall')),
    findsOneWidget,
  );
}

Future<void> _testConnectionFailure(WidgetTester tester) async {
  final transport = _WidgetTransport(
    connectError: const SocketException('pairing rejected'),
  );
  final processing = _WidgetProcessing();
  await tester.pumpWidget(
    _japaneseShell(
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
    '接続する',
  );
  await tester.ensureVisible(connectButton);
  tester.widget<FilledButton>(connectButton).onPressed?.call();
  await tester.pump();
  await tester.runAsync(() => _waitForConnection(transport));
  await tester.pump();

  expect(find.text('接続できませんでした'), findsOneWidget);
  expect(processing.preparedAsrLocales, isEmpty);
  expect(processing.preparedTranslationPairs, isEmpty);
  expect(find.widgetWithText(FilledButton, '接続する'), findsOneWidget);
}

Future<void> _testDictionaryPreparationFailure(WidgetTester tester) async {
  final transport = _WidgetTransport();
  await tester.pumpWidget(
    _japaneseShell(
      home: app.CompanionHomePage(
        key: UniqueKey(),
        createTransport: () => transport,
        createProcessing: _WidgetProcessing.new,
        prepareAzooKeyDictionary: () async {
          throw StateError('dictionary unavailable');
        },
      ),
    ),
  );
  await _showDetailedMode(tester);
  await _tapVisible(tester, find.widgetWithText(FilledButton, '接続する'));
  await tester.runAsync(() => _waitForConnection(transport));
  await tester.pump();

  expect(
    find.textContaining('接続失敗: Bad state: dictionary unavailable'),
    findsOneWidget,
  );
  expect(find.widgetWithText(FilledButton, '接続する'), findsOneWidget);
}

Future<void> _testUserRequestedDiscoveryTimeout(WidgetTester tester) async {
  var discoveryCalls = 0;
  await tester.pumpWidget(
    _japaneseShell(
      home: app.CompanionHomePage(
        key: UniqueKey(),
        createProcessing: _WidgetProcessing.new,
        autoDiscover: true,
        discoverDesktop: () async {
          discoveryCalls += 1;
          throw TimeoutException('Native unavailable');
        },
      ),
    ),
  );
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 20)),
  );
  await tester.pump();
  await _showDetailedMode(tester);
  await _tapVisible(tester, find.byKey(const Key('connection-button')));
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 20)),
  );
  await tester.pump();

  expect(discoveryCalls, 2);
  expect(
    find.textContaining('Nativeを自動検出できません'),
    findsOneWidget,
  );
}

Future<void> _testSystemCameraFailures(WidgetTester tester) async {
  await tester.pumpWidget(
    _japaneseShell(
      home: const app.CompanionHomePage(),
    ),
  );
  await _tapVisible(tester, find.byKey(const Key('camera-button')));
  await tester.pump();
  expect(
    find.text('標準カメラアプリでQRコードを読み取ってください'),
    findsOneWidget,
  );

  await tester.pumpWidget(
    _japaneseShell(
      home: app.CompanionHomePage(
        key: UniqueKey(),
        openSystemCamera: () async {
          throw StateError('camera unavailable');
        },
      ),
    ),
  );
  await _tapVisible(tester, find.byKey(const Key('camera-button')));
  await tester.pump();
  expect(find.text('カメラを開けませんでした'), findsOneWidget);
}

Future<void> _testAutomaticReconnect(WidgetTester tester) async {
  final first = _WidgetTransport();
  final second = _WidgetTransport();
  final transports = [first, second];
  var transportIndex = 0;
  var discoveryCalls = 0;
  await tester.pumpWidget(
    app.KotobaBeaconCompanionApp(
      locale: const Locale('ja'),
      home: app.CompanionHomePage(
        createTransport: () => transports[transportIndex++],
        createProcessing: _WidgetProcessing.new,
        prepareAzooKeyDictionary: () async {},
        prepareAzooKeyModel: (_) async {},
        discoverDesktop: () async {
          discoveryCalls += 1;
          return DiscoveryResponse(
            nonce: BigInt.zero,
            endpoint: 'ws://192.168.1.227:18183/companion',
            token: '0123456789abcdef0123456789abcdef',
          );
        },
        autoDiscover: true,
      ),
    ),
  );
  await tester.runAsync(() => _waitForConfigured(first));
  await tester.pumpAndSettle();
  expect(find.widgetWithText(OutlinedButton, '切断する'), findsOneWidget);
  first.addText(
    '{"version":1,"type":"session.ready","session_id":"first",'
    '"route":{"asr":"desktop","azookey":"mobile",'
    '"translation":"desktop"}}',
  );
  await tester.pump(const Duration(milliseconds: 20));

  await tester.runAsync(() async {
    first.addError(StateError('Desktop disconnected'));
    await Future<void>.delayed(const Duration(milliseconds: 20));
  });
  await tester.pump();
  await tester.runAsync(() => _waitForClose(first));
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 200)),
  );
  await tester.pump();
  final status = tester.widget<Text>(
    find.byKey(const Key('connection-status')),
  );

  expect(discoveryCalls, 2, reason: 'status=${status.data}');
  await tester.runAsync(() => _waitForConfigured(second));
  expect(first.closeCalls, greaterThanOrEqualTo(1));
  expect(second.connectCalls, 1);
}

Future<void> _testManualDisconnectRecovery(WidgetTester tester) async {
  final transport = _WidgetTransport();
  await tester.pumpWidget(
    _japaneseShell(
      home: app.CompanionHomePage(
        initialRoute: const PipelineRoute(
          asr: ExecutionDevice.desktop,
          azookey: ExecutionDevice.desktop,
          translation: ExecutionDevice.desktop,
        ),
        createTransport: () => transport,
        createProcessing: _WidgetProcessing.new,
      ),
    ),
  );
  tester
      .widget<FilledButton>(
        find.widgetWithText(FilledButton, '接続する'),
      )
      .onPressed
      ?.call();
  await tester.runAsync(() => _waitForConfigured(transport));
  await tester.pumpAndSettle();
  await tester.runAsync(() async {
    transport.addError(StateError('Desktop disconnected'));
    await Future<void>.delayed(const Duration(milliseconds: 20));
  });
  await tester.pump();
  await tester.runAsync(() => _waitForClose(transport));
  await tester.pump();

  expect(find.widgetWithText(FilledButton, '接続する'), findsOneWidget);
}

Future<void> _testPreparedDictionaryRelease(WidgetTester tester) async {
  final transport = _WidgetTransport();
  final processing = _WidgetProcessing();
  await tester.pumpWidget(
    _japaneseShell(
      home: app.CompanionHomePage(
        key: UniqueKey(),
        createTransport: () => transport,
        createProcessing: () => processing,
        prepareAzooKeyDictionary: () async {},
        prepareAzooKeyModel: (_) async {},
      ),
    ),
  );
  final connectButton = find.widgetWithText(
    FilledButton,
    '接続する',
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

  final desktopAzooKey = find.byKey(
    const Key('azookey-provider-_AzooKeyChoice.desktopNative'),
  );
  expect(desktopAzooKey, findsOneWidget);
  await tester.ensureVisible(desktopAzooKey);
  await tester.pump();
  await tester.tap(desktopAzooKey);
  await tester.runAsync(() => _waitForRouteRequest(transport));
  await tester.pump();

  expect(
    decodeMobileRouteRequest(json: transport.sentTexts.last).azookey,
    ExecutionDevice.desktop,
  );
}

Future<void> _testUnavailableSpeechTranscriber(WidgetTester tester) async {
  debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
  addTearDown(() => debugDefaultTargetPlatformOverride = null);
  final transport = _WidgetTransport();
  final processing = _WidgetProcessing(
    providerReport: const ProcessingProviderAvailability(
      speechAnalyzer: false,
      sfSpeechRecognizer: true,
      rustSherpaOnnx: true,
      translationSession: true,
    ),
  );
  await tester.pumpWidget(
    app.KotobaBeaconCompanionApp(
      locale: const Locale('ja'),
      home: app.CompanionHomePage(
        createTransport: () => transport,
        createProcessing: () => processing,
        prepareAzooKeyDictionary: () async {},
        prepareAzooKeyModel: (_) async {},
      ),
    ),
  );
  await tester.pump();
  await _showDetailedMode(tester);
  expect(
    tester
        .widget<GestureDetector>(
          find.byKey(
            const Key(
              'translation-provider-'
              '_TranslationChoice.platformTranslationSession',
            ),
          ),
        )
        .onTap,
    isNotNull,
  );
  expect(
    tester
        .widget<GestureDetector>(
          find.byKey(
            const Key(
              'translation-provider-'
              '_TranslationChoice.platformTranslationSessionHighFidelity',
            ),
          ),
        )
        .onTap,
    isNotNull,
  );
  final connectButton = find.widgetWithText(
    CupertinoButton,
    '接続する',
  );
  await tester.ensureVisible(connectButton);
  tester.widget<CupertinoButton>(connectButton).onPressed?.call();
  await tester.runAsync(() => _waitForConfigured(transport));
  transport.addText(
    '{"version":1,"type":"session.ready","session_id":"availability",'
    '"route":{"asr":"mobile","azookey":"mobile",'
    '"translation":"mobile"}}',
  );
  await tester.pump(const Duration(milliseconds: 20));

  expect(
    tester
        .widget<GestureDetector>(
          find.byKey(const Key('asr-provider-_AsrChoice.speechAnalyzer')),
        )
        .onTap,
    isNull,
  );
  expect(
    tester
        .widget<GestureDetector>(
          find.byKey(const Key('asr-provider-_AsrChoice.sfSpeechRecognizer')),
        )
        .onTap,
    isNotNull,
  );
  debugDefaultTargetPlatformOverride = null;
}

Future<void> _testCupertinoInterface(WidgetTester tester) async {
  debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
  addTearDown(() => debugDefaultTargetPlatformOverride = null);
  final transport = _WidgetTransport();
  final processing = _WidgetProcessing();
  await tester.pumpWidget(
    app.KotobaBeaconCompanionApp(
      locale: const Locale('ja'),
      key: UniqueKey(),
      home: app.CompanionHomePage(
        createTransport: () => transport,
        createProcessing: () => processing,
        prepareAzooKeyDictionary: () async {},
        prepareAzooKeyModel: (_) async {},
        discoverDesktop: () async => DiscoveryResponse(
          nonce: BigInt.zero,
          endpoint: 'ws://192.168.1.227:18183/companion',
          token: '0123456789abcdef0123456789abcdef',
        ),
        autoDiscover: true,
      ),
    ),
  );

  expect(find.byType(CupertinoPageScaffold), findsOneWidget);
  final cupertinoApp = tester.widget<CupertinoApp>(find.byType(CupertinoApp));
  expect(cupertinoApp.theme?.textTheme.textStyle.fontSize, 16);
  expect(cupertinoApp.theme?.textTheme.textStyle.fontWeight, FontWeight.w400);
  expect(cupertinoApp.theme?.textTheme.navTitleTextStyle.fontSize, 20);
  expect(
    cupertinoApp.theme?.textTheme.navTitleTextStyle.fontWeight,
    FontWeight.w600,
  );
  expect(find.byType(CupertinoTextField), findsNothing);
  await _showDetailedMode(tester);
  expect(find.byType(CupertinoTextField), findsNWidgets(2));
  expect(find.byKey(const Key('asr-provider')), findsOneWidget);
  expect(find.byKey(const Key('azookey-provider')), findsOneWidget);
  expect(find.byKey(const Key('translation-provider')), findsOneWidget);
  expect(find.text('iOS SpeechAnalyzer（リアルタイム）'), findsOneWidget);
  expect(find.textContaining('SFSpeechRecognizer'), findsOneWidget);
  expect(find.text('iOS TranslationSession'), findsOneWidget);
  expect(find.text('iOS TranslationSession（高精度）'), findsOneWidget);
  expect(find.byType(SegmentedButton<ExecutionDevice>), findsNothing);

  await tester.runAsync(() => _waitForConnection(transport));
  transport.addText(
    '{"version":1,"type":"session.ready",'
    '"session_id":"cupertino-session",'
    '"route":{"asr":"mobile","azookey":"mobile",'
    '"translation":"mobile"}}',
  );
  await tester.pump(const Duration(milliseconds: 20));
  expect(find.text('接続状態'), findsOneWidget);
  expect(find.text('認証済み'), findsOneWidget);
  await _tapVisible(tester, find.text('詳細情報を表示'));
  await tester.pump();
  expect(find.text('—'), findsWidgets);

  await _tapVisible(
    tester,
    find.byKey(const Key('asr-provider-_AsrChoice.desktopNative')),
  );
  await tester.runAsync(() => _waitForRouteRequest(transport));
  expect(
    decodeMobileRouteRequest(json: transport.sentTexts.last),
    const PipelineRoute(
      asr: ExecutionDevice.desktop,
      azookey: ExecutionDevice.mobile,
      translation: ExecutionDevice.mobile,
    ),
  );
  transport.addText(
    '{"version":1,"type":"route.configure",'
    '"route":{"asr":"desktop","azookey":"mobile",'
    '"translation":"mobile"}}',
  );
  await tester.pump(const Duration(milliseconds: 20));
  expect(find.text('dmm'), findsOneWidget);
  debugDefaultTargetPlatformOverride = null;
}

Future<void> _testIPadResponsiveLayout(WidgetTester tester) async {
  debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
  addTearDown(() async {
    debugDefaultTargetPlatformOverride = null;
    await tester.binding.setSurfaceSize(null);
  });

  await tester.binding.setSurfaceSize(const Size(1194, 834));
  await tester.pumpWidget(
    const app.KotobaBeaconCompanionApp(locale: Locale('ja')),
  );
  expect(find.byKey(const Key('phone-single-pane')), findsOneWidget);
  await _showDetailedMode(tester);
  expect(find.byKey(const Key('tablet-two-pane')), findsOneWidget);

  await tester.binding.setSurfaceSize(const Size(834, 1194));
  await tester.pump();
  expect(find.byKey(const Key('phone-single-pane')), findsOneWidget);

  await tester.binding.setSurfaceSize(const Size(390, 844));
  await tester.pump();
  expect(
    find.byKey(const Key('vertical-control-asr-provider')),
    findsOneWidget,
  );
  debugDefaultTargetPlatformOverride = null;
}

void _setPhoneView(WidgetTester tester) {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void _setTabletView(WidgetTester tester) {
  tester.view.physicalSize = const Size(1280, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> _showDetailedMode(WidgetTester tester) async {
  await _tapVisible(tester, find.byKey(const Key('menu-button')));
  await tester.pumpAndSettle();
  await _tapVisible(tester, find.byKey(const Key('menu-detailed')));
  await tester.pumpAndSettle();
}

Future<void> _testStandardModeChoices(WidgetTester tester) async {
  _setPhoneView(tester);
  await tester.pumpWidget(
    const app.KotobaBeaconCompanionApp(locale: Locale('ja')),
  );

  expect(find.text('デスクトップ'), findsNWidgets(3));
  expect(find.text('スマホ'), findsNWidgets(3));
  expect(find.byKey(const Key('connection-button')), findsOneWidget);
  expect(find.byKey(const Key('camera-button')), findsOneWidget);
  expect(find.byKey(const Key('endpoint-field')), findsNothing);

  await _showDetailedMode(tester);
  await _tapVisible(
    tester,
    find.byKey(const Key('azookey-provider-_AzooKeyChoice.mobileXsmall')),
  );
  await _tapVisible(tester, find.byKey(const Key('menu-button')));
  await tester.pumpAndSettle();
  await _tapVisible(tester, find.byKey(const Key('menu-standard')));
  await tester.pumpAndSettle();
  expect(find.byKey(const Key('endpoint-field')), findsNothing);

  await tester.tap(
    find.byKey(
      const Key('azookey-provider-_AzooKeyChoice.desktopNative'),
    ),
  );
  await tester.pump();
  expect(find.textContaining('を選択しました'), findsNothing);
}

Future<void> _testStandardModeHidesDiscoveryFailure(
  WidgetTester tester,
) async {
  await tester.pumpWidget(
    app.KotobaBeaconCompanionApp(
      locale: const Locale('ja'),
      home: app.CompanionHomePage(
        autoDiscover: true,
        createProcessing: _WidgetProcessing.new,
        prepareAzooKeyDictionary: () async {},
        prepareAzooKeyModel: (_) async {},
        discoverDesktop: () async {
          throw TimeoutException('missing');
        },
      ),
    ),
  );
  await tester.pump();
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 20)),
  );
  await tester.pump();
  expect(find.textContaining('自動検出'), findsNothing);
  expect(find.textContaining('TimeoutException'), findsNothing);
  expect(find.textContaining('接続できませんでした'), findsNothing);
  expect(find.textContaining('未接続または同期中'), findsOneWidget);
}

Future<void> _testAndroidTabletNoun(WidgetTester tester) async {
  _setTabletView(tester);
  await tester.pumpWidget(
    const app.KotobaBeaconCompanionApp(locale: Locale('ja')),
  );
  expect(find.text('タブレット'), findsNWidgets(3));
}

Future<void> _testEnglishCopy(WidgetTester tester) async {
  await tester.pumpWidget(
    const app.KotobaBeaconCompanionApp(locale: Locale('en')),
  );

  expect(find.text('Connect'), findsOneWidget);
  expect(find.text('Scan QR with camera'), findsOneWidget);
  expect(find.text('Desktop'), findsNWidgets(3));
  expect(find.text('Device'), findsNWidgets(3));
  expect(find.text('Speech recognition'), findsOneWidget);
  await _tapVisible(tester, find.byKey(const Key('menu-button')));
  await tester.pumpAndSettle();
  expect(find.text('Standard mode'), findsOneWidget);
  expect(find.text('Detailed mode'), findsOneWidget);
}

Future<void> _testQrPairingLink(WidgetTester tester) async {
  final transport = _WidgetTransport();
  final pairing = StreamController<Uri>.broadcast();
  addTearDown(() async {
    await pairing.close();
  });
  var cameraOpens = 0;
  await tester.pumpWidget(
    _japaneseShell(
      home: app.CompanionHomePage(
        createTransport: () => transport,
        createProcessing: _WidgetProcessing.new,
        prepareAzooKeyDictionary: () async {},
        prepareAzooKeyModel: (_) async {},
        pairingLinks: pairing.stream,
        openSystemCamera: () async => cameraOpens += 1,
      ),
    ),
  );
  await _tapVisible(tester, find.byKey(const Key('camera-button')));
  await tester.pump();
  expect(cameraOpens, 1);
  pairing.add(
    Uri.parse(
      'kotobabeacon://pair?endpoint=ws%3A%2F%2F192.168.1.8%3A18183%2Fcompanion&token=qr-token-1',
    ),
  );
  await tester.pump();
  await tester.runAsync(() => _waitForConnection(transport));
  await tester.pump();
  expect(transport.openCalls, 1);
  expect(transport.tokens, ['qr-token-1']);
  transport.addText(
    '{"version":1,"type":"session.ready","session_id":"qr-session",'
    '"route":{"asr":"desktop","azookey":"mobile",'
    '"translation":"mobile"}}',
  );
  await tester.pump(const Duration(milliseconds: 20));
  expect(find.byKey(const Key('camera-button')), findsNothing);
  expect(find.widgetWithText(FilledButton, '接続する'), findsNothing);
  expect(find.widgetWithText(OutlinedButton, '切断する'), findsOneWidget);
}

Future<void> _tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
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

Future<void> _waitForClose(_WidgetTransport transport) async {
  for (var attempt = 0; attempt < 1000; attempt += 1) {
    if (transport.closeCalls > 0) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('disconnected transport did not close');
}

Future<void> _waitForConfigured(_WidgetTransport transport) async {
  for (var attempt = 0; attempt < 1000; attempt += 1) {
    if (transport.connectCalls > 0) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('connection configuration did not complete');
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
  final tokens = <String>[];

  @override
  Stream<Object> get messages => _messages.stream;

  void addText(String message) => _messages.add(message);

  void addError(Object error) => _messages.addError(error);

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
  }) {
    tokens.add(token);
  }

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
  _WidgetProcessing({
    this.capabilityReport = _testCapabilities,
    this.providerReport = const ProcessingProviderAvailability(
      speechAnalyzer: true,
      sfSpeechRecognizer: true,
      rustSherpaOnnx: true,
      translationSession: true,
    ),
  });

  final MobileCapabilities capabilityReport;
  final ProcessingProviderAvailability providerReport;
  final _events = StreamController<ProcessingEvent>.broadcast();
  final started = Completer<void>();
  final preparedAsrLocales = <String>[];
  final preparedTranslationPairs = <String>[];
  int cancelCalls = 0;
  int translateCalls = 0;
  int releaseTranslationCalls = 0;

  @override
  Stream<ProcessingEvent> get events => _events.stream;

  void emit(ProcessingEvent event) => _events.add(event);

  @override
  Future<void> configureAsrProvider(MobileAsrProvider provider) async {}

  @override
  Future<void> configureTranslationProvider(
    MobileTranslationProvider provider,
  ) async {}

  @override
  Future<ProcessingProviderAvailability> providerAvailability() async =>
      providerReport;

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
  Future<void> releaseTranslation() async {
    releaseTranslationCalls += 1;
  }

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
