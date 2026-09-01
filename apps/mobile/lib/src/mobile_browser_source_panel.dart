// Public widget fields mirror Flutter's declarative construction and are
// documented by the widget-level contract.
// ignore_for_file: public_member_api_docs

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:kotoba_beacon_companion/src/companion_l10n.dart';
import 'package:kotoba_beacon_companion/src/companion_style.dart';
import 'package:kotoba_beacon_companion/src/mobile_browser_source.dart';

bool get _cupertino => defaultTargetPlatform == TargetPlatform.iOS;

/// Mobile HTML host toggle, live URL, style editor, and local preview.
final class MobileBrowserSourcePanel extends StatefulWidget {
  const MobileBrowserSourcePanel({
    required this.enabled,
    required this.busy,
    required this.url,
    required this.style,
    required this.previewSource,
    required this.previewTranslation,
    required this.onToggle,
    required this.onCopyUrl,
    required this.onStyleChanged,
    required this.onPreviewSourceChanged,
    required this.onPreviewTranslationChanged,
    super.key,
  });

  final bool enabled;
  final bool busy;
  final String? url;
  final CompanionCaptionStyle style;
  final String previewSource;
  final String previewTranslation;
  final ValueChanged<bool> onToggle;
  final VoidCallback onCopyUrl;
  final ValueChanged<CompanionCaptionStyle> onStyleChanged;
  final ValueChanged<String> onPreviewSourceChanged;
  final ValueChanged<String> onPreviewTranslationChanged;

  @override
  State<MobileBrowserSourcePanel> createState() =>
      _MobileBrowserSourcePanelState();
}

