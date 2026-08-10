import { selectVisibleCaptionSentence } from "@caption-bridge/sentence-boundary";

/**
 * Live Web Speech plate text matching Tauri overlay paging.
 *
 * Continuous recognition concatenates every final. The overlay keeps only the
 * newest sentence (copula / punctuation) or, when that heuristic cannot page
 * yet, the latest pause-delimited Web Speech final.
 */
export const visibleWebSpeechCaption = (
  accumulatedFinalText: string,
  latestFinalSegment = "",
): string => {
  const accumulated = accumulatedFinalText.replace(/\s+/gu, " ").trim();
  if (!accumulated) {
    return "";
  }
  const paged = selectVisibleCaptionSentence(accumulated, { key: "source" });
  if (paged && paged !== accumulated) {
    return paged;
  }
  const latest = latestFinalSegment.replace(/\s+/gu, " ").trim();
  if (latest && (accumulated === latest || accumulated.endsWith(latest))) {
    return latest;
  }
  return paged || accumulated;
};
