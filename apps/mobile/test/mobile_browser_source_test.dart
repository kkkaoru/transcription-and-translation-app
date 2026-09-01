import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/src/mobile_browser_source.dart';

void main() {
  test('builds a LAN URL and falls back to Simulator loopback', () {
    expect(
      buildMobileBrowserSourceUrl(
        <InternetAddress>[InternetAddress('192.168.1.42')],
        1522,
      ),
      'http://192.168.1.42:1522/',
    );
    expect(
      buildMobileBrowserSourceUrl(<InternetAddress>[], 1522),
      'http://127.0.0.1:1522/',
    );
  });

  test('preferences restore the complete editable caption style', () {
    final preferences = MobileBrowserSourcePreferences.fromJson(
      <String, Object?>{
        'enabled': true,
        'style': <String, Object?>{
          'fontFamily': 'Noto Sans JP',
          'fontWeight': 900,
          'letterSpacing': 1.5,
          'lineHeight': 1.4,
          'sourceSize': 48,
          'sourceColor': '#ABCDEF',
          'sourceOpacity': 0.8,
          'translationSize': 32,
          'translationColor': '#123456',
          'translationOpacity': 0.7,
          'xPercent': 44,
          'yPercent': 80,
          'backgroundEnabled': true,
          'backgroundColor': '#010203',
          'backgroundOpacity': 0.6,
          'shadowEnabled': false,
          'shadowColor': '#000001',
          'shadowBlur': 4,
          'shadowOffsetX': 2,
          'shadowOffsetY': 3,
          'outlineEnabled': true,
          'outlineColor': '#040506',
          'outlineWidth': 5,
        },
      },
    );

    expect(preferences.enabled, isTrue);
    expect(preferences.style.fontWeight, 900);
    expect(preferences.style.sourceColor, '#abcdef');
    expect(preferences.style.backgroundEnabled, isTrue);
    expect(preferences.style.shadowEnabled, isFalse);
    expect(preferences.style.outlineWidth, 5);
    expect(preferences.toJson()['style'], preferences.style.toJson());
  });

  test(
    'invalid persisted colors fall back without accepting malformed CSS',
    () {
      final style = CompanionCaptionStyle.fromJson(
        <String, Object?>{
          'sourceColor': 'white',
          'translationColor': '#00FF00',
        },
      );

      expect(style.sourceColor, '#ffffff');
      expect(style.translationColor, '#00ff00');
    },
  );
}
