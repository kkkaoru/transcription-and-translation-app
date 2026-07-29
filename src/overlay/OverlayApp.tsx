import { useEffect, useState } from "react";
import { bridge } from "../core/bridge";
import { createDefaultConfig } from "../core/defaults";
import type { AppConfig, CaptionPayload } from "../core/types";
import { OverlayView } from "./CaptionOverlay";
import { createPreviewCaption } from "./captions";
import { NativeFramePublisher } from "./NativeFramePublisher";

export const OverlayApp = () => {
  const [config, setConfig] = useState<AppConfig>(createDefaultConfig);
  const [caption, setCaption] = useState<CaptionPayload>(createPreviewCaption);

  useEffect(() => {
    document.documentElement.classList.add("overlay-document");
    document.body.classList.add("overlay-document");
    return () => {
      document.documentElement.classList.remove("overlay-document");
      document.body.classList.remove("overlay-document");
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const disposers: Array<() => void> = [];
    void bridge
      .getConfig()
      .then((next) => {
        if (mounted) {
          setConfig(next);
        }
      })
      .catch(() => undefined);
    void bridge
      .listenCaptions(setCaption)
      .then((dispose) => {
        if (mounted) {
          disposers.push(dispose);
        } else {
          dispose();
        }
      })
      .catch(() => undefined);
    void bridge
      .listenConfig(setConfig)
      .then((dispose) => {
        if (mounted) {
          disposers.push(dispose);
        } else {
          dispose();
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, []);

  return (
    <>
      <OverlayView config={config} caption={caption} />
      <NativeFramePublisher config={config} caption={caption} />
    </>
  );
};
