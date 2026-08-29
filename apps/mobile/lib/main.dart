import 'dart:async';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kotoba_beacon_companion/src/azookey_assets.dart';
import 'package:kotoba_beacon_companion/src/companion_connection.dart';
import 'package:kotoba_beacon_companion/src/companion_controller.dart';
import 'package:kotoba_beacon_companion/src/mobile_rust_asr_assets.dart';
import 'package:kotoba_beacon_companion/src/native_processing.dart';
import 'package:kotoba_beacon_companion/src/quickmt_assets.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';
import 'package:kotoba_beacon_companion/src/rust/frb_generated.dart';
import 'package:path_provider/path_provider.dart';

const _gap = 8.0;
const _sectionGap = 16.0;
const _controlHeight = 48.0;
const _contentColor = Color(0xff1c1c1e);
const _bodyTextStyle = TextStyle(
  color: _contentColor,
  fontSize: 16,
  height: 1.4,
  fontWeight: FontWeight.w400,
);
const _emphasisTextStyle = TextStyle(
  color: _contentColor,
  fontSize: 16,
  height: 1.3,
  fontWeight: FontWeight.w600,
);
const _titleTextStyle = TextStyle(
  color: _contentColor,
  fontSize: 20,
  height: 1.2,
  fontWeight: FontWeight.w600,
);

/// Starts the mobile companion after initializing the generated Rust bridge.
// coverage:ignore-start
Future<void> main() => startCompanion(
  initializeRust: RustLib.init,
  root: const KotobaBeaconCompanionApp(
    home: CompanionHomePage(autoDiscover: true),
  ),
);
// coverage:ignore-end

/// Initializes Flutter and Rust, then mounts [root].
Future<void> startCompanion({
  required Future<void> Function() initializeRust,
  required Widget root,
}) async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeRust();
  runApp(root);
}

/// Platform-native application shell for the mobile companion.
class KotobaBeaconCompanionApp extends StatelessWidget {
  /// Creates the companion application.
  const KotobaBeaconCompanionApp({
    super.key,
    this.home = const CompanionHomePage(),
  });

  /// Platform-adaptive home page, replaceable by deterministic tests.
  final Widget home;

  @override
  Widget build(BuildContext context) {
    if (_usesCupertino) {
      return CupertinoApp(
        title: 'Kotoba Beacon Companion',
        debugShowCheckedModeBanner: false,
        theme: const CupertinoThemeData(
          brightness: Brightness.light,
          primaryColor: Color(0xff007a70),
          scaffoldBackgroundColor: CupertinoColors.systemGroupedBackground,
          textTheme: CupertinoTextThemeData(
            textStyle: _bodyTextStyle,
            actionTextStyle: _emphasisTextStyle,
            navTitleTextStyle: _titleTextStyle,
          ),
        ),
        home: home,
      );
    }
    return MaterialApp(
      title: 'Kotoba Beacon Companion',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff3a7d71)),
        textTheme: const TextTheme(
          bodyLarge: _bodyTextStyle,
          bodyMedium: _bodyTextStyle,
          titleLarge: _titleTextStyle,
          titleMedium: _emphasisTextStyle,
          labelLarge: _emphasisTextStyle,
        ),
        inputDecorationTheme: const InputDecorationTheme(
          contentPadding: EdgeInsets.all(12),
          border: OutlineInputBorder(),
        ),
        filledButtonTheme: const FilledButtonThemeData(
          style: ButtonStyle(
            minimumSize: WidgetStatePropertyAll(
              Size.fromHeight(_controlHeight),
            ),
            textStyle: WidgetStatePropertyAll(_emphasisTextStyle),
          ),
        ),
        outlinedButtonTheme: const OutlinedButtonThemeData(
          style: ButtonStyle(
            minimumSize: WidgetStatePropertyAll(
              Size.fromHeight(_controlHeight),
            ),
            textStyle: WidgetStatePropertyAll(_emphasisTextStyle),
          ),
        ),
        useMaterial3: true,
      ),
      home: home,
    );
  }
}

bool get _usesCupertino => defaultTargetPlatform == TargetPlatform.iOS;

enum _AsrChoice {
  desktopNative,
  speechAnalyzer,
  sfSpeechRecognizer,
  androidMlKit,
  rustSherpaOnnxReazonSpeech,
}

enum _AzooKeyChoice { desktopNative, mobileSmall, mobileXsmall }

enum _TranslationChoice {
  desktopNative,
  platformTranslationSession,
  platformTranslationSessionHighFidelity,
  rustQuickMt,
}

CompanionTransport _createTransport() => WebSocketCompanionTransport();

// Platform wiring is covered by simulator and physical-device verification;
// resolvers and Rust boundaries use deterministic injected-path tests.
// coverage:ignore-start
ProcessingBackend _createProcessing() => NativeProcessingBackend(
  mobileRustAsr: MobileRustAsrBackend(
    prepare: _prepareMobileRustAsr,
    transcribe: (pcm16) => transcribeMobileRustAsr(pcm16: pcm16),
    release: releaseMobileRustAsr,
  ),
  quickMtTranslation: QuickMtTranslationBackend(
    prepare: _prepareQuickMtTranslation,
    translate: (text) => translateQuickmt(text: text),
    release: releaseQuickmtTranslation,
  ),
);

Future<void> _prepareAzooKeyDictionary() async {
  final data = await rootBundle.load('assets/azookey/system.azkdict.gz');
  await initializeAzookeyDictionary(bytes: data.buffer.asUint8List());
}

Future<void> _prepareMobileRustAsr() => prepareMobileRustAsrRuntime(
  usesAppleBundle: Platform.isIOS,
  executablePath: Platform.resolvedExecutable,
  supportDirectory: getApplicationSupportDirectory,
  loadAsset: rootBundle.load,
  prepareModel: prepareMobileRustAsr,
);

