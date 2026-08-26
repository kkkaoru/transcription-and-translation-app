import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/src/azookey_assets.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';

void main() {
  test('resolves Small directly from an iOS or iPadOS app bundle', () async {
    final paths = await resolveAzooKeyAssets(
      model: AzooKeyModel.small,
      usesAppleBundle: true,
      executablePath: '/Applications/Runner.app/Runner',
      supportDirectory: () => throw StateError('must not copy Apple assets'),
      loadAsset: (_) => throw StateError('must not load Apple assets'),
    );

    expect(
      paths.modelPath,
      '/Applications/Runner.app/Frameworks/App.framework/flutter_assets/'
      'assets/azookey/models/small/ggml-model-Q5_K_M.gguf',
    );
    expect(
      paths.tokenizerDirectory,
      '/Applications/Runner.app/Frameworks/App.framework/flutter_assets/'
      'assets/azookey/tokenizer',
    );

    AzooKeyModel? preparedModel;
    await prepareAzooKeyRuntime(
      model: AzooKeyModel.small,
      usesAppleBundle: true,
      executablePath: '/Applications/Runner.app/Runner',
      supportDirectory: () => throw StateError('must not copy Apple assets'),
      loadAsset: (_) => throw StateError('must not load Apple assets'),
      prepareModel:
          ({
            required model,
            required modelPath,
            required tokenizerDirectory,
          }) async {
            preparedModel = model;
            expect(modelPath, paths.modelPath);
            expect(tokenizerDirectory, paths.tokenizerDirectory);
          },
    );
    expect(preparedModel, AzooKeyModel.small);
  });

  test(
    'copies XSmall and tokenizer assets once on packaged platforms',
    () async {
      final support = await Directory.systemTemp.createTemp('azookey-assets-');
      addTearDown(() => support.deleteSync(recursive: true));
      final loaded = <String>[];
      Future<ByteData> loader(String asset) async {
        loaded.add(asset);
        return ByteData.sublistView(Uint8List.fromList([1, 2, 3]));
      }

      final first = await resolveAzooKeyAssets(
        model: AzooKeyModel.xsmall,
        usesAppleBundle: false,
        executablePath: '/unused',
        supportDirectory: () async => support,
        loadAsset: loader,
      );
      final second = await resolveAzooKeyAssets(
        model: AzooKeyModel.xsmall,
        usesAppleBundle: false,
        executablePath: '/unused',
        supportDirectory: () async => support,
        loadAsset: loader,
      );

      expect(File(first.modelPath).readAsBytesSync(), [1, 2, 3]);
      expect(first.tokenizerDirectory, second.tokenizerDirectory);
      expect(loaded, [
        'assets/azookey/models/xsmall/ggml-model-Q5_K_M.gguf',
        'assets/azookey/tokenizer/vocab.json',
        'assets/azookey/tokenizer/merges.txt',
      ]);
    },
  );
}
