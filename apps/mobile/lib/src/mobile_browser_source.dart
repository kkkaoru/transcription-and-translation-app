// The immutable settings object is intentionally field-rich because it mirrors
// the shared Rust/HTML style contract.
// JSON restoration is a lookup boundary, not a generative API.
// ignore_for_file: public_member_api_docs
// ignore_for_file: prefer_constructors_over_static_methods

import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:kotoba_beacon_companion/src/rust/api/simple.dart' as rust;
import 'package:path_provider/path_provider.dart';

const _settingsFileName = 'mobile_browser_source.json';
const _fontFamily = 'Noto Sans JP';

/// Visual settings shared by the Mobile preview and its HTML caption host.
final class CompanionCaptionStyle {
  const CompanionCaptionStyle({
    this.fontFamily = _fontFamily,
    this.fontWeight = 750,
    this.letterSpacing = 0.2,
    this.lineHeight = 1.3,
    this.sourceSize = 36,
    this.sourceColor = '#ffffff',
    this.sourceOpacity = 1,
    this.translationSize = 29,
    this.translationColor = '#bfe8ff',
    this.translationOpacity = 1,
    this.xPercent = 50,
    this.yPercent = 88,
    this.backgroundEnabled = false,
    this.backgroundColor = '#061018',
    this.backgroundOpacity = 0.72,
    this.shadowEnabled = true,
    this.shadowColor = '#000000',
    this.shadowBlur = 8,
    this.shadowOffsetX = 0,
    this.shadowOffsetY = 3,
    this.outlineEnabled = true,
    this.outlineColor = '#061018',
    this.outlineWidth = 3,
  });

  final String fontFamily;
  final int fontWeight;
  final double letterSpacing;
  final double lineHeight;
  final double sourceSize;
  final String sourceColor;
  final double sourceOpacity;
  final double translationSize;
  final String translationColor;
  final double translationOpacity;
  final double xPercent;
  final double yPercent;
  final bool backgroundEnabled;
  final String backgroundColor;
  final double backgroundOpacity;
  final bool shadowEnabled;
  final String shadowColor;
  final double shadowBlur;
  final double shadowOffsetX;
  final double shadowOffsetY;
  final bool outlineEnabled;
  final String outlineColor;
  final double outlineWidth;

  CompanionCaptionStyle copyWith({
    String? fontFamily,
    int? fontWeight,
    double? letterSpacing,
    double? lineHeight,
    double? sourceSize,
    String? sourceColor,
    double? sourceOpacity,
    double? translationSize,
    String? translationColor,
    double? translationOpacity,
    double? xPercent,
    double? yPercent,
    bool? backgroundEnabled,
    String? backgroundColor,
    double? backgroundOpacity,
    bool? shadowEnabled,
    String? shadowColor,
    double? shadowBlur,
    double? shadowOffsetX,
    double? shadowOffsetY,
    bool? outlineEnabled,
    String? outlineColor,
    double? outlineWidth,
  }) => CompanionCaptionStyle(
    fontFamily: fontFamily ?? this.fontFamily,
    fontWeight: fontWeight ?? this.fontWeight,
    letterSpacing: letterSpacing ?? this.letterSpacing,
    lineHeight: lineHeight ?? this.lineHeight,
    sourceSize: sourceSize ?? this.sourceSize,
    sourceColor: sourceColor ?? this.sourceColor,
    sourceOpacity: sourceOpacity ?? this.sourceOpacity,
    translationSize: translationSize ?? this.translationSize,
    translationColor: translationColor ?? this.translationColor,
    translationOpacity: translationOpacity ?? this.translationOpacity,
    xPercent: xPercent ?? this.xPercent,
    yPercent: yPercent ?? this.yPercent,
    backgroundEnabled: backgroundEnabled ?? this.backgroundEnabled,
    backgroundColor: backgroundColor ?? this.backgroundColor,
    backgroundOpacity: backgroundOpacity ?? this.backgroundOpacity,
    shadowEnabled: shadowEnabled ?? this.shadowEnabled,
    shadowColor: shadowColor ?? this.shadowColor,
    shadowBlur: shadowBlur ?? this.shadowBlur,
    shadowOffsetX: shadowOffsetX ?? this.shadowOffsetX,
    shadowOffsetY: shadowOffsetY ?? this.shadowOffsetY,
    outlineEnabled: outlineEnabled ?? this.outlineEnabled,
    outlineColor: outlineColor ?? this.outlineColor,
    outlineWidth: outlineWidth ?? this.outlineWidth,
  );

