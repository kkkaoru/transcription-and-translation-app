import { useEffect, useRef } from "react";
import { captionHoldClearDelayMs } from "../core/caption-hold-clear";
import type { CaptionPayload } from "../core/types";

/**
 * Blank the live caption after a short hold once recognition stops updating,
 * so finalized text does not remain until the next utterance.
 */
export const useCaptionHoldClear = (
  caption: CaptionPayload,
  onClear: () => void,
): void => {
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;

  useEffect(() => {
    const delay = captionHoldClearDelayMs(caption);
    if (delay == null) {
      return;
    }
    const timer = setTimeout(() => {
      onClearRef.current();
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [
    caption.id,
    caption.sourceText,
    caption.translationText,
    caption.isFinal,
    caption.provisional,
    caption.receivedAt,
  ]);
};
