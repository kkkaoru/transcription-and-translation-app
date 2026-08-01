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

const drawNativeCaption = (
  context: CanvasRenderingContext2D,
  text: string,
  style: CaptionTextStyle,
  x: number,
  y: number,
  maxWidth: number,
) => {
  const fontSize = Math.max(1, finiteNumber(style.fontSizePx, 34));
  const letterSpacing = finiteNumber(style.letterSpacingPx, 0);
  const characters = Array.from(text);
  context.font = `${Math.round(boundedNumber(style.fontWeight, 100, 900, 700))} ${fontSize}px ${style.fontFamily}`;
  context.textBaseline = "middle";
  context.lineJoin = "round";
  const characterWidths = characters.map((character) => context.measureText(character).width);
  const rawWidth =
    characterWidths.reduce((total, characterWidth) => total + characterWidth, 0) +
    Math.max(0, characters.length - 1) * letterSpacing;
  const scale = rawWidth > maxWidth && maxWidth > 0 ? maxWidth / rawWidth : 1;
  const drawWidth = rawWidth * scale;
  const startX =
    style.textAlign === "left"
      ? x
      : style.textAlign === "right"
        ? x - drawWidth
        : x - drawWidth / 2;

  const drawCharacters = (operation: "fill" | "stroke") => {
    let cursor = startX;
    for (const [index, character] of characters.entries()) {
      if (operation === "stroke") {
        context.strokeText(character, cursor, y);
      } else {
        context.fillText(character, cursor, y);
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
    drawCharacters("stroke");
  }
  context.fillStyle = style.color;
  drawCharacters("fill");
  context.restore();
};

const renderFrame = (
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
  const rows = captionItems(config, caption).map(({ text, style }) => ({
    text,
    style,
    height: Math.max(
      1,
      finiteNumber(style.fontSizePx, 34) * finiteNumber(style.lineHeight, 1.3) +
        Math.max(0, finiteNumber(style.paddingY, 0)) * 2,
    ),
  }));
  const gap = Math.max(0, finiteNumber(config.overlay.gapPx, 8));
  const totalHeight =
    rows.reduce((total, row) => total + row.height, 0) + gap * Math.max(0, rows.length - 1);
  let rowY = blockY - totalHeight / 2;

  for (const row of rows) {
    const style = row.style;
    const lineWidth = Math.min(
      blockWidth * (boundedNumber(style.maxWidthPercent, 1, 100, 86) / 100),
      blockWidth,
    );
    const paddingX = Math.max(0, finiteNumber(style.paddingX, 0));
    const textX =
      style.textAlign === "left"
        ? (width - blockWidth) / 2 + paddingX
        : style.textAlign === "right"
          ? (width + blockWidth) / 2 - paddingX
          : blockX;
    const textY = rowY + row.height / 2;
    context.font = `${Math.round(boundedNumber(style.fontWeight, 100, 900, 700))} ${Math.max(1, finiteNumber(style.fontSizePx, 34))}px ${style.fontFamily}`;
    const textWidth = Math.min(lineWidth, context.measureText(row.text).width);
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
    drawNativeCaption(context, row.text, style, textX, textY, lineWidth);
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
    config.overlay.source.fontSizePx,
    config.overlay.source.color,
    config.overlay.translation.fontSizePx,
    config.overlay.translation.color,
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
          const frame = renderFrame(canvas, config, caption);
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
