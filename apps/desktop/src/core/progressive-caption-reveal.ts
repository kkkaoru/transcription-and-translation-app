import { captionGraphemes } from "../overlay/captions";

/** Delay between newly recognized graphemes while revealing a longer hypothesis. */
export const PROGRESSIVE_REVEAL_MS_PER_GRAPHEME = 12;
/** Cap so a long jump (e.g. silence interim) still finishes promptly. */
export const PROGRESSIVE_REVEAL_MAX_MS = 160;

/**
 * True when `next` is a longer recognition of the same growing utterance as
 * `previous` (prefix extension). Non-prefix rewrites (kana→kanji) jump.
 */
export const shouldProgressivelyReveal = (previous: string, next: string): boolean => {
  const prev = previous.trim();
  const nxt = next.trim();
  if (!nxt || nxt === prev) {
    return false;
  }
  if (!prev) {
    return captionGraphemes(nxt).length > 1;
  }
  return nxt.startsWith(prev) && captionGraphemes(nxt).length > captionGraphemes(prev).length;
};

/** Reveal delay for the remaining graphemes, capped for long jumps. */
export const progressiveRevealStepMs = (remainingGraphemes: number): number => {
  const safeRemaining = Math.max(0, Math.floor(remainingGraphemes));
  if (safeRemaining <= 0) {
    return 0;
  }
  const totalBudget = Math.min(
    PROGRESSIVE_REVEAL_MAX_MS,
    PROGRESSIVE_REVEAL_MS_PER_GRAPHEME * safeRemaining,
  );
  return Math.max(8, Math.floor(totalBudget / safeRemaining));
};

/**
 * Advance `displayed` by one grapheme toward `target` when target is a prefix
 * extension; otherwise snap to target.
 */
export const advanceProgressiveReveal = (displayed: string, target: string): string => {
  const next = target;
  if (displayed === next) {
    return next;
  }
  if (!shouldProgressivelyReveal(displayed, next)) {
    return next;
  }
  const targetGraphemes = captionGraphemes(next);
  if (!displayed.trim()) {
    return targetGraphemes[0] ?? next;
  }
  const displayedCount = captionGraphemes(displayed).length;
  if (displayedCount >= targetGraphemes.length) {
    return next;
  }
  return targetGraphemes.slice(0, displayedCount + 1).join("");
};
