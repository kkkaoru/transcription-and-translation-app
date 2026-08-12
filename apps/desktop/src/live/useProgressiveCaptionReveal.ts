import { useEffect, useRef, useState } from "react";
import {
  advanceProgressiveReveal,
  immediateProgressiveRevealStart,
  progressiveRevealStepMs,
  resolveProgressiveRevealSourceTarget,
  shouldProgressivelyReveal,
} from "../core/progressive-caption-reveal";
import type { CaptionPayload } from "../core/types";
import { captionGraphemes } from "../overlay/captions";

/**
 * Reveal newly recognized source graphemes one-by-one so Live/Syphon captions
 * grow like こ → こん → こんにちは as ASR hypotheses lengthen within a turn.
 *
 * Utterance id changes and non-prefix rewrites snap immediately so the previous
 * turn's characters never paint under the new caption (and switches stay fast).
 *
 * Only characters already present in the latest recognition target are shown;
 * the helper never invents text ahead of ASR. An empty plate always paints the
 * first grapheme on the same update that starts progressive growth so viewers
 * never wait a full step interval on a blank caption. The reveal target is the
 * newest visible sentence (same paging as the overlay), not the raw
 * multi-clause `sourceText`, so finished-clause paging cannot collapse a
 * mid-reveal prefix to a single grapheme.
 */
export const useProgressiveCaptionReveal = (caption: CaptionPayload): CaptionPayload => {
  const revealTarget = resolveProgressiveRevealSourceTarget(caption);
  const [displayedSource, setDisplayedSource] = useState(revealTarget);
  const [trackedId, setTrackedId] = useState(caption.id);
  const displayedRef = useRef(displayedSource);
  const targetRef = useRef(revealTarget);
  const idRef = useRef(caption.id);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Prefer the synced surface for this render so a new turn never commits with
  // the previous utterance's characters (React may also retry after setState).
  let paintSource = displayedSource;
  if (caption.id !== trackedId) {
    setTrackedId(caption.id);
    setDisplayedSource(revealTarget);
    paintSource = revealTarget;
    displayedRef.current = revealTarget;
    idRef.current = caption.id;
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
    // Empty plate → multi-grapheme: paint the first character this frame.
    const firstStep = immediateProgressiveRevealStart(displayedSource, revealTarget);
    setDisplayedSource(firstStep);
    paintSource = firstStep;
    displayedRef.current = firstStep;
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
      // grapheme (e.g. Strict Mode remount), do it before waiting on a timer.
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
      // Render-phase sync already snapped to the new turn's visible sentence.
      clearTimer();
      displayedRef.current = target;
      setDisplayedSource(target);
      return clearTimer;
    }

    const current = displayedRef.current;
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
  }, [caption.id, revealTarget]);

  // Caught up: keep the full caption so overlay paging/offsets stay authoritative.
  if (paintSource === revealTarget) {
    return caption;
  }
  return { ...caption, sourceText: paintSource };
};
