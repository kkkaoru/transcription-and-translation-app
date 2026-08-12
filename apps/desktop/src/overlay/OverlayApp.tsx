import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../core/bridge";
import { shouldBlankCaptionForHoldClear } from "../core/caption-hold-clear";
import { mergeCaptionPayload } from "../core/caption-updates";
import { createDefaultConfig } from "../core/defaults";
import { markCaptionDisplay } from "../core/display-timing";
import { buildProvisionalCaptionFromAsrStage } from "../core/parapper-provisional";
import type { AppConfig, CaptionPayload } from "../core/types";
import { useCaptionHoldClear } from "../live/useCaptionHoldClear";
import { useProgressiveCaptionReveal } from "../live/useProgressiveCaptionReveal";
import { OverlayView } from "./CaptionOverlay";
import { createEmptyCaption, createHoldClearedCaption, createPreviewCaption } from "./captions";
import { NativeFramePublisher } from "./NativeFramePublisher";

/**
 * The overlay receives only the standard user-facing caption surface. Raw ASR
 * rows are emitted on `pipeline:stage` for diagnostics and must never replace
 * the normalized AzooKey/source or translator result in OBS.
 */
export const isOverlayCaption = (caption: CaptionPayload): boolean => {
  const stage = caption.stage;
  if (stage !== undefined && stage !== "source" && stage !== "translation") {
    return false;
  }
  return Boolean(
    (typeof caption.sourceText === "string" && caption.sourceText.trim()) ||
      (typeof caption.translationText === "string" && caption.translationText.trim()),
  );
};

/** Tauri's runtime unlisten can be async despite the public `UnlistenFn` type. */
const disposeSafely = (dispose: () => void): void => {
  try {
    const result = (dispose as unknown as () => unknown)();
    if (result && typeof result === "object" && "then" in result) {
      const pending = result as PromiseLike<unknown>;
      void pending.then(undefined, () => undefined);
    }
  } catch {
    // A disconnected webview may reject cleanup. It is safe to ignore here.
  }
};

const isNativeRendererRoute = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  return params.get("native") === "1";
};

const isTransparentCaptureRoute = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  return params.get("transparent") === "1" || params.get("overlay") === "1";
};

