import 'dart:async';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kotoba_beacon_companion/src/azookey_assets.dart';
import 'package:kotoba_beacon_companion/src/companion_connection.dart';
import 'package:kotoba_beacon_companion/src/companion_controller.dart';
import 'package:kotoba_beacon_companion/src/companion_l10n.dart';
import 'package:kotoba_beacon_companion/src/companion_pairing.dart';
import 'package:kotoba_beacon_companion/src/companion_style.dart';
import 'package:kotoba_beacon_companion/src/mobile_browser_source.dart';
import 'package:kotoba_beacon_companion/src/mobile_browser_source_panel.dart';
import 'package:kotoba_beacon_companion/src/mobile_rust_asr_assets.dart';
import 'package:kotoba_beacon_companion/src/native_processing.dart';
import 'package:kotoba_beacon_companion/src/quickmt_assets.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';
import 'package:kotoba_beacon_companion/src/rust/frb_generated.dart';
import 'package:path_provider/path_provider.dart';

/// Starts the mobile companion after initializing the generated Rust bridge.
// coverage:ignore-start
const _processingChannel = MethodChannel('kotoba_beacon/processing');
const _pairingEvents = EventChannel('kotoba_beacon/pairing');

Future<void> main() => startCompanion(
  initializeRust: () async {
    await RustLib.init();
    await loadMobileBrowserSourceFont();
  },
  root: KotobaBeaconCompanionApp(
    home: CompanionHomePage(
      autoDiscover: true,
      loadBrowserSourcePreferences: loadMobileBrowserSourcePreferences,
      saveBrowserSourcePreferences: saveMobileBrowserSourcePreferences,
      pairingLinks: _pairingEvents
          .receiveBroadcastStream()
          .where((event) => event is String)
          .map((event) => Uri.parse(event as String)),
      openSystemCamera: () =>
          _processingChannel.invokeMethod<void>('openSystemCamera'),
    ),
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
    this.locale,
  });

  /// Platform-adaptive home page, replaceable by deterministic tests.
  final Widget home;

  /// Optional locale override for tests; production follows the device.
  final Locale? locale;

  @override
  Widget build(BuildContext context) {
    final l10n = CompanionL10n.fromLocale(
      locale ?? WidgetsBinding.instance.platformDispatcher.locale,
    );
    if (_usesCupertino) {
      return CompanionL10nScope(
        l10n: l10n,
        child: CupertinoApp(
          title: l10n.title,
          debugShowCheckedModeBanner: false,
          theme: const CupertinoThemeData(
            brightness: Brightness.light,
            primaryColor: CompanionStyle.primary,
            barBackgroundColor: CompanionStyle.pageBackground,
            scaffoldBackgroundColor: CompanionStyle.pageBackground,
            textTheme: CupertinoTextThemeData(
              textStyle: CompanionStyle.body,
              actionTextStyle: CompanionStyle.emphasis,
              navTitleTextStyle: CompanionStyle.title,
            ),
          ),
          home: home,
        ),
      );
    }
    return CompanionL10nScope(
      l10n: l10n,
      child: MaterialApp(
        title: l10n.title,
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          colorScheme: const ColorScheme.light(
            primary: CompanionStyle.primary,
            onSurface: CompanionStyle.content,
            onSurfaceVariant: CompanionStyle.muted,
            outline: CompanionStyle.primary,
          ),
          scaffoldBackgroundColor: CompanionStyle.pageBackground,
          appBarTheme: const AppBarTheme(
            backgroundColor: CompanionStyle.pageBackground,
            foregroundColor: CompanionStyle.content,
            elevation: 0,
          ),
          cardColor: CompanionStyle.surface,
          textTheme: const TextTheme(
            bodyLarge: CompanionStyle.body,
            bodyMedium: CompanionStyle.body,
            titleLarge: CompanionStyle.title,
            titleMedium: CompanionStyle.emphasis,
            labelLarge: CompanionStyle.emphasis,
          ),
          inputDecorationTheme: const InputDecorationTheme(
            contentPadding: EdgeInsets.all(CompanionStyle.inset),
            border: OutlineInputBorder(),
          ),
          filledButtonTheme: FilledButtonThemeData(
            style: ButtonStyle(
              minimumSize: const WidgetStatePropertyAll(
                Size.fromHeight(CompanionStyle.controlHeight),
              ),
              backgroundColor: WidgetStateProperty.resolveWith((states) {
                final enabled = !states.contains(WidgetState.disabled);
                return CompanionStyle.buttonFill(
                  emphasized: true,
                  enabled: enabled,
                );
              }),
              foregroundColor: WidgetStateProperty.resolveWith((states) {
                final enabled = !states.contains(WidgetState.disabled);
                return CompanionStyle.buttonLabel(
                  emphasized: true,
                  enabled: enabled,
                );
              }),
              textStyle: const WidgetStatePropertyAll(CompanionStyle.emphasis),
            ),
          ),
          outlinedButtonTheme: OutlinedButtonThemeData(
            style: ButtonStyle(
              minimumSize: const WidgetStatePropertyAll(
                Size.fromHeight(CompanionStyle.controlHeight),
              ),
              backgroundColor: WidgetStateProperty.resolveWith((states) {
                final enabled = !states.contains(WidgetState.disabled);
                return CompanionStyle.buttonFill(
                  emphasized: false,
                  enabled: enabled,
                );
              }),
              foregroundColor: WidgetStateProperty.resolveWith((states) {
                final enabled = !states.contains(WidgetState.disabled);
                return CompanionStyle.buttonLabel(
                  emphasized: false,
                  enabled: enabled,
                );
              }),
              side: WidgetStateProperty.resolveWith((states) {
                final enabled = !states.contains(WidgetState.disabled);
                return BorderSide(
                  color: CompanionStyle.buttonBorder(enabled: enabled),
                );
              }),
              textStyle: const WidgetStatePropertyAll(CompanionStyle.emphasis),
            ),
          ),
          useMaterial3: true,
        ),
        home: home,
      ),
    );
  }
}

