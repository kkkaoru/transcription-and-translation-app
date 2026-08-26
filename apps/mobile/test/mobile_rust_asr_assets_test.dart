import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/src/mobile_rust_asr_assets.dart';

void main() {
  test('resolves Mobile Rust ASR directly from an Apple bundle', () async {
    final directory = await resolveMobileRustAsrAssets(
      usesAppleBundle: true,
      executablePath: '/Applications/Runner.app/Runner',
      supportDirectory: () => throw StateError('must not copy Apple assets'),
      loadAsset: (_) => throw StateError('must not load Apple assets'),
    );

    expect(
      directory,
      '/Applications/Runner.app/Frameworks/App.framework/flutter_assets/'
      'assets/asr/reazonspeech-k2-v2',
    );
    String? preparedDirectory;
    await prepareMobileRustAsrRuntime(
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

  test(
    'copies every Mobile Rust ASR file once on packaged platforms',
    () async {
      final support = await Directory.systemTemp.createTemp('mobile-rust-asr-');
      addTearDown(() => support.deleteSync(recursive: true));
      final loaded = <String>[];
      Future<ByteData> loader(String asset) async {
        loaded.add(asset);
        return ByteData.sublistView(Uint8List.fromList([1, 2, 3]));
      }

      final first = await resolveMobileRustAsrAssets(
        usesAppleBundle: false,
        executablePath: '/unused',
        supportDirectory: () async => support,
        loadAsset: loader,
      );
      final second = await resolveMobileRustAsrAssets(
        usesAppleBundle: false,
        executablePath: '/unused',
        supportDirectory: () async => support,
        loadAsset: loader,
      );

      expect(first, second);
      expect(Directory(first).listSync().whereType<File>().length, 4);
      expect(
        loaded,
        mobileRustAsrAssetFiles
            .map((name) => 'assets/asr/reazonspeech-k2-v2/$name')
            .toList(),
      );
    },
  );
}