export const OverlayApp = () => {
  const nativeRenderer = isNativeRendererRoute();
  const transparentCapture = isTransparentCaptureRoute() && !nativeRenderer;
  const [config, setConfig] = useState<AppConfig>(createDefaultConfig);
  // Syphon/Spout2 starts with sample copy so clients can frame the layout
  // before the first recognition. Window Capture stays blank until live text.
  const [caption, setCaption] = useState<CaptionPayload>(() =>
    transparentCapture ? createEmptyCaption() : createPreviewCaption(),
  );
  /**
   * Keep the latest committed caption outside React's state updater. Merge and
   * display-timing side effects must run once per event; StrictMode/concurrent
   * replays of `setCaption(current => …)` would otherwise duplicate
   * `markCaptionDisplay` and cross-ID pending-translation inserts (same pattern
   * as MainApp.mergeAndCommitCaption).
   */
  const captionRef = useRef(caption);
  // Match MainApp Live/Syphon: reveal growing source graphemes on the overlay
  // paths. Hold-clear still keys off the merged caption, not reveal ticks.
  const progressiveCaption = useProgressiveCaptionReveal(caption);

  const blankDisplayedCaption = useCallback((expectedEpoch: string): void => {
    const current = captionRef.current;
    if (!shouldBlankCaptionForHoldClear(expectedEpoch, current)) {
      return;
    }
    const empty = createHoldClearedCaption();
    captionRef.current = empty;
    setCaption(empty);
  }, []);

  useCaptionHoldClear(caption, blankDisplayedCaption);

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
    let idle = false;
    const disposers: Array<() => void> = [];
    const applyCaption = (nextCaption: CaptionPayload): void => {
      if (!mounted || idle || !isOverlayCaption(nextCaption)) {
        return;
      }
      const current = captionRef.current;
      // The preview is generated when the overlay mounts. A real caption
      // may legitimately have an older `startedAt` (for example when OBS
      // opens after capture already began), so do not let the generic
      // out-of-order guard reject the first native replay.
      const merged =
        current.id === "preview" ? nextCaption : mergeCaptionPayload(current, nextCaption);
      if (merged === null || merged === current) {
        return;
      }
      captionRef.current = merged;
      markCaptionDisplay(merged);
      setCaption(merged);
    };
    const replayLatestCaption = (): void => {
      // Do not await replay in the effect. A missing command in an older
      // bundle, a disconnected webview, or a rejected IPC call must not leave
      // the transparent overlay waiting forever.
      let replay: Promise<CaptionPayload | null>;
      try {
        replay = bridge.getLatestCaption();
      } catch {
        return;
      }
      void replay
        .then((latest) => {
          if (latest) {
            applyCaption(latest);
          }
        })
        .catch(() => undefined);
    };

    void bridge
      .getConfig()
      .then((next) => {
        if (mounted) {
          setConfig(next);
        }
      })
      .catch(() => undefined);

    // `listen` resolves only after native registration. Replay once
    // immediately (renderer cache), then again after registration (native
    // history) to close the event-before-listener race without ever blocking
    // the overlay mount on a subscription Promise.
    let listenPromise: Promise<() => void>;
    try {
      listenPromise = Promise.resolve(bridge.listenCaptions(applyCaption));
    } catch {
      listenPromise = Promise.reject(new Error("caption listener unavailable"));
    }
    replayLatestCaption();
    void listenPromise
      .then((dispose) => {
        if (mounted && typeof dispose === "function") {
          disposers.push(dispose);
        } else if (typeof dispose === "function") {
          disposeSafely(dispose);
        }
        return bridge.getLatestCaption();
      })
      .then((latest) => {
        if (latest) {
          applyCaption(latest);
        }
      })
      .catch(() => {
        // Registration can fail when the overlay webview is closing. A final
        // best-effort history read still recovers a caption when available.
        replayLatestCaption();
      });
    void bridge
      .listenConfig(setConfig)
      .then((dispose) => {
        if (mounted) {
          disposers.push(dispose);
        } else {
          disposeSafely(dispose);
        }
      })
      .catch(() => undefined);
    // Runtime events are available in the native overlay webview as well as
    // the main window. Clear only a successful idle transition; an error must
    // leave the last caption visible for diagnosis per the README contract.
    if (typeof bridge.listenRuntime === "function") {
      void bridge
        .listenRuntime((status) => {
          idle = status.status === "idle";
          if (status.status === "starting" || status.status === "capturing") {
            idle = false;
          }
          if (idle && !status.lastError) {
            // Native Syphon/Spout path restores sample text for OBS layout checks.
            // Transparent Window Capture clears so a stopped session does not look live.
            const cleared = nativeRenderer ? createPreviewCaption() : createEmptyCaption();
            captionRef.current = cleared;
            setCaption(cleared);
          }
        })
        .then((dispose) => {
          if (mounted) {
            disposers.push(dispose);
          } else {
            disposeSafely(dispose);
          }
        })
        .catch(() => undefined);
    }
    // Primary Syphon/Spout publisher is this off-screen webview. Live already
    // paints ASR as a provisional source caption; without the same mapping
    // here, native-renderer waits for AzooKey `caption:update` and the first
    // recognized words never reach OBS.
    if (typeof bridge.listenPipelineStages === "function") {
      void bridge
        .listenPipelineStages((stageEvent) => {
          if (!mounted || idle) {
            return;
          }
          const provisional = buildProvisionalCaptionFromAsrStage(stageEvent, {
            sourceLanguage: captionRef.current.sourceLanguage,
            targetLanguage: captionRef.current.targetLanguage,
          });
          if (provisional) {
            applyCaption(provisional);
          }
        })
        .then((dispose) => {
          if (mounted) {
            disposers.push(dispose);
          } else {
            disposeSafely(dispose);
          }
        })
        .catch(() => undefined);
    }
    return () => {
      mounted = false;
      for (const dispose of disposers) {
        disposeSafely(dispose);
      }
    };
  }, [nativeRenderer]);

  if (nativeRenderer) {
    return (
      <div
        data-testid="native-renderer-root"
        data-source-text={progressiveCaption.sourceText}
        data-translation-text={progressiveCaption.translationText}
      >
        <NativeFramePublisher config={config} caption={progressiveCaption} />
      </div>
    );
  }

  return <OverlayView config={config} caption={progressiveCaption} />;
};