  Map<String, Object> toJson() => <String, Object>{
    'fontFamily': fontFamily,
    'fontWeight': fontWeight,
    'letterSpacing': letterSpacing,
    'lineHeight': lineHeight,
    'sourceSize': sourceSize,
    'sourceColor': sourceColor,
    'sourceOpacity': sourceOpacity,
    'translationSize': translationSize,
    'translationColor': translationColor,
    'translationOpacity': translationOpacity,
    'xPercent': xPercent,
    'yPercent': yPercent,
    'backgroundEnabled': backgroundEnabled,
    'backgroundColor': backgroundColor,
    'backgroundOpacity': backgroundOpacity,
    'shadowEnabled': shadowEnabled,
    'shadowColor': shadowColor,
    'shadowBlur': shadowBlur,
    'shadowOffsetX': shadowOffsetX,
    'shadowOffsetY': shadowOffsetY,
    'outlineEnabled': outlineEnabled,
    'outlineColor': outlineColor,
    'outlineWidth': outlineWidth,
  };

  static CompanionCaptionStyle fromJson(Map<String, Object?> json) {
    const fallback = CompanionCaptionStyle();
    return CompanionCaptionStyle(
      fontFamily: _string(json['fontFamily'], fallback.fontFamily),
      fontWeight: _integer(json['fontWeight'], fallback.fontWeight),
      letterSpacing: _number(json['letterSpacing'], fallback.letterSpacing),
      lineHeight: _number(json['lineHeight'], fallback.lineHeight),
      sourceSize: _number(json['sourceSize'], fallback.sourceSize),
      sourceColor: _color(json['sourceColor'], fallback.sourceColor),
      sourceOpacity: _number(json['sourceOpacity'], fallback.sourceOpacity),
      translationSize: _number(
        json['translationSize'],
        fallback.translationSize,
      ),
      translationColor: _color(
        json['translationColor'],
        fallback.translationColor,
      ),
      translationOpacity: _number(
        json['translationOpacity'],
        fallback.translationOpacity,
      ),
      xPercent: _number(json['xPercent'], fallback.xPercent),
      yPercent: _number(json['yPercent'], fallback.yPercent),
      backgroundEnabled: _boolean(
        json['backgroundEnabled'],
        fallback.backgroundEnabled,
      ),
      backgroundColor: _color(
        json['backgroundColor'],
        fallback.backgroundColor,
      ),
      backgroundOpacity: _number(
        json['backgroundOpacity'],
        fallback.backgroundOpacity,
      ),
      shadowEnabled: _boolean(
        json['shadowEnabled'],
        fallback.shadowEnabled,
      ),
      shadowColor: _color(json['shadowColor'], fallback.shadowColor),
      shadowBlur: _number(json['shadowBlur'], fallback.shadowBlur),
      shadowOffsetX: _number(
        json['shadowOffsetX'],
        fallback.shadowOffsetX,
      ),
      shadowOffsetY: _number(
        json['shadowOffsetY'],
        fallback.shadowOffsetY,
      ),
      outlineEnabled: _boolean(
        json['outlineEnabled'],
        fallback.outlineEnabled,
      ),
      outlineColor: _color(json['outlineColor'], fallback.outlineColor),
      outlineWidth: _number(json['outlineWidth'], fallback.outlineWidth),
    );
  }

  rust.MobileBrowserSourceStyle toRust() => rust.MobileBrowserSourceStyle(
    fontFamily: fontFamily,
    fontWeight: fontWeight,
    letterSpacingPx: letterSpacing,
    lineHeight: lineHeight,
    sourceSizePx: sourceSize,
    sourceColor: sourceColor,
    sourceOpacity: sourceOpacity,
    translationSizePx: translationSize,
    translationColor: translationColor,
    translationOpacity: translationOpacity,
    xPercent: xPercent,
    yPercent: yPercent,
    backgroundEnabled: backgroundEnabled,
    backgroundColor: backgroundColor,
    backgroundOpacity: backgroundOpacity,
    shadowEnabled: shadowEnabled,
    shadowColor: shadowColor,
    shadowBlurPx: shadowBlur,
    shadowOffsetX: shadowOffsetX,
    shadowOffsetY: shadowOffsetY,
    outlineEnabled: outlineEnabled,
    outlineColor: outlineColor,
    outlineWidthPx: outlineWidth,
  );
}

/// Persisted Mobile HTML host state.
final class MobileBrowserSourcePreferences {
  const MobileBrowserSourcePreferences({
    this.enabled = false,
    this.style = const CompanionCaptionStyle(),
  });

