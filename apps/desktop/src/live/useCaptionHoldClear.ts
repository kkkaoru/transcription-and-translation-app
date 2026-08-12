import { useEffect, useRef } from "react";
import { captionHoldClearDelayMs } from "../core/caption-hold-clear";
import type { CaptionPayload } from "../core/types";

/**
 * Blank the live caption after a short hold once recognition stops updating,
 * so finalized text does not remain until the next utterance.
 */
export const useCaptionHoldClear = (caption: CaptionPayload, onClear: () => void): void => {
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;

  const holdClearDelay = captionHoldClearDelayMs(caption);
  const holdClearEpoch = [
    caption.id,
    caption.sourceText,
    caption.translationText,
    String(caption.isFinal),
    String(caption.provisional),
    String(caption.receivedAt),
  ].join("\u0000");

  useEffect(() => {
    if (holdClearDelay == null || holdClearEpoch.length === 0) {
      return;
    }
    const timer = setTimeout(() => {
      onClearRef.current();
    }, holdClearDelay);
    return () => {
      clearTimeout(timer);
    };
  }, [holdClearDelay, holdClearEpoch]);
};
