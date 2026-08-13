import {
  type CaptionSentenceHints,
  detectCaptionSentenceEnds,
  selectVisibleCaptionSentence,
} from "@caption-bridge/sentence-boundary";
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../core/bridge";
import { shouldBlankCaptionForHoldClear } from "../core/caption-hold-clear";
import {
  asrLatencyFromUnknown,
  markCaptionIpcReceived,
  parseNumericTurnId,
} from "../core/caption-latency";
import { isShorterSameUtteranceSurface, mergeCaptionPayload } from "../core/caption-updates";
import { createDefaultConfig } from "../core/defaults";
import { markCaptionDisplay } from "../core/display-timing";
import {
  buildProvisionalCaptionFromAsrStage,
  joinDisjointAsrStageOntoLead,
  type OverlayAsrFoldStage,
  pickLatestSuccessfulAsrStage,
  rememberOverlayAsrStage,
} from "../core/parapper-provisional";
import {
  partialWindowRelayFence,
  shouldApplyPartialWindowRelay,
  type PartialWindowRelayFence,
} from "../core/partialWindowRelay";
import type {
  AppConfig,
  CaptionPayload,
  PartialWindowCaption,
  PipelineStageEvent,
} from "../core/types";
import { useCaptionFreshness } from "../live/useCaptionFreshness";
import { useCaptionHoldClear } from "../live/useCaptionHoldClear";
import { useProgressiveCaptionReveal } from "../live/useProgressiveCaptionReveal";
import { OverlayView } from "./CaptionOverlay";
import { createEmptyCaption, createHoldClearedCaption, createPreviewCaption } from "./captions";
import { NativeFramePublisher } from "./NativeFramePublisher";
import {
  isStaleOverlayAsrStage,
  overlayAsrFenceFromCaption,
  overlayAsrSessionKey,
  overlayAsrStageFence,
  rearmPreviewHold,
  retainHeldOverlayCaption,
  shouldBufferOverlayAsrStageForFold,
  shouldHoldCaptionOverPreview,
  shouldSettleAsrHistoryReplay,
} from "./overlay-first-caption";

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

/**
 * Caller-owned display sentence carry. Local to OverlayApp (separate WebView
 * from Live/MainApp): hints-only sticky via previousText / previousEnds.
 */
type OverlayStickyState = {
  previousText: string;
  previousEnds: number[];
};

type OverlayStickyOwner = {
  id: string;
  captureGeneration: number | null;
};

type OverlayStickyRefs = {
  source: { current: OverlayStickyState | null };
  translation: { current: OverlayStickyState | null };
  owner: { current: OverlayStickyOwner | null };
};

const normalizeOverlayStickyText = (text: string): string => text.replace(/\r\n?/gu, "\n").trim();

/** Reset display-only sentence carry; IPC caption state remains untouched. */
const resetOverlayStickyRefs = (refs: OverlayStickyRefs): void => {
  refs.source.current = null;
  refs.translation.current = null;
  refs.owner.current = null;
};

const compatibleOverlayStickyState = (
  sticky: OverlayStickyState | null,
  text: string,
): OverlayStickyState | null => {
  if (!sticky?.previousText || sticky.previousEnds.length === 0) {
    return null;
  }
  const normalized = normalizeOverlayStickyText(text);
  const previous = normalizeOverlayStickyText(sticky.previousText);
  if (!normalized || !previous) {
    return null;
  }
  // A revision may grow or temporarily shrink the same turn, but a rewrite
  // with a different prefix must not inherit a sentence end from another turn.
  if (normalized.startsWith(previous) || previous.startsWith(normalized)) {
    return sticky;
  }
  return null;
};

