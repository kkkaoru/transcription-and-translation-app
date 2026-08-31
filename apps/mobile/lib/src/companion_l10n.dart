// Catalog accessors are the public copy API; documenting each getter
// would only repeat the string purpose already expressed by the name.
// ignore_for_file: public_member_api_docs
// of() is a lookup, not a generative constructor.
// ignore_for_file: prefer_constructors_over_static_methods
// Connected state is a two-value display flag, not a configuration object.
// ignore_for_file: avoid_positional_boolean_parameters

import 'package:flutter/widgets.dart';

/// Form factor used to choose the Japanese device noun.
enum CompanionDeviceKind { phone, ipad, androidTablet }

/// Japanese and English copy for the mobile companion.
final class CompanionL10n {
  /// Resolves copy from a platform or test locale.
  factory CompanionL10n.fromLocale(Locale locale) =>
      locale.languageCode == 'ja' ? japanese : english;

  const CompanionL10n._(this._japanese);

  /// Japanese copy.
  static const japanese = CompanionL10n._(true);

  /// English copy.
  static const english = CompanionL10n._(false);

  final bool _japanese;

  /// Resolves copy from the nearest [CompanionL10nScope] or locale.
  static CompanionL10n of(BuildContext context) {
    final scope = context
        .dependOnInheritedWidgetOfExactType<CompanionL10nScope>();
    if (scope != null) return scope.l10n;
    final locale = Localizations.maybeLocaleOf(context);
    if (locale != null) return CompanionL10n.fromLocale(locale);
    return CompanionL10n.fromLocale(
      WidgetsBinding.instance.platformDispatcher.locale,
    );
  }

  /// Language code used by the companion app locale.
  String get languageCode => _japanese ? 'ja' : 'en';

  String get title => 'Kotoba Beacon Companion';

  String get menu => _japanese ? 'メニュー' : 'Menu';

  String get cancel => _japanese ? 'キャンセル' : 'Cancel';

  String get standardMode => _japanese ? '通常モード' : 'Standard mode';

  String get detailedMode => _japanese ? '詳細モード' : 'Detailed mode';

  String get connection => _japanese ? '接続情報' : 'Connection';

  String get endpoint => _japanese ? 'エンドポイント' : 'Endpoint';

  String get endpointHint =>
      _japanese ? 'デスクトップのWebSocketエンドポイント' : 'Desktop WebSocket endpoint';

  String get pairingToken => _japanese ? 'ペアリングトークン' : 'Pairing token';

  String get pairingTokenHint => _japanese ? 'トークンを入力' : 'Enter pairing token';

  String get connect => _japanese ? '接続する' : 'Connect';

  String get disconnect => _japanese ? '切断する' : 'Disconnect';

  String get scanQrWithCamera =>
      _japanese ? 'カメラでQRを読み取る' : 'Scan QR with camera';

  String get features => _japanese ? '連携機能' : 'Processing';

  String get asrMethod => _japanese ? '文字起こし' : 'Speech recognition';

  String get azookeyMethod => _japanese ? '日本語変換' : 'Japanese conversion';

  String get translationMethod => _japanese ? '翻訳' : 'Translation';

  String get processOnDesktop => _japanese ? 'デスクトップで処理' : 'Process on desktop';

  String get processOnThisDevice =>
      _japanese ? 'この端末で処理' : 'Process on this device';

  String get desktopNoun => _japanese ? 'デスクトップ' : 'Desktop';

  String deviceNoun({required CompanionDeviceKind kind}) {
    if (!_japanese) return 'Device';
    return switch (kind) {
      CompanionDeviceKind.phone => 'スマホ',
      CompanionDeviceKind.ipad => 'iPad',
      CompanionDeviceKind.androidTablet => 'タブレット',
    };
  }

  String get couldNotConnect => _japanese ? '接続できませんでした' : 'Could not connect';

  String get couldNotOpenCamera =>
      _japanese ? 'カメラを開けませんでした' : 'Could not open the camera';

  String get desktopNative => 'Desktop Native';

  String get iosSpeechAnalyzer => _japanese
      ? 'iOS SpeechAnalyzer（リアルタイム）'
      : 'iOS SpeechAnalyzer (realtime)';

  String get iosSfSpeechRecognizer => _japanese
      ? 'iOS SFSpeechRecognizer（オンデバイス）'
      : 'iOS SFSpeechRecognizer (on-device)';

  String get androidMlKitSpeech => 'Android ML Kit Speech';

  String get mobileRustReazonSpeech =>
      _japanese ? 'Mobile Rust（ReazonSpeech）' : 'Mobile Rust (ReazonSpeech)';

  String get mobileRustAzookeySmall =>
      _japanese ? 'Mobile Rust（AzooKey Small）' : 'Mobile Rust (AzooKey Small)';

  String get mobileRustAzookeyXsmall => _japanese
      ? 'Mobile Rust（AzooKey XSmall）'
      : 'Mobile Rust (AzooKey XSmall)';

  String get iosTranslationSession => 'iOS TranslationSession';

  String get iosTranslationSessionHighFidelity => _japanese
      ? 'iOS TranslationSession（高精度）'
      : 'iOS TranslationSession (high fidelity)';

  String get mobileRustQuickMt =>
      _japanese ? 'Mobile Rust（QuickMT）' : 'Mobile Rust (QuickMT)';

