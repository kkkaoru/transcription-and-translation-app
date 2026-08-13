import { useEffect, useRef, useState } from "react";
import {
  advanceProgressiveReveal,
  alignCaptionOffsetsToPaintedSource,
  immediateProgressiveRevealStart,
  isSingleGraphemeCaptionSurface,
  PROGRESSIVE_FIRST_PAINT_COALESCE_MS,
  progressiveRevealStepMs,
  resolveProgressiveRevealSourceTarget,
  shouldHoldSingleGraphemeFirstPaint,
  shouldProgressivelyReveal,
  shouldSnapAvailablePrefixExtension,
  shouldSnapProgressiveFirstPaint,
} from "../core/progressive-caption-reveal";
import type { CaptionPayload } from "../core/types";
import { captionGraphemes } from "../overlay/captions";

export type ProgressiveCaptionRevealOptions = {
  /**
   * Overlay/Syphon: snap to an already-recognized longer prefix instead of
   * typewriting from the committed lead. Live leaves this unset.
   */
  snapAvailablePrefixExtensions?: boolean;
};

/**
 * Reveal newly recognized source graphemes one-by-one so Live/Syphon captions
 * grow like こ → こん → こんにちは as ASR hypotheses lengthen within a turn.
 *
 * Utterance id changes and non-prefix rewrites snap immediately so the previous
 * turn's characters never paint under the new caption (and switches stay fast).
 *
 * Only characters already present in the latest recognition target are shown;
 * the helper never invents text ahead of ASR. An empty plate paints the full
 * first hypothesis on the same update so viewers never wait a grapheme timer
 * on a blank caption. A one-grapheme first hypothesis is held until that
 * first frame commits (or a longer surface arrives) so Syphon/overlay never
 * first-paints `こ` when `こんにちは` is about to replace it. A longer surface
 * that arrives before that first frame commits (one display frame / 16ms) snaps
 * immediately. Later prefix extensions still reveal one grapheme at a time on
 * Live. Overlay may snap those extensions once the longer surface is already
 * in the caption so Syphon does not stay on the first piece.
 * The reveal target is the newest visible sentence (same paging as the
 * overlay), not the raw multi-clause `sourceText`, so finished-clause paging
 * cannot collapse a mid-reveal prefix to a single grapheme.
 */