Future<void> _prepareQuickMtTranslation() => prepareQuickMtRuntime(
  usesAppleBundle: Platform.isIOS,
  executablePath: Platform.resolvedExecutable,
  supportDirectory: getApplicationSupportDirectory,
  loadAsset: rootBundle.load,
  prepareModel: prepareQuickmtTranslation,
);

Future<void> _prepareAzooKeyModel(AzooKeyModel model) => prepareAzooKeyRuntime(
  model: model,
  usesAppleBundle: Platform.isIOS,
  executablePath: Platform.resolvedExecutable,
  supportDirectory: getApplicationSupportDirectory,
  loadAsset: rootBundle.load,
  prepareModel: prepareAzookeyModel,
);
// coverage:ignore-end

/// Pairing, route selection, and live-result screen.
class CompanionHomePage extends StatefulWidget {
  /// Creates the companion home screen.
  const CompanionHomePage({
    super.key,
    this.initialRoute,
    this.initialAzooKeyModel = AzooKeyModel.small,
    this.createTransport = _createTransport,
    this.createProcessing = _createProcessing,
    this.prepareAzooKeyDictionary = _prepareAzooKeyDictionary,
    this.prepareAzooKeyModel = _prepareAzooKeyModel,
    this.discoverDesktop = discoverCompanion,
    this.autoDiscover = false,
  });

  /// Initial Rust-owned stage assignment shown by the route controls.
  final PipelineRoute? initialRoute;

  /// Initial on-device AzooKey GGUF model.
  final AzooKeyModel initialAzooKeyModel;

  /// Creates a fresh authenticated transport for each connection attempt.
  final CompanionTransport Function() createTransport;

  /// Creates a fresh platform processing provider for each connection attempt.
  final ProcessingBackend Function() createProcessing;

  /// Loads and initializes the portable AzooKey dictionary.
  final Future<void> Function() prepareAzooKeyDictionary;

  /// Loads the selected bundled AzooKey GGUF verifier.
  final Future<void> Function(AzooKeyModel model) prepareAzooKeyModel;

  /// Locates Native and receives its short-lived authenticated connection data.
  final Future<DiscoveryResponse> Function() discoverDesktop;

  /// Starts LAN discovery when the production page first appears.
  final bool autoDiscover;

  @override
  State<CompanionHomePage> createState() => _CompanionHomePageState();
}

class _CompanionHomePageState extends State<CompanionHomePage> {
  final _endpointController = TextEditingController(
    text: 'ws://192.168.1.2:18183/companion',
  );
  final _tokenController = TextEditingController();
  late PipelineRoute _route;
  late AzooKeyModel _azooKeyModel;
  late _AsrChoice _asrChoice;
  late _AzooKeyChoice _azooKeyChoice;
  late _TranslationChoice _translationChoice;
  CompanionTransport? _transport;
  ProcessingBackend? _processing;
  CompanionController? _companion;
  MobileCapabilities? _capabilities;
  ProcessingProviderAvailability? _providerAvailability;
  String _status = 'デスクトップのLAN endpointとpairing tokenを入力してください';
  String _sourceText = '';
  String _azooKeyText = '';
  String _translationText = '';
  bool _dictionaryReady = false;
  bool _azooKeyModelReady = false;
  bool _connecting = false;
  bool _discovering = false;
  bool _authenticated = false;
  bool _routeControlsEnabled = false;
  bool _selectionPending = false;

