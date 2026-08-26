import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kotoba_beacon_companion/src/companion_connection.dart';
import 'package:kotoba_beacon_companion/src/companion_controller.dart';
import 'package:kotoba_beacon_companion/src/native_processing.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';
import 'package:kotoba_beacon_companion/src/rust/frb_generated.dart';

/// Starts the mobile companion after initializing the generated Rust bridge.
Future<void> main() => startCompanion(
  initializeRust: RustLib.init,
  root: const KotobaBeaconCompanionApp(
    home: CompanionHomePage(autoDiscover: true),
  ),
);

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
          primaryColor: Color(0xff007a70),
          scaffoldBackgroundColor: CupertinoColors.systemGroupedBackground,
        ),
        home: home,
      );
    }
    return MaterialApp(
      title: 'Kotoba Beacon Companion',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff3a7d71)),
        useMaterial3: true,
      ),
      home: home,
    );
  }
}

bool get _usesCupertino => defaultTargetPlatform == TargetPlatform.iOS;

CompanionTransport _createTransport() => WebSocketCompanionTransport();

ProcessingBackend _createProcessing() => NativeProcessingBackend();

Future<void> _prepareAzooKeyDictionary() async {
  final data = await rootBundle.load('assets/azookey/system.azkdict.gz');
  await initializeAzookeyDictionary(bytes: data.buffer.asUint8List());
}

/// Pairing, route selection, and live-result screen.
class CompanionHomePage extends StatefulWidget {
  /// Creates the companion home screen.
  const CompanionHomePage({
    super.key,
    this.initialRoute = const PipelineRoute(
      asr: ExecutionDevice.mobile,
      azookey: ExecutionDevice.mobile,
      translation: ExecutionDevice.mobile,
    ),
    this.createTransport = _createTransport,
    this.createProcessing = _createProcessing,
    this.prepareAzooKeyDictionary = _prepareAzooKeyDictionary,
    this.discoverDesktop = discoverCompanion,
    this.autoDiscover = false,
  });

  /// Initial Rust-owned stage assignment shown by the route controls.
  final PipelineRoute initialRoute;

  /// Creates a fresh authenticated transport for each connection attempt.
  final CompanionTransport Function() createTransport;

  /// Creates a fresh platform processing provider for each connection attempt.
  final ProcessingBackend Function() createProcessing;

  /// Loads and initializes the portable AzooKey dictionary.
  final Future<void> Function() prepareAzooKeyDictionary;

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
  CompanionTransport? _transport;
  ProcessingBackend? _processing;
  CompanionController? _companion;
  MobileCapabilities? _capabilities;
  String _status = 'デスクトップのLAN endpointとpairing tokenを入力してください';
  String _sourceText = '';
  String _azooKeyText = '';
  String _translationText = '';
  bool _dictionaryReady = false;
  bool _connecting = false;
  bool _discovering = false;
  bool _authenticated = false;
  bool _routeControlsEnabled = false;

