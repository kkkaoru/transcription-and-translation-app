import { selectVisibleCaptionSentence } from "@caption-bridge/sentence-boundary";
import { captionGraphemes } from "../overlay/captions";
import type { CaptionPayload } from "./types";

/** Delay between newly recognized graphemes while revealing a longer hypothesis. */
export const PROGRESSIVE_REVEAL_MS_PER_GRAPHEME = 12;
/** Cap so a long jump (e.g. silence interim) still finishes promptly. */
export const PROGRESSIVE_REVEAL_MAX_MS = 160;

/**
 * Source string the progressive reveal should grow toward.
 *
 * Overlay/Syphon already page finished clauses to the newest sentence. Revealing
 * the raw full `sourceText` character-by-character recreates those clause
 * boundaries as temporary prefixes (`今日は晴れです。明`), and sentence paging
 * then collapses the plate to a one-grapheme fragment mid-animation. Target the
 * same visible sentence the final paint would show so reveal intermediates stay
 * inside one clause.
 */
export const resolveProgressiveRevealSourceTarget = (caption: CaptionPayload): string =>
  selectVisibleCaptionSentence(caption.sourceText, {
    key: "source",
    azookeyInputText: caption.azookeyInputText,
    sentenceEndOffsets: caption.sentenceEndOffsets,
    softBreakOffsets: caption.softBreakOffsets,
  });

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

/**
 * First paint for a progressive jump from an empty plate.
 *
 * Callers must not wait a full step interval before showing anything: the first
 * recognized grapheme should appear on the same update that starts progressive
 * growth. Subsequent graphemes still use the timer-driven step path.
 */
export const immediateProgressiveRevealStart = (displayed: string, target: string): string => {
  if (displayed.trim()) {
    return displayed;
  }
  if (!shouldProgressivelyReveal(displayed, target)) {
    return target;
  }
  return advanceProgressiveReveal(displayed, target);
};
