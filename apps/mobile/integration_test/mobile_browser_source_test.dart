import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:kotoba_beacon_companion/src/mobile_browser_source.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart';
import 'package:kotoba_beacon_companion/src/rust/frb_generated.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(RustLib.init);

  testWidgets('serves styled captions from the iOS Simulator LAN host', (
    _,
  ) async {
    final port = await startMobileBrowserSource();
    try {
      await updateMobileBrowserSourceStyle(
        style: const CompanionCaptionStyle(
          sourceColor: '#ff0000',
          backgroundEnabled: true,
        ).toRust(),
      );
      await updateMobileBrowserSourceCaption(
        source: 'Simulator字幕',
        translation: 'Simulator caption',
      );

      final client = HttpClient();
      try {
        final request = await client.getUrl(
          Uri.parse('http://127.0.0.1:$port/captions.json'),
        );
        final response = await request.close();
        final body = await utf8.decoder.bind(response).join();
        final json = jsonDecode(body) as Map<String, Object?>;
        final caption = json['caption']! as Map<String, Object?>;
        final style = json['style']! as Map<String, Object?>;
        expect(response.statusCode, HttpStatus.ok);
        expect(caption['source'], 'Simulator字幕');
        expect(caption['translation'], 'Simulator caption');
        expect(style['sourceColor'], '#ff0000');
        expect(style['backgroundEnabled'], isTrue);
      } finally {
        client.close(force: true);
      }
    } finally {
      await stopMobileBrowserSource();
    }
  });
}
