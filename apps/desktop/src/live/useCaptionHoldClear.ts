import { useEffect, useRef } from "react";
import {
  captionHoldClearDelayMs,
  captionHoldClearEpoch,
  logCaptionDisplayLifecycle,
} from "../core/caption-hold-clear";
import type { CaptionPayload } from "../core/types";

/**
 * Blank the live caption after a short hold once recognition stops updating,
 * so finalized text does not remain until the next utterance.
 *
 * The callback receives the epoch that scheduled the timer. Callers must ignore
 * clears whose epoch no longer matches the visible caption — a replacement
 * utterance can land before React clears the previous timeout.
 */
export const useCaptionHoldClear = (
  caption: CaptionPayload,
  onClear: (expectedEpoch: string) => void,
): void => {
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;
  // Read the latest plate without listing `caption` as an effect dependency.
  // Adding it would reset the hold timer on every revision and keep stale text.
  const captionRef = useRef(caption);
  captionRef.current = caption;

  const holdClearDelay = captionHoldClearDelayMs(caption);
  const holdClearEpoch = captionHoldClearEpoch(caption);

  useEffect(() => {
    if (holdClearDelay == null || holdClearEpoch.length === 0) {
      return;
    }
    const scheduledEpoch = holdClearEpoch;
    logCaptionDisplayLifecycle("hold", captionRef.current);
    const timer = setTimeout(() => {
      onClearRef.current(scheduledEpoch);
    }, holdClearDelay);
    return () => {
      clearTimeout(timer);
    };
  }, [holdClearDelay, holdClearEpoch]);
};