  @override
  void initState() {
    super.initState();
    _route = widget.initialRoute ?? defaultPipelineRoute();
    _azooKeyModel = widget.initialAzooKeyModel;
    _asrChoice = _route.asr == ExecutionDevice.desktop
        ? _AsrChoice.desktopNative
        : _defaultMobileAsrChoice;
    _azooKeyChoice = _route.azookey == ExecutionDevice.desktop
        ? _AzooKeyChoice.desktopNative
        : _azooKeyChoiceForModel(_azooKeyModel);
    _translationChoice = _route.translation == ExecutionDevice.desktop
        ? _TranslationChoice.desktopNative
        : _TranslationChoice.rustQuickMt;
    _providerAvailability = ProcessingProviderAvailability(
      speechAnalyzer: _usesCupertino,
      sfSpeechRecognizer: _usesCupertino,
      rustSherpaOnnx: _usesCupertino,
      translationSession: _usesCupertino,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_probeProviderAvailabilityAndStart());
    });
  }

  Future<void> _probeProviderAvailabilityAndStart() async {
    final probe = widget.createProcessing();
    try {
      await probe.capabilities();
      final availability = await probe.providerAvailability();
      if (!mounted) return;
      setState(() {
        _providerAvailability = availability;
        _constrainProviderChoices(availability);
      });
    } on Object {
      // Keep the platform-based choices usable; preparation reports a concrete
      // provider error if the capability probe itself is unavailable.
    } finally {
      await _disposeCapabilityProbe(probe);
    }
    if (mounted && widget.autoDiscover) await _discoverAndConnect();
  }

  Future<void> _disposeCapabilityProbe(ProcessingBackend probe) async {
    if (probe is! NativeProcessingBackend) return;
    try {
      await probe.cancel();
    } on Object {
      // Capability probing must not block LAN discovery.
    }
    await probe.dispose();
  }

  @override
  void dispose() {
    unawaited(releaseAzookeyDictionary());
    unawaited(releaseAzookeyModel());
    unawaited(_companion?.dispose());
    unawaited(_disposeTransport(_transport));
    unawaited(_disposeProcessing(_processing));
    _endpointController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  Future<void> _initializeDictionary() async {
    try {
      await widget.prepareAzooKeyDictionary();
      if (!mounted) return;
      setState(() {
        _dictionaryReady = true;
        _status = 'デスクトップのLAN endpointとpairing tokenを入力してください';
      });
    } on Object catch (error) {
      if (mounted) setState(() => _status = 'AzooKey辞書エラー: $error');
      rethrow;
    }
  }

  Future<void> _initializeAzooKeyModel() async {
    await widget.prepareAzooKeyModel(_azooKeyModel);
    if (!mounted) return;
    setState(() => _azooKeyModelReady = true);
  }

  Future<void> _prepareInitialAzooKeyResources() async {
    if (!_dictionaryReady) {
      setState(() => _status = 'AzooKey辞書を準備中');
      await _initializeDictionary();
    }
    if (!_azooKeyModelReady) {
      setState(
        () => _status = 'AzooKey ${_azooKeyModelLabel(_azooKeyModel)} GGUFを準備中',
      );
      await _initializeAzooKeyModel();
    }
  }

  Future<void> _discoverAndConnect() async {
    if (_discovering || _connecting || _companion != null) return;
    setState(() {
      _discovering = true;
      _status = '同一ネットワーク上のNativeを検出中';
    });
    try {
      final discovered = await widget.discoverDesktop();
      _endpointController.text = discovered.endpoint;
      _tokenController.text = discovered.token;
      if (!mounted) return;
      setState(() => _status = 'Nativeを検出しました。認証接続中');
      await _toggleConnection();
    } on TimeoutException {
      if (!mounted) return;
      setState(() {
        _status =
            'Nativeを自動検出できません。'
            'ローカルネットワーク許可と同一Wi-Fiを確認してください';
      });
    } on Object catch (error) {
      if (mounted) setState(() => _status = '自動検出失敗: $error');
    } finally {
      if (mounted) setState(() => _discovering = false);
    }
  }

  Future<void> _toggleConnection() async {
    if (_companion != null) {
      final companion = _companion;
      final transport = _transport;
      final processing = _processing;
      setState(() {
        _companion = null;
        _transport = null;
        _processing = null;
        _status = '切断しました';
        _dictionaryReady = false;
        _azooKeyModelReady = false;
        _capabilities = null;
        _authenticated = false;
        _routeControlsEnabled = false;
      });
      await companion?.dispose();
      await _disposeTransport(transport);
      await _disposeProcessing(processing);
      await releaseAzookeyDictionary();
      await releaseAzookeyModel();
      return;
    }
    if (_connecting) return;
    setState(() {
      _connecting = true;
      _status = '接続中';
    });
    final transport = widget.createTransport();
    final processing = widget.createProcessing();
    CompanionController? companion;
    try {
      setState(() => _status = 'LAN接続中');
      await transport.open(
        endpoint: Uri.parse(_endpointController.text.trim()),
      );
      setState(() => _status = '接続済み端末のAPI利用可否を判定中');
      final capabilities = await processing.capabilities();
      final providerAvailability = await processing.providerAvailability();
      _providerAvailability = providerAvailability;
      _constrainProviderChoices(providerAvailability);
      final supportedRoute = _constrainRoute(_selectedRoute, capabilities);
      _route = supportedRoute;
      _synchronizeChoicesWithRoute(supportedRoute);
      transport.authenticate(
        token: _tokenController.text,
        capabilities: capabilities,
      );
      companion = CompanionController(
        route: supportedRoute,
        transport: transport,
        processing: processing,
        onStatus: _setStatus,
        onRouteRequested: _applyRequestedRoute,
        onRouteControlsEnabled: ({required enabled}) {
          if (!mounted) return;
          setState(() => _routeControlsEnabled = enabled);
          if (enabled) unawaited(_applyDeferredSelection());
        },
        onConnectionChanged: _handleConnectionChanged,
        onSource: (text) => _setResult(source: text),
        onAzooKey: (text) => _setResult(azooKey: text),
        onTranslation: (text) => _setResult(translation: text),
      );
      if (supportedRoute.azookey == ExecutionDevice.mobile) {
        await _prepareInitialAzooKeyResources();
      }
      await _configureSelectedProviders(processing);
      if (supportedRoute.translation == ExecutionDevice.mobile) {
        setState(
          () => _status = '${_translationChoiceLabel(_translationChoice)}を準備中',
        );
        await processing.prepareTranslation(
          sourceLanguage: 'ja',
          targetLanguage: 'en',
        );
      }
      transport.configure(
        route: supportedRoute,
        capabilities: capabilities,
      );
      if (!mounted) return;
      setState(() {
        _transport = transport;
        _processing = processing;
        _companion = companion;
        _capabilities = capabilities;
        _selectionPending = false;
        _connecting = false;
        _status = '認証応答を待っています / route ${pipelineRouteId(route: _route)}';
      });
    } on Object catch (error) {
      await companion?.dispose();
      await _disposeTransport(transport);
      await _disposeProcessing(processing);
      if (!mounted) return;
      setState(() {
        _connecting = false;
        _status = '接続失敗: $error';
      });
    }
  }

  void _handleConnectionChanged({required bool connected}) {
    if (!mounted) return;
    setState(() => _authenticated = connected);
    if (!connected) unawaited(_recoverUnexpectedDisconnect());
  }

  Future<void> _recoverUnexpectedDisconnect() async {
    // Leave the transport's onError callback before cancelling its own
    // subscription; cancelling synchronously from that callback can stall.
    await Future<void>.value();
    if (!mounted || _companion == null) return;
    final companion = _companion;
    final transport = _transport;
    final processing = _processing;
    setState(() {
      _companion = null;
      _transport = null;
      _processing = null;
      _capabilities = null;
      if (!widget.autoDiscover) {
        _dictionaryReady = false;
        _azooKeyModelReady = false;
      }
      _routeControlsEnabled = false;
      _connecting = false;
      _discovering = false;
      _status = '接続が切れました。再接続を準備中';
    });
    companion?.disposeAfterTransportFailure();
    await _disposeTransport(transport);
    await _disposeProcessing(processing);
    if (mounted && widget.autoDiscover) {
      await _discoverAndConnect();
      return;
    }
    unawaited(releaseAzookeyDictionary());
    unawaited(releaseAzookeyModel());
  }

  Future<void> _disposeTransport(CompanionTransport? transport) async {
    await transport?.close();
    if (transport is WebSocketCompanionTransport) await transport.dispose();
  }

  Future<void> _disposeProcessing(ProcessingBackend? processing) async {
    await processing?.cancel();
    if (processing is NativeProcessingBackend) await processing.dispose();
  }

  void _setStatus(String value) {
    if (mounted) setState(() => _status = value);
  }

  void _setResult({String? source, String? azooKey, String? translation}) {
    if (!mounted) return;
    setState(() {
      if (source != null) _sourceText = source;
      if (azooKey != null) _azooKeyText = azooKey;
      if (translation != null) _translationText = translation;
    });
  }

  Future<void> _configureSelectedProviders(ProcessingBackend processing) async {
    await processing.configureAsrProvider(_mobileAsrProvider(_asrChoice));
    if (_translationChoice != _TranslationChoice.desktopNative) {
      await processing.configureTranslationProvider(
        _mobileTranslationProvider(_translationChoice),
      );
    }
  }

  Future<void> _setAsrChoice(_AsrChoice choice) async {
    setState(() {
      _asrChoice = choice;
      _selectionPending = true;
    });
    await _applySelectionOrDefer('${_asrChoiceLabel(choice)}を選択しました');
  }

  Future<void> _setAzooKeyChoice(_AzooKeyChoice choice) async {
    if (choice != _AzooKeyChoice.desktopNative) {
      final model = choice == _AzooKeyChoice.mobileSmall
          ? AzooKeyModel.small
          : AzooKeyModel.xsmall;
      if (model != _azooKeyModel) _azooKeyModelReady = false;
      _azooKeyModel = model;
    }
    setState(() {
      _azooKeyChoice = choice;
      _selectionPending = true;
    });
    await _applySelectionOrDefer('${_azooKeyChoiceLabel(choice)}を選択しました');
  }

  Future<void> _setTranslationChoice(_TranslationChoice choice) async {
    setState(() {
      _translationChoice = choice;
      _selectionPending = true;
    });
    await _applySelectionOrDefer('${_translationChoiceLabel(choice)}を選択しました');
  }

  PipelineRoute get _selectedRoute => PipelineRoute(
    asr: _asrChoice == _AsrChoice.desktopNative
        ? ExecutionDevice.desktop
        : ExecutionDevice.mobile,
    azookey: _azooKeyChoice == _AzooKeyChoice.desktopNative
        ? ExecutionDevice.desktop
        : ExecutionDevice.mobile,
    translation: _translationChoice == _TranslationChoice.desktopNative
        ? ExecutionDevice.desktop
        : ExecutionDevice.mobile,
  );

  Future<void> _applySelectionOrDefer(String selectedStatus) async {
    if (_companion == null) {
      setState(() => _status = selectedStatus);
      return;
    }
    if (!_routeControlsEnabled) {
      setState(() => _status = '$selectedStatus。現在の認識完了後に反映します');
      return;
    }
    await _applyDeferredSelection();
  }

  Future<void> _applyDeferredSelection() async {
    if (!_selectionPending || _companion == null || !_routeControlsEnabled) {
      return;
    }
    final capabilities = _capabilities;
    if (capabilities == null) return;
    final requestedRoute = _constrainRoute(_selectedRoute, capabilities);
    _selectionPending = false;
    if (requestedRoute == _route) {
      await _prepareRouteResources(requestedRoute);
      return;
    }
    await _requestRoute(requestedRoute);
  }

  Future<void> _requestRoute(PipelineRoute requestedRoute) async {
    final transport = _transport;
    if (transport == null) return;
    setState(() {
      _routeControlsEnabled = false;
      _status =
          '設定をデスクトップと同期中: '
          '${pipelineRouteId(route: requestedRoute)}';
    });
    try {
      await _prepareRouteResources(requestedRoute);
      transport.sendText(encodeRouteRequest(route: requestedRoute));
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _routeControlsEnabled = true;
        _status = '設定同期失敗: $error';
      });
    }
  }

  Future<void> _applyRequestedRoute(PipelineRoute route) async {
    await _prepareRouteResources(route);
    if (!mounted) return;
    setState(() {
      _route = route;
      _synchronizeChoicesWithRoute(route);
    });
  }

  void _constrainProviderChoices(
    ProcessingProviderAvailability availability,
  ) {
    if (_asrChoice == _AsrChoice.speechAnalyzer &&
        !availability.speechAnalyzer) {
      _asrChoice = availability.sfSpeechRecognizer
          ? _AsrChoice.sfSpeechRecognizer
          : _AsrChoice.rustSherpaOnnxReazonSpeech;
    }
    if (_asrChoice == _AsrChoice.sfSpeechRecognizer &&
        !availability.sfSpeechRecognizer) {
      _asrChoice = availability.rustSherpaOnnx
          ? _AsrChoice.rustSherpaOnnxReazonSpeech
          : _AsrChoice.desktopNative;
    }
    if (_translationChoice != _TranslationChoice.rustQuickMt &&
        _translationChoice != _TranslationChoice.desktopNative &&
        !availability.translationSession) {
      _translationChoice = _TranslationChoice.rustQuickMt;
    }
  }

  void _synchronizeChoicesWithRoute(PipelineRoute route) {
    if (route.asr == ExecutionDevice.desktop) {
      _asrChoice = _AsrChoice.desktopNative;
    } else if (_asrChoice == _AsrChoice.desktopNative) {
      _asrChoice = _defaultMobileAsrChoice;
    }
    if (route.azookey == ExecutionDevice.desktop) {
      _azooKeyChoice = _AzooKeyChoice.desktopNative;
    } else if (_azooKeyChoice == _AzooKeyChoice.desktopNative) {
      _azooKeyChoice = _azooKeyChoiceForModel(_azooKeyModel);
    }
    if (route.translation == ExecutionDevice.desktop) {
      _translationChoice = _TranslationChoice.desktopNative;
    } else if (_translationChoice == _TranslationChoice.desktopNative) {
      _translationChoice = _TranslationChoice.rustQuickMt;
    }
  }

  Future<void> _prepareRouteResources(PipelineRoute route) async {
    final processing = _processing;
    if (processing == null) return;
    await _configureSelectedProviders(processing);
    if (route.asr == ExecutionDevice.mobile &&
        _asrChoice == _AsrChoice.rustSherpaOnnxReazonSpeech) {
      await processing.prepareAsr('ja-JP');
    }
    if (route.azookey == ExecutionDevice.mobile) {
      if (!_dictionaryReady) await _initializeDictionary();
      if (!_azooKeyModelReady) await _initializeAzooKeyModel();
    }
    if (route.azookey == ExecutionDevice.desktop) {
      if (_dictionaryReady) unawaited(releaseAzookeyDictionary());
      if (_azooKeyModelReady) unawaited(releaseAzookeyModel());
      _dictionaryReady = false;
      _azooKeyModelReady = false;
    }
    if (route.translation == ExecutionDevice.mobile) {
      await processing.prepareTranslation(
        sourceLanguage: 'ja',
        targetLanguage: 'en',
      );
    } else {
      await processing.releaseTranslation();
    }
  }

  @override
  Widget build(BuildContext context) {
    final connected = _companion != null;
    return _PlatformPage(
      title: 'Kotoba Beacon Companion',
      child: SafeArea(
        child: _AdaptiveBody(
          configuration: _configurationWidgets(connected: connected),
          results: _resultWidgets(),
        ),
      ),
    );
  }

  List<Widget> _configurationWidgets({required bool connected}) {
    final providerAvailability = _providerAvailability;
    final translationAvailable =
        providerAvailability?.translationSession ?? false;
    return [
      const _SectionHeading('接続情報'),
      const SizedBox(height: _gap),
      const Text('エンドポイント', style: _emphasisTextStyle),
      const SizedBox(height: _gap / 2),
      _PlatformTextField(
        key: const Key('endpoint-field'),
        controller: _endpointController,
        enabled: !connected,
        keyboardType: TextInputType.url,
        label: 'Desktop WebSocket endpoint',
      ),
      const SizedBox(height: _gap),
      const Text('ペアリングトークン', style: _emphasisTextStyle),
      const SizedBox(height: _gap / 2),
      _PlatformTextField(
        key: const Key('token-field'),
        controller: _tokenController,
        enabled: !connected,
        obscureText: true,
        label: 'Pairing token',
      ),
      const SizedBox(height: _gap),
      Semantics(
        liveRegion: true,
        child: Text(
          _status,
          key: const Key('connection-status'),
          style: _bodyTextStyle,
        ),
      ),
      const SizedBox(height: _gap),
      _ConnectionStateCard(connected: _authenticated),
      const SizedBox(height: _gap),
      _ConnectionButton(
        connected: connected,
        enabled: !_connecting && !_discovering,
        onPressed: connected
            ? _toggleConnection
            : widget.autoDiscover
            ? _discoverAndConnect
            : _toggleConnection,
      ),
      const SizedBox(height: _sectionGap),
      const _SectionHeading('連携機能'),
      const SizedBox(height: _gap),
      _ChoiceSelector<_AsrChoice>(
        label: 'ASR方式',
        keyId: 'asr-provider',
        value: _asrChoice,
        options: [
          const _ChoiceOption(
            value: _AsrChoice.desktopNative,
            label: 'Desktop Native（デスクトップで処理）',
          ),
          if (_usesCupertino)
            _ChoiceOption(
              value: _AsrChoice.speechAnalyzer,
              label: 'iOS SpeechAnalyzer + SpeechTranscriber（リアルタイム）',
              available: providerAvailability?.speechAnalyzer ?? false,
            ),
          if (_usesCupertino)
            _ChoiceOption(
              value: _AsrChoice.sfSpeechRecognizer,
              label: 'iOS SFSpeechRecognizer（オンデバイス・リアルタイム）',
              available: providerAvailability?.sfSpeechRecognizer ?? false,
            ),
          if (!_usesCupertino)
            _ChoiceOption(
              value: _AsrChoice.androidMlKit,
              label: 'Android ML Kit GenAI Speech Recognition',
              available: _capabilities?.asrAvailable ?? true,
            ),
          _ChoiceOption(
            value: _AsrChoice.rustSherpaOnnxReazonSpeech,
            label:
                'Mobile Rust: sherpa-onnx + ReazonSpeech K2 v2 '
                'INT8（ONNX Runtime）',
            available: providerAvailability?.rustSherpaOnnx ?? false,
          ),
        ],
        onChanged: (value) => unawaited(_setAsrChoice(value)),
      ),
      _ChoiceSelector<_AzooKeyChoice>(
        label: 'AzooKey方式',
        keyId: 'azookey-provider',
        value: _azooKeyChoice,
        options: const [
          _ChoiceOption(
            value: _AzooKeyChoice.desktopNative,
            label: 'Desktop Native（デスクトップで処理）',
          ),
          _ChoiceOption(
            value: _AzooKeyChoice.mobileSmall,
            label: 'Mobile Rust: AzooKey + zenz-v3.2-small Q5_K_M GGUF',
          ),
          _ChoiceOption(
            value: _AzooKeyChoice.mobileXsmall,
            label: 'Mobile Rust: AzooKey + zenz-v3.2-xsmall Q5_K_M GGUF',
          ),
        ],
        onChanged: (value) => unawaited(_setAzooKeyChoice(value)),
      ),
      _ChoiceSelector<_TranslationChoice>(
        label: '翻訳方式',
        keyId: 'translation-provider',
        value: _translationChoice,
        options: _translationOptions(translationAvailable),
        onChanged: (value) => unawaited(_setTranslationChoice(value)),
      ),
    ];
  }

  List<_ChoiceOption<_TranslationChoice>> _translationOptions(
    bool platformAvailable,
  ) => [
    const _ChoiceOption(
      value: _TranslationChoice.desktopNative,
      label: 'Desktop Native（デスクトップで処理）',
    ),
    if (_usesCupertino)
      _ChoiceOption(
        value: _TranslationChoice.platformTranslationSession,
        label: 'iOS TranslationSession（標準 / lowLatency）',
        available: platformAvailable,
      ),
    if (_usesCupertino)
      _ChoiceOption(
        value: _TranslationChoice.platformTranslationSessionHighFidelity,
        label: 'iOS TranslationSession.highFidelity',
        available: platformAvailable,
      ),
    const _ChoiceOption(
      value: _TranslationChoice.rustQuickMt,
      label:
          'Mobile Rust: QuickMT ja→en + CTranslate2 INT8 + '
          'SentencePiece（beam 2）',
    ),
  ];

  List<Widget> _resultWidgets() => [
    _CollapsibleSection(
      sectionKey: const Key('processing-details'),
      label: '詳細情報を表示',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _ConnectionCard(
            endpoint: _endpointController.text.trim(),
            route: _route,
            asrChoice: _asrChoice,
            azooKeyChoice: _azooKeyChoice,
            translationChoice: _translationChoice,
            capabilities: _capabilities,
          ),
          _ResultCard(label: 'ASR', text: _sourceText),
          _ResultCard(label: 'AzooKey', text: _azooKeyText),
          _ResultCard(label: 'Translation', text: _translationText),
        ],
      ),
    ),
  ];
}

