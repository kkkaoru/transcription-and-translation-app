import { useEffect, useRef } from "react";
import { bytesToBase64 } from "../core/audio";
import { bridge, formatBridgeError } from "../core/bridge";
import { markCaptionVisible } from "../core/caption-latency";
import { appendStructuredLog } from "../core/structuredLog";
import type { AppConfig, CaptionPayload, CaptionTextStyle } from "../core/types";
import { captionGraphemes, captionItems, captionTextLines } from "./captions";

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

/**
 * WKWebView/Tauri must get an explicit alpha-capable context. Omitting
 * `{ alpha: true }` has left some webviews with an opaque backing store, so
 * `clearRect` produced solid black (0,0,0,255) and Syphon/Spout clients showed
 * a black plate instead of text-on-transparent.
 */
export const NATIVE_FRAME_CONTEXT_OPTIONS: CanvasRenderingContext2DSettings = {
  alpha: true,
  willReadFrequently: true,
};

/** Acquire the 2D context used for native Syphon/Spout caption frames. */
export const acquireNativeFrameContext = (
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null => canvas.getContext("2d", NATIVE_FRAME_CONTEXT_OPTIONS);

/**
 * Force every pixel to straight transparent black.
 *
 * `clearRect` alone is not enough on an accidentally-opaque canvas. The `copy`
 * composite writes `rgba(0,0,0,0)` into the buffer regardless of prior contents
 * when the context actually supports alpha.
 */
export const clearNativeFrameToTransparent = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void => {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "copy";
  context.fillStyle = "rgba(0, 0, 0, 0)";
  context.fillRect(0, 0, width, height);
  context.restore();
};

/**
 * Convert canvas straight-alpha RGBA into premultiplied RGBA for GPU clients.
 *
 * Syphon, Spout2, and OBS composite video textures as premultiplied. Leaving
 * straight alpha makes transparent regions read as opaque black (RGB=0,A=255
 * after an opaque clear, or non-zero RGB with A=0 that some clients ignore).
 * Zero-alpha pixels are forced to RGB 0 so the plate stays fully transparent.
 */
export const premultiplyStraightRgba = (pixels: Uint8ClampedArray | Uint8Array): Uint8Array => {
  const data = new Uint8Array(pixels);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    if (alpha === 0) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      continue;
    }
    if (alpha === 255) {
      continue;
    }
    data[index] = Math.round(((data[index] ?? 0) * alpha) / 255);
    data[index + 1] = Math.round(((data[index + 1] ?? 0) * alpha) / 255);
    data[index + 2] = Math.round(((data[index + 2] ?? 0) * alpha) / 255);
  }
  return data;
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
  const characters = captionGraphemes(text);
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
    const characters = captionGraphemes(value);
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

  for (const character of captionGraphemes(normalizedText)) {
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

/**
 * Layout already-segmented caption lines without a second pixel wrap.
 *
 * {@link captionTextLines} already clamps to CAPTION_MAX_VISIBLE_LINES and
 * maxChars; re-wrapping by canvas width duplicated the DOM bug where each
 * logical line lost ~1 glyph and grew into 3–4 visual rows.
 */
export const measurePrewrappedNativeCaption = (
  context: CanvasRenderingContext2D,
  lines: string[],
  style: CaptionTextStyle,
): NativeCaptionLayout => {
  const letterSpacing = finiteNumber(style.letterSpacingPx, 0);
  context.font = captionFont(style);
  const safeLines = lines.length > 0 ? lines : [""];
  const maxLineWidth = safeLines.reduce(
    (maximum, line) => Math.max(maximum, measureNativeTextWidth(context, line, letterSpacing)),
    0,
  );
  return {
    lineHeight: Math.max(
      1,
      finiteNumber(style.fontSizePx, 34) * Math.max(0.1, finiteNumber(style.lineHeight, 1.3)),
    ),
    lines: safeLines,
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
    const characters = captionGraphemes(textLine);
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
  // Caller may already size the canvas; only resize when dimensions change.
  // Resize before acquiring the context so the first getContext sees the final
  // buffer size, and always pass alpha:true (see NATIVE_FRAME_CONTEXT_OPTIONS).
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = acquireNativeFrameContext(canvas);
  if (!context) {
    return null;
  }
  clearNativeFrameToTransparent(context, width, height);

  const blockWidth = Math.max(
    1,
    width - Math.max(0, finiteNumber(config.overlay.safeAreaPx, 42)) * 2,
  );
  const blockX = (width * boundedNumber(config.overlay.captionXPercent, 0, 100, 50)) / 100;
  const blockY = (height * boundedNumber(config.overlay.captionYPercent, 0, 100, 88)) / 100;
  const rows = captionItems(config, caption).map((item) => {
    const style = item.style;
    const paddingX = Math.max(0, finiteNumber(style.paddingX, 0));
    const lineWidth = Math.min(
      blockWidth * (boundedNumber(style.maxWidthPercent, 1, 100, 86) / 100),
      Math.max(1, blockWidth - paddingX * 2),
    );
    const hasText = item.text.trim().length > 0;
    // Always reserve both source and translation row heights so the native
    // plate does not jump when translation arrives or clears.
    const layout = measurePrewrappedNativeCaption(
      context,
      hasText ? captionTextLines(item) : [""],
      style,
    );
    return {
      layout,
      lineWidth,
      style,
      hasText,
      height: Math.max(
        1,
        layout.lineHeight * Math.max(1, layout.lines.length) +
          Math.max(0, finiteNumber(style.paddingY, 0)) * 2,
      ),
    };
  });
  // DOM overlay and OBS page both render `gap: max(10, gapPx)`; keep the
  // native/Syphon output spacing-identical, including the sub-10px clamp.
  const gap = Math.max(10, finiteNumber(config.overlay.gapPx, 14));
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
    const textWidth = Math.min(row.lineWidth, Math.max(row.layout.maxLineWidth, 1));
    const plateWidth = Math.min(blockWidth, textWidth + paddingX * 2);
    const plateLeft =
      style.textAlign === "left"
        ? textX - paddingX
        : style.textAlign === "right"
          ? textX - plateWidth + paddingX
          : textX - plateWidth / 2;

    if (row.hasText && style.backgroundEnabled) {
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
    if (row.hasText) {
      const textY = rowY + row.height / 2;
      // Pass a non-binding width so drawNativeCaption does not soft-wrap again;
      // layout.lines are already budget-segmented and capped to two rows.
      drawNativeCaption(
        context,
        row.layout.lines.join("\n"),
        style,
        textX,
        textY,
        Math.max(row.lineWidth, row.layout.maxLineWidth, 1),
      );
    }
    rowY += row.height + gap;
  }

  return {
    height,
    pixels: premultiplyStraightRgba(context.getImageData(0, 0, width, height).data),
    width,
  };
};

/** Cache fonts.ready so caption updates do not re-await every paint. */
let fontsReady: Promise<void> | null = null;

/**
 * Wait for webfonts, but never block native Syphon/Spout publishing forever.
 *
 * Off-screen / occluded WKWebViews have been observed to leave
 * `document.fonts.ready` pending indefinitely. Without a deadline the native
 * publisher never calls `publishOverlayFrame`, so Syphon clients only ever see
 * the initial transparent plate.
 */
export const NATIVE_FONTS_READY_TIMEOUT_MS = 500;

/**
 * Off-screen WKWebView often never runs `requestAnimationFrame`. Fall back in
 * one display frame so Syphon/Spout still receive frames when rAF is throttled.
 * Matches the canvas-not-ready retry; the paint path is unchanged.
 */
export const NATIVE_RAF_FALLBACK_MS = 16;

const GENERIC_FONT_FALLBACK =
  /,\s*(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded)(?:\s*,\s*(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded))*\s*$/iu;

/**
 * Drop generic CSS families so `document.fonts.check` cannot succeed on
 * `sans-serif` alone and skip waiting for the real caption face.
 */
export const fontCssForReadinessCheck = (fontCss: string): string =>
  fontCss.replace(GENERIC_FONT_FALLBACK, "").trim();

export const overlayCaptionFontCss = (config: AppConfig): string[] => [
  captionFont(config.overlay.source),
  captionFont(config.overlay.translation),
];

/** True when canvas can already measure/paint with this caption `font` value. */
export const captionFontCssIsReady = (fontCss: string): boolean => {
  if (typeof document === "undefined" || !document.fonts) {
    return true;
  }
  if (document.fonts.status === "loaded") {
    return true;
  }
  const check = document.fonts.check;
  if (typeof check !== "function") {
    return false;
  }
  const candidate = fontCssForReadinessCheck(fontCss);
  if (!candidate) {
    return false;
  }
  try {
    return check.call(document.fonts, candidate);
  } catch {
    return false;
  }
};

/** Clear the fonts.ready cache between tests so suites cannot leak waiters. */
export const __resetNativeFontsReadyForTests = (): void => {
  fontsReady = null;
};

export const ensureFontsReady = (fontCssList: readonly string[] = []): Promise<void> => {
  if (typeof document === "undefined" || !document.fonts?.ready) {
    return Promise.resolve();
  }
  if (document.fonts.status === "loaded") {
    return Promise.resolve();
  }
  if (fontCssList.length > 0 && fontCssList.every((css) => captionFontCssIsReady(css))) {
    return Promise.resolve();
  }
  if (!fontsReady) {
    fontsReady = Promise.race([
      document.fonts.ready.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        setTimeout(resolve, NATIVE_FONTS_READY_TIMEOUT_MS);
      }),
    ]);
  }
  return fontsReady;
};

