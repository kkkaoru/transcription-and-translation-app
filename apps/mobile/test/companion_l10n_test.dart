import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/src/companion_l10n.dart';

void main() {
  test('uses Japanese copy for ja locales', () {
    const l10n = CompanionL10n.japanese;

    expect(l10n.languageCode, 'ja');
    expect(l10n.connect, '接続する');
    expect(l10n.processOnDesktop, 'デスクトップで処理');
    expect(l10n.processOnThisDevice, 'この端末で処理');
    expect(l10n.deviceNoun(kind: CompanionDeviceKind.phone), 'スマホ');
    expect(l10n.deviceNoun(kind: CompanionDeviceKind.ipad), 'iPad');
    expect(
      l10n.deviceNoun(kind: CompanionDeviceKind.androidTablet),
      'タブレット',
    );
    expect(l10n.connectedSession('s1', 'mmm'), '接続済み: s1 / mmm');
    expect(l10n.settingsSynced('mmd'), '設定同期済み: mmd');
  });

  test('uses English copy for non-Japanese locales', () {
    final l10n = CompanionL10n.fromLocale(const Locale('en', 'US'));

    expect(l10n.languageCode, 'en');
    expect(l10n.connect, 'Connect');
    expect(l10n.processOnDesktop, 'Process on desktop');
    expect(l10n.processOnThisDevice, 'Process on this device');
    expect(l10n.deviceNoun(kind: CompanionDeviceKind.phone), 'Device');
    expect(l10n.deviceNoun(kind: CompanionDeviceKind.ipad), 'Device');
    expect(
      l10n.deviceNoun(kind: CompanionDeviceKind.androidTablet),
      'Device',
    );
    expect(l10n.connectedSession('s1', 'mmm'), 'Connected: s1 / mmm');
    expect(l10n.settingsSynced('mmd'), 'Settings synced: mmd');
    expect(
      l10n.unavailableOnThisDevice('QuickMT'),
      'QuickMT (unavailable on this device)',
    );
  });

  testWidgets('reads copy from the inherited scope', (tester) async {
    late CompanionL10n resolved;
    await tester.pumpWidget(
      CompanionL10nScope(
        l10n: CompanionL10n.english,
        child: Builder(
          builder: (context) {
            resolved = CompanionL10n.of(context);
            return const SizedBox();
          },
        ),
      ),
    );

    expect(resolved.disconnect, 'Disconnect');
  });

  test('covers Japanese and English copy catalogs', () {
    _readCatalog(CompanionL10n.japanese);
    _readCatalog(CompanionL10n.english);
    expect(
      CompanionL10n.fromLocale(const Locale('ja')).menu,
      CompanionL10n.japanese.menu,
    );
  });
}