PipelineRoute _constrainRoute(
  PipelineRoute route,
  MobileCapabilities capabilities,
) => PipelineRoute(
  asr: capabilities.asrAvailable ? route.asr : ExecutionDevice.desktop,
  azookey: capabilities.azookeyAvailable
      ? route.azookey
      : ExecutionDevice.desktop,
  translation: capabilities.translationAvailable
      ? route.translation
      : ExecutionDevice.desktop,
);

class _AdaptiveBody extends StatelessWidget {
  const _AdaptiveBody({required this.configuration, required this.results});

  static const _wideBreakpoint = 900.0;
  static const _wideMaxWidth = 1180.0;
  static const _narrowMaxWidth = 680.0;

  final List<Widget> configuration;
  final List<Widget> results;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final wide = constraints.maxWidth >= _wideBreakpoint;
      final content = wide
          ? Row(
              key: const Key('tablet-two-pane'),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: _Pane(children: configuration)),
                const SizedBox(width: _sectionGap),
                Expanded(child: _Pane(children: results)),
              ],
            )
          : _Pane(
              key: const Key('phone-single-pane'),
              children: [
                ...configuration,
                const SizedBox(height: _sectionGap),
                ...results,
              ],
            );
      return SingleChildScrollView(
        padding: const EdgeInsets.all(_sectionGap),
        child: Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: wide ? _wideMaxWidth : _narrowMaxWidth,
            ),
            child: content,
          ),
        ),
      );
    },
  );
}