  final bool enabled;
  final CompanionCaptionStyle style;

  Map<String, Object> toJson() => <String, Object>{
    'enabled': enabled,
    'style': style.toJson(),
  };

  static MobileBrowserSourcePreferences fromJson(Map<String, Object?> json) {
    final rawStyle = json['style'];
    return MobileBrowserSourcePreferences(
      enabled: json['enabled'] == true,
      style: rawStyle is Map<String, Object?>
          ? CompanionCaptionStyle.fromJson(rawStyle)
          : const CompanionCaptionStyle(),
    );
  }
}

/// Host operations injected into the Mobile UI and its tests.
abstract interface class MobileBrowserSourceBackend {
  Future<String> start();
  Future<void> stop();
  Future<void> updateCaption(String source, String translation);
  Future<void> updateStyle(CompanionCaptionStyle style);
}

/// Rust-backed LAN HTML host used by production iOS and Android builds.
final class RustMobileBrowserSourceBackend
    implements MobileBrowserSourceBackend {
  const RustMobileBrowserSourceBackend();

  @override
  Future<String> start() async {
    final port = await rust.startMobileBrowserSource();
    final interfaces = await NetworkInterface.list(
      type: InternetAddressType.IPv4,
    );
    return buildMobileBrowserSourceUrl(
      interfaces.expand((interface) => interface.addresses),
      port,
    );
  }

  @override
  Future<void> stop() => rust.stopMobileBrowserSource();

  @override
  Future<void> updateCaption(String source, String translation) =>
      rust.updateMobileBrowserSourceCaption(
        source: source,
        translation: translation,
      );

  @override
  Future<void> updateStyle(CompanionCaptionStyle style) =>
      rust.updateMobileBrowserSourceStyle(style: style.toRust());
}

/// Selects a reachable IPv4 URL, with loopback as the iOS Simulator fallback.
String buildMobileBrowserSourceUrl(
  Iterable<InternetAddress> addresses,
  int port,
) {
  final address = addresses
      .where(
        (candidate) =>
            candidate.type == InternetAddressType.IPv4 &&
            !candidate.isLoopback &&
            candidate.address != '0.0.0.0',
      )
      .map((candidate) => candidate.address)
      .firstOrNull;
  return Uri(
    scheme: 'http',
    host: address ?? InternetAddress.loopbackIPv4.address,
    port: port,
    path: '/',
  ).toString();
}

/// Loads the saved host toggle and style from the application sandbox.
Future<MobileBrowserSourcePreferences>
loadMobileBrowserSourcePreferences() async {
  final directory = await getApplicationSupportDirectory();
  final file = File('${directory.path}/$_settingsFileName');
  if (!file.existsSync()) return const MobileBrowserSourcePreferences();
  final decoded = jsonDecode(await file.readAsString());
  if (decoded is! Map<String, Object?>) {
    return const MobileBrowserSourcePreferences();
  }
  return MobileBrowserSourcePreferences.fromJson(decoded);
}

/// Atomically saves the host toggle and style in the application sandbox.
Future<void> saveMobileBrowserSourcePreferences(
  MobileBrowserSourcePreferences preferences,
) async {
  final directory = await getApplicationSupportDirectory();
  await directory.create(recursive: true);
  final file = File('${directory.path}/$_settingsFileName');
  final temporary = File('${file.path}.tmp');
  await temporary.writeAsString(jsonEncode(preferences.toJson()), flush: true);
  await temporary.rename(file.path);
}

Future<void>? _fontLoad;

/// Loads the exact font bytes embedded by the shared Browser Source crate.
Future<void> loadMobileBrowserSourceFont() => _fontLoad ??= () async {
  final bytes = await rust.mobileBrowserSourceFontBytes();
  final loader = FontLoader(_fontFamily)
    ..addFont(
      Future<ByteData>.value(ByteData.sublistView(Uint8List.fromList(bytes))),
    );
  await loader.load();
}();

String _string(Object? value, String fallback) =>
    value is String && value.isNotEmpty ? value : fallback;

int _integer(Object? value, int fallback) =>
    value is num ? value.toInt() : fallback;

double _number(Object? value, double fallback) =>
    value is num && value.isFinite ? value.toDouble() : fallback;

bool _boolean(Object? value, bool fallback) => value is bool ? value : fallback;

String _color(Object? value, String fallback) {
  if (value is! String || !RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(value)) {
    return fallback;
  }
  return value.toLowerCase();
}