export const useProgressiveCaptionReveal = (
  caption: CaptionPayload,
  options: ProgressiveCaptionRevealOptions = {},
): CaptionPayload => {
  const snapAvailablePrefixExtensions = options.snapAvailablePrefixExtensions === true;
  const revealTarget = resolveProgressiveRevealSourceTarget(caption);
  const [displayedSource, setDisplayedSource] = useState(() =>
    isSingleGraphemeCaptionSurface(revealTarget) ? "" : revealTarget,
  );
  const [trackedId, setTrackedId] = useState(caption.id);
  const displayedRef = useRef(displayedSource);
  const targetRef = useRef(revealTarget);
  const idRef = useRef(caption.id);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstFramePendingRef = useRef(true);

  // Prefer the synced surface for this render so a new turn never commits with
  // the previous utterance's characters (React may also retry after setState).
  let paintSource = displayedSource;
  if (caption.id !== trackedId) {
    setTrackedId(caption.id);
    firstFramePendingRef.current = true;
    const nextPaint = isSingleGraphemeCaptionSurface(revealTarget) ? "" : revealTarget;
    setDisplayedSource(nextPaint);
    paintSource = nextPaint;
    displayedRef.current = nextPaint;
    idRef.current = caption.id;
    targetRef.current = revealTarget;
  } else if (
    shouldHoldSingleGraphemeFirstPaint(displayedSource, revealTarget, firstFramePendingRef.current)
  ) {
    paintSource = displayedSource;
    displayedRef.current = displayedSource;
    targetRef.current = revealTarget;
  } else if (
    displayedSource !== revealTarget &&
    !shouldProgressivelyReveal(displayedSource, revealTarget)
  ) {
    setDisplayedSource(revealTarget);
    paintSource = revealTarget;
    displayedRef.current = revealTarget;
    targetRef.current = revealTarget;
  } else if (
    displayedSource !== revealTarget &&
    !displayedSource.trim() &&
    shouldProgressivelyReveal(displayedSource, revealTarget)
  ) {
    // Empty plate → first hypothesis: paint the full visible sentence this frame.
    const firstStep = immediateProgressiveRevealStart(displayedSource, revealTarget);
    setDisplayedSource(firstStep);
    paintSource = firstStep;
    displayedRef.current = firstStep;
    targetRef.current = revealTarget;
  } else if (
    displayedSource !== revealTarget &&
    (shouldSnapProgressiveFirstPaint(
      displayedSource,
      revealTarget,
      firstFramePendingRef.current,
    ) ||
      shouldSnapAvailablePrefixExtension(
        displayedSource,
        revealTarget,
        snapAvailablePrefixExtensions,
      ))
  ) {
    // Longer surface is already available. Overlay snaps after first commit so
    // the first piece does not remain on Syphon while the tail is in state.
    setDisplayedSource(revealTarget);
    paintSource = revealTarget;
    displayedRef.current = revealTarget;
    targetRef.current = revealTarget;
  } else {
    displayedRef.current = displayedSource;
  }

  useEffect(() => {
    const clearTimer = (): void => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const scheduleToward = (from: string, target: string): void => {
      clearTimer();
      let current = from;
      // Defense-in-depth: if render-phase sync did not already seed the first
      // hypothesis (e.g. Strict Mode remount), do it before waiting on a timer.
      if (!current.trim() && shouldProgressivelyReveal(current, target)) {
        current = immediateProgressiveRevealStart(current, target);
        displayedRef.current = current;
        setDisplayedSource(current);
      }
      if (!shouldProgressivelyReveal(current, target)) {
        return;
      }
      const remaining = captionGraphemes(target).length - captionGraphemes(current).length;
      if (remaining <= 0) {
        return;
      }
      timerRef.current = setTimeout(() => {
        const latestTarget = targetRef.current;
        const next = advanceProgressiveReveal(displayedRef.current, latestTarget);
        displayedRef.current = next;
        setDisplayedSource(next);
        if (shouldProgressivelyReveal(next, latestTarget)) {
          scheduleToward(next, latestTarget);
        }
      }, progressiveRevealStepMs(remaining));
    };

    const target = revealTarget;
    const idChanged = caption.id !== idRef.current;
    idRef.current = caption.id;
    targetRef.current = target;

    if (idChanged) {
      // Render-phase sync already snapped to the new turn's visible sentence,
      // except a one-grapheme first hyp which stays empty until first frame.
      clearTimer();
      firstFramePendingRef.current = true;
      const nextPaint = isSingleGraphemeCaptionSurface(target) ? "" : target;
      displayedRef.current = nextPaint;
      setDisplayedSource(nextPaint);
      return clearTimer;
    }

    const current = displayedRef.current;
    if (shouldHoldSingleGraphemeFirstPaint(current, target, firstFramePendingRef.current)) {
      return clearTimer;
    }
    if (
      shouldSnapProgressiveFirstPaint(current, target, firstFramePendingRef.current) ||
      shouldSnapAvailablePrefixExtension(current, target, snapAvailablePrefixExtensions)
    ) {
      clearTimer();
      displayedRef.current = target;
      setDisplayedSource(target);
      return clearTimer;
    }
    if (shouldProgressivelyReveal(current, target)) {
      scheduleToward(current, target);
      return clearTimer;
    }

    clearTimer();
    if (current !== target) {
      displayedRef.current = target;
      setDisplayedSource(target);
    }
    return clearTimer;
  }, [caption.id, revealTarget, snapAvailablePrefixExtensions]);

  useEffect(() => {
    if (!firstFramePendingRef.current) {
      return;
    }
    let raf = 0;
    const commitFirstFrame = (): void => {
      if (idRef.current !== caption.id || targetRef.current !== revealTarget) {
        return;
      }
      firstFramePendingRef.current = false;
      if (!displayedRef.current.trim() && isSingleGraphemeCaptionSurface(targetRef.current)) {
        displayedRef.current = targetRef.current;
        setDisplayedSource(targetRef.current);
      }
    };
    if (typeof requestAnimationFrame === "function") {
      raf = requestAnimationFrame(commitFirstFrame);
    }
    const fallback = setTimeout(commitFirstFrame, PROGRESSIVE_FIRST_PAINT_COALESCE_MS);
    return () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      clearTimeout(fallback);
    };
  }, [caption.id, revealTarget]);

  // Caught up: keep the full caption so overlay paging/offsets stay authoritative.
  if (paintSource === revealTarget) {
    return caption;
  }
  if (shouldHoldSingleGraphemeFirstPaint(paintSource, revealTarget, firstFramePendingRef.current)) {
    const held: CaptionPayload = { ...caption, sourceText: "" };
    delete held.sentenceEndOffsets;
    delete held.softBreakOffsets;
    return held;
  }
  return alignCaptionOffsetsToPaintedSource(caption, paintSource);
};
