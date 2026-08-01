import { useEffect, useRef } from "react";
import { bytesToBase64 } from "../core/audio";
import { bridge } from "../core/bridge";
import type { AppConfig, CaptionPayload, CaptionTextStyle } from "../core/types";
import { captionItems } from "./captions";

const hexToRgba = (value: string, alpha: number): string => {
  const match = /^#([\da-f]{6})$/i.exec(value);
  if (!match) {
    return `rgba(255, 255, 255, ${alpha})`;
  }
  const hex = match[1] ?? "ffffff";
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
};

const finiteNumber = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

const boundedNumber = (value: number, minimum: number, maximum: number, fallback: number): number =>
  Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));

const drawRoundedRect = (
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  radius: number,
) => {
  const safeRadius = Math.min(Math.max(0, radius), width / 2, height / 2);
  context.beginPath();
  context.moveTo(left + safeRadius, top);
  context.lineTo(left + width - safeRadius, top);
  context.quadraticCurveTo(left + width, top, left + width, top + safeRadius);
  context.lineTo(left + width, top + height - safeRadius);
  context.quadraticCurveTo(left + width, top + height, left + width - safeRadius, top + height);
  context.lineTo(left + safeRadius, top + height);
  context.quadraticCurveTo(left, top + height, left, top + height - safeRadius);
  context.lineTo(left, top + safeRadius);
  context.quadraticCurveTo(left, top, left + safeRadius, top);
  context.closePath();
};

/**
 * Measure canvas text using the same letter-spacing approximation as the DOM
 * caption renderer. Canvas does not implement CSS `letter-spacing` for
 * `fillText`, so native output advances one grapheme at a time below.
 */
const measureNativeTextWidth = (
  context: CanvasRenderingContext2D,
  text: string,
  letterSpacing: number,
): number => {
  const characters = Array.from(text);
  if (characters.length === 0) {
    return 0;
  }
  return Math.max(
    0,
    context.measureText(text).width +
      Math.max(0, characters.length - 1) * finiteNumber(letterSpacing, 0),
  );
};

/**
 * Wrap native caption text without dropping any characters.
 *
 * A previous implementation measured the whole caption and scaled it down to
 * `maxWidth`, making a long Japanese/English sentence unreadably tiny. This
 * greedy wrapper keeps every grapheme, prefers whitespace boundaries for Latin
 * text, and falls back to grapheme boundaries for Japanese or unbroken tokens.
 * Explicit newlines are retained as line breaks. The measurement callback is
 * injected so this algorithm can be covered without a real browser canvas.
 */
export const wrapNativeText = (
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
  letterSpacing = 0,
): string[] => {
  const boundedWidth = Math.max(1, finiteNumber(maxWidth, 1));
  const spacing = finiteNumber(letterSpacing, 0);
  const widthOf = (value: string): number => {
    const characters = Array.from(value);
    if (characters.length === 0) {
      return 0;
    }
    return Math.max(
      0,
      finiteNumber(measure(value), 0) + Math.max(0, characters.length - 1) * spacing,
    );
  };
  const isBreakable = (value: string): boolean => /\s/u.test(value);
  const lines: string[] = [];
  let current: string[] = [];
  // Treat CRLF/CR as the same logical line break as the DOM caption path.
  const normalizedText = text.replace(/\r\n?/gu, "\n");

  const flush = (): void => {
    lines.push(current.join(""));
    current = [];
  };

  for (const character of Array.from(normalizedText)) {
    if (character === "\n") {
      flush();
      continue;
    }
    const candidate = [...current, character];
    if (current.length === 0 || widthOf(candidate.join("")) <= boundedWidth) {
      current = candidate;
      continue;
    }

    // Keep the whitespace on the preceding line so joining wrapped lines
    // reconstructs the original caption exactly (including spaces).
    let breakIndex = -1;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      if (isBreakable(current[index] ?? "")) {
        breakIndex = index;
        break;
      }
    }
    if (breakIndex >= 0) {
      lines.push(current.slice(0, breakIndex + 1).join(""));
      current = [...current.slice(breakIndex + 1), character];
    } else {
      lines.push(current.join(""));
      current = [character];
    }
  }
  // Always flush the final logical line. This keeps leading/trailing and
  // repeated explicit newlines representable as empty line entries.
  flush();
  return lines;
};

interface NativeCaptionLayout {
  lineHeight: number;
  lines: string[];
  maxLineWidth: number;
}

const captionFont = (style: CaptionTextStyle): string =>
  `${Math.round(boundedNumber(style.fontWeight, 100, 900, 700))} ${Math.max(1, finiteNumber(style.fontSizePx, 34))}px ${style.fontFamily}`;

