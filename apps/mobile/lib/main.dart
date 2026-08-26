import 'dart:async';

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
  root: const KotobaBeaconCompanionApp(),
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

/// Root Material application for the Kotoba Beacon mobile companion.
class KotobaBeaconCompanionApp extends StatelessWidget {
  /// Creates the companion application.
  const KotobaBeaconCompanionApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Kotoba Beacon Companion',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff3a7d71)),
      useMaterial3: true,
    ),
    home: const CompanionHomePage(),
  );
}

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
  });

  /// Initial Rust-owned stage assignment shown by the route controls.
  final PipelineRoute initialRoute;

  /// Creates a fresh authenticated transport for each connection attempt.
  final CompanionTransport Function() createTransport;

  /// Creates a fresh platform processing provider for each connection attempt.
  final ProcessingBackend Function() createProcessing;

  /// Loads and initializes the portable AzooKey dictionary.
  final Future<void> Function() prepareAzooKeyDictionary;

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
  bool _routeControlsEnabled = false;

  @override
  void initState() {
    super.initState();
    _route = widget.initialRoute;
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
    if (_companion == null || capabilities == null) return;
    if (device == ExecutionDevice.mobile && !_supports(capabilities, stage)) {
      return;
    }
    final route = PipelineRoute(
      asr: stage == ProcessingStage.asr ? device : _route.asr,
      azookey: stage == ProcessingStage.azookey ? device : _route.azookey,
      translation: stage == ProcessingStage.translation
          ? device
          : _route.translation,
    );
    await _applyRequestedRoute(route);
    _companion?.route = route;
    _transport?.sendText(encodeRouteRequest(route: route));
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
    return Scaffold(
      appBar: AppBar(title: const Text('Kotoba Beacon Companion')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text('同一ネットワーク接続', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 12),
            TextField(
              controller: _endpointController,
              enabled: !connected,
              autocorrect: false,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                labelText: 'Desktop WebSocket endpoint',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _tokenController,
              enabled: !connected,
              obscureText: true,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'Pairing token',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 20),
            Text(
              '処理場所 (${pipelineRouteId(route: _route)})',
              style: Theme.of(context).textTheme.titleLarge,
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
            FilledButton.icon(
              onPressed: !_connecting ? _toggleConnection : null,
              icon: Icon(connected ? Icons.link_off : Icons.lan),
              label: Text(connected ? '切断' : 'デスクトップへ接続'),
            ),
            const SizedBox(height: 12),
            Text(_status, key: const Key('connection-status')),
            const Divider(height: 32),
            _ResultCard(label: 'ASR', text: _sourceText),
            _ResultCard(label: 'AzooKey', text: _azooKeyText),
            _ResultCard(label: 'Translation', text: _translationText),
          ],
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
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Row(
      children: [
        Expanded(child: Text(label)),
        SegmentedButton<ExecutionDevice>(
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
        ),
      ],
    ),
  );
}

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.label, required this.text});

  final String label;
  final String text;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 6),
          Text(text.isEmpty ? '—' : text),
        ],
      ),
    ),
  );
}