  String get connectionState => _japanese ? '接続状態' : 'Connection state';

  String get authenticated => _japanese ? '認証済み' : 'Authenticated';

  String get notConnected =>
      _japanese ? '未接続または同期中' : 'Not connected or syncing';

  String get showDetails => _japanese ? '詳細情報を表示' : 'Show details';

  String get desktopEndpoint =>
      _japanese ? 'デスクトップのエンドポイント' : 'Desktop endpoint';

  String get synchronizedRoute => _japanese ? '同期済みルート' : 'Synchronized route';

  String get mobileApis => _japanese ? 'モバイルAPI' : 'Mobile APIs';

  String get available => _japanese ? '利用可' : 'Available';

  String get unavailable => _japanese ? '利用不可' : 'Unavailable';

  String get emptyResult => '—';

  String get enterEndpointAndToken => _japanese
      ? 'デスクトップのLANエンドポイントとペアリングトークンを入力してください'
      : 'Enter the desktop LAN endpoint and pairing token';

  String get preparingAzookeyDictionary =>
      _japanese ? 'AzooKey辞書を準備中' : 'Preparing the AzooKey dictionary';

  String preparingAzookeyModel(String model) =>
      _japanese ? 'AzooKey $model GGUFを準備中' : 'Preparing AzooKey $model GGUF';

  String get discoveringNative =>
      _japanese ? '同一ネットワーク上のNativeを検出中' : 'Looking for Native on this network';

  String get discoveredNative =>
      _japanese ? 'Nativeを検出しました。認証接続中' : 'Found Native. Authenticating';

  String get discoveryTimeout => _japanese
      ? 'Nativeを自動検出できません。ローカルネットワーク許可と同一Wi-Fiを確認してください'
      : 'Could not find Native. Check local network permission '
            'and the same Wi-Fi';

  String discoveryFailed(Object error) =>
      _japanese ? '自動検出失敗: $error' : 'Discovery failed: $error';

  String get readPairingFromQr => _japanese
      ? 'QRコードから接続情報を読み取りました'
      : 'Read connection details from the QR code';

  String get scanQrInSystemCamera => _japanese
      ? '標準カメラアプリでQRコードを読み取ってください'
      : 'Scan the QR code with the system camera app';

  String cameraOpenFailed(Object error) =>
      _japanese ? 'カメラを開けません: $error' : 'Could not open the camera: $error';

  String get switchedToStandard =>
      _japanese ? '通常モードに切り替えました' : 'Switched to standard mode';

  String get switchedToDetailed =>
      _japanese ? '詳細モードに切り替えました' : 'Switched to detailed mode';

  String get connecting => _japanese ? '接続中' : 'Connecting';

  String get connectingLan => _japanese ? 'LAN接続中' : 'Connecting over LAN';

  String get checkingDeviceApis =>
      _japanese ? '接続済み端末のAPI利用可否を判定中' : 'Checking APIs on this device';

  String connectionFailed(Object error) =>
      _japanese ? '接続失敗: $error' : 'Connection failed: $error';

  String get disconnected => _japanese ? '切断しました' : 'Disconnected';

  String get reconnecting => _japanese
      ? '接続が切れました。再接続を準備中'
      : 'Connection lost. Preparing to reconnect';

  String dictionaryError(Object error) =>
      _japanese ? 'AzooKey辞書エラー: $error' : 'AzooKey dictionary error: $error';

  String preparingTranslation(String label) =>
      _japanese ? '$labelを準備中' : 'Preparing $label';

  String connectedSession(String sessionId, String route) => _japanese
      ? '接続済み: $sessionId / $route'
      : 'Connected: $sessionId / $route';

  String settingsSynced(String route) =>
      _japanese ? '設定同期済み: $route' : 'Settings synced: $route';

  String waitingForAuthentication(String route) => _japanese
      ? '認証応答を待っています / route $route'
      : 'Waiting for authentication / route $route';

  String selectedProvider(String label) =>
      _japanese ? '$labelを選択しました' : 'Selected $label';

  String applyAfterRecognition(String selectedStatus) => _japanese
      ? '$selectedStatus。現在の認識完了後に反映します'
      : '$selectedStatus. It will apply after the current recognition ends';

  String syncingRoute(String route) => _japanese
      ? '設定をデスクトップと同期中: $route'
      : 'Syncing settings with desktop: $route';

  String syncFailed(Object error) =>
      _japanese ? '設定同期失敗: $error' : 'Could not sync settings: $error';

  String unavailableOnThisDevice(String label) =>
      _japanese ? '$label（この端末では利用不可）' : '$label (unavailable on this device)';

  String connectionStateValue(bool connected) =>
      connected ? authenticated : notConnected;

  String connectionStateLine(bool connected) =>
      '$connectionState: ${connectionStateValue(connected)}';
}

/// Provides [CompanionL10n] to descendant widgets.
final class CompanionL10nScope extends InheritedWidget {
  /// Creates a localization scope.
  const CompanionL10nScope({
    required this.l10n,
    required super.child,
    super.key,
  });

  /// Active copy bundle.
  final CompanionL10n l10n;

  @override
  bool updateShouldNotify(CompanionL10nScope oldWidget) =>
      l10n.languageCode != oldWidget.l10n.languageCode;
}