/** Stable key for display-relevant native frame inputs (skip identical republish). */
export const framePaintKey = (config: AppConfig, caption: CaptionPayload): string =>
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
    // The per-line character budget directly changes the painted line split,
    // so a budget-only config change must invalidate the previous frame key
    // and trigger a native repaint. `captionMaxChars` is optional for legacy
    // configs; JSON.stringify yields a stable distinct value either way.
    JSON.stringify(config.overlay.captionMaxChars),
  ].join("\u0001");

/** Max automatic retries for the same paint key after a rejected invoke. */
export const NATIVE_PUBLISH_MAX_FAILURES = 3;

/**
 * Pure publish gate for native overlay frames.
 *
 * Guarantees:
 * - `lastSuccessfulKey` advances only after a successful publish
 * - a rejected publish does not permanently suppress that key
 * - while one invoke is in flight, newer keys queue as latest-wins pending
 * - a success for a stale in-flight key never overwrites a newer success path
 * - retries are bounded per key so a permanently dead native worker cannot spin
 */
export type NativePublishGate = {
  lastSuccessfulKey: string;
  inFlightKey: string | null;
  pendingKey: string | null;
  failureCount: number;
  failureKey: string | null;
};

export const createNativePublishGate = (): NativePublishGate => ({
  lastSuccessfulKey: "",
  inFlightKey: null,
  pendingKey: null,
  failureCount: 0,
  failureKey: null,
});

