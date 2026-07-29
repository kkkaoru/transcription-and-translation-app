import type { CSSProperties } from "react";
import type { CaptionTextStyle, OverlayConfig } from "./types";

export const clampNumber = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

export const toCaptionCss = (style: CaptionTextStyle): CSSProperties => {
  const cullingColor = `color-mix(in srgb, ${style.cullingColor} ${clampNumber(style.cullingOpacity, 0, 1) * 100}%, transparent)`;
  const outline = style.cullingEnabled ? `0 0 ${style.cullingWidthPx}px ${cullingColor}` : "none";
  const shadow = style.shadowEnabled
    ? `${style.shadowOffsetX}px ${style.shadowOffsetY}px ${style.shadowBlurPx}px ${style.shadowColor}`
    : "none";
  return {
    color: style.color,
    opacity: clampNumber(style.opacity, 0, 1),
    fontFamily: style.fontFamily,
    fontSize: `${Math.max(1, style.fontSizePx)}px`,
    fontWeight: clampNumber(style.fontWeight, 100, 900),
    letterSpacing: `${style.letterSpacingPx}px`,
    lineHeight: style.lineHeight,
    textAlign: style.textAlign,
    maxWidth: `${clampNumber(style.maxWidthPercent, 1, 100)}%`,
    WebkitTextStroke: style.cullingEnabled
      ? `${style.cullingWidthPx}px ${cullingColor}`
      : "0 transparent",
    paintOrder: "stroke fill",
    textShadow: [outline, shadow].filter((part) => part !== "none").join(", ") || "none",
    backgroundColor: style.backgroundEnabled
      ? `color-mix(in srgb, ${style.backgroundColor} ${clampNumber(style.backgroundOpacity, 0, 1) * 100}%, transparent)`
      : "transparent",
    padding: `${Math.max(0, style.paddingY)}px ${Math.max(0, style.paddingX)}px`,
    borderRadius: `${Math.max(0, style.borderRadius)}px`,
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  };
};

export const overlayCaptionCss = (overlay: OverlayConfig): CSSProperties => ({
  position: "absolute",
  left: `${clampNumber(overlay.captionXPercent, 0, 100)}%`,
  top: `${clampNumber(overlay.captionYPercent, 0, 100)}%`,
  width: `calc(100% - ${Math.max(0, overlay.safeAreaPx) * 2}px)`,
  transform: "translate(-50%, -50%)",
  gap: `${Math.max(0, overlay.gapPx)}px`,
  flexDirection: "column",
});

export const normalizeHexColor = (value: string, fallback: string): string =>
  /^#[\da-f]{6}$/i.test(value) ? value : fallback;
