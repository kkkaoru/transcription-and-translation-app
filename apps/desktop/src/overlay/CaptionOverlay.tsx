import { memo, useLayoutEffect, useRef } from "react";
import {
  logCaptionOverflow,
  overlayCaptionCss,
  readCaptionOverflow,
  shouldLogCaptionOverflow,
  toCaptionCss,
} from "../core/style";
import type { AppConfig, CaptionPayload } from "../core/types";
import { captionItems, captionTextSegmentLines } from "./captions";

/** Keep an invisible line box so empty translation/source slots do not shift layout. */
const CAPTION_SLOT_PLACEHOLDER = "\u00a0";

export const CaptionLines = memo(
  ({
    config,
    caption,
    partialWindowText = "",
    placeholder = false,
  }: {
    config: AppConfig;
    caption: CaptionPayload;
    /** Display-only OPEN-segment suffix; never part of CaptionPayload.sourceText. */
    partialWindowText?: string;
    placeholder?: boolean;
  }) => {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const overflowedRef = useRef<boolean | null>(null);

    // Measure after React commits the new caption DOM. Do not measure during render.
    useLayoutEffect(() => {
      let cancelled = false;
      const items = captionItems(config, caption, placeholder, partialWindowText);

      const measureOverflow = (): void => {
        if (cancelled) {
          return;
        }
        const host = hostRef.current;
        if (!host) {
          return;
        }
        const measurement = readCaptionOverflow(host);
        if (!shouldLogCaptionOverflow(overflowedRef.current, measurement)) {
          return;
        }
        overflowedRef.current = measurement.overflowed;
        logCaptionOverflow(measurement);
      };

      if (items.length > 0) {
        measureOverflow();
      }

      const host = hostRef.current;
      if (!host) {
        return () => {
          cancelled = true;
        };
      }

      const resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => {
              measureOverflow();
            });
      resizeObserver?.observe(host);

      // Web fonts can swap after the first commit. Re-measure without blocking on
      // fonts.ready (off-screen WKWebView can stall that promise indefinitely).
      const fonts = typeof document === "undefined" ? null : document.fonts;
      const onFontsSettled = (): void => {
        measureOverflow();
      };
      fonts?.addEventListener?.("loadingdone", onFontsSettled);
      void fonts?.ready?.then(onFontsSettled, () => undefined);

      return () => {
        cancelled = true;
        resizeObserver?.disconnect();
        fonts?.removeEventListener?.("loadingdone", onFontsSettled);
      };
    }, [config, caption, partialWindowText, placeholder]);

    return (
      <div ref={hostRef} className="caption-lines" style={overlayCaptionCss(config.overlay)}>
        {captionItems(config, caption, placeholder, partialWindowText).map((item) => {
          const segmentLines = captionTextSegmentLines(item);
          const hasText = segmentLines.some((line) => line.some((segment) => segment.text.trim()));
          return (
            <div
              className={`caption-line caption-line-${item.key}${hasText ? "" : " caption-line-empty"}`}
              key={item.key}
              style={toCaptionCss(item.style)}
              aria-hidden={hasText ? undefined : true}
              data-empty={hasText ? undefined : "true"}
            >
              {hasText
                ? segmentLines.map((line, lineIndex, lines) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: presentational wrapped lines have no local state.
                    <span key={`${item.key}-${lineIndex}`}>
                      {line.map((segment) => (
                        <span
                          className={segment.dimmed ? "caption-partial-window" : undefined}
                          key={`${item.key}-${segment.dimmed}-${segment.text}`}
                        >
                          {segment.text}
                        </span>
                      ))}
                      {lineIndex < lines.length - 1 ? "\n" : null}
                    </span>
                  ))
                : CAPTION_SLOT_PLACEHOLDER}
            </div>
          );
        })}
      </div>
    );
  },
);
CaptionLines.displayName = "CaptionLines";

export const OverlayView = memo(
  ({
    config,
    caption,
    partialWindowText,
    preview = false,
    placeholder = false,
  }: {
    config: AppConfig;
    caption: CaptionPayload;
    partialWindowText?: string;
    /** CSS chrome for the in-app OBS preview stage (checkerboard host). */
    preview?: boolean;
    /**
     * When true, render static sample copy instead of `caption`.
     * Keep false on the live stage so recognized text appears in the preview.
     */
    placeholder?: boolean;
  }) => (
    <main className={`overlay-root${preview ? " overlay-preview" : ""}`}>
      <CaptionLines
        config={config}
        caption={caption}
        partialWindowText={partialWindowText}
        placeholder={placeholder}
      />
    </main>
  ),
);
OverlayView.displayName = "OverlayView";