class _Pane extends StatelessWidget {
  const _Pane({required this.children, super.key});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: children,
  );
}

class _PlatformPage extends StatelessWidget {
  const _PlatformPage({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (_usesCupertino) {
      return CupertinoPageScaffold(
        navigationBar: CupertinoNavigationBar(middle: Text(title)),
        child: child,
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: child,
    );
  }
}

class _SectionHeading extends StatelessWidget {
  const _SectionHeading(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(text, style: _emphasisTextStyle);
  }
}

class _PlatformTextField extends StatelessWidget {
  const _PlatformTextField({
    required this.controller,
    required this.enabled,
    required this.label,
    super.key,
    this.keyboardType,
    this.obscureText = false,
  });

  final TextEditingController controller;
  final bool enabled;
  final String label;
  final TextInputType? keyboardType;
  final bool obscureText;

  @override
  Widget build(BuildContext context) {
    if (_usesCupertino) {
      return CupertinoTextField(
        controller: controller,
        enabled: enabled,
        autocorrect: false,
        keyboardType: keyboardType,
        obscureText: obscureText,
        padding: const EdgeInsets.all(12),
        placeholder: label,
        style: _bodyTextStyle,
        placeholderStyle: _bodyTextStyle.copyWith(
          color: CupertinoColors.placeholderText.resolveFrom(context),
        ),
      );
    }
    return TextField(
      controller: controller,
      enabled: enabled,
      autocorrect: false,
      keyboardType: keyboardType,
      obscureText: obscureText,
      style: _bodyTextStyle,
      decoration: InputDecoration(labelText: label),
    );
  }
}

class _ConnectionButton extends StatelessWidget {
  const _ConnectionButton({
    required this.connected,
    required this.enabled,
    required this.onPressed,
  });

  final bool connected;
  final bool enabled;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => _PlatformActionButton(
    buttonKey: const Key('connection-button'),
    label: connected ? '接続中は切断する' : '自動検出で接続する',
    enabled: enabled,
    emphasized: true,
    onPressed: onPressed,
  );
}

class _PlatformActionButton extends StatelessWidget {
  const _PlatformActionButton({
    required this.buttonKey,
    required this.label,
    required this.enabled,
    required this.emphasized,
    required this.onPressed,
  });

  final Key buttonKey;
  final String label;
  final bool enabled;
  final bool emphasized;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final action = enabled ? onPressed : null;
    if (_usesCupertino) {
      final textColor = emphasized
          ? CupertinoColors.white
          : CupertinoTheme.of(context).primaryColor;
      final child = SizedBox(
        height: _controlHeight,
        child: Center(
          child: Text(
            label,
            style: _emphasisTextStyle.copyWith(color: textColor),
          ),
        ),
      );
      if (emphasized) {
        return CupertinoButton.filled(
          key: buttonKey,
          padding: EdgeInsets.zero,
          onPressed: action,
          child: child,
        );
      }
      return CupertinoButton.tinted(
        key: buttonKey,
        padding: EdgeInsets.zero,
        onPressed: action,
        child: child,
      );
    }
    if (emphasized) {
      return FilledButton(
        key: buttonKey,
        onPressed: action,
        child: Text(label),
      );
    }
    return OutlinedButton(
      key: buttonKey,
      onPressed: action,
      child: Text(label),
    );
  }
}

final class _ChoiceOption<T> {
  const _ChoiceOption({
    required this.value,
    required this.label,
    this.available = true,
  });