final class _MobileBrowserSourcePanelState
    extends State<MobileBrowserSourcePanel> {
  late final TextEditingController _sourceColor;
  late final TextEditingController _translationColor;
  late final TextEditingController _backgroundColor;
  late final TextEditingController _shadowColor;
  late final TextEditingController _outlineColor;
  late final TextEditingController _previewSource;
  late final TextEditingController _previewTranslation;
  bool _editorExpanded = false;

  @override
  void initState() {
    super.initState();
    _sourceColor = TextEditingController(text: widget.style.sourceColor);
    _translationColor = TextEditingController(
      text: widget.style.translationColor,
    );
    _backgroundColor = TextEditingController(
      text: widget.style.backgroundColor,
    );
    _shadowColor = TextEditingController(text: widget.style.shadowColor);
    _outlineColor = TextEditingController(text: widget.style.outlineColor);
    _previewSource = TextEditingController(text: widget.previewSource);
    _previewTranslation = TextEditingController(
      text: widget.previewTranslation,
    );
  }

  @override
  void didUpdateWidget(MobileBrowserSourcePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncController(_sourceColor, widget.style.sourceColor);
    _syncController(_translationColor, widget.style.translationColor);
    _syncController(_backgroundColor, widget.style.backgroundColor);
    _syncController(_shadowColor, widget.style.shadowColor);
    _syncController(_outlineColor, widget.style.outlineColor);
  }

  @override
  void dispose() {
    _sourceColor.dispose();
    _translationColor.dispose();
    _backgroundColor.dispose();
    _shadowColor.dispose();
    _outlineColor.dispose();
    _previewSource.dispose();
    _previewTranslation.dispose();
    super.dispose();
  }

  void _syncController(TextEditingController controller, String value) {
    if (controller.text != value && !controller.selection.isValid) {
      controller.text = value;
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = CompanionL10n.of(context);
    return Column(
      key: const Key('mobile-browser-source-panel'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(l10n.htmlHost, style: CompanionStyle.emphasis),
        const SizedBox(height: CompanionStyle.gap),
        _ToggleRow(
          key: const Key('mobile-browser-source-toggle'),
          label: l10n.htmlHostEnabled,
          value: widget.enabled,
          enabled: !widget.busy,
          onChanged: widget.onToggle,
        ),
        if (widget.busy) ...[
          const SizedBox(height: CompanionStyle.gap),
          const Center(child: CupertinoActivityIndicator()),
        ],
        if (widget.url case final url?) ...[
          const SizedBox(height: CompanionStyle.gap),
          SelectableText(url, key: const Key('mobile-browser-source-url')),
          const SizedBox(height: CompanionStyle.gap),
          _ActionButton(
            buttonKey: const Key('copy-mobile-browser-source-url'),
            label: l10n.copyHtmlUrl,
            onPressed: widget.onCopyUrl,
          ),
        ],
        const SizedBox(height: CompanionStyle.gap),
        MobileCaptionPreview(
          style: widget.style,
          source: widget.previewSource,
          translation: widget.previewTranslation,
        ),
        const SizedBox(height: CompanionStyle.gap),
        _ActionButton(
          buttonKey: const Key('toggle-mobile-caption-style-editor'),
          label: _editorExpanded
              ? l10n.hideCaptionStyle
              : l10n.editCaptionStyle,
          onPressed: () => setState(() => _editorExpanded = !_editorExpanded),
        ),
        if (_editorExpanded) ...[
          const SizedBox(height: CompanionStyle.section),
          ..._styleControls(l10n),
        ],
      ],
    );
  }

  List<Widget> _styleControls(CompanionL10n l10n) =>
      <Widget>[
            _TextControl(
              controller: _previewSource,
              label: l10n.previewRecognition,
              onChanged: widget.onPreviewSourceChanged,
            ),
            _TextControl(
              controller: _previewTranslation,
              label: l10n.previewTranslation,
              onChanged: widget.onPreviewTranslationChanged,
            ),
            _SliderControl(
              label: l10n.fontWeight,
              value: widget.style.fontWeight.toDouble(),
              minimum: 100,
              maximum: 900,
              divisions: 8,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(fontWeight: value.round()),
              ),
            ),
            _SliderControl(
              label: l10n.letterSpacing,
              value: widget.style.letterSpacing,
              minimum: -2,
              maximum: 10,
              divisions: 48,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(letterSpacing: value),
              ),
            ),
            _SliderControl(
              label: l10n.lineHeight,
              value: widget.style.lineHeight,
              minimum: 1,
              maximum: 2,
              divisions: 20,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(lineHeight: value),
              ),
            ),
            _SliderControl(
              label: l10n.sourceSize,
              value: widget.style.sourceSize,
              minimum: 8,
              maximum: 96,
              divisions: 88,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(sourceSize: value),
              ),
            ),
            _ColorControl(
              controller: _sourceColor,
              label: l10n.sourceColor,
              onColor: (color) => widget.onStyleChanged(
                widget.style.copyWith(sourceColor: color),
              ),
            ),
            _SliderControl(
              label: l10n.sourceOpacity,
              value: widget.style.sourceOpacity,
              minimum: 0,
              maximum: 1,
              divisions: 20,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(sourceOpacity: value),
              ),
            ),
            _SliderControl(
              label: l10n.translationSize,
              value: widget.style.translationSize,
              minimum: 8,
              maximum: 96,
              divisions: 88,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(translationSize: value),
              ),
            ),
            _ColorControl(
              controller: _translationColor,
              label: l10n.translationColor,
              onColor: (color) => widget.onStyleChanged(
                widget.style.copyWith(translationColor: color),
              ),
            ),
            _SliderControl(
              label: l10n.translationOpacity,
              value: widget.style.translationOpacity,
              minimum: 0,
              maximum: 1,
              divisions: 20,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(translationOpacity: value),
              ),
            ),
            _SliderControl(
              label: l10n.positionX,
              value: widget.style.xPercent,
              minimum: 0,
              maximum: 100,
              divisions: 100,
              onChanged: (value) =>
                  widget.onStyleChanged(widget.style.copyWith(xPercent: value)),
            ),
            _SliderControl(
              label: l10n.positionY,
              value: widget.style.yPercent,
              minimum: 0,
              maximum: 100,
              divisions: 100,
              onChanged: (value) =>
                  widget.onStyleChanged(widget.style.copyWith(yPercent: value)),
            ),
            _ToggleRow(
              label: l10n.background,
              value: widget.style.backgroundEnabled,
              enabled: true,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(backgroundEnabled: value),
              ),
            ),
            _ColorControl(
              controller: _backgroundColor,
              label: l10n.backgroundColor,
              onColor: (color) => widget.onStyleChanged(
                widget.style.copyWith(backgroundColor: color),
              ),
            ),
            _SliderControl(
              label: l10n.backgroundOpacity,
              value: widget.style.backgroundOpacity,
              minimum: 0,
              maximum: 1,
              divisions: 20,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(backgroundOpacity: value),
              ),
            ),
            _ToggleRow(
              label: l10n.shadow,
              value: widget.style.shadowEnabled,
              enabled: true,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(shadowEnabled: value),
              ),
            ),
            _ColorControl(
              controller: _shadowColor,
              label: l10n.shadowColor,
              onColor: (color) => widget.onStyleChanged(
                widget.style.copyWith(shadowColor: color),
              ),
            ),
            _SliderControl(
              label: l10n.shadowBlur,
              value: widget.style.shadowBlur,
              minimum: 0,
              maximum: 40,
              divisions: 40,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(shadowBlur: value),
              ),
            ),
            _SliderControl(
              label: l10n.shadowOffsetX,
              value: widget.style.shadowOffsetX,
              minimum: -20,
              maximum: 20,
              divisions: 40,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(shadowOffsetX: value),
              ),
            ),
            _SliderControl(
              label: l10n.shadowOffsetY,
              value: widget.style.shadowOffsetY,
              minimum: -20,
              maximum: 20,
              divisions: 40,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(shadowOffsetY: value),
              ),
            ),
            _ToggleRow(
              label: l10n.outline,
              value: widget.style.outlineEnabled,
              enabled: true,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(outlineEnabled: value),
              ),
            ),
            _ColorControl(
              controller: _outlineColor,
              label: l10n.outlineColor,
              onColor: (color) => widget.onStyleChanged(
                widget.style.copyWith(outlineColor: color),
              ),
            ),
            _SliderControl(
              label: l10n.outlineWidth,
              value: widget.style.outlineWidth,
              minimum: 0,
              maximum: 12,
              divisions: 24,
              onChanged: (value) => widget.onStyleChanged(
                widget.style.copyWith(outlineWidth: value),
              ),
            ),
          ]
          .expand(
            (control) => <Widget>[
              control,
              const SizedBox(height: CompanionStyle.gap),
            ],
          )
          .toList();
}

