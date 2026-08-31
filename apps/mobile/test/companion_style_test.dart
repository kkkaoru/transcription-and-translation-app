import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kotoba_beacon_companion/src/companion_style.dart';

void main() {
  test('keeps one content color, one accent, and two type sizes', () {
    expect(CompanionStyle.content, const Color(0xff1c1c1e));
    expect(CompanionStyle.pageBackground, const Color(0xfff2f2f7));
    expect(CompanionStyle.surface, const Color(0xffffffff));
    expect(CompanionStyle.primary, const Color(0xff007a70));
    expect(CompanionStyle.onPrimary, const Color(0xffffffff));
    expect(CompanionStyle.muted, const Color(0xff8e8e93));
    expect(CompanionStyle.unavailable, const Color(0xffe5e5ea));
    expect(CompanionStyle.body.fontSize, 16);
    expect(CompanionStyle.body.fontWeight, FontWeight.w400);
    expect(CompanionStyle.emphasis.fontSize, 16);
    expect(CompanionStyle.emphasis.fontWeight, FontWeight.w600);
    expect(CompanionStyle.title.fontSize, 20);
    expect(CompanionStyle.title.fontWeight, FontWeight.w600);
  });

  test('keeps two vertical rhythms and one control height', () {
    expect(CompanionStyle.gap, 8);
    expect(CompanionStyle.section, 16);
    expect(CompanionStyle.inset, 12);
    expect(CompanionStyle.controlHeight, 48);
    expect(CompanionStyle.radius, 10);
    expect(CompanionStyle.borderWidth, 1);
  });

  test('maps button colors from the shared tokens', () {
    expect(
      CompanionStyle.buttonFill(emphasized: true, enabled: true),
      CompanionStyle.primary,
    );
    expect(
      CompanionStyle.buttonFill(emphasized: true, enabled: false),
      CompanionStyle.unavailable,
    );
    expect(
      CompanionStyle.buttonFill(emphasized: false, enabled: true),
      CompanionStyle.surface,
    );
    expect(
      CompanionStyle.buttonLabel(emphasized: true, enabled: true),
      CompanionStyle.onPrimary,
    );
    expect(
      CompanionStyle.buttonLabel(emphasized: false, enabled: true),
      CompanionStyle.primary,
    );
    expect(
      CompanionStyle.buttonLabel(emphasized: false, enabled: false),
      CompanionStyle.muted,
    );
    expect(
      CompanionStyle.buttonBorder(enabled: true),
      CompanionStyle.primary,
    );
    expect(
      CompanionStyle.buttonBorder(enabled: false),
      CompanionStyle.unavailable,
    );
  });
}