bool get _usesCupertino => defaultTargetPlatform == TargetPlatform.iOS;

CompanionDeviceKind _deviceKind(BuildContext context) {
  final isLarge = MediaQuery.sizeOf(context).shortestSide >= 600;
  if (!isLarge) return CompanionDeviceKind.phone;
  if (defaultTargetPlatform == TargetPlatform.iOS) {
    return CompanionDeviceKind.ipad;
  }
  if (defaultTargetPlatform == TargetPlatform.android) {
    return CompanionDeviceKind.androidTablet;
  }
  return CompanionDeviceKind.phone;
}

enum _DisplayMode { standard, detailed }

enum _StatusKind { idle, progress, error }

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
    this.pairingLinks,
    this.openSystemCamera,
    this.autoDiscover = false,
    this.browserSourceBackend = const RustMobileBrowserSourceBackend(),
    this.loadBrowserSourcePreferences,
    this.saveBrowserSourcePreferences,
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

  /// Camera-scanned pairing URLs delivered while the page is visible.
  final Stream<Uri>? pairingLinks;

  /// Opens the platform camera app for QR pairing.
  final Future<void> Function()? openSystemCamera;

  /// Owns the opt-in Mobile LAN HTML caption server.
  final MobileBrowserSourceBackend browserSourceBackend;

  /// Loads persisted HTML host settings in production.
  final Future<MobileBrowserSourcePreferences> Function()?
  loadBrowserSourcePreferences;

  /// Saves persisted HTML host settings in production.
  final Future<void> Function(MobileBrowserSourcePreferences preferences)?
  saveBrowserSourcePreferences;

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
  late _DisplayMode _displayMode;
  late _AsrChoice _asrChoice;
  late _AzooKeyChoice _azooKeyChoice;
  late _TranslationChoice _translationChoice;
  CompanionTransport? _transport;
  ProcessingBackend? _processing;
  CompanionController? _companion;
  MobileCapabilities? _capabilities;
  ProcessingProviderAvailability? _providerAvailability;
  CompanionL10n _l10n = CompanionL10n.japanese;
  _StatusKind _statusKind = _StatusKind.idle;
  String _status = '';
  bool _userInitiatedConnection = false;
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
  bool _browserSourceEnabled = false;
  bool _browserSourceBusy = false;
  String? _browserSourceUrl;
  CompanionCaptionStyle _browserSourceStyle = const CompanionCaptionStyle();
  String _previewSourceText = 'こんにちは聞こえますか。';
  String _previewTranslationText = 'Hello, can you hear me?';
  String _hostSourceText = '';
  String _hostTranslationText = '';
  Timer? _browserSourceSaveTimer;
  StreamSubscription<Uri>? _pairingSubscription;

  @override
  void initState() {
    super.initState();
    _route = widget.initialRoute ?? defaultPipelineRoute();
    _azooKeyModel = widget.initialAzooKeyModel;
    _displayMode = _DisplayMode.standard;
    _asrChoice = _route.asr == ExecutionDevice.desktop
        ? _AsrChoice.desktopNative
        : _displayMode == _DisplayMode.standard
        ? _AsrChoice.rustSherpaOnnxReazonSpeech
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
    final pairingLinks = widget.pairingLinks;
    if (pairingLinks != null) {
      _pairingSubscription = pairingLinks.listen(_applyPairingLink);
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_restoreBrowserSourcePreferences());
      unawaited(_probeProviderAvailabilityAndStart());
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _l10n = CompanionL10n.of(context);
    if (_status.isEmpty && !_isStandard) {
      _status = _l10n.enterEndpointAndToken;
    }
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
    unawaited(_pairingSubscription?.cancel());
    _browserSourceSaveTimer?.cancel();
    if (_browserSourceEnabled) unawaited(widget.browserSourceBackend.stop());
    _endpointController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  Future<void> _restoreBrowserSourcePreferences() async {
    final load = widget.loadBrowserSourcePreferences;
    if (load == null) return;
    try {
      final preferences = await load();
      if (!mounted) return;
      setState(() {
        _browserSourceStyle = preferences.style;
        _browserSourceEnabled = preferences.enabled;
      });
      if (preferences.enabled) await _startBrowserSource();
    } on Object catch (error) {
      _reportBrowserSourceFailure(error);
    }
  }

  Future<void> _setBrowserSourceEnabled(bool enabled) async {
    if (_browserSourceBusy || enabled == _browserSourceEnabled) return;
    setState(() {
      _browserSourceEnabled = enabled;
      _browserSourceBusy = true;
    });
    try {
      if (enabled) {
        await _startBrowserSource();
      } else {
        await _stopBrowserSource();
      }
      _scheduleBrowserSourceSave();
    } on Object catch (error) {
      _restoreBrowserSourceToggle(enabled, error);
    }
  }

  Future<void> _stopBrowserSource() async {
    await widget.browserSourceBackend.stop();
    if (!mounted) return;
    setState(() {
      _browserSourceUrl = null;
      _browserSourceBusy = false;
    });
    _companion?.publishBrowserSourceStatus();
  }

  void _restoreBrowserSourceToggle(bool enabled, Object error) {
    if (!mounted) return;
    setState(() {
      _browserSourceEnabled = !enabled;
      _browserSourceBusy = false;
    });
    _reportBrowserSourceFailure(error);
  }

  Future<void> _startBrowserSource() async {
    if (!_browserSourceBusy && mounted) {
      setState(() => _browserSourceBusy = true);
    }
    final url = await widget.browserSourceBackend.start();
    await widget.browserSourceBackend.updateStyle(_browserSourceStyle);
    await widget.browserSourceBackend.updateCaption(
      _hostSourceText.isEmpty ? _previewSourceText : _hostSourceText,
      _hostTranslationText.isEmpty
          ? _previewTranslationText
          : _hostTranslationText,
    );
    if (!mounted) return;
    setState(() {
      _browserSourceEnabled = true;
      _browserSourceUrl = url;
      _browserSourceBusy = false;
    });
    _companion?.publishBrowserSourceStatus();
  }

  Future<void> _applyHostedCaption(String source, String translation) async {
    _hostSourceText = source;
    _hostTranslationText = translation;
    if (!_browserSourceEnabled) return;
    await widget.browserSourceBackend.updateCaption(source, translation);
  }

  void _setBrowserSourceStyle(CompanionCaptionStyle style) {
    setState(() => _browserSourceStyle = style);
    if (_browserSourceEnabled) {
      unawaited(
        widget.browserSourceBackend
            .updateStyle(style)
            .catchError(_reportBrowserSourceFailure),
      );
    }
    _scheduleBrowserSourceSave();
  }

  void _setPreviewCaption({String? source, String? translation}) {
    setState(() {
      if (source != null) _previewSourceText = source;
      if (translation != null) _previewTranslationText = translation;
    });
    if (_browserSourceEnabled && _hostSourceText.isEmpty) {
      unawaited(
        widget.browserSourceBackend
            .updateCaption(_previewSourceText, _previewTranslationText)
            .catchError(_reportBrowserSourceFailure),
      );
    }
  }

  void _scheduleBrowserSourceSave() {
    final save = widget.saveBrowserSourcePreferences;
    if (save == null) return;
    _browserSourceSaveTimer?.cancel();
    _browserSourceSaveTimer = Timer(const Duration(milliseconds: 250), () {
      unawaited(
        save(
          MobileBrowserSourcePreferences(
            enabled: _browserSourceEnabled,
            style: _browserSourceStyle,
          ),
        ).catchError(_reportBrowserSourceFailure),
      );
    });
  }

  void _reportBrowserSourceFailure(Object error) {
    if (!mounted) return;
    setState(() {
      _browserSourceBusy = false;
      _statusKind = _StatusKind.error;
      _status = _l10n.browserSourceFailed(error);
    });
  }

  Future<void> _copyBrowserSourceUrl() async {
    final url = _browserSourceUrl;
    if (url == null) return;
    await Clipboard.setData(ClipboardData(text: url));
  }

  Future<void> _initializeDictionary() async {
    try {
      await widget.prepareAzooKeyDictionary();
      if (!mounted) return;
      setState(() {
        _dictionaryReady = true;
        _setIdleStatus(_isStandard ? '' : _l10n.enterEndpointAndToken);
      });
    } on Object catch (error) {
      _reportDictionaryFailure(error);
      rethrow;
    }
  }

  void _reportDictionaryFailure(Object error) {
    if (!mounted) return;
    setState(() {
      final message = _l10n.dictionaryError(error);
      if (_userInitiatedConnection) {
        _setErrorStatus(message);
      } else {
        _setIdleStatus(_isStandard ? '' : message);
      }
    });
  }

  Future<void> _initializeAzooKeyModel() async {
    await widget.prepareAzooKeyModel(_azooKeyModel);
    if (!mounted) return;
    setState(() => _azooKeyModelReady = true);
  }

  Future<void> _prepareInitialAzooKeyResources() async {
    if (!_dictionaryReady) {
      setState(() => _setProgressStatus(_l10n.preparingAzookeyDictionary));
      await _initializeDictionary();
    }
    if (!_azooKeyModelReady) {
      setState(
        () => _setProgressStatus(
          _l10n.preparingAzookeyModel(_azooKeyModelLabel(_azooKeyModel)),
        ),
      );
      await _initializeAzooKeyModel();
    }
  }

  Future<void> _discoverAndConnect({bool userInitiated = false}) async {
    if (_discovering || _connecting || _companion != null) return;
    if (userInitiated) _userInitiatedConnection = true;
    setState(() {
      _discovering = true;
      if (userInitiated || !_isStandard) {
        _setProgressStatus(_l10n.discoveringNative);
      }
    });
    try {
      final discovered = await widget.discoverDesktop();
      _endpointController.text = discovered.endpoint;
      _tokenController.text = discovered.token;
      if (!mounted) return;
      setState(() => _setProgressStatus(_l10n.discoveredNative));
      await _toggleConnection();
    } on TimeoutException {
      _reportDiscoveryFailure(
        userInitiated: userInitiated,
        errorMessage: _l10n.discoveryTimeout,
      );
    } on Object catch (error) {
      _reportDiscoveryFailure(
        userInitiated: userInitiated,
        errorMessage: _l10n.discoveryFailed(error),
      );
    } finally {
      if (mounted) setState(() => _discovering = false);
    }
  }

  void _reportDiscoveryFailure({
    required bool userInitiated,
    required String errorMessage,
  }) {
    if (!mounted) return;
    setState(() {
      if (userInitiated) {
        _setErrorStatus(errorMessage);
      } else {
        _setIdleStatus(_isStandard ? '' : _l10n.enterEndpointAndToken);
      }
    });
  }

  void _applyPairingLink(Uri uri) {
    final pairing = parseCompanionPairingLink(uri);
    if (pairing == null || _companion != null || _connecting) return;
    _endpointController.text = pairing.endpoint;
    _tokenController.text = pairing.token;
    _userInitiatedConnection = true;
    setState(() => _setProgressStatus(_l10n.readPairingFromQr));
    unawaited(_toggleConnection());
  }

  Future<void> _openSystemCamera() async {
    final openCamera = widget.openSystemCamera;
    _userInitiatedConnection = true;
    if (openCamera == null) {
      setState(() => _setProgressStatus(_l10n.scanQrInSystemCamera));
      return;
    }
    try {
      await openCamera();
      if (!mounted) return;
      setState(() => _setProgressStatus(_l10n.scanQrInSystemCamera));
    } on Object catch (error) {
      if (!mounted) return;
      setState(
        () => _setErrorStatus(
          _l10n.cameraOpenFailed(error),
          friendly: _l10n.couldNotOpenCamera,
        ),
      );
    }
  }

  Future<void> _setDisplayMode(_DisplayMode mode) async {
    if (mode == _displayMode) return;
    setState(() {
      _displayMode = mode;
      if (mode == _DisplayMode.standard) {
        _applyStandardProviderChoices();
        _selectionPending = true;
      }
    });
    await _applySelectionOrDefer();
  }

  void _applyStandardProviderChoices() {
    if (_asrChoice != _AsrChoice.desktopNative) {
      _asrChoice = _AsrChoice.rustSherpaOnnxReazonSpeech;
    }
    if (_azooKeyChoice != _AzooKeyChoice.desktopNative) {
      if (_azooKeyModel != AzooKeyModel.small) {
        _azooKeyModelReady = false;
        _azooKeyModel = AzooKeyModel.small;
      }
      _azooKeyChoice = _AzooKeyChoice.mobileSmall;
    }
    if (_translationChoice != _TranslationChoice.desktopNative) {
      _translationChoice = _TranslationChoice.rustQuickMt;
    }
  }

  Future<void> _toggleConnection() async {
    if (_companion != null) {
      await _disconnect();
      return;
    }
    if (_connecting) return;
    await _connect();
  }

  Future<void> _disconnect() async {
    final companion = _companion;
    final transport = _transport;
    final processing = _processing;
    setState(() {
      _companion = null;
      _transport = null;
      _processing = null;
      _userInitiatedConnection = false;
      _setIdleStatus(_l10n.disconnected);
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
  }

  Future<void> _connect() async {
    setState(() {
      _connecting = true;
      _setProgressStatus(_l10n.connecting);
    });
    final transport = widget.createTransport();
    final processing = widget.createProcessing();
    CompanionController? companion;
    try {
      setState(() => _setProgressStatus(_l10n.connectingLan));
      await transport.open(
        endpoint: Uri.parse(_endpointController.text.trim()),
      );
      setState(() => _setProgressStatus(_l10n.checkingDeviceApis));
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
        connectedStatus: _l10n.connectedSession,
        syncedStatus: _l10n.settingsSynced,
        onStatus: _setStatus,
        onRouteRequested: _applyRequestedRoute,
        onRouteControlsEnabled: _handleRouteControlsEnabled,
        onConnectionChanged: _handleConnectionChanged,
        onSource: (text) => _setResult(source: text),
        onAzooKey: (text) => _setResult(azooKey: text),
        onTranslation: (text) => _setResult(translation: text),
        onBrowserSourceCaption: _applyHostedCaption,
        browserSourceEnabled: () => _browserSourceEnabled,
        browserSourceUrl: () => _browserSourceUrl,
      );
      if (supportedRoute.azookey == ExecutionDevice.mobile) {
        await _prepareInitialAzooKeyResources();
      }
      await _configureSelectedProviders(processing);
      if (supportedRoute.translation == ExecutionDevice.mobile) {
        setState(
          () => _setProgressStatus(
            _l10n.preparingTranslation(
              _translationChoiceLabel(_translationChoice, _l10n),
            ),
          ),
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
        _setProgressStatus(
          _l10n.waitingForAuthentication(pipelineRouteId(route: _route)),
        );
      });
    } on Object catch (error) {
      await companion?.dispose();
      await _disposeTransport(transport);
      await _disposeProcessing(processing);
      _reportConnectionFailure(error);
    }
  }

  void _handleRouteControlsEnabled({required bool enabled}) {
    if (!mounted) return;
    setState(() => _routeControlsEnabled = enabled);
    if (enabled) unawaited(_applyDeferredSelection());
  }

  void _reportConnectionFailure(Object error) {
    if (!mounted) return;
    setState(() {
      _connecting = false;
      final message = _l10n.connectionFailed(error);
      if (_userInitiatedConnection) {
        _setErrorStatus(message);
      } else {
        _setIdleStatus(_isStandard ? '' : message);
      }
    });
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
      _userInitiatedConnection = false;
      _setIdleStatus(_isStandard ? '' : _l10n.reconnecting);
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
    if (!mounted) return;
    setState(() {
      _statusKind = _StatusKind.progress;
      _status = value;
    });
  }

  void _setIdleStatus(String message) {
    _statusKind = _StatusKind.idle;
    _status = message;
  }

  void _setProgressStatus(String message) {
    _statusKind = _StatusKind.progress;
    _status = message;
  }

  void _setErrorStatus(String detailed, {String? friendly}) {
    _statusKind = _StatusKind.error;
    _status = _isStandard ? (friendly ?? _l10n.couldNotConnect) : detailed;
  }

  String _visibleStatusText() {
    if (!_isStandard) return _status;
    if (_statusKind == _StatusKind.idle) return '';
    return _status;
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
    await _applySelectionOrDefer();
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
    await _applySelectionOrDefer();
  }

  Future<void> _setTranslationChoice(_TranslationChoice choice) async {
    setState(() {
      _translationChoice = choice;
      _selectionPending = true;
    });
    await _applySelectionOrDefer();
  }

  bool get _isStandard => _displayMode == _DisplayMode.standard;

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

  Future<void> _applySelectionOrDefer() async {
    if (_companion == null || !_routeControlsEnabled) return;
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
      _setProgressStatus(
        _l10n.syncingRoute(pipelineRouteId(route: requestedRoute)),
      );
    });
    try {
      await _prepareRouteResources(requestedRoute);
      transport.sendText(encodeRouteRequest(route: requestedRoute));
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _routeControlsEnabled = true;
        _setErrorStatus(_l10n.syncFailed(error));
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
    if (_asrChoice == _AsrChoice.rustSherpaOnnxReazonSpeech &&
        !availability.rustSherpaOnnx) {
      _asrChoice = _AsrChoice.desktopNative;
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
      _asrChoice = _displayMode == _DisplayMode.standard
          ? _AsrChoice.rustSherpaOnnxReazonSpeech
          : _defaultMobileAsrChoice;
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
    final l10n = CompanionL10n.of(context);
    return _PlatformPage(
      title: l10n.title,
      menu: _AppMenu(
        mode: _displayMode,
        onSelected: (mode) => unawaited(_setDisplayMode(mode)),
      ),
      child: SafeArea(
        child: _AdaptiveBody(
          configuration: _configurationWidgets(
            connected: connected,
            l10n: l10n,
          ),
          results: _isStandard ? const <Widget>[] : _resultWidgets(l10n),
        ),
      ),
    );
  }

  List<Widget> _configurationWidgets({
    required bool connected,
    required CompanionL10n l10n,
  }) {
    final providerAvailability = _providerAvailability;
    final translationAvailable =
        providerAvailability?.translationSession ?? false;
    return [
      if (_displayMode == _DisplayMode.detailed) ...[
        Text(l10n.endpoint, style: CompanionStyle.emphasis),
        const SizedBox(height: CompanionStyle.gap),
        _PlatformTextField(
          key: const Key('endpoint-field'),
          controller: _endpointController,
          enabled: !connected,
          keyboardType: TextInputType.url,
          label: l10n.endpointHint,
        ),
        const SizedBox(height: CompanionStyle.gap),
        Text(l10n.pairingToken, style: CompanionStyle.emphasis),
        const SizedBox(height: CompanionStyle.gap),
        _PlatformTextField(
          key: const Key('token-field'),
          controller: _tokenController,
          enabled: !connected,
          obscureText: true,
          label: l10n.pairingTokenHint,
        ),
        const SizedBox(height: CompanionStyle.gap),
      ],
      Semantics(
        liveRegion: true,
        child: Text(
          _visibleStatusText(),
          key: const Key('connection-status'),
          style: CompanionStyle.body,
        ),
      ),
      const SizedBox(height: CompanionStyle.gap),
      _ConnectionStateCard(connected: _authenticated),
      if (!connected) ...[
        const SizedBox(height: CompanionStyle.gap),
        _PlatformActionButton(
          buttonKey: const Key('camera-button'),
          label: l10n.scanQrWithCamera,
          enabled: !_connecting && !_discovering,
          emphasized: false,
          onPressed: () => unawaited(_openSystemCamera()),
        ),
        const SizedBox(height: CompanionStyle.gap),
        _PlatformActionButton(
          buttonKey: const Key('connection-button'),
          label: l10n.connect,
          enabled: !_connecting && !_discovering,
          emphasized: true,
          onPressed: widget.autoDiscover
              ? () => unawaited(_discoverAndConnect(userInitiated: true))
              : () {
                  _userInitiatedConnection = true;
                  unawaited(_toggleConnection());
                },
        ),
      ] else ...[
        const SizedBox(height: CompanionStyle.gap),
        _PlatformActionButton(
          buttonKey: const Key('connection-button'),
          label: l10n.disconnect,
          enabled: !_connecting && !_discovering,
          emphasized: false,
          onPressed: _toggleConnection,
        ),
      ],
      const SizedBox(height: CompanionStyle.section),
      _SectionHeading(l10n.features),
      const SizedBox(height: CompanionStyle.gap),
      if (_isStandard) ...[
        _StandardStageToggle<_AsrChoice>(
          label: l10n.asrMethod,
          keyId: 'asr-provider',
          value: _asrChoice == _AsrChoice.desktopNative
              ? _AsrChoice.desktopNative
              : _AsrChoice.rustSherpaOnnxReazonSpeech,
          desktopValue: _AsrChoice.desktopNative,
          deviceValue: _AsrChoice.rustSherpaOnnxReazonSpeech,
          deviceAvailable: providerAvailability?.rustSherpaOnnx ?? false,
          onChanged: (value) => unawaited(_setAsrChoice(value)),
        ),
        _StandardStageToggle<_AzooKeyChoice>(
          label: l10n.azookeyMethod,
          keyId: 'azookey-provider',
          value: _azooKeyChoice == _AzooKeyChoice.desktopNative
              ? _AzooKeyChoice.desktopNative
              : _AzooKeyChoice.mobileSmall,
          desktopValue: _AzooKeyChoice.desktopNative,
          deviceValue: _AzooKeyChoice.mobileSmall,
          deviceAvailable: true,
          onChanged: (value) => unawaited(_setAzooKeyChoice(value)),
        ),
        _StandardStageToggle<_TranslationChoice>(
          label: l10n.translationMethod,
          keyId: 'translation-provider',
          value: _translationChoice == _TranslationChoice.desktopNative
              ? _TranslationChoice.desktopNative
              : _TranslationChoice.rustQuickMt,
          desktopValue: _TranslationChoice.desktopNative,
          deviceValue: _TranslationChoice.rustQuickMt,
          deviceAvailable: true,
          onChanged: (value) => unawaited(_setTranslationChoice(value)),
        ),
      ] else ...[
        _ChoiceSelector<_AsrChoice>(
          label: l10n.asrMethod,
          keyId: 'asr-provider',
          value: _asrChoice,
          options: _asrOptions(providerAvailability, l10n),
          onChanged: (value) => unawaited(_setAsrChoice(value)),
        ),
        _ChoiceSelector<_AzooKeyChoice>(
          label: l10n.azookeyMethod,
          keyId: 'azookey-provider',
          value: _azooKeyChoice,
          options: _azooKeyOptions(l10n),
          onChanged: (value) => unawaited(_setAzooKeyChoice(value)),
        ),
        _ChoiceSelector<_TranslationChoice>(
          label: l10n.translationMethod,
          keyId: 'translation-provider',
          value: _translationChoice,
          options: _translationOptions(translationAvailable, l10n),
          onChanged: (value) => unawaited(_setTranslationChoice(value)),
        ),
      ],
      const SizedBox(height: CompanionStyle.section),
      MobileBrowserSourcePanel(
        enabled: _browserSourceEnabled,
        busy: _browserSourceBusy,
        url: _browserSourceUrl,
        style: _browserSourceStyle,
        previewSource: _previewSourceText,
        previewTranslation: _previewTranslationText,
        onToggle: (enabled) => unawaited(_setBrowserSourceEnabled(enabled)),
        onCopyUrl: () => unawaited(_copyBrowserSourceUrl()),
        onStyleChanged: _setBrowserSourceStyle,
        onPreviewSourceChanged: (source) => _setPreviewCaption(source: source),
        onPreviewTranslationChanged: (translation) =>
            _setPreviewCaption(translation: translation),
      ),
    ];
  }

  List<_ChoiceOption<_AsrChoice>> _asrOptions(
    ProcessingProviderAvailability? availability,
    CompanionL10n l10n,
  ) {
    final rustAvailable = availability?.rustSherpaOnnx ?? false;
    return [
      _ChoiceOption(
        value: _AsrChoice.desktopNative,
        label: l10n.desktopNative,
      ),
      if (_usesCupertino)
        _ChoiceOption(
          value: _AsrChoice.speechAnalyzer,
          label: l10n.iosSpeechAnalyzer,
          available: availability?.speechAnalyzer ?? false,
        ),
      if (_usesCupertino)
        _ChoiceOption(
          value: _AsrChoice.sfSpeechRecognizer,
          label: l10n.iosSfSpeechRecognizer,
          available: availability?.sfSpeechRecognizer ?? false,
        ),
      if (!_usesCupertino)
        _ChoiceOption(
          value: _AsrChoice.androidMlKit,
          label: l10n.androidMlKitSpeech,
          available: _capabilities?.asrAvailable ?? true,
        ),
      _ChoiceOption(
        value: _AsrChoice.rustSherpaOnnxReazonSpeech,
        label: l10n.mobileRustReazonSpeech,
        available: rustAvailable,
      ),
    ];
  }

  List<_ChoiceOption<_AzooKeyChoice>> _azooKeyOptions(CompanionL10n l10n) {
    return [
      _ChoiceOption(
        value: _AzooKeyChoice.desktopNative,
        label: l10n.desktopNative,
      ),
      _ChoiceOption(
        value: _AzooKeyChoice.mobileSmall,
        label: l10n.mobileRustAzookeySmall,
      ),
      _ChoiceOption(
        value: _AzooKeyChoice.mobileXsmall,
        label: l10n.mobileRustAzookeyXsmall,
      ),
    ];
  }

  List<_ChoiceOption<_TranslationChoice>> _translationOptions(
    bool platformAvailable,
    CompanionL10n l10n,
  ) {
    return [
      _ChoiceOption(
        value: _TranslationChoice.desktopNative,
        label: l10n.desktopNative,
      ),
      if (_usesCupertino)
        _ChoiceOption(
          value: _TranslationChoice.platformTranslationSession,
          label: l10n.iosTranslationSession,
          available: platformAvailable,
        ),
      if (_usesCupertino)
        _ChoiceOption(
          value: _TranslationChoice.platformTranslationSessionHighFidelity,
          label: l10n.iosTranslationSessionHighFidelity,
          available: platformAvailable,
        ),
      _ChoiceOption(
        value: _TranslationChoice.rustQuickMt,
        label: l10n.mobileRustQuickMt,
      ),
    ];
  }

  List<Widget> _resultWidgets(CompanionL10n l10n) => [
    _CollapsibleSection(
      sectionKey: const Key('processing-details'),
      label: l10n.showDetails,
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
          _ResultCard(label: l10n.asrMethod, text: _sourceText),
          _ResultCard(label: l10n.azookeyMethod, text: _azooKeyText),
          _ResultCard(label: l10n.translationMethod, text: _translationText),
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
      final hasResults = results.isNotEmpty;
      final wide = constraints.maxWidth >= _wideBreakpoint && hasResults;
      final content = wide
          ? Row(
              key: const Key('tablet-two-pane'),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: _Pane(children: configuration)),
                const SizedBox(width: CompanionStyle.section),
                Expanded(child: _Pane(children: results)),
              ],
            )
          : _Pane(
              key: const Key('phone-single-pane'),
              children: [
                ...configuration,
                if (results.isNotEmpty) ...[
                  const SizedBox(height: CompanionStyle.section),
                  ...results,
                ],
              ],
            );
      return SingleChildScrollView(
        padding: const EdgeInsets.all(CompanionStyle.section),
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
  const _PlatformPage({
    required this.title,
    required this.menu,
    required this.child,
  });

  final String title;
  final Widget menu;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (_usesCupertino) {
      return CupertinoPageScaffold(
        navigationBar: CupertinoNavigationBar(
          middle: Text(title),
          trailing: menu,
        ),
        child: child,
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(title), actions: [menu]),
      body: child,
    );
  }
}

class _AppMenu extends StatelessWidget {
  const _AppMenu({required this.mode, required this.onSelected});

  final _DisplayMode mode;
  final ValueChanged<_DisplayMode> onSelected;

  @override
  Widget build(BuildContext context) {
    final l10n = CompanionL10n.of(context);
    if (_usesCupertino) {
      return CupertinoButton(
        key: const Key('menu-button'),
        padding: EdgeInsets.zero,
        onPressed: () => unawaited(_showCupertinoMenu(context, l10n)),
        child: Icon(CupertinoIcons.bars, semanticLabel: l10n.menu),
      );
    }
    return PopupMenuButton<_DisplayMode>(
      key: const Key('menu-button'),
      icon: Icon(Icons.menu, semanticLabel: l10n.menu),
      tooltip: l10n.menu,
      initialValue: mode,
      onSelected: onSelected,
      itemBuilder: (context) => [
        PopupMenuItem(
          key: const Key('menu-standard'),
          value: _DisplayMode.standard,
          child: Text(l10n.standardMode),
        ),
        PopupMenuItem(
          key: const Key('menu-detailed'),
          value: _DisplayMode.detailed,
          child: Text(l10n.detailedMode),
        ),
      ],
    );
  }

  Future<void> _showCupertinoMenu(
    BuildContext context,
    CompanionL10n l10n,
  ) async {
    final selected = await showCupertinoModalPopup<_DisplayMode>(
      context: context,
      builder: (context) => CupertinoActionSheet(
        title: Text(l10n.menu),
        actions: [
          CupertinoActionSheetAction(
            key: const Key('menu-standard'),
            onPressed: () => Navigator.pop(context, _DisplayMode.standard),
            child: Text(l10n.standardMode),
          ),
          CupertinoActionSheetAction(
            key: const Key('menu-detailed'),
            onPressed: () => Navigator.pop(context, _DisplayMode.detailed),
            child: Text(l10n.detailedMode),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.pop(context),
          child: Text(l10n.cancel),
        ),
      ),
    );
    if (selected != null) onSelected(selected);
  }
}

class _SectionHeading extends StatelessWidget {
  const _SectionHeading(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(text, style: CompanionStyle.emphasis);
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
        padding: const EdgeInsets.all(CompanionStyle.inset),
        placeholder: label,
        style: CompanionStyle.body,
        placeholderStyle: CompanionStyle.body.copyWith(
          color: CompanionStyle.muted,
        ),
      );
    }
    return TextField(
      controller: controller,
      enabled: enabled,
      autocorrect: false,
      keyboardType: keyboardType,
      obscureText: obscureText,
      style: CompanionStyle.body,
      decoration: InputDecoration(labelText: label),
    );
  }
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
      final child = SizedBox(
        height: CompanionStyle.controlHeight,
        child: Center(
          child: Text(
            label,
            style: CompanionStyle.emphasis.copyWith(
              color: CompanionStyle.buttonLabel(
                emphasized: emphasized,
                enabled: enabled,
              ),
            ),
          ),
        ),
      );
      final button = CupertinoButton(
        key: buttonKey,
        padding: EdgeInsets.zero,
        color: CompanionStyle.buttonFill(
          emphasized: emphasized,
          enabled: enabled,
        ),
        disabledColor: CompanionStyle.unavailable,
        borderRadius: BorderRadius.circular(CompanionStyle.radius),
        onPressed: action,
        child: child,
      );
      if (emphasized) return button;
      return DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(CompanionStyle.radius),
          border: Border.all(
            color: CompanionStyle.buttonBorder(enabled: enabled),
          ),
        ),
        child: button,
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

