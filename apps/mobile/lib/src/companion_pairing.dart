const _pairingScheme = 'kotobabeacon';
const _pairingHost = 'pair';

/// Endpoint and token extracted from a camera-scanned pairing URL.
final class CompanionPairingLink {
  /// Creates pairing credentials.
  const CompanionPairingLink({required this.endpoint, required this.token});

  /// Desktop companion WebSocket endpoint.
  final String endpoint;

  /// Short-lived pairing token advertised by Native.
  final String token;
}

/// Encodes Native pairing data for a camera-readable custom URL.
String encodeCompanionPairingLink({
  required String endpoint,
  required String token,
}) => Uri(
  scheme: _pairingScheme,
  host: _pairingHost,
  queryParameters: <String, String>{
    'endpoint': endpoint,
    'token': token,
  },
).toString();

/// Parses a `kotobabeacon://pair` URL produced by Native.
CompanionPairingLink? parseCompanionPairingLink(Uri uri) {
  if (uri.scheme != _pairingScheme) return null;
  if (!_isPairingTarget(uri)) return null;
  final endpoint = uri.queryParameters['endpoint']?.trim() ?? '';
  final token = uri.queryParameters['token']?.trim() ?? '';
  if (endpoint.isEmpty || token.isEmpty) return null;
  return CompanionPairingLink(endpoint: endpoint, token: token);
}

bool _isPairingTarget(Uri uri) {
  if (uri.host == _pairingHost) return true;
  return uri.path == '/$_pairingHost' || uri.path == _pairingHost;
}