void _readCatalog(CompanionL10n l10n) {
  expect(l10n.title, isNotEmpty);
  expect(l10n.menu, isNotEmpty);
  expect(l10n.cancel, isNotEmpty);
  expect(l10n.standardMode, isNotEmpty);
  expect(l10n.detailedMode, isNotEmpty);
  expect(l10n.connection, isNotEmpty);
  expect(l10n.endpoint, isNotEmpty);
  expect(l10n.endpointHint, isNotEmpty);
  expect(l10n.pairingToken, isNotEmpty);
  expect(l10n.pairingTokenHint, isNotEmpty);
  expect(l10n.connect, isNotEmpty);
  expect(l10n.disconnect, isNotEmpty);
  expect(l10n.scanQrWithCamera, isNotEmpty);
  expect(l10n.features, isNotEmpty);
  expect(l10n.asrMethod, isNotEmpty);
  expect(l10n.azookeyMethod, isNotEmpty);
  expect(l10n.translationMethod, isNotEmpty);
  expect(l10n.processOnDesktop, isNotEmpty);
  expect(l10n.processOnThisDevice, isNotEmpty);
  expect(l10n.desktopNoun, isNotEmpty);
  expect(l10n.deviceNoun(kind: CompanionDeviceKind.phone), isNotEmpty);
  expect(l10n.deviceNoun(kind: CompanionDeviceKind.ipad), isNotEmpty);
  expect(
    l10n.deviceNoun(kind: CompanionDeviceKind.androidTablet),
    isNotEmpty,
  );
  expect(l10n.couldNotConnect, isNotEmpty);
  expect(l10n.couldNotOpenCamera, isNotEmpty);
  expect(l10n.desktopNative, isNotEmpty);
  expect(l10n.iosSpeechAnalyzer, isNotEmpty);
  expect(l10n.iosSfSpeechRecognizer, isNotEmpty);
  expect(l10n.androidMlKitSpeech, isNotEmpty);
  expect(l10n.mobileRustReazonSpeech, isNotEmpty);
  expect(l10n.mobileRustAzookeySmall, isNotEmpty);
  expect(l10n.mobileRustAzookeyXsmall, isNotEmpty);
  expect(l10n.iosTranslationSession, isNotEmpty);
  expect(l10n.iosTranslationSessionHighFidelity, isNotEmpty);
  expect(l10n.mobileRustQuickMt, isNotEmpty);
  expect(l10n.connectionState, isNotEmpty);
  expect(l10n.authenticated, isNotEmpty);
  expect(l10n.notConnected, isNotEmpty);
  expect(l10n.showDetails, isNotEmpty);
  expect(l10n.desktopEndpoint, isNotEmpty);
  expect(l10n.synchronizedRoute, isNotEmpty);
  expect(l10n.mobileApis, isNotEmpty);
  expect(l10n.available, isNotEmpty);
  expect(l10n.unavailable, isNotEmpty);
  expect(l10n.emptyResult, isNotEmpty);
  expect(l10n.enterEndpointAndToken, isNotEmpty);
  expect(l10n.preparingAzookeyDictionary, isNotEmpty);
  expect(l10n.preparingAzookeyModel('Small'), isNotEmpty);
  expect(l10n.discoveringNative, isNotEmpty);
  expect(l10n.discoveredNative, isNotEmpty);
  expect(l10n.discoveryTimeout, isNotEmpty);
  expect(l10n.discoveryFailed('x'), isNotEmpty);
  expect(l10n.readPairingFromQr, isNotEmpty);
  expect(l10n.scanQrInSystemCamera, isNotEmpty);
  expect(l10n.cameraOpenFailed('x'), isNotEmpty);
  expect(l10n.switchedToStandard, isNotEmpty);
  expect(l10n.switchedToDetailed, isNotEmpty);
  expect(l10n.connecting, isNotEmpty);
  expect(l10n.connectingLan, isNotEmpty);
  expect(l10n.checkingDeviceApis, isNotEmpty);
  expect(l10n.connectionFailed('x'), isNotEmpty);
  expect(l10n.disconnected, isNotEmpty);
  expect(l10n.reconnecting, isNotEmpty);
  expect(l10n.dictionaryError('x'), isNotEmpty);
  expect(l10n.preparingTranslation('QuickMT'), isNotEmpty);
  expect(l10n.connectedSession('s', 'mmm'), isNotEmpty);
  expect(l10n.settingsSynced('mmm'), isNotEmpty);
  expect(l10n.waitingForAuthentication('mmm'), isNotEmpty);
  expect(l10n.selectedProvider('ASR'), isNotEmpty);
  expect(l10n.applyAfterRecognition('ASR'), isNotEmpty);
  expect(l10n.syncingRoute('mmm'), isNotEmpty);
  expect(l10n.syncFailed('x'), isNotEmpty);
  expect(l10n.unavailableOnThisDevice('ASR'), isNotEmpty);
  expect(l10n.connectionStateValue(true), isNotEmpty);
  expect(l10n.connectionStateValue(false), isNotEmpty);
  expect(l10n.connectionStateLine(true), isNotEmpty);
}