class _StandardStageToggle<T extends Object> extends StatelessWidget {
  const _StandardStageToggle({
    required this.label,
    required this.keyId,
    required this.value,
    required this.desktopValue,
    required this.deviceValue,
    required this.deviceAvailable,
    required this.onChanged,
  });

  final String label;
  final String keyId;
  final T value;
  final T desktopValue;
  final T deviceValue;
  final bool deviceAvailable;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = CompanionL10n.of(context);
    final deviceLabel = l10n.deviceNoun(kind: _deviceKind(context));
    final selected = value == desktopValue ? desktopValue : deviceValue;
    if (_usesCupertino) {
      return _LabeledControl(
        label: label,
        controlKey: keyId,
        control: SizedBox(
          width: double.infinity,
          height: CompanionStyle.controlHeight,
          child: CupertinoSlidingSegmentedControl<T>(
            key: Key(keyId),
            groupValue: selected,
            onValueChanged: (next) {
              if (next == null) return;
              if (next == deviceValue && !deviceAvailable) return;
              onChanged(next);
            },
            children: <T, Widget>{
              desktopValue: _segmentLabel(
                '$keyId-$desktopValue',
                l10n.desktopNoun,
              ),
              deviceValue: _segmentLabel(
                '$keyId-$deviceValue',
                deviceLabel,
              ),
            },
          ),
        ),
      );
    }
    return _LabeledControl(
      label: label,
      controlKey: keyId,
      control: SizedBox(
        width: double.infinity,
        height: CompanionStyle.controlHeight,
        child: SegmentedButton<T>(
          key: Key(keyId),
          showSelectedIcon: false,
          selected: <T>{selected},
          onSelectionChanged: (next) {
            if (next.length != 1) return;
            onChanged(next.single);
          },
          segments: [
            ButtonSegment<T>(
              value: desktopValue,
              label: _segmentLabel('$keyId-$desktopValue', l10n.desktopNoun),
            ),
            ButtonSegment<T>(
              value: deviceValue,
              enabled: deviceAvailable,
              label: _segmentLabel('$keyId-$deviceValue', deviceLabel),
            ),
          ],
        ),
      ),
    );
  }

  Widget _segmentLabel(String key, String text) => Text(
    text,
    key: Key(key),
    style: CompanionStyle.body,
  );
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
    controlKey: keyId,
    control: DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(CompanionStyle.radius),
        border: Border.all(color: CompanionStyle.primary),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(
          CompanionStyle.radius - CompanionStyle.borderWidth,
        ),
        child: Column(
          key: Key(keyId),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: options.indexed
              .map((entry) => _segment(context, entry.$1, entry.$2))
              .toList(growable: false),
        ),
      ),
    ),
  );

  Widget _segment(
    BuildContext context,
    int index,
    _ChoiceOption<T> option,
  ) {
    final selected = option.value == value;
    const primary = CompanionStyle.primary;
    final background = !option.available
        ? CompanionStyle.unavailable
        : selected
        ? primary
        : CompanionStyle.surface;
    final foreground = !option.available
        ? CompanionStyle.muted
        : selected
        ? CompanionStyle.onPrimary
        : CompanionStyle.content;
    final l10n = CompanionL10n.of(context);
    final text = option.available
        ? option.label
        : l10n.unavailableOnThisDevice(option.label);
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
            border: index == 0
                ? null
                : const Border(top: BorderSide(color: primary)),
          ),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: CompanionStyle.controlHeight,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: CompanionStyle.gap,
                vertical: CompanionStyle.gap,
              ),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  text,
                  style: CompanionStyle.body.copyWith(
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
  const _LabeledControl({
    required this.label,
    required this.controlKey,
    required this.control,
  });

  static const _horizontalBreakpoint = 560.0;

  final String label;
  final String controlKey;
  final Widget control;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: CompanionStyle.gap),
    child: LayoutBuilder(
      builder: (context, constraints) =>
          constraints.maxWidth >= _horizontalBreakpoint
          ? Row(
              key: Key('horizontal-control-$controlKey'),
              children: [
                Expanded(child: Text(label, style: CompanionStyle.body)),
                Expanded(child: control),
              ],
            )
          : Column(
              key: Key('vertical-control-$controlKey'),
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(label, style: CompanionStyle.emphasis),
                const SizedBox(height: CompanionStyle.gap),
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

String _asrChoiceLabel(_AsrChoice choice, CompanionL10n l10n) =>
    switch (choice) {
      _AsrChoice.desktopNative => l10n.desktopNative,
      _AsrChoice.speechAnalyzer => l10n.iosSpeechAnalyzer,
      _AsrChoice.sfSpeechRecognizer => l10n.iosSfSpeechRecognizer,
      _AsrChoice.androidMlKit => l10n.androidMlKitSpeech,
      _AsrChoice.rustSherpaOnnxReazonSpeech => l10n.mobileRustReazonSpeech,
    };

String _azooKeyChoiceLabel(_AzooKeyChoice choice, CompanionL10n l10n) =>
    switch (choice) {
      _AzooKeyChoice.desktopNative => l10n.desktopNative,
      _AzooKeyChoice.mobileSmall => l10n.mobileRustAzookeySmall,
      _AzooKeyChoice.mobileXsmall => l10n.mobileRustAzookeyXsmall,
    };

String _translationChoiceLabel(
  _TranslationChoice choice,
  CompanionL10n l10n,
) => switch (choice) {
  _TranslationChoice.desktopNative => l10n.desktopNative,
  _TranslationChoice.platformTranslationSession => l10n.iosTranslationSession,
  _TranslationChoice.platformTranslationSessionHighFidelity =>
    l10n.iosTranslationSessionHighFidelity,
  _TranslationChoice.rustQuickMt => l10n.mobileRustQuickMt,
};

class _ConnectionStateCard extends StatelessWidget {
  const _ConnectionStateCard({required this.connected});

  final bool connected;

  @override
  Widget build(BuildContext context) {
    final l10n = CompanionL10n.of(context);
    final connection = l10n.connectionStateValue(connected);
    if (_usesCupertino) {
      return CupertinoListSection.insetGrouped(
        margin: EdgeInsets.zero,
        children: [
          CupertinoListTile(
            title: Text(l10n.connectionState, style: CompanionStyle.emphasis),
            additionalInfo: Text(connection, style: CompanionStyle.body),
          ),
        ],
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(CompanionStyle.section),
        child: Text(
          l10n.connectionStateLine(connected),
          style: CompanionStyle.emphasis,
        ),
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
          minimumSize: const Size(0, CompanionStyle.controlHeight),
          padding: const EdgeInsets.symmetric(horizontal: CompanionStyle.gap),
          alignment: Alignment.centerLeft,
          onPressed: _toggle,
          child: _heading(),
        )
      else
        TextButton(
          style: const ButtonStyle(
            minimumSize: WidgetStatePropertyAll(
              Size.fromHeight(CompanionStyle.controlHeight),
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
      const SizedBox(width: CompanionStyle.gap),
      Text(widget.label, style: CompanionStyle.emphasis),
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
    final items = _detailItems(CompanionL10n.of(context));
    if (_usesCupertino) {
      return CupertinoListSection.insetGrouped(
        margin: EdgeInsets.zero,
        children: items
            .map(
              (item) => CupertinoListTile(
                title: Text(item.$1, style: CompanionStyle.emphasis),
                subtitle: Text(item.$2, style: CompanionStyle.body),
              ),
            )
            .toList(growable: false),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(CompanionStyle.section),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: items
              .map(
                (item) =>
                    Text('${item.$1}: ${item.$2}', style: CompanionStyle.body),
              )
              .toList(growable: false),
        ),
      ),
    );
  }

  List<(String, String)> _detailItems(CompanionL10n l10n) {
    final capabilities = this.capabilities;
    return [
      (l10n.desktopEndpoint, endpoint),
      (l10n.synchronizedRoute, pipelineRouteId(route: route)),
      (l10n.asrMethod, _asrChoiceLabel(asrChoice, l10n)),
      (l10n.azookeyMethod, _azooKeyChoiceLabel(azooKeyChoice, l10n)),
      (
        l10n.translationMethod,
        _translationChoiceLabel(translationChoice, l10n),
      ),
      if (capabilities != null)
        (
          l10n.mobileApis,
          '${l10n.asrMethod} '
              '${_availability(capabilities.asrAvailable, l10n)}, '
              '${l10n.azookeyMethod} '
              '${_availability(capabilities.azookeyAvailable, l10n)}, '
              '${l10n.translationMethod} '
              '${_availability(capabilities.translationAvailable, l10n)}',
        ),
    ];
  }
}

String _availability(bool available, CompanionL10n l10n) =>
    available ? l10n.available : l10n.unavailable;

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.label, required this.text});

  final String label;
  final String text;

  @override
  Widget build(BuildContext context) {
    final value = text.isEmpty ? CompanionL10n.of(context).emptyResult : text;
    if (_usesCupertino) {
      return CupertinoListSection.insetGrouped(
        margin: const EdgeInsets.symmetric(vertical: CompanionStyle.gap),
        children: [
          CupertinoListTile(
            title: Text(label, style: CompanionStyle.emphasis),
            subtitle: Text(value, style: CompanionStyle.body),
          ),
        ],
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(CompanionStyle.section),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: CompanionStyle.emphasis),
            const SizedBox(height: CompanionStyle.gap),
            Text(value, style: CompanionStyle.body),
          ],
        ),
      ),
    );
  }
}
