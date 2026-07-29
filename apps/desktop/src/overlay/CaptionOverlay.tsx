import { overlayCaptionCss, toCaptionCss } from "../core/style";
import type { AppConfig, CaptionPayload } from "../core/types";
import { captionItems } from "./captions";

export const CaptionLines = ({
  config,
  caption,
  placeholder = false,
}: {
  config: AppConfig;
  caption: CaptionPayload;
  placeholder?: boolean;
}) => (
  <div className="caption-lines" style={overlayCaptionCss(config.overlay)}>
    {captionItems(config, caption, placeholder).map((item) => (
      <div
        className={`caption-line caption-line-${item.key}`}
        key={item.key}
        style={toCaptionCss(item.style)}
      >
        {item.text}
      </div>
    ))}
  </div>
);

export const OverlayView = ({
  config,
  caption,
  preview = false,
}: {
  config: AppConfig;
  caption: CaptionPayload;
  preview?: boolean;
}) => (
  <main className={`overlay-root${preview ? " overlay-preview" : ""}`}>
    <CaptionLines config={config} caption={caption} placeholder={preview} />
  </main>
);
