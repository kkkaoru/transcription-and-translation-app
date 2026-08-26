import 'dart:io';
import 'dart:typed_data';

/// Files required by the Desktop-equivalent Mobile Rust ASR runtime.
const mobileRustAsrAssetFiles = <String>[
  'encoder-epoch-99-avg-1.int8.onnx',
  'decoder-epoch-99-avg-1.onnx',
  'joiner-epoch-99-avg-1.int8.onnx',
  'tokens.txt',
];

/// Rust sherpa-onnx preparation boundary used after asset resolution.
typedef MobileRustAsrPreparer = Future<void> Function({
  required String modelDirectory,
});

/// Resolves bundled ReazonSpeech files and initializes sherpa-onnx.
Future<void> prepareMobileRustAsrRuntime({
  required bool usesAppleBundle,
  required String executablePath,
  required Future<Directory> Function() supportDirectory,
  required Future<ByteData> Function(String asset) loadAsset,
  required MobileRustAsrPreparer prepareModel,
}) async {
  final modelDirectory = await resolveMobileRustAsrAssets(
    usesAppleBundle: usesAppleBundle,
    executablePath: executablePath,
    supportDirectory: supportDirectory,
    loadAsset: loadAsset,
  );
  await prepareModel(modelDirectory: modelDirectory);
}

/// Resolves direct Apple bundle paths or copies packaged assets once.
Future<String> resolveMobileRustAsrAssets({
  required bool usesAppleBundle,
  required String executablePath,
  required Future<Directory> Function() supportDirectory,
  required Future<ByteData> Function(String asset) loadAsset,
}) async {
  const assetRoot = 'assets/asr/reazonspeech-k2-v2';
  if (usesAppleBundle) {
    return '${File(executablePath).parent.path}/Frameworks/'
        'App.framework/flutter_assets/$assetRoot';
  }
  final support = await supportDirectory();
  final destination = Directory('${support.path}/asr/reazonspeech-k2-v2');
  for (final name in mobileRustAsrAssetFiles) {
    await _copyAssetIfMissing(
      '$assetRoot/$name',
      File('${destination.path}/$name'),
      loadAsset,
    );
  }
  return destination.path;
}

Future<void> _copyAssetIfMissing(
  String asset,
  File destination,
  Future<ByteData> Function(String asset) loadAsset,
) async {
  if (destination.existsSync() && destination.lengthSync() > 0) return;
  await destination.parent.create(recursive: true);
  final data = await loadAsset(asset);
  await destination.writeAsBytes(data.buffer.asUint8List(), flush: true);
}
