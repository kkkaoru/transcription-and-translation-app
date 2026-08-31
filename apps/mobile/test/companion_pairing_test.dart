import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/src/companion_pairing.dart';

void main() {
  test('encodes a camera-readable pairing URL', () {
    expect(
      encodeCompanionPairingLink(
        endpoint: 'ws://192.168.1.2:18183/companion',
        token: '0123456789abcdef0123456789abcdef',
      ),
      'kotobabeacon://pair?endpoint=ws%3A%2F%2F192.168.1.2%3A18183%2Fcompanion&token=0123456789abcdef0123456789abcdef',
    );
  });

  test('parses a Native pairing URL', () {
    final parsed = parseCompanionPairingLink(
      Uri.parse(
        'kotobabeacon://pair?endpoint=ws%3A%2F%2F192.168.1.2%3A18183%2Fcompanion&token=0123456789abcdef0123456789abcdef',
      ),
    );

    expect(parsed?.endpoint, 'ws://192.168.1.2:18183/companion');
    expect(parsed?.token, '0123456789abcdef0123456789abcdef');
  });

  test('parses a pairing path without a host', () {
    final parsed = parseCompanionPairingLink(
      Uri.parse(
        'kotobabeacon:///pair?endpoint=ws://192.168.1.9:18183/companion&token=path-token',
      ),
    );

    expect(parsed?.endpoint, 'ws://192.168.1.9:18183/companion');
    expect(parsed?.token, 'path-token');
  });

  test('rejects a URL that is not a pairing link', () {
    expect(
      parseCompanionPairingLink(Uri.parse('https://example.com/pair')),
      isNull,
    );
    expect(
      parseCompanionPairingLink(Uri.parse('kotobabeacon://status')),
      isNull,
    );
    expect(
      parseCompanionPairingLink(Uri.parse('kotobabeacon://pair?token=only')),
      isNull,
    );
  });
}
