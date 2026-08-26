import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/src/quickmt_assets.dart';

void main() {
  test('resolves QuickMT directly from an Apple application bundle', () async {
    final directory = await resolveQuickMtAssets(
      usesAppleBundle: true,
      executablePath: '/Applications/Runner.app/Runner',
      supportDirectory: () => throw StateError('must not copy Apple assets'),
      loadAsset: (_) => throw StateError('must not load Apple assets'),
    );

    expect(
      directory,
      '/Applications/Runner.app/Frameworks/App.framework/flutter_assets/'
      'assets/quickmt/quickmt-ja-en',
    );
    String? preparedDirectory;
    await prepareQuickMtRuntime(
      usesAppleBundle: true,
      executablePath: '/Applications/Runner.app/Runner',
      supportDirectory: () => throw StateError('must not copy Apple assets'),
      loadAsset: (_) => throw StateError('must not load Apple assets'),
      prepareModel: ({required modelDirectory}) async {
        preparedDirectory = modelDirectory;
      },
    );
    expect(preparedDirectory, directory);
  });

  test('copies every QuickMT file once on packaged platforms', () async {
    final support = await Directory.systemTemp.createTemp('quickmt-assets-');
    addTearDown(() => support.deleteSync(recursive: true));
    final loaded = <String>[];
    Future<ByteData> loader(String asset) async {
      loaded.add(asset);
      return ByteData.sublistView(Uint8List.fromList([1, 2, 3]));
    }

    final first = await resolveQuickMtAssets(
      usesAppleBundle: false,
      executablePath: '/unused',
      supportDirectory: () async => support,
      loadAsset: loader,
    );
    final second = await resolveQuickMtAssets(
      usesAppleBundle: false,
      executablePath: '/unused',
      supportDirectory: () async => support,
      loadAsset: loader,
    );

    expect(first, second);
    expect(Directory(first).listSync().whereType<File>().length, 6);
    expect(
      loaded,
      quickMtAssetFiles
          .map((name) => 'assets/quickmt/quickmt-ja-en/$name')
          .toList(),
    );
  });
}
