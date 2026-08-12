import { useEffect, useRef, useState } from "react";
import {
  advanceProgressiveReveal,
  progressiveRevealStepMs,
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
 * the helper never invents text ahead of ASR.
 */
export const useProgressiveCaptionReveal = (caption: CaptionPayload): CaptionPayload => {
  const [displayedSource, setDisplayedSource] = useState(caption.sourceText);
  const [trackedId, setTrackedId] = useState(caption.id);
  const displayedRef = useRef(displayedSource);
  const targetRef = useRef(caption.sourceText);
  const idRef = useRef(caption.id);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Prefer the synced surface for this render so a new turn never commits with
  // the previous utterance's characters (React may also retry after setState).
  let paintSource = displayedSource;
  if (caption.id !== trackedId) {
    setTrackedId(caption.id);
    setDisplayedSource(caption.sourceText);
    paintSource = caption.sourceText;
    displayedRef.current = caption.sourceText;
    idRef.current = caption.id;
    targetRef.current = caption.sourceText;
  } else if (
    displayedSource !== caption.sourceText &&
    !shouldProgressivelyReveal(displayedSource, caption.sourceText)
  ) {
    setDisplayedSource(caption.sourceText);
    paintSource = caption.sourceText;
    displayedRef.current = caption.sourceText;
    targetRef.current = caption.sourceText;
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
      if (!shouldProgressivelyReveal(from, target)) {
        return;
      }
      const remaining = captionGraphemes(target).length - captionGraphemes(from).length;
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

    const target = caption.sourceText;
    const idChanged = caption.id !== idRef.current;
    idRef.current = caption.id;
    targetRef.current = target;

    if (idChanged) {
      // Render-phase sync already snapped to the full new turn.
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
  }, [caption.id, caption.sourceText]);

  if (paintSource === caption.sourceText) {
    return caption;
  }
  return { ...caption, sourceText: paintSource };
};
