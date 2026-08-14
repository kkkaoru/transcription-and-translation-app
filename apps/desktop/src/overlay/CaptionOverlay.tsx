import { memo } from "react";
import { overlayCaptionCss, toCaptionCss } from "../core/style";
import type { AppConfig, CaptionPayload } from "../core/types";
import { captionItems, captionTextLines } from "./captions";

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
  }) => (
    <div className="caption-lines" style={overlayCaptionCss(config.overlay)}>
      {captionItems(config, caption, placeholder, partialWindowText).map((item) => {
        const hasText = item.text.trim().length > 0;
        return (
          <div
            className={`caption-line caption-line-${item.key}${hasText ? "" : " caption-line-empty"}`}
            key={item.key}
            style={toCaptionCss(item.style)}
            aria-hidden={hasText ? undefined : true}
            data-empty={hasText ? undefined : "true"}
          >
            {hasText ? (
              <>
                {captionTextLines(item).join("\n")}
                {item.key === "source" && item.partialWindowText ? (
                  <span className="caption-partial-window"> {item.partialWindowText}</span>
                ) : null}
              </>
            ) : (
              CAPTION_SLOT_PLACEHOLDER
            )}
          </div>
        );
      })}
    </div>
  ),
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