export type NativePublishStart =
  | { action: "skip" }
  | { action: "defer"; pendingKey: string }
  | { action: "publish"; key: string }
  | { action: "exhausted"; key: string };

/** Decide whether to start a publish for `nextKey`. Mutates the gate when publishing or deferring. */
export const beginNativePublish = (
  gate: NativePublishGate,
  nextKey: string,
): NativePublishStart => {
  if (gate.inFlightKey !== null) {
    // Latest-wins while a previous invoke is outstanding. This check must come
    // before the last-success comparison: the current props can legitimately
    // revert to a frame that was already successful while a newer frame is
    // still in flight. Keep that reverted frame pending so the newer success
    // cannot leave OBS showing stale output.
    gate.pendingKey = nextKey;
    return { action: "defer", pendingKey: nextKey };
  }
  if (nextKey === gate.lastSuccessfulKey) {
    gate.pendingKey = null;
    return { action: "skip" };
  }
  if (gate.failureKey === nextKey && gate.failureCount >= NATIVE_PUBLISH_MAX_FAILURES) {
    return { action: "exhausted", key: nextKey };
  }
  gate.inFlightKey = nextKey;
  gate.pendingKey = null;
  return { action: "publish", key: nextKey };
};

/** Record a successful publish. Returns the next key that should be published, if any. */
export const completeNativePublishSuccess = (
  gate: NativePublishGate,
  publishedKey: string,
): string | null => {
  if (gate.inFlightKey === publishedKey) {
    gate.inFlightKey = null;
  }
  // A stale success must not rewind past a newer key already in flight/pending.
  if (gate.inFlightKey !== null && gate.inFlightKey !== publishedKey) {
    return null;
  }
  if (gate.pendingKey !== null && gate.pendingKey !== publishedKey) {
    gate.lastSuccessfulKey = publishedKey;
    if (gate.failureKey === publishedKey) {
      gate.failureCount = 0;
      gate.failureKey = null;
    }
    const next = gate.pendingKey;
    gate.pendingKey = null;
    return next !== gate.lastSuccessfulKey ? next : null;
  }
  gate.lastSuccessfulKey = publishedKey;
  if (gate.failureKey === publishedKey) {
    gate.failureCount = 0;
    gate.failureKey = null;
  }
  const next = gate.pendingKey;
  gate.pendingKey = null;
  return next && next !== gate.lastSuccessfulKey ? next : null;
};

