import type { CSSProperties } from "react";
import { appendStructuredLog } from "./structuredLog";
import type { CaptionTextStyle, OverlayConfig } from "./types";

export interface CaptionOverflowMeasurement {
  contentWidth: number;
  containerWidth: number;
  overflowed: boolean;
  lineCount: number;
}

const CAPTION_OVERFLOW_LINE_SELECTOR = ".caption-line";

export const measureCaptionOverflow = (input: {
  contentWidth: number;
  containerWidth: number;
  lineCount: number;
}): CaptionOverflowMeasurement => {
  const contentWidth = Math.max(0, Math.round(input.contentWidth));
  const containerWidth = Math.max(0, Math.round(input.containerWidth));
  const lineCount = Math.max(0, Math.round(input.lineCount));
  return {
    contentWidth,
    containerWidth,
    overflowed: contentWidth > containerWidth,
    lineCount,
  };
};

export const isMeasurableCaptionOverflow = (measurement: CaptionOverflowMeasurement): boolean =>
  measurement.contentWidth > 0 || measurement.containerWidth > 0;

export const shouldLogCaptionOverflow = (
  previousOverflowed: boolean | null,
  next: CaptionOverflowMeasurement,
): boolean => {
  if (!isMeasurableCaptionOverflow(next)) {
    return false;
  }
  return previousOverflowed !== next.overflowed;
};

const overflowAmount = (measurement: CaptionOverflowMeasurement): number =>
  measurement.contentWidth - measurement.containerWidth;

const pickCaptionOverflow = (
  current: CaptionOverflowMeasurement | null,
  candidate: CaptionOverflowMeasurement,
): CaptionOverflowMeasurement => {
  if (current == null) {
    return candidate;
  }
  if (candidate.overflowed !== current.overflowed) {
    return candidate.overflowed ? candidate : current;
  }
  return overflowAmount(candidate) > overflowAmount(current) ? candidate : current;
};

const captionLineCount = (node: HTMLElement): number => {
  const declared = node.querySelectorAll(":scope > span").length;
  if (declared > 0) {
    return declared;
  }
  return node.textContent?.trim() ? 1 : 0;
};

export const readCaptionOverflow = (container: {
  clientWidth: number;
  querySelectorAll: (selector: string) => Iterable<Element>;
}): CaptionOverflowMeasurement => {
  const fallbackWidth = Math.max(0, Math.round(container.clientWidth));
  let selected: CaptionOverflowMeasurement | null = null;
  for (const node of container.querySelectorAll(CAPTION_OVERFLOW_LINE_SELECTOR)) {
    if (!(node instanceof HTMLElement) || node.dataset["empty"] === "true") {
      continue;
    }
    const lineBox = Math.max(0, Math.round(node.clientWidth));
    selected = pickCaptionOverflow(
      selected,
      measureCaptionOverflow({
        contentWidth: node.scrollWidth,
        containerWidth: lineBox > 0 ? lineBox : fallbackWidth,
        lineCount: captionLineCount(node),
      }),
    );
  }
  return (
    selected ??
    measureCaptionOverflow({ contentWidth: 0, containerWidth: fallbackWidth, lineCount: 0 })
  );
};

export const logCaptionOverflow = (
  measurement: CaptionOverflowMeasurement,
  nowMs: number = Date.now(),
): void => {
  appendStructuredLog({
    level: "info",
    source: "frontend",
    stage: "display",
    message: `caption overflow content_width=${measurement.contentWidth} container_width=${measurement.containerWidth} overflowed=${measurement.overflowed} line_count=${measurement.lineCount}`,
    epochMs: nowMs,
    fields: {
      contentWidth: measurement.contentWidth,
      containerWidth: measurement.containerWidth,
      overflowed: measurement.overflowed,
      lineCount: measurement.lineCount,
    },
  });
};

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
    // Keep horizontal padding inside maxWidth so DOM captions use the same
    // available line width as the native canvas renderer.
    boxSizing: "border-box",
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

export const overlayCaptionCss = (overlay: OverlayConfig): CSSProperties => {
  const safe = Math.max(0, overlay.safeAreaPx);
  const x = clampNumber(overlay.captionXPercent, 0, 100);
  const y = clampNumber(overlay.captionYPercent, 0, 100);
  return {
    position: "absolute",
    left: `${x}%`,
    top: `${y}%`,
    width: `calc(100% - ${safe * 2}px)`,
    maxWidth: `calc(100% - ${safe * 2}px)`,
    transform: "translate(-50%, -100%)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: `${Math.max(10, overlay.gapPx)}px`,
    boxSizing: "border-box",
    overflow: "visible",
    pointerEvents: "none",
  };
};

export const normalizeHexColor = (value: string, fallback: string): string =>
  /^#[\da-f]{6}$/i.test(value) ? value : fallback;

/**
 * Fit an overlay canvas into a smaller in-app preview stage without OBS.
 * Returns 1 when the stage size is unknown so callers can fall back to fill layout.
 * Scale is clamped to (0, 1] so the preview never enlarges past the designed overlay size.
 */
export const computePreviewFitScale = (
  stageWidth: number,
  stageHeight: number,
  overlayWidth: number,
  overlayHeight: number,
): number => {
  const stageW = Number.isFinite(stageWidth) ? stageWidth : 0;
  const stageH = Number.isFinite(stageHeight) ? stageHeight : 0;
  const overlayW = Math.max(1, Number.isFinite(overlayWidth) ? overlayWidth : 1);
  const overlayH = Math.max(1, Number.isFinite(overlayHeight) ? overlayHeight : 1);
  if (stageW <= 1 || stageH <= 1) {
    return 1;
  }
  const fit = Math.min(stageW / overlayW, stageH / overlayH);
  if (!Number.isFinite(fit) || fit <= 0) {
    return 1;
  }
  // Keep a tiny lower bound so extremely small stages still paint something visible.
  return Math.min(1, Math.max(0.05, fit));
};