const measureNativeCaption = (
  context: CanvasRenderingContext2D,
  text: string,
  style: CaptionTextStyle,
  maxWidth: number,
): NativeCaptionLayout => {
  const letterSpacing = finiteNumber(style.letterSpacingPx, 0);
  context.font = captionFont(style);
  const lines = wrapNativeText(
    text,
    maxWidth,
    (value) => context.measureText(value).width,
    letterSpacing,
  );
  const maxLineWidth = lines.reduce(
    (maximum, line) => Math.max(maximum, measureNativeTextWidth(context, line, letterSpacing)),
    0,
  );
  return {
    lineHeight: Math.max(
      1,
      finiteNumber(style.fontSizePx, 34) * Math.max(0.1, finiteNumber(style.lineHeight, 1.3)),
    ),
    lines,
    maxLineWidth,
  };
};

const drawNativeCaption = (
  context: CanvasRenderingContext2D,
  text: string,
  style: CaptionTextStyle,
  x: number,
  y: number,
  maxWidth: number,
) => {
  const layout = measureNativeCaption(context, text, style, maxWidth);
  const letterSpacing = finiteNumber(style.letterSpacingPx, 0);
  context.textBaseline = "middle";
  context.lineJoin = "round";

  const drawLine = (textLine: string, lineY: number, operation: "fill" | "stroke"): void => {
    const characters = Array.from(textLine);
    const characterWidths = characters.map((character) => context.measureText(character).width);
    const rawWidth = measureNativeTextWidth(context, textLine, letterSpacing);
    // A single glyph can still exceed a very narrow configured width. Scale
    // only that individual line; never scale a whole multi-line caption.
    const scale =
      characters.length === 1 && rawWidth > maxWidth && maxWidth > 0 ? maxWidth / rawWidth : 1;
    const drawWidth = rawWidth * scale;
    const startX =
      style.textAlign === "left"
        ? x
        : style.textAlign === "right"
          ? x - drawWidth
          : x - drawWidth / 2;
    let cursor = startX;
    for (const [index, character] of characters.entries()) {
      if (operation === "stroke") {
        context.strokeText(character, cursor, lineY);
      } else {
        context.fillText(character, cursor, lineY);
      }
      cursor += ((characterWidths[index] ?? 0) + letterSpacing) * scale;
    }
  };

  context.save();
  context.globalAlpha = boundedNumber(style.opacity, 0, 1, 1);
  if (style.shadowEnabled) {
    context.shadowColor = style.shadowColor;
    context.shadowBlur = Math.max(0, finiteNumber(style.shadowBlurPx, 0));
    context.shadowOffsetX = finiteNumber(style.shadowOffsetX, 0);
    context.shadowOffsetY = finiteNumber(style.shadowOffsetY, 0);
  }
  const cullingWidth = Math.max(0, finiteNumber(style.cullingWidthPx, 0));
  if (style.cullingEnabled && cullingWidth > 0) {
    context.lineWidth = cullingWidth * 2;
    context.strokeStyle = hexToRgba(
      style.cullingColor,
      boundedNumber(style.cullingOpacity, 0, 1, 1),
    );
    for (const [index, line] of layout.lines.entries()) {
      drawLine(
        line,
        y - ((layout.lines.length - 1) * layout.lineHeight) / 2 + index * layout.lineHeight,
        "stroke",
      );
    }
  }
  context.fillStyle = style.color;
  for (const [index, line] of layout.lines.entries()) {
    drawLine(
      line,
      y - ((layout.lines.length - 1) * layout.lineHeight) / 2 + index * layout.lineHeight,
      "fill",
    );
  }
  context.restore();
};