/**
 * Record a rejected publish without advancing `lastSuccessfulKey`.
 * Returns the latest key to retry, or null when retries are exhausted / cancelled.
 */
export const completeNativePublishFailure = (
  gate: NativePublishGate,
  publishedKey: string,
): { nextKey: string | null; exhausted: boolean } => {
  if (gate.inFlightKey === publishedKey) {
    gate.inFlightKey = null;
  }
  const nextKey = gate.pendingKey ?? publishedKey;
  gate.pendingKey = null;
  if (nextKey === gate.lastSuccessfulKey) {
    return { nextKey: null, exhausted: false };
  }
  if (nextKey !== publishedKey) {
    // A newer caption arrived during the failed invoke — retry that key with a
    // fresh failure budget instead of the stale failed frame.
    gate.failureKey = null;
    gate.failureCount = 0;
    return { nextKey, exhausted: false };
  }
  if (gate.failureKey === publishedKey) {
    gate.failureCount += 1;
  } else {
    gate.failureKey = publishedKey;
    gate.failureCount = 1;
  }
  if (gate.failureCount >= NATIVE_PUBLISH_MAX_FAILURES) {
    return { nextKey: null, exhausted: true };
  }
  return { nextKey: publishedKey, exhausted: false };
};

export const NativeFramePublisher = ({
  config,
  caption,
}: {
  config: AppConfig;
  caption: CaptionPayload;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastSizeRef = useRef({ width: 0, height: 0 });
  const gateRef = useRef<NativePublishGate>(createNativePublishGate());
  // Always-latest props so an in-flight retry can paint the current caption
  // without republishing a stale frame that lost a race to a newer effect.
  const latestRef = useRef({ config, caption });
  latestRef.current = { config, caption };

  useEffect(() => {
    if (!bridge.isDesktop()) {
      return;
    }
    // Capture the prop revision that triggered this effect. Inner schedule()
    // still reads latestRef so a queued retry never paints a stale caption.
    latestRef.current = { config, caption };

    let cancelled = false;
    let raf = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let rafFallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const clearRetry = (): void => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    const clearRafFallback = (): void => {
      if (rafFallbackTimer !== undefined) {
        clearTimeout(rafFallbackTimer);
        rafFallbackTimer = undefined;
      }
    };

    const scheduleRetry = (delayMs: number): void => {
      clearRetry();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (!cancelled) {
          schedule();
        }
      }, delayMs);
    };

    const paint = (): void => {
      void ensureFontsReady(overlayCaptionFontCss(latestRef.current.config)).then(() => {
        if (cancelled) {
          return;
        }
        const { config: currentConfig, caption: currentCaption } = latestRef.current;
        const nextKey = framePaintKey(currentConfig, currentCaption);
        const decision = beginNativePublish(gateRef.current, nextKey);
        if (decision.action === "exhausted") {
          appendStructuredLog({
            level: "error",
            source: "frontend",
            stage: "native-output",
            message:
              "native overlay publish suppressed after repeated failures; OBS may show a frozen frame",
            chunkId: currentCaption.id,
            fields: {
              failureCount: gateRef.current.failureCount,
            },
          });
          return;
        }
        if (decision.action !== "publish") {
          return;
        }

        const canvas = canvasRef.current;
        if (!canvas) {
          // Canvas not mounted yet; release the in-flight claim and retry shortly.
          gateRef.current.inFlightKey = null;
          scheduleRetry(16);
          return;
        }

        const width = Math.max(1, Math.round(currentConfig.overlay.width));
        const height = Math.max(1, Math.round(currentConfig.overlay.height));
        // Avoid resetting the bitmap when only text changes (transparent clear
        // still runs inside renderNativeFrame).
        if (lastSizeRef.current.width !== width || lastSizeRef.current.height !== height) {
          canvas.width = width;
          canvas.height = height;
          lastSizeRef.current = { width, height };
        }
        const publishedKey = nextKey;
        try {
          const frame = renderNativeFrame(canvas, currentConfig, currentCaption);
          if (!frame) {
            gateRef.current.inFlightKey = null;
            scheduleRetry(16);
            return;
          }
          if (cancelled) {
            gateRef.current.inFlightKey = null;
            return;
          }
          void bridge
            .publishOverlayFrame(bytesToBase64(frame.pixels), frame.width, frame.height)
            .then(() => {
              if (cancelled) {
                // Cleanup already released the old claim. Never clear a
                // replacement effect's claim if it republishes the same key.
                return;
              }
              const followUp = completeNativePublishSuccess(gateRef.current, publishedKey);
              if (currentCaption.sourceText.trim()) {
                markCaptionVisible(currentCaption.id);
              }
              if (followUp) {
                schedule();
              }
            })
            .catch((error: unknown) => {
              if (cancelled) {
                // Cleanup already released the old claim. Never clear a
                // replacement effect's claim if it republishes the same key.
                return;
              }
              const detail = formatBridgeError(error) ?? "native overlay publish rejected";
              const { nextKey: retryKey, exhausted } = completeNativePublishFailure(
                gateRef.current,
                publishedKey,
              );
              appendStructuredLog({
                level: exhausted ? "error" : "warn",
                source: "frontend",
                stage: "native-output",
                message: exhausted
                  ? "native overlay publish exhausted retries; OBS may show a frozen frame"
                  : "native overlay publish failed; will retry latest frame",
                error: detail,
                chunkId: currentCaption.id,
                fields: {
                  failureCount: gateRef.current.failureCount,
                  exhausted,
                },
              });
              if (retryKey) {
                // Brief backoff avoids a tight loop when the native worker is
                // reconnecting, while still recovering without a caption change.
                scheduleRetry(200);
              }
            });
        } catch (error) {
          if (cancelled) {
            if (gateRef.current.inFlightKey === publishedKey) {
              gateRef.current.inFlightKey = null;
            }
            return;
          }
          const detail = formatBridgeError(error) ?? "native overlay frame render failed";
          const { nextKey: retryKey, exhausted } = completeNativePublishFailure(
            gateRef.current,
            publishedKey,
          );
          appendStructuredLog({
            level: exhausted ? "error" : "warn",
            source: "frontend",
            stage: "native-output",
            message: exhausted
              ? "native overlay publish exhausted retries; OBS may show a frozen frame"
              : "native overlay frame render failed; will retry latest frame",
            error: detail,
            chunkId: currentCaption.id,
            fields: {
              failureCount: gateRef.current.failureCount,
              exhausted,
            },
          });
          if (retryKey) {
            scheduleRetry(200);
          }
        }
      });
    };

    const schedule = (): void => {
      // Coalesce burst progressive updates (ASR → normalize → translate) into one frame.
      if (raf) {
        cancelAnimationFrame(raf);
      }
      clearRafFallback();
      raf = requestAnimationFrame(() => {
        raf = 0;
        clearRafFallback();
        paint();
      });
      // Off-screen WKWebView often never runs rAF. Fall back so Syphon/Spout
      // still receive frames from native-renderer or a throttled main window.
      rafFallbackTimer = setTimeout(() => {
        rafFallbackTimer = undefined;
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        if (!cancelled) {
          paint();
        }
      }, NATIVE_RAF_FALLBACK_MS);
    };

    // Start webfont wait in parallel with rAF / the 16ms fallback so first
    // paint is max(layout, fonts), not layout then fonts.
    void ensureFontsReady(overlayCaptionFontCss(config));
    schedule();
    return () => {
      cancelled = true;
      clearRetry();
      clearRafFallback();
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      // A prop change can clean up this effect while its native IPC call is
      // still unresolved. Preserve the latest desired key and invalidate an
      // otherwise-successful key so the replacement effect cannot skip it after
      // dropping the stale in-flight claim. Without this, a B→A transition can
      // leave OBS on B forever because A was already successful before B began.
      if (gateRef.current.inFlightKey !== null) {
        const latestKey = framePaintKey(latestRef.current.config, latestRef.current.caption);
        gateRef.current.inFlightKey = null;
        gateRef.current.pendingKey = latestKey;
        if (gateRef.current.lastSuccessfulKey === latestKey) {
          gateRef.current.lastSuccessfulKey = "";
        }
      }
    };
  }, [caption, config]);

  return <canvas ref={canvasRef} className="native-output-canvas" />;
};
