import 'dart:io';
import 'dart:typed_data';

/// Files required by the shared Japanese-to-English QuickMT runtime.
const quickMtAssetFiles = <String>[
  'config.json',
  'model.bin',
  'source_vocabulary.json',
  'target_vocabulary.json',
  'src.spm.model',
  'tgt.spm.model',
];

/// Rust QuickMT preparation boundary used after asset resolution.
typedef QuickMtPreparer = Future<void> Function({
  required String modelDirectory,
});

/// Resolves the bundled model and initializes the shared CTranslate2 runtime.
Future<void> prepareQuickMtRuntime({
  required bool usesAppleBundle,
  required String executablePath,
  required Future<Directory> Function() supportDirectory,
  required Future<ByteData> Function(String asset) loadAsset,
  required QuickMtPreparer prepareModel,
}) async {
  final modelDirectory = await resolveQuickMtAssets(
    usesAppleBundle: usesAppleBundle,
    executablePath: executablePath,
    supportDirectory: supportDirectory,
    loadAsset: loadAsset,
  );
  await prepareModel(modelDirectory: modelDirectory);
}

/// Resolves direct Apple bundle paths or copies packaged assets once.
Future<String> resolveQuickMtAssets({
  required bool usesAppleBundle,
  required String executablePath,
  required Future<Directory> Function() supportDirectory,
  required Future<ByteData> Function(String asset) loadAsset,
}) async {
  const assetRoot = 'assets/quickmt/quickmt-ja-en';
  if (usesAppleBundle) {
    return '${File(executablePath).parent.path}/Frameworks/'
        'App.framework/flutter_assets/$assetRoot';
  }
  final support = await supportDirectory();
  final destination = Directory('${support.path}/quickmt/quickmt-ja-en');
  for (final name in quickMtAssetFiles) {
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