export const renderNativeFrame = (
  canvas: HTMLCanvasElement,
  config: AppConfig,
  caption: CaptionPayload,
): { height: number; pixels: Uint8Array; width: number } | null => {
  const width = Math.max(1, Math.round(finiteNumber(config.overlay.width, 1_280)));
  const height = Math.max(1, Math.round(finiteNumber(config.overlay.height, 720)));
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  // Caller may already size the canvas; only resize when dimensions change.
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.clearRect(0, 0, width, height);

  const blockWidth = Math.max(
    1,
    width - Math.max(0, finiteNumber(config.overlay.safeAreaPx, 42)) * 2,
  );
  const blockX = (width * boundedNumber(config.overlay.captionXPercent, 0, 100, 50)) / 100;
  const blockY = (height * boundedNumber(config.overlay.captionYPercent, 0, 100, 86)) / 100;
  const rows = captionItems(config, caption)
    .filter((item) => item.text.trim().length > 0)
    .map((item) => {
      const style = item.style;
      const paddingX = Math.max(0, finiteNumber(style.paddingX, 0));
      const lineWidth = Math.min(
        blockWidth * (boundedNumber(style.maxWidthPercent, 1, 100, 86) / 100),
        Math.max(1, blockWidth - paddingX * 2),
      );
      const layout = measureNativeCaption(context, item.text, style, lineWidth);
      return {
        layout,
        lineWidth,
        style,
        height: Math.max(
          1,
          layout.lineHeight * layout.lines.length +
            Math.max(0, finiteNumber(style.paddingY, 0)) * 2,
        ),
      };
    });
  const gap = Math.max(0, finiteNumber(config.overlay.gapPx, 8));
  const totalHeight =
    rows.reduce((total, row) => total + row.height, 0) + gap * Math.max(0, rows.length - 1);
  let rowY = blockY - totalHeight / 2;

  for (const row of rows) {
    const style = row.style;
    const paddingX = Math.max(0, finiteNumber(style.paddingX, 0));
    const textX =
      style.textAlign === "left"
        ? (width - blockWidth) / 2 + paddingX
        : style.textAlign === "right"
          ? (width + blockWidth) / 2 - paddingX
          : blockX;
    const textWidth = Math.min(row.lineWidth, row.layout.maxLineWidth);
    const plateWidth = Math.min(blockWidth, textWidth + paddingX * 2);
    const plateLeft =
      style.textAlign === "left"
        ? textX - paddingX
        : style.textAlign === "right"
          ? textX - plateWidth + paddingX
          : textX - plateWidth / 2;

    if (style.backgroundEnabled) {
      context.save();
      context.fillStyle = hexToRgba(
        style.backgroundColor,
        boundedNumber(style.backgroundOpacity, 0, 1, 1),
      );
      drawRoundedRect(
        context,
        plateLeft,
        rowY,
        plateWidth,
        row.height,
        Math.max(0, finiteNumber(style.borderRadius, 0)),
      );
      context.fill();
      context.restore();
    }
    const textY = rowY + row.height / 2;
    drawNativeCaption(context, row.layout.lines.join("\n"), style, textX, textY, row.lineWidth);
    rowY += row.height + gap;
  }

  return {
    height,
    pixels: new Uint8Array(context.getImageData(0, 0, width, height).data),
    width,
  };
};

/** Cache fonts.ready so caption updates do not re-await every paint. */
let fontsReady: Promise<void> | null = null;
const ensureFontsReady = (): Promise<void> => {
  if (typeof document === "undefined" || !document.fonts?.ready) {
    return Promise.resolve();
  }
  if (!fontsReady) {
    fontsReady = document.fonts.ready.then(
      () => undefined,
      () => undefined,
    );
  }
  return fontsReady;
};

/** Stable key for display-relevant native frame inputs (skip identical republish). */
const framePaintKey = (config: AppConfig, caption: CaptionPayload): string =>
  [
    caption.id,
    caption.sourceText,
    caption.translationText,
    caption.stage ?? "",
    config.overlay.width,
    config.overlay.height,
    config.overlay.order,
    config.overlay.gapPx,
    config.overlay.safeAreaPx,
    config.overlay.captionXPercent,
    config.overlay.captionYPercent,
    JSON.stringify(config.overlay.source),
    JSON.stringify(config.overlay.translation),
  ].join("\u0001");

export const NativeFramePublisher = ({
  config,
  caption,
}: {
  config: AppConfig;
  caption: CaptionPayload;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastPaintKeyRef = useRef<string>("");
  const lastSizeRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    if (!bridge.isDesktop()) {
      return;
    }
    const paintKey = framePaintKey(config, caption);
    if (paintKey === lastPaintKeyRef.current) {
      return;
    }

    let cancelled = false;
    let raf = 0;
    const schedule = (): void => {
      // Coalesce burst progressive updates (ASR → normalize → translate) into one frame.
      raf = requestAnimationFrame(() => {
        void ensureFontsReady().then(() => {
          const canvas = canvasRef.current;
          if (!canvas || cancelled) {
            return;
          }
          // Re-check after rAF: a newer effect may have cancelled this paint.
          if (cancelled) {
            return;
          }
          const nextKey = framePaintKey(config, caption);
          if (nextKey === lastPaintKeyRef.current) {
            return;
          }
          const width = Math.max(1, Math.round(config.overlay.width));
          const height = Math.max(1, Math.round(config.overlay.height));
          // Avoid resetting the bitmap when only text changes (cheaper clearRect path).
          if (lastSizeRef.current.width !== width || lastSizeRef.current.height !== height) {
            canvas.width = width;
            canvas.height = height;
            lastSizeRef.current = { width, height };
          }
          const frame = renderNativeFrame(canvas, config, caption);
          if (!frame || cancelled) {
            return;
          }
          lastPaintKeyRef.current = nextKey;
          void bridge
            .publishOverlayFrame(bytesToBase64(frame.pixels), frame.width, frame.height)
            .catch(() => undefined);
        });
      });
    };
    schedule();
    return () => {
      cancelled = true;
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, [caption, config]);

  return <canvas ref={canvasRef} className="native-output-canvas" />;
};