const rememberOverlayStickyState = (
  text: string,
  hints: CaptionSentenceHints,
  previous: OverlayStickyState | null,
): OverlayStickyState | null => {
  const normalized = normalizeOverlayStickyText(text);
  if (!normalized) {
    return null;
  }
  // Recompute fresh ends without feeding the old carry back into its own
  // history. The caller-owned ref stores only boundaries accepted for this
  // compatible prefix, not a module-global cache or an IPC field.
  const freshEnds = detectCaptionSentenceEnds(normalized, {
    ...hints,
    previousText: undefined,
    previousEnds: undefined,
  });
  const compatible = compatibleOverlayStickyState(previous, normalized);
  const limit = Array.from(normalized).length;
  const mergedEnds = [...new Set([...(compatible?.previousEnds ?? []), ...freshEnds])]
    .filter((offset) => Number.isInteger(offset) && offset > 0 && offset <= limit)
    .sort((left, right) => left - right);
  if (mergedEnds.length === 0) {
    return null;
  }
  return { previousText: normalized, previousEnds: mergedEnds };
};

/** Bang/question and elongation-only remainders keep the recognized head. */
const shouldKeepOverlayHeadAfterStickyPage = (original: string, paged: string): boolean => {
  const source = original.trim();
  const shown = paged.trim();
  if (!shown || shown === source || !source.endsWith(shown)) {
    return false;
  }
  const prefix = source.slice(0, source.length - shown.length);
  if (/[！？!?]\s*$/u.test(prefix)) {
    return true;
  }
  return /^[ー〜～]+$/u.test(shown);
};

const applyOverlayStickyField = (
  text: string,
  hints: CaptionSentenceHints,
  sticky: OverlayStickyState | null,
): string => {
  const paged = selectVisibleCaptionSentence(text, {
    ...hints,
    previousText: sticky?.previousText,
    previousEnds: sticky?.previousEnds,
  });
  if (!paged || paged === text || shouldKeepOverlayHeadAfterStickyPage(text, paged)) {
    return text;
  }
  return paged;
};

/**
 * Apply the same caller-owned sentence carry to Overlay DOM and native output.
 * Merge/replay/freshness keep the original CaptionPayload; both display
 * consumers receive one sticky-applied surface.
 */
