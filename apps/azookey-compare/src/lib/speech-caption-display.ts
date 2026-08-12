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
  const latest = latestFinalSegment.replace(/\s+/gu, " ").trim();
  const paged = selectVisibleCaptionSentence(accumulated, { key: "source" });
  if (paged && paged !== accumulated) {
    // Soft mid-dump paging (e.g. after a greeting) can still leave multiple
    // unfinished utterances. Prefer the pause-delimited Web Speech final when
    // it is already the page suffix — matching Tauri overlay reset behavior.
    if (latest && accumulated.endsWith(latest) && paged.endsWith(latest)) {
      return latest;
    }
    return paged;
  }
  if (latest && (accumulated === latest || accumulated.endsWith(latest))) {
    return latest;
  }
  return paged || accumulated;
};
