import { useEffect, useRef, useState } from "react";
import { captionGraphemes } from "../overlay/captions";
import {
  advanceProgressiveReveal,
  progressiveRevealStepMs,
  shouldProgressivelyReveal,
} from "../core/progressive-caption-reveal";
import type { CaptionPayload } from "../core/types";

/**
 * Reveal newly recognized source graphemes one-by-one so Live/Syphon captions
 * grow like こ → こん → こんにちは as ASR hypotheses lengthen.
 *
 * Only characters already present in the latest recognition target are shown;
 * the helper never invents text ahead of ASR.
 */
export const useProgressiveCaptionReveal = (caption: CaptionPayload): CaptionPayload => {
  const [displayedSource, setDisplayedSource] = useState(caption.sourceText);
  const displayedRef = useRef(displayedSource);
  const targetRef = useRef(caption.sourceText);
  const idRef = useRef(caption.id);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  displayedRef.current = displayedSource;

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
      clearTimer();
      if (shouldProgressivelyReveal("", target)) {
        const first = advanceProgressiveReveal("", target);
        displayedRef.current = first;
        setDisplayedSource(first);
        scheduleToward(first, target);
      } else {
        displayedRef.current = target;
        setDisplayedSource(target);
      }
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

  if (displayedSource === caption.sourceText) {
    return caption;
  }
  return { ...caption, sourceText: displayedSource };
};