  @override
  void initState() {
    super.initState();
    _route = widget.initialRoute;
    if (widget.autoDiscover) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        unawaited(_discoverAndConnect());
      });
    }
  }

  @override
  void dispose() {
    unawaited(releaseAzookeyDictionary());
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
        _capabilities = null;
        _authenticated = false;
        _routeControlsEnabled = false;
      });
      await companion?.dispose();
      await _disposeTransport(transport);
      await _disposeProcessing(processing);
      await releaseAzookeyDictionary();
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
      final supportedRoute = _constrainRoute(_route, capabilities);
      _route = supportedRoute;
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
          if (mounted) setState(() => _routeControlsEnabled = enabled);
        },
        onConnectionChanged: ({required connected}) {
          if (mounted) setState(() => _authenticated = connected);
        },
        onSource: (text) => _setResult(source: text),
        onAzooKey: (text) => _setResult(azooKey: text),
        onTranslation: (text) => _setResult(translation: text),
      );
      if (supportedRoute.azookey == ExecutionDevice.mobile &&
          !_dictionaryReady) {
        setState(() => _status = 'AzooKey辞書を準備中');
        await _initializeDictionary();
      }
      if (supportedRoute.asr == ExecutionDevice.mobile) {
        setState(() => _status = '端末内ASRモデルを準備中');
        await processing.prepareAsr('ja-JP');
      }
      if (supportedRoute.translation == ExecutionDevice.mobile) {
        setState(() => _status = '端末内翻訳モデルを準備中');
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

  Future<void> _setStage(ProcessingStage stage, ExecutionDevice device) async {
    final capabilities = _capabilities;
    final transport = _transport;
    if (_companion == null || capabilities == null || transport == null) return;
    if (device == ExecutionDevice.mobile && !_supports(capabilities, stage)) {
      return;
    }
    final requestedRoute = PipelineRoute(
      asr: stage == ProcessingStage.asr ? device : _route.asr,
      azookey: stage == ProcessingStage.azookey ? device : _route.azookey,
      translation: stage == ProcessingStage.translation
          ? device
          : _route.translation,
    );
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
    setState(() => _route = route);
  }

  Future<void> _prepareRouteResources(PipelineRoute route) async {
    final processing = _processing;
    if (processing == null) return;
    if (route.azookey == ExecutionDevice.mobile && !_dictionaryReady) {
      await _initializeDictionary();
    }
    if (route.azookey == ExecutionDevice.desktop && _dictionaryReady) {
      unawaited(releaseAzookeyDictionary());
      _dictionaryReady = false;
    }
    if (route.asr == ExecutionDevice.mobile) {
      await processing.prepareAsr('ja-JP');
    }
    if (route.translation == ExecutionDevice.mobile) {
      await processing.prepareTranslation(
        sourceLanguage: 'ja',
        targetLanguage: 'en',
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final connected = _companion != null;
    return _PlatformPage(
      title: 'Kotoba Beacon Companion',
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _SectionHeading('同一ネットワーク接続'),
              const SizedBox(height: 12),
              _PlatformTextField(
                key: const Key('endpoint-field'),
                controller: _endpointController,
                enabled: !connected,
                keyboardType: TextInputType.url,
                label: 'Desktop WebSocket endpoint',
              ),
              const SizedBox(height: 12),
              _PlatformTextField(
                key: const Key('token-field'),
                controller: _tokenController,
                enabled: !connected,
                obscureText: true,
                label: 'Pairing token',
              ),
              const SizedBox(height: 20),
              _SectionHeading(
                '処理場所 (${pipelineRouteId(route: _route)})',
              ),
              const SizedBox(height: 8),
              _StageLocation(
                label: 'ASR',
                value: _route.asr,
                enabled: connected && _routeControlsEnabled,
                mobileAvailable: _capabilities?.asrAvailable ?? false,
                onChanged: (value) => unawaited(
                  _setStage(ProcessingStage.asr, value),
                ),
              ),
              _StageLocation(
                label: 'AzooKey',
                value: _route.azookey,
                enabled: connected && _routeControlsEnabled,
                mobileAvailable: _capabilities?.azookeyAvailable ?? false,
                onChanged: (value) => unawaited(
                  _setStage(ProcessingStage.azookey, value),
                ),
              ),
              _StageLocation(
                label: '翻訳',
                value: _route.translation,
                enabled: connected && _routeControlsEnabled,
                mobileAvailable: _capabilities?.translationAvailable ?? false,
                onChanged: (value) => unawaited(
                  _setStage(ProcessingStage.translation, value),
                ),
              ),
              const SizedBox(height: 12),
              _DiscoveryButton(
                enabled: !connected && !_connecting && !_discovering,
                onPressed: _discoverAndConnect,
              ),
              const SizedBox(height: 8),
              _ConnectionButton(
                connected: connected,
                enabled: !_connecting && !_discovering,
                onPressed: _toggleConnection,
              ),
              const SizedBox(height: 12),
              Text(_status, key: const Key('connection-status')),
              const SizedBox(height: 12),
              _ConnectionCard(
                connected: _authenticated,
                endpoint: _endpointController.text.trim(),
                route: _route,
                capabilities: _capabilities,
              ),
              const _PlatformDivider(),
              _ResultCard(label: 'ASR', text: _sourceText),
              _ResultCard(label: 'AzooKey', text: _azooKeyText),
              _ResultCard(label: 'Translation', text: _translationText),
            ],
          ),
        ),
      ),
    );
  }
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

bool _supports(MobileCapabilities capabilities, ProcessingStage stage) =>
    switch (stage) {
      ProcessingStage.asr => capabilities.asrAvailable,
      ProcessingStage.azookey => capabilities.azookeyAvailable,
      ProcessingStage.translation => capabilities.translationAvailable,
    };

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
    if (_usesCupertino) {
      return Text(
        text,
        style: CupertinoTheme.of(context).textTheme.navTitleTextStyle,
      );
    }
    return Text(text, style: Theme.of(context).textTheme.titleLarge);
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
        padding: const EdgeInsets.all(14),
        placeholder: label,
      );
    }
    return TextField(
      controller: controller,
      enabled: enabled,
      autocorrect: false,
      keyboardType: keyboardType,
      obscureText: obscureText,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
    );
  }
}

class _DiscoveryButton extends StatelessWidget {
  const _DiscoveryButton({required this.enabled, required this.onPressed});

