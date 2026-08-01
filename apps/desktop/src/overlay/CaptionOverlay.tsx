import { memo } from "react";
import { overlayCaptionCss, toCaptionCss } from "../core/style";
import type { AppConfig, CaptionPayload } from "../core/types";
import { captionItems, captionTextLines } from "./captions";

export const CaptionLines = memo(
  ({
    config,
    caption,
    placeholder = false,
  }: {
    config: AppConfig;
    caption: CaptionPayload;
    placeholder?: boolean;
  }) => (
    <div className="caption-lines" style={overlayCaptionCss(config.overlay)}>
      {captionItems(config, caption, placeholder)
        .filter((item) => item.text.trim().length > 0)
        .map((item) => (
          <div
            className={`caption-line caption-line-${item.key}`}
            key={item.key}
            style={toCaptionCss(item.style)}
          >
            {captionTextLines(item).join("\n")}
          </div>
        ))}
    </div>
  ),
);
CaptionLines.displayName = "CaptionLines";

export const OverlayView = memo(
  ({
    config,
    caption,
    preview = false,
    placeholder = false,
  }: {
    config: AppConfig;
    caption: CaptionPayload;
    /** CSS chrome for the in-app OBS preview stage (checkerboard host). */
    preview?: boolean;
    /**
     * When true, render static sample copy instead of `caption`.
     * Keep false on the live stage so recognized text appears in the preview.
     */
    placeholder?: boolean;
  }) => (
    <main className={`overlay-root${preview ? " overlay-preview" : ""}`}>
      <CaptionLines config={config} caption={caption} placeholder={placeholder} />
    </main>
  ),
);
OverlayView.displayName = "OverlayView";