  final T value;
  final String label;
  final bool available;
}

class _ChoiceSelector<T> extends StatelessWidget {
  const _ChoiceSelector({
    required this.label,
    required this.keyId,
    required this.value,
    required this.options,
    required this.onChanged,
  });

  final String label;
  final String keyId;
  final T value;
  final List<_ChoiceOption<T>> options;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) => _LabeledControl(
    label: label,
    control: ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Column(
        key: Key(keyId),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: options.indexed
            .map((entry) => _segment(context, entry.$1, entry.$2))
            .toList(growable: false),
      ),
    ),
  );

  Widget _segment(
    BuildContext context,
    int index,
    _ChoiceOption<T> option,
  ) {
    final selected = option.value == value;
    final primary = _usesCupertino
        ? CupertinoTheme.of(context).primaryColor
        : Theme.of(context).colorScheme.primary;
    final unavailableBackground = _usesCupertino
        ? CupertinoColors.systemGrey5.resolveFrom(context)
        : Theme.of(context).colorScheme.surfaceContainerHighest;
    final background = !option.available
        ? unavailableBackground
        : selected
        ? primary
        : (_usesCupertino
              ? CupertinoColors.systemBackground.resolveFrom(context)
              : Theme.of(context).colorScheme.surface);
    final foreground = !option.available
        ? CupertinoColors.inactiveGray
        : selected
        ? (_usesCupertino
              ? CupertinoColors.white
              : Theme.of(context).colorScheme.onPrimary)
        : _contentColor;
    final text = option.available
        ? option.label
        : '${option.label}（この端末では利用不可）';
    return Semantics(
      button: true,
      selected: selected,
      enabled: option.available,
      child: GestureDetector(
        key: Key('$keyId-${option.value}'),
        behavior: HitTestBehavior.opaque,
        onTap: option.available ? () => onChanged(option.value) : null,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: background,
            border: Border(
              left: BorderSide(color: primary),
              right: BorderSide(color: primary),
              top: BorderSide(color: primary),
              bottom: index == options.length - 1
                  ? BorderSide(color: primary)
                  : BorderSide.none,
            ),
          ),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: _controlHeight),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: _gap,
                vertical: _gap,
              ),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  text,
                  style: _bodyTextStyle.copyWith(
                    color: foreground,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _LabeledControl extends StatelessWidget {
  const _LabeledControl({required this.label, required this.control});

  static const _horizontalBreakpoint = 560.0;

  final String label;
  final Widget control;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: _gap / 2),
    child: LayoutBuilder(
      builder: (context, constraints) =>
          constraints.maxWidth >= _horizontalBreakpoint
          ? Row(
              key: Key('horizontal-control-$label'),
              children: [
                Expanded(child: Text(label, style: _bodyTextStyle)),
                Expanded(child: control),
              ],
            )
          : Column(
              key: Key('vertical-control-$label'),
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(label, style: _emphasisTextStyle),
                const SizedBox(height: _gap / 2),
                control,
              ],
            ),
    ),
  );
}