  final bool enabled;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    if (_usesCupertino) {
      return CupertinoButton.tinted(
        key: const Key('discovery-button'),
        onPressed: enabled ? onPressed : null,
        child: const Text('Nativeを自動検出して接続'),
      );
    }
    return OutlinedButton.icon(
      key: const Key('discovery-button'),
      onPressed: enabled ? onPressed : null,
      icon: const Icon(Icons.radar),
      label: const Text('Nativeを自動検出して接続'),
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
  Widget build(BuildContext context) {
    final label = connected ? '切断' : 'デスクトップへ接続';
    if (_usesCupertino) {
      return CupertinoButton.filled(
        key: const Key('connection-button'),
        onPressed: enabled ? onPressed : null,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              connected ? CupertinoIcons.clear_circled : CupertinoIcons.link,
            ),
            const SizedBox(width: 8),
            Text(label),
          ],
        ),
      );
    }
    return FilledButton.icon(
      key: const Key('connection-button'),
      onPressed: enabled ? onPressed : null,
      icon: Icon(connected ? Icons.link_off : Icons.lan),
      label: Text(label),
    );
  }
}

class _PlatformDivider extends StatelessWidget {
  const _PlatformDivider();

  @override
  Widget build(BuildContext context) {
    if (_usesCupertino) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 16),
        child: Container(
          height: 0.5,
          color: CupertinoColors.separator.resolveFrom(context),
        ),
      );
    }
    return const Divider(height: 32);
  }
}

class _StageLocation extends StatelessWidget {
  const _StageLocation({
    required this.label,
    required this.value,
    required this.enabled,
    required this.mobileAvailable,
    required this.onChanged,
  });

  final String label;
  final ExecutionDevice value;
  final bool enabled;
  final bool mobileAvailable;
  final ValueChanged<ExecutionDevice> onChanged;

  @override
  Widget build(BuildContext context) {
    final control = _usesCupertino
        ? IgnorePointer(
            ignoring: !enabled,
            child: Opacity(
              opacity: enabled ? 1 : 0.5,
              child: CupertinoSlidingSegmentedControl<ExecutionDevice>(
                key: Key('stage-$label'),
                groupValue: value,
                children: {
                  ExecutionDevice.desktop: const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 8),
                    child: Text('Desktop'),
                  ),
                  ExecutionDevice.mobile: Opacity(
                    opacity: mobileAvailable ? 1 : 0.35,
                    child: const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 8),
                      child: Text('Mobile'),
                    ),
                  ),
                },
                onValueChanged: _changeCupertinoStage,
              ),
            ),
          )
        : SegmentedButton<ExecutionDevice>(
            key: Key('stage-$label'),
            segments: [
              const ButtonSegment(
                value: ExecutionDevice.desktop,
                label: Text('Desktop'),
              ),
              ButtonSegment(
                value: ExecutionDevice.mobile,
                label: const Text('Mobile'),
                enabled: mobileAvailable,
              ),
            ],
            selected: {value},
            onSelectionChanged: enabled
                ? (selection) => onChanged(selection.single)
                : null,
          );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(child: Text(label)),
          control,
        ],
      ),
    );
  }

  void _changeCupertinoStage(ExecutionDevice? selection) {
    if (!enabled || selection == null) return;
    if (selection == ExecutionDevice.mobile && !mobileAvailable) return;
    onChanged(selection);
  }
}

class _ConnectionCard extends StatelessWidget {
  const _ConnectionCard({
    required this.connected,
    required this.endpoint,
    required this.route,
    required this.capabilities,
  });

  final bool connected;
  final String endpoint;
  final PipelineRoute route;
  final MobileCapabilities? capabilities;

  @override
  Widget build(BuildContext context) {
    final capabilities = this.capabilities;
    final connection = connected ? '認証済み' : '未接続または同期中';
    final routeId = pipelineRouteId(route: route);
    final apiStatus = capabilities == null
        ? null
        : 'ASR ${_availability(capabilities.asrAvailable)}, '
              'AzooKey ${_availability(capabilities.azookeyAvailable)}, '
              '翻訳 ${_availability(capabilities.translationAvailable)}';
    if (_usesCupertino) {
      return CupertinoListSection.insetGrouped(
        margin: EdgeInsets.zero,
        children: [
          CupertinoListTile(
            title: const Text('接続状態'),
            additionalInfo: Text(connection),
          ),
          CupertinoListTile(
            title: const Text('Desktop'),
            subtitle: Text(endpoint),
          ),
          CupertinoListTile(
            title: const Text('同期済み route'),
            additionalInfo: Text(routeId),
          ),
          if (apiStatus != null)
            CupertinoListTile(
              title: const Text('Mobile APIs'),
              subtitle: Text(apiStatus),
            ),
        ],
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '接続状態: $connection',
              style: Theme.of(context).textTheme.labelLarge,
            ),
            Text('Desktop: $endpoint'),
            Text('同期済み route: $routeId'),
            if (apiStatus != null) Text('Mobile APIs: $apiStatus'),
          ],
        ),
      ),
    );
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
          CupertinoListTile(title: Text(label), subtitle: Text(value)),
        ],
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: Theme.of(context).textTheme.labelLarge),
            const SizedBox(height: 6),
            Text(value),
          ],
        ),
      ),
    );
  }
}
