import 'package:flutter/material.dart';

/// Shared visual tokens for standard and detailed companion screens.
abstract final class CompanionStyle {
  /// Primary readable content color.
  static const Color content = Color(0xff1c1c1e);

  /// Page background behind cards and controls.
  static const Color pageBackground = Color(0xfff2f2f7);

  /// Raised surface for cards, fields, and unselected controls.
  static const Color surface = Color(0xffffffff);

  /// Single accent used for selected controls and primary actions.
  static const Color primary = Color(0xff007a70);

  /// Text and icons on [primary].
  static const Color onPrimary = Color(0xffffffff);

  /// Secondary copy, placeholders, and disabled labels.
  static const Color muted = Color(0xff8e8e93);

  /// Disabled and unavailable fills.
  static const Color unavailable = Color(0xffe5e5ea);

  /// Vertical rhythm between related controls.
  static const double gap = 8;

  /// Vertical rhythm between sections.
  static const double section = 16;

  /// Inset used inside text fields and choice rows.
  static const double inset = 12;

  /// Minimum tappable control height.
  static const double controlHeight = 48;

  /// Corner radius for grouped choice controls.
  static const double radius = 10;

  /// Hairline used for choice control outlines.
  static const double borderWidth = 1;

  /// Body copy: 16 pt regular.
  static const TextStyle body = TextStyle(
    color: content,
    fontSize: 16,
    height: 1.4,
    fontWeight: FontWeight.w400,
  );

  /// Labels and selected actions: 16 pt semibold.
  static const TextStyle emphasis = TextStyle(
    color: content,
    fontSize: 16,
    height: 1.3,
    fontWeight: FontWeight.w600,
  );

  /// Navigation titles: 20 pt semibold.
  static const TextStyle title = TextStyle(
    color: content,
    fontSize: 20,
    height: 1.2,
    fontWeight: FontWeight.w600,
  );

  /// Fill for a primary or secondary action button.
  static Color buttonFill({
    required bool emphasized,
    required bool enabled,
  }) {
    if (!enabled) return unavailable;
    return emphasized ? primary : surface;
  }

  /// Label for a primary or secondary action button.
  static Color buttonLabel({
    required bool emphasized,
    required bool enabled,
  }) {
    if (!enabled) return muted;
    return emphasized ? onPrimary : primary;
  }

  /// Outline for a secondary action button.
  static Color buttonBorder({required bool enabled}) =>
      enabled ? primary : unavailable;
}