_AsrChoice get _defaultMobileAsrChoice =>
    _usesCupertino ? _AsrChoice.speechAnalyzer : _AsrChoice.androidMlKit;

MobileAsrProvider _mobileAsrProvider(_AsrChoice choice) => switch (choice) {
  _AsrChoice.speechAnalyzer => MobileAsrProvider.platformSpeechAnalyzer,
  _AsrChoice.sfSpeechRecognizer => MobileAsrProvider.platformSFSpeechRecognizer,
  _AsrChoice.androidMlKit => MobileAsrProvider.androidMlKit,
  _AsrChoice.rustSherpaOnnxReazonSpeech =>
    MobileAsrProvider.rustSherpaOnnxReazonSpeech,
  _AsrChoice.desktopNative => MobileAsrProvider.platformSpeechAnalyzer,
};

MobileTranslationProvider _mobileTranslationProvider(
  _TranslationChoice choice,
) => switch (choice) {
  _TranslationChoice.platformTranslationSession =>
    MobileTranslationProvider.platformTranslationSession,
  _TranslationChoice.platformTranslationSessionHighFidelity =>
    MobileTranslationProvider.platformTranslationSessionHighFidelity,
  _TranslationChoice.desktopNative ||
  _TranslationChoice.rustQuickMt => MobileTranslationProvider.rustQuickMt,
};

String _azooKeyModelLabel(AzooKeyModel model) => switch (model) {
  AzooKeyModel.small => 'Small',
  AzooKeyModel.xsmall => 'XSmall',
};

_AzooKeyChoice _azooKeyChoiceForModel(AzooKeyModel model) => switch (model) {
  AzooKeyModel.small => _AzooKeyChoice.mobileSmall,
  AzooKeyModel.xsmall => _AzooKeyChoice.mobileXsmall,
};

String _asrChoiceLabel(_AsrChoice choice) => switch (choice) {
  _AsrChoice.desktopNative => 'Desktop Native ASR',
  _AsrChoice.speechAnalyzer => 'iOS SpeechAnalyzer + SpeechTranscriber（リアルタイム）',
  _AsrChoice.sfSpeechRecognizer => 'iOS SFSpeechRecognizer（オンデバイス）',
  _AsrChoice.androidMlKit => 'Android ML Kit GenAI Speech Recognition',
  _AsrChoice.rustSherpaOnnxReazonSpeech =>
    'Mobile Rust sherpa-onnx + ReazonSpeech K2 v2 INT8',
};

