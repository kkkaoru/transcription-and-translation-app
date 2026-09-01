import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/main.dart';
import 'package:kotoba_beacon_companion/src/mobile_browser_source.dart';
import 'package:kotoba_beacon_companion/src/mobile_browser_source_panel.dart';

void main() {
  testWidgets('edits and previews Mobile HTML caption style', (tester) async {
    var enabled = false;
    var style = const CompanionCaptionStyle();
    await tester.pumpWidget(
      KotobaBeaconCompanionApp(
        locale: const Locale('ja'),
        home: StatefulBuilder(
          builder: (context, setState) => Scaffold(
            body: SingleChildScrollView(
              child: MobileBrowserSourcePanel(
                enabled: enabled,
                busy: false,
                url: enabled ? 'http://127.0.0.1:1522/' : null,
                style: style,
                previewSource: 'プレビュー字幕',
                previewTranslation: 'Preview caption',
                onToggle: (value) => setState(() => enabled = value),
                onCopyUrl: () {},
                onStyleChanged: (value) => setState(() => style = value),
                onPreviewSourceChanged: (_) {},
                onPreviewTranslationChanged: (_) {},
              ),
            ),
          ),
        ),
      ),
    );

    expect(
      find.byKey(const Key('mobile-caption-style-preview')),
      findsOneWidget,
    );
    expect(find.text('プレビュー字幕'), findsNWidgets(2));
    await tester.tap(find.byType(Switch));
    await tester.pump();
    expect(enabled, isTrue);
    expect(find.text('http://127.0.0.1:1522/'), findsOneWidget);

    final editorToggle = find.byKey(
      const Key('toggle-mobile-caption-style-editor'),
    );
    await tester.ensureVisible(editorToggle);
    await tester.tap(editorToggle);
    await tester.pump();
    final captionColor = find.widgetWithText(TextField, '字幕色 (#RRGGBB)');
    expect(captionColor, findsOneWidget);
    await tester.enterText(captionColor, '#ff0000');
    await tester.pump();
    expect(style.sourceColor, '#ff0000');
  });
}
