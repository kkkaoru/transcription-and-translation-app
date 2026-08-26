import 'dart:io';
import 'dart:typed_data';

import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';

/// Filesystem paths consumed by the Rust GGUF verifier.
final class AzooKeyAssetPaths {
  /// Creates resolved model and tokenizer paths.
  const AzooKeyAssetPaths({
    required this.modelPath,
    required this.tokenizerDirectory,
  });

  /// Selected GGUF path.
  final String modelPath;

  /// Directory containing `vocab.json` and `merges.txt`.
  final String tokenizerDirectory;
}

/// Rust model preparation boundary used after asset resolution.
typedef AzooKeyModelPreparer = Future<void> Function({
  required AzooKeyModel model,
  required String modelPath,
  required String tokenizerDirectory,
});

/// Resolves assets and prepares the selected Rust verifier.
Future<void> prepareAzooKeyRuntime({
  required AzooKeyModel model,
  required bool usesAppleBundle,
  required String executablePath,
  required Future<Directory> Function() supportDirectory,
  required Future<ByteData> Function(String asset) loadAsset,
  required AzooKeyModelPreparer prepareModel,
}) async {
  final paths = await resolveAzooKeyAssets(
    model: model,
    usesAppleBundle: usesAppleBundle,
    executablePath: executablePath,
    supportDirectory: supportDirectory,
    loadAsset: loadAsset,
  );
  await prepareModel(
    model: model,
    modelPath: paths.modelPath,
    tokenizerDirectory: paths.tokenizerDirectory,
  );
}

/// Resolves direct Apple bundle paths or copies packaged assets to writable
/// application support storage on platforms whose assets are not files.
Future<AzooKeyAssetPaths> resolveAzooKeyAssets({
  required AzooKeyModel model,
  required bool usesAppleBundle,
  required String executablePath,
  required Future<Directory> Function() supportDirectory,
  required Future<ByteData> Function(String asset) loadAsset,
}) async {
  const assetRoot = 'assets/azookey';
  final modelName = model == AzooKeyModel.small ? 'small' : 'xsmall';
  if (usesAppleBundle) {
    final root =
        '${File(executablePath).parent.path}/Frameworks/'
        'App.framework/flutter_assets/$assetRoot';
    return AzooKeyAssetPaths(
      modelPath: '$root/models/$modelName/ggml-model-Q5_K_M.gguf',
      tokenizerDirectory: '$root/tokenizer',
    );
  }
  final support = await supportDirectory();
  final root = Directory('${support.path}/azookey');
  final modelPath = '${root.path}/models/$modelName/ggml-model-Q5_K_M.gguf';
  await _copyAssetIfMissing(
    '$assetRoot/models/$modelName/ggml-model-Q5_K_M.gguf',
    File(modelPath),
    loadAsset,
  );
  await _copyAssetIfMissing(
    '$assetRoot/tokenizer/vocab.json',
    File('${root.path}/tokenizer/vocab.json'),
    loadAsset,
  );
  await _copyAssetIfMissing(
    '$assetRoot/tokenizer/merges.txt',
    File('${root.path}/tokenizer/merges.txt'),
    loadAsset,
  );
  return AzooKeyAssetPaths(
    modelPath: modelPath,
    tokenizerDirectory: '${root.path}/tokenizer',
  );
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