const applyOverlayStickyDisplay = (
  caption: CaptionPayload,
  refs: OverlayStickyRefs,
): CaptionPayload => {
  if (caption.id === "preview" || caption.id === "empty") {
    resetOverlayStickyRefs(refs);
    return caption;
  }

  const generation =
    typeof caption.captureGeneration === "number" ? caption.captureGeneration : null;
  const owner = refs.owner.current;
  const generationChanged =
    owner != null &&
    owner.captureGeneration !== generation &&
    (owner.captureGeneration != null || generation != null);
  if (owner && (owner.id !== caption.id || generationChanged)) {
    refs.source.current = null;
    refs.translation.current = null;
  }
  refs.owner.current = { id: caption.id, captureGeneration: generation };

  const sourceHints: CaptionSentenceHints = {
    key: "source",
    azookeyInputText: caption.azookeyInputText,
    sentenceEndOffsets: caption.sentenceEndOffsets,
    softBreakOffsets: caption.softBreakOffsets,
    deferSentencePaging: caption.provisional === true,
  };
  const translationHints: CaptionSentenceHints = {
    key: "translation",
    deferSentencePaging: caption.provisional === true,
  };
  const sourceSticky = compatibleOverlayStickyState(refs.source.current, caption.sourceText);
  const translationSticky = compatibleOverlayStickyState(
    refs.translation.current,
    caption.translationText,
  );

  // Folded provisional ASR must keep the joined lead+tail; do not seed or
  // apply copula carry on that surface. The following normalized caption can
  // still seed from its own authoritative boundary hints.
  if (caption.provisional === true) {
    return caption;
  }

  refs.source.current = rememberOverlayStickyState(caption.sourceText, sourceHints, sourceSticky);
  refs.translation.current = rememberOverlayStickyState(
    caption.translationText,
    translationHints,
    translationSticky,
  );

  const nextSource = applyOverlayStickyField(caption.sourceText, sourceHints, sourceSticky);
  const nextTranslation = applyOverlayStickyField(
    caption.translationText,
    translationHints,
    translationSticky,
  );
  if (nextSource === caption.sourceText && nextTranslation === caption.translationText) {
    return caption;
  }
  const next: CaptionPayload = {
    ...caption,
    sourceText: nextSource,
    translationText: nextTranslation,
  };
  if (nextSource !== caption.sourceText) {
    // Offsets are relative to the full IPC source surface; passing them to the
    // suffix would page/cut again in captionItems and native rendering.
    delete next.sentenceEndOffsets;
    delete next.softBreakOffsets;
  }
  return next;
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
  const [partialWindow, setPartialWindow] = useState<PartialWindowCaption | null>(null);
  // Retain this even after a clear: it prevents a delayed older IPC invoke
  // from resurrecting an OPEN-segment suffix in this renderer.
  const partialWindowFence = useRef<PartialWindowRelayFence | null>(null);
  /**
   * Keep the latest committed caption outside React's state updater. Merge and
   * display-timing side effects must run once per event; StrictMode/concurrent
   * replays of `setCaption(current => …)` would otherwise duplicate
   * `markCaptionDisplay` and cross-ID pending-translation inserts (same pattern
   * as MainApp.mergeAndCommitCaption).
   */
  const captionRef = useRef(caption);
  /** Display-only sentence carry shared by Overlay DOM and native publisher. */
  const stickyRefs = useRef<OverlayStickyRefs>({
    source: { current: null },
    translation: { current: null },
    owner: { current: null },
  }).current;
  // Match MainApp: grow source graphemes on overlay/Syphon. Snap an already
  // recognized longer same-turn surface so the plate is not stuck on the first
  // piece after the 16ms first-commit. Hold-clear still keys off the merge.
  const freshnessCaption = useCaptionFreshness(caption);
  const progressiveCaption = useProgressiveCaptionReveal(freshnessCaption, {
    snapAvailablePrefixExtensions: true,
  });
  const displayCaption = applyOverlayStickyDisplay(progressiveCaption, stickyRefs);

  const blankDisplayedCaption = useCallback(
    (expectedEpoch: string): void => {
      const current = captionRef.current;
      if (!shouldBlankCaptionForHoldClear(expectedEpoch, current)) {
        return;
      }
      const empty = createHoldClearedCaption();
      setPartialWindow(null);
      resetOverlayStickyRefs(stickyRefs);
      captionRef.current = empty;
      setCaption(empty);
    },
    [stickyRefs],
  );

  useCaptionHoldClear(caption, blankDisplayedCaption);

  useEffect(() => {
    document.documentElement.classList.add("overlay-document");
    document.body.classList.add("overlay-document");
    return () => {
      document.documentElement.classList.remove("overlay-document");
      document.body.classList.remove("overlay-document");
      // Re-open gets fresh caller-owned sticky refs; no sentence end leaks
      // across an Overlay webview lifetime.
      resetOverlayStickyRefs(stickyRefs);
    };
  }, [stickyRefs]);

  useEffect(() => {
    let mounted = true;
    let idle = false;
    const disposers: Array<() => void> = [];
    const applyCaption = (nextCaption: CaptionPayload): void => {
      if (!mounted || idle || !isOverlayCaption(nextCaption)) {
        return;
      }
      // A normal interim/completion owns the committed body and invalidates
      // the OPEN-segment suffix even if a clear IPC relay was missed.
      setPartialWindow(null);
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
      // In-flight AzooKey of the lead can emit caption:update after overlay
      // already painted the joined ASR surface. Keep-longer of that join.
      // Same id only: a later short turn must still replace the plate.
      if (
        current.id !== "preview" &&
        current.id !== "empty" &&
        merged.id === current.id &&
        isShorterSameUtteranceSurface(merged.sourceText, current.sourceText)
      ) {
        return;
      }
      captionRef.current = merged;
      // Native-renderer is a separate webview from Live. Join `*_at` here so
      // Syphon first-paint spans are not missing speech_start_at when the
      // caption or ASR stage already carries them.
      markCaptionIpcReceived(merged.id, {
        turnId: parseNumericTurnId(merged.id),
        asrLatency: merged.asrLatency ?? asrLatencyFromUnknown(nextCaption),
      });
      markCaptionDisplay(merged);
      setCaption(merged);
    };
    // Short getLatestCaption / caption:update must not replace preview before
    // ASR history settles; otherwise first Syphon paint is a truncated sentence.
    let asrHistorySettled = typeof bridge.listenPipelineStages !== "function";
    let heldOverPreview: CaptionPayload | null = null;
    let asrHistoryInvalidated = false;
    let staleAsrFence: ReturnType<typeof overlayAsrStageFence> | null = null;
    let idleAsrSessionKey: string | null = null;
    let asrStageBuffer: OverlayAsrFoldStage[] = [];
    let lastJoinedAsrStage: OverlayAsrFoldStage | null = null;
    const flushHeldCaptionOverPreview = (): void => {
      const held = heldOverPreview;
      heldOverPreview = null;
      if (held) {
        applyCaption(held);
      }
    };
    const settleAsrHistory = (): void => {
      if (asrHistorySettled) {
        return;
      }
      asrHistorySettled = true;
      flushHeldCaptionOverPreview();
    };
    const ingestCaption = (nextCaption: CaptionPayload): void => {
      if (!mounted || idle || !isOverlayCaption(nextCaption)) {
        return;
      }
      if (shouldHoldCaptionOverPreview(captionRef.current.id, nextCaption, asrHistorySettled)) {
        heldOverPreview = retainHeldOverlayCaption(heldOverPreview, nextCaption);
        return;
      }
      applyCaption(nextCaption);
    };
    let replayLatestAsrStage = (): void => {
      settleAsrHistory();
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
            ingestCaption(latest);
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
      listenPromise = Promise.resolve(bridge.listenCaptions(ingestCaption));
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
          ingestCaption(latest);
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
            if (!asrHistorySettled) {
              replayLatestAsrStage();
            }
          }
          if (idle && !status.lastError) {
            // Native Syphon/Spout path restores sample text for OBS layout checks.
            // Transparent Window Capture clears so a stopped session does not look live.
            asrHistoryInvalidated = true;
            asrStageBuffer = [];
            lastJoinedAsrStage = null;
            staleAsrFence =
              staleAsrFence ?? overlayAsrFenceFromCaption(captionRef.current) ?? staleAsrFence;
            idleAsrSessionKey =
              (staleAsrFence ? overlayAsrSessionKey(staleAsrFence.utteranceId) : null) ??
              idleAsrSessionKey;
            const cleared = nativeRenderer ? createPreviewCaption() : createEmptyCaption();
            setPartialWindow(null);
            resetOverlayStickyRefs(stickyRefs);
            captionRef.current = cleared;
            setCaption(cleared);
            const nextHold = rearmPreviewHold(
              cleared.id,
              typeof bridge.listenPipelineStages === "function",
            );
            asrHistorySettled = nextHold.asrHistorySettled;
            heldOverPreview = nextHold.heldOverPreview;
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
    if (typeof bridge.listenPartialWindows === "function") {
      void bridge
        .listenPartialWindows((next) => {
          if (!mounted || idle) {
            return;
          }
          if (!shouldApplyPartialWindowRelay(partialWindowFence.current, next)) {
            return;
          }
          partialWindowFence.current = partialWindowRelayFence(next);
          setPartialWindow(next.text.trim() ? next : null);
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
      const asrStageRef = (
        stageEvent: OverlayAsrFoldStage,
      ): ReturnType<typeof overlayAsrStageFence> =>
        overlayAsrStageFence({
          utteranceId: stageEvent.utteranceId,
          at: stageEvent.at,
          startedAt: stageEvent.startedAt,
          captureGeneration: stageEvent.captureGeneration,
        });
      const paintFoldedAsrStage = (
        folded: OverlayAsrFoldStage,
        source: "history" | "live",
      ): boolean => {
        if (!mounted || idle) {
          return false;
        }
        const toPaint = joinDisjointAsrStageOntoLead(lastJoinedAsrStage, folded);
        const nextText = toPaint.surfaceText?.trim() || toPaint.outputText.trim();
        const current = captionRef.current;
        const currentText =
          current.id === "preview" || current.id === "empty" ? "" : current.sourceText.trim();
        const stale = isStaleOverlayAsrStage(
          asrStageRef(toPaint),
          staleAsrFence,
          asrHistoryInvalidated,
          source,
          idleAsrSessionKey,
        );
        if (stale) {
          if (!nextText || nextText === currentText) {
            return false;
          }
          if (currentText && isShorterSameUtteranceSurface(nextText, currentText)) {
            return false;
          }
        }
        // Same-turn shorter follow-up after a joined paint: do not collapse
        // lastJoined / the plate. A different utterance id still replaces.
        if (
          current.id !== "preview" &&
          current.id !== "empty" &&
          current.id === toPaint.utteranceId &&
          currentText &&
          isShorterSameUtteranceSurface(nextText, currentText)
        ) {
          return false;
        }
        const provisional = buildProvisionalCaptionFromAsrStage(toPaint, {
          sourceLanguage: captionRef.current.sourceLanguage,
          targetLanguage: captionRef.current.targetLanguage,
        });
        if (!provisional) {
          return false;
        }
        lastJoinedAsrStage = toPaint;
        staleAsrFence = asrStageRef(toPaint);
        asrHistoryInvalidated = false;
        ingestCaption(provisional);
        settleAsrHistory();
        return true;
      };
      const applyAsrStage = (
        stageEvent: OverlayAsrFoldStage,
        source: "history" | "live",
      ): boolean => {
        if (!mounted || idle) {
          return false;
        }
        if (
          !shouldBufferOverlayAsrStageForFold(
            asrStageRef(stageEvent),
            staleAsrFence,
            asrHistoryInvalidated,
            source,
            idleAsrSessionKey,
          )
        ) {
          return false;
        }
        asrStageBuffer = rememberOverlayAsrStage(asrStageBuffer, stageEvent);
        const folded = pickLatestSuccessfulAsrStage(asrStageBuffer);
        return folded ? paintFoldedAsrStage(folded, source) : false;
      };
      replayLatestAsrStage = (): void => {
        if (typeof bridge.getPipelineStageHistory !== "function") {
          settleAsrHistory();
          return;
        }
        let replay: Promise<PipelineStageEvent[]>;
        try {
          replay = bridge.getPipelineStageHistory();
        } catch {
          settleAsrHistory();
          return;
        }
        if (!replay || typeof replay.then !== "function") {
          settleAsrHistory();
          return;
        }
        void replay
          .then((history) => {
            for (const event of history) {
              if (event.stage !== "asr" || !event.ok) {
                continue;
              }
              if (
                !shouldBufferOverlayAsrStageForFold(
                  asrStageRef(event),
                  staleAsrFence,
                  asrHistoryInvalidated,
                  "history",
                  idleAsrSessionKey,
                )
              ) {
                continue;
              }
              asrStageBuffer = rememberOverlayAsrStage(asrStageBuffer, event);
            }
            const latest = pickLatestSuccessfulAsrStage(asrStageBuffer);
            const applied = latest ? paintFoldedAsrStage(latest, "history") : false;
            if (shouldSettleAsrHistoryReplay(applied, asrHistoryInvalidated)) {
              settleAsrHistory();
            }
          })
          .catch(() => {
            settleAsrHistory();
          });
      };
      replayLatestAsrStage();
      void bridge
        .listenPipelineStages((stageEvent) => {
          applyAsrStage(stageEvent, "live");
        })
        .then((dispose) => {
          if (mounted && typeof dispose === "function") {
            disposers.push(dispose);
          } else if (typeof dispose === "function") {
            disposeSafely(dispose);
          }
          replayLatestAsrStage();
        })
        .catch(() => {
          replayLatestAsrStage();
        });
    }
    return () => {
      mounted = false;
      for (const dispose of disposers) {
        disposeSafely(dispose);
      }
    };
  }, [nativeRenderer, stickyRefs]);

  if (nativeRenderer) {
    return (
      <div
        data-testid="native-renderer-root"
        data-source-text={displayCaption.sourceText}
        data-translation-text={displayCaption.translationText}
      >
        <NativeFramePublisher
          config={config}
          caption={displayCaption}
          partialWindowText={partialWindow?.text ?? ""}
        />
      </div>
    );
  }

  return (
    <OverlayView
      config={config}
      caption={displayCaption}
      partialWindowText={partialWindow?.text ?? ""}
    />
  );
};