/// 16:9 preview following the same placement, colors, and effects as HTML.
final class MobileCaptionPreview extends StatelessWidget {
  const MobileCaptionPreview({
    required this.style,
    required this.source,
    required this.translation,
    super.key,
  });

  final CompanionCaptionStyle style;
  final String source;
  final String translation;

  @override
  Widget build(BuildContext context) => AspectRatio(
    key: const Key('mobile-caption-style-preview'),
    aspectRatio: 16 / 9,
    child: ClipRect(
      child: ColoredBox(
        color: const Color(0xff17202a),
        child: Align(
          alignment: Alignment(
            (style.xPercent / 50) - 1,
            (style.yPercent / 50) - 1,
          ),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            color: style.backgroundEnabled
                ? _hexColor(style.backgroundColor).withValues(
                    alpha: style.backgroundOpacity,
                  )
                : Colors.transparent,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                _OutlinedCaptionText(
                  text: source,
                  size: style.sourceSize,
                  color: _hexColor(
                    style.sourceColor,
                  ).withValues(alpha: style.sourceOpacity),
                  style: style,
                ),
                _OutlinedCaptionText(
                  text: translation,
                  size: style.translationSize,
                  color: _hexColor(
                    style.translationColor,
                  ).withValues(alpha: style.translationOpacity),
                  style: style,
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

final class _OutlinedCaptionText extends StatelessWidget {
  const _OutlinedCaptionText({
    required this.text,
    required this.size,
    required this.color,
    required this.style,
  });

  final String text;
  final double size;
  final Color color;
  final CompanionCaptionStyle style;

  @override
  Widget build(BuildContext context) {
    final previewSize = (size * 0.42).clamp(8.0, 40.0);
    final base = TextStyle(
      fontFamily: style.fontFamily,
      fontSize: previewSize,
      fontWeight: FontWeight.lerp(
        FontWeight.w100,
        FontWeight.w900,
        (style.fontWeight - 100) / 800,
      ),
      letterSpacing: style.letterSpacing * 0.42,
      height: style.lineHeight,
      shadows: style.shadowEnabled
          ? <Shadow>[
              Shadow(
                color: _hexColor(style.shadowColor),
                blurRadius: style.shadowBlur * 0.42,
                offset: Offset(
                  style.shadowOffsetX * 0.42,
                  style.shadowOffsetY * 0.42,
                ),
              ),
            ]
          : null,
    );
    final fill = Text(
      text,
      textAlign: TextAlign.center,
      style: base.copyWith(color: color),
    );
    if (!style.outlineEnabled || style.outlineWidth == 0) return fill;
    return Stack(
      alignment: Alignment.center,
      children: [
        Text(
          text,
          textAlign: TextAlign.center,
          style: base.copyWith(
            foreground: Paint()
              ..style = PaintingStyle.stroke
              ..strokeWidth = style.outlineWidth * 0.84
              ..color = _hexColor(style.outlineColor),
          ),
        ),
        fill,
      ],
    );
  }
}

final class _SliderControl extends StatelessWidget {
  const _SliderControl({
    required this.label,
    required this.value,
    required this.minimum,
    required this.maximum,
    required this.divisions,
    required this.onChanged,
  });

  final String label;
  final double value;
  final double minimum;
  final double maximum;
  final int divisions;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text('$label: ${value.toStringAsFixed(1)}'),
      if (_cupertino)
        CupertinoSlider(
          value: value.clamp(minimum, maximum),
          min: minimum,
          max: maximum,
          divisions: divisions,
          onChanged: onChanged,
        )
      else
        Slider(
          value: value.clamp(minimum, maximum),
          min: minimum,
          max: maximum,
          divisions: divisions,
          onChanged: onChanged,
        ),
    ],
  );
}

final class _ToggleRow extends StatelessWidget {
  const _ToggleRow({
    required this.label,
    required this.value,
    required this.enabled,
    required this.onChanged,
    super.key,
  });

  final String label;
  final bool value;
  final bool enabled;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(child: Text(label)),
      if (_cupertino)
        CupertinoSwitch(
          value: value,
          onChanged: enabled ? onChanged : null,
        )
      else
        Switch(value: value, onChanged: enabled ? onChanged : null),
    ],
  );
}

final class _TextControl extends StatelessWidget {
  const _TextControl({
    required this.controller,
    required this.label,
    required this.onChanged,
  });

  final TextEditingController controller;
  final String label;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    if (_cupertino) {
      return CupertinoTextField(
        controller: controller,
        placeholder: label,
        onChanged: onChanged,
      );
    }
    return TextField(
      controller: controller,
      decoration: InputDecoration(labelText: label),
      onChanged: onChanged,
    );
  }
}

final class _ColorControl extends StatelessWidget {
  const _ColorControl({
    required this.controller,
    required this.label,
    required this.onColor,
  });

  final TextEditingController controller;
  final String label;
  final ValueChanged<String> onColor;

  @override
  Widget build(BuildContext context) => _TextControl(
    controller: controller,
    label: '$label (#RRGGBB)',
    onChanged: (value) {
      if (RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(value)) {
        onColor(value.toLowerCase());
      }
    },
  );
}

final class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.buttonKey,
    required this.label,
    required this.onPressed,
  });

  final Key buttonKey;
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    if (_cupertino) {
      return CupertinoButton(
        key: buttonKey,
        onPressed: onPressed,
        child: Text(label),
      );
    }
    return OutlinedButton(
      key: buttonKey,
      onPressed: onPressed,
      child: Text(label),
    );
  }
}

Color _hexColor(String value) {
  final normalized = value.replaceFirst('#', '');
  return Color(int.parse('ff$normalized', radix: 16));
}
