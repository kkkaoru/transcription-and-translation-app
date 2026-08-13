import { useEffect, useRef, useState } from "react";
import {
  cachedCaptionBoundaryOffsets,
  captionMissingBoundaryOffsets,
  ensureCaptionBoundaryOffsets,
} from "../core/caption-boundary-offsets";
import {
  applyCaptionFreshnessWindow,
  isCaptionFreshnessTtlExempt,
  stampGraphemePaintedAt,
} from "../core/caption-freshness";
import type { CaptionPayload } from "../core/types";

const FRESHNESS_TICK_MS = 250;

/**
 * Display-only 5s freshness window. Hold-clear and `captionRef` keep the merged
 * caption; Live/Syphon consume this result before progressive reveal.
 */
export const useCaptionFreshness = (caption: CaptionPayload): CaptionPayload => {
  const [clock, setClock] = useState(() => Date.now());
  const [resolved, setResolved] = useState<CaptionPayload>(caption);
  const previousSourceRef = useRef("");
  const idRef = useRef(caption.id);
  const paintedAtRef = useRef<number[]>([]);
  const lastGrowthAtRef = useRef(Date.now());
  const freshnessTtlExemptRef = useRef(isCaptionFreshnessTtlExempt(caption));

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClock(Date.now());
    }, FRESHNESS_TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    setClock(Date.now());
    if (!captionMissingBoundaryOffsets(caption)) {
      setResolved(caption);
      return;
    }
    const sourceText = caption.sourceText;
    let cancelled = false;
    void ensureCaptionBoundaryOffsets(caption).then((next) => {
      if (cancelled || next.sourceText !== sourceText) {
        return;
      }
      setResolved(next);
    });
    return () => {
      cancelled = true;
    };
  }, [caption]);

  const now = clock;
  let previousSource = previousSourceRef.current;
  if (caption.id !== idRef.current) {
    paintedAtRef.current = stampGraphemePaintedAt("", [], caption.sourceText, now);
    lastGrowthAtRef.current = now;
    previousSource = "";
    previousSourceRef.current = caption.sourceText;
    idRef.current = caption.id;
  } else if (caption.sourceText !== previousSourceRef.current) {
    paintedAtRef.current = stampGraphemePaintedAt(
      previousSourceRef.current,
      paintedAtRef.current,
      caption.sourceText,
      now,
    );
    lastGrowthAtRef.current = now;
    previousSource = previousSourceRef.current;
    previousSourceRef.current = caption.sourceText;
  }

  // A pure interim is TTL-exempt in applyCaptionFreshnessWindow. When it later
  // gains a translation or finalizes, restamp both clocks so the window starts
  // from that transition instead of the stale first-paint time.
  const isFreshnessTtlExempt = isCaptionFreshnessTtlExempt(caption);
  if (!isFreshnessTtlExempt && freshnessTtlExemptRef.current) {
    paintedAtRef.current = stampGraphemePaintedAt("", [], caption.sourceText, now);
    lastGrowthAtRef.current = now;
    previousSource = "";
    previousSourceRef.current = caption.sourceText;
  }
  freshnessTtlExemptRef.current = isFreshnessTtlExempt;

  const captionWithOffsets =
    resolved.sourceText === caption.sourceText && captionMissingBoundaryOffsets(caption)
      ? {
          ...caption,
          sentenceEndOffsets: resolved.sentenceEndOffsets,
          softBreakOffsets: resolved.softBreakOffsets,
        }
      : caption;
  const tokenCharEnds = cachedCaptionBoundaryOffsets(caption.sourceText)?.tokens.map(
    (token) => token.charEnd,
  );

  if (caption.id === "preview" || caption.id === "empty") {
    return caption;
  }

  return applyCaptionFreshnessWindow({
    caption: captionWithOffsets,
    now,
    graphemePaintedAt: paintedAtRef.current,
    lastGrowthAt: lastGrowthAtRef.current,
    previousSourceText: previousSource,
    tokenCharEnds,
  });
};
