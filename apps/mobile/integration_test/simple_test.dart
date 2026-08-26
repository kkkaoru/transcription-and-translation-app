import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:kotoba_beacon_companion/main.dart';
import 'package:kotoba_beacon_companion/src/rust/frb_generated.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(RustLib.init);

  testWidgets('loads Rust-defined mobile default route', (tester) async {
    await tester.pumpWidget(const KotobaBeaconCompanionApp());
    expect(find.text('連携機能'), findsOneWidget);
    expect(find.textContaining('zenz-v3.2-small Q5_K_M GGUF'), findsOneWidget);
    expect(find.textContaining('Mobile Rust: QuickMT'), findsOneWidget);
  });
}