String _azooKeyChoiceLabel(_AzooKeyChoice choice) => switch (choice) {
  _AzooKeyChoice.desktopNative => 'Desktop Native',
  _AzooKeyChoice.mobileSmall =>
    'Mobile Rust AzooKey + zenz-v3.2-small Q5_K_M GGUF',
  _AzooKeyChoice.mobileXsmall =>
    'Mobile Rust AzooKey + zenz-v3.2-xsmall Q5_K_M GGUF',
};

String _translationChoiceLabel(_TranslationChoice choice) => switch (choice) {
  _TranslationChoice.desktopNative => 'Desktop Native翻訳',
  _TranslationChoice.platformTranslationSession =>
    'iOS TranslationSession lowLatency',
  _TranslationChoice.platformTranslationSessionHighFidelity =>
    'iOS TranslationSession.highFidelity',
  _TranslationChoice.rustQuickMt => 'Mobile Rust QuickMT',
};

class _ConnectionStateCard extends StatelessWidget {
  const _ConnectionStateCard({required this.connected});

  final bool connected;

  @override
  Widget build(BuildContext context) {
    final connection = connected ? '認証済み' : '未接続または同期中';
    if (_usesCupertino) {
      return CupertinoListSection.insetGrouped(
        margin: EdgeInsets.zero,
        children: [
          CupertinoListTile(
            title: const Text('接続状態', style: _emphasisTextStyle),
            additionalInfo: Text(connection, style: _bodyTextStyle),
          ),
        ],
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(_sectionGap),
        child: Text('接続状態: $connection', style: _emphasisTextStyle),
      ),
    );
  }
}

class _CollapsibleSection extends StatefulWidget {
  const _CollapsibleSection({
    required this.sectionKey,
    required this.label,
    required this.child,
  });

  final Key sectionKey;
  final String label;
  final Widget child;

  @override
  State<_CollapsibleSection> createState() => _CollapsibleSectionState();
}

class _CollapsibleSectionState extends State<_CollapsibleSection> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) => Column(
    key: widget.sectionKey,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      if (_usesCupertino)
        CupertinoButton(
          minimumSize: const Size(0, _controlHeight),
          padding: const EdgeInsets.symmetric(horizontal: _gap),
          alignment: Alignment.centerLeft,
          onPressed: _toggle,
          child: _heading(),
        )
      else
        TextButton(
          style: const ButtonStyle(
            minimumSize: WidgetStatePropertyAll(
              Size.fromHeight(_controlHeight),
            ),
            alignment: Alignment.centerLeft,
          ),
          onPressed: _toggle,
          child: _heading(),
        ),
      if (_expanded) widget.child,
    ],
  );

  Widget _heading() => Row(
    children: [
      Icon(
        _expanded
            ? (_usesCupertino ? CupertinoIcons.chevron_up : Icons.expand_less)
            : (_usesCupertino
                  ? CupertinoIcons.chevron_down
                  : Icons.expand_more),
      ),
      const SizedBox(width: _gap),
      Text(widget.label, style: _emphasisTextStyle),
    ],
  );

  void _toggle() => setState(() => _expanded = !_expanded);
}

class _ConnectionCard extends StatelessWidget {
  const _ConnectionCard({
    required this.endpoint,
    required this.route,
    required this.asrChoice,
    required this.azooKeyChoice,
    required this.translationChoice,
    required this.capabilities,
  });

  final String endpoint;
  final PipelineRoute route;
  final _AsrChoice asrChoice;
  final _AzooKeyChoice azooKeyChoice;
  final _TranslationChoice translationChoice;
  final MobileCapabilities? capabilities;

  @override
  Widget build(BuildContext context) {
    final items = _detailItems();
    if (_usesCupertino) {
      return CupertinoListSection.insetGrouped(
        margin: EdgeInsets.zero,
        children: items
            .map(
              (item) => CupertinoListTile(
                title: Text(item.$1, style: _emphasisTextStyle),
                subtitle: Text(item.$2, style: _bodyTextStyle),
              ),
            )
            .toList(growable: false),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(_sectionGap),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: items
              .map(
                (item) => Text('${item.$1}: ${item.$2}', style: _bodyTextStyle),
              )
              .toList(growable: false),
        ),
      ),
    );
  }

  List<(String, String)> _detailItems() {
    final capabilities = this.capabilities;
    return [
      ('Desktop endpoint', endpoint),
      ('同期済み route', pipelineRouteId(route: route)),
      ('ASR方式', _asrChoiceLabel(asrChoice)),
      ('AzooKey方式', _azooKeyChoiceLabel(azooKeyChoice)),
      ('翻訳方式', _translationChoiceLabel(translationChoice)),
      if (capabilities != null)
        (
          'Mobile APIs',
          'ASR ${_availability(capabilities.asrAvailable)}, '
              'AzooKey ${_availability(capabilities.azookeyAvailable)}, '
              '翻訳 ${_availability(capabilities.translationAvailable)}',
        ),
    ];
  }
}

String _availability(bool available) => available ? '利用可' : '利用不可';

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.label, required this.text});

  final String label;
  final String text;

  @override
  Widget build(BuildContext context) {
    final value = text.isEmpty ? '—' : text;
    if (_usesCupertino) {
      return CupertinoListSection.insetGrouped(
        margin: const EdgeInsets.symmetric(vertical: 4),
        children: [
          CupertinoListTile(
            title: Text(label, style: _emphasisTextStyle),
            subtitle: Text(value, style: _bodyTextStyle),
          ),
        ],
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(_sectionGap),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: _emphasisTextStyle),
            const SizedBox(height: _gap),
            Text(value, style: _bodyTextStyle),
          ],
        ),
      ),
    );
  }
}
