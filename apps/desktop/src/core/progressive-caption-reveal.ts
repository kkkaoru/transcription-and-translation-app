import { selectVisibleCaptionSentence } from "@caption-bridge/sentence-boundary";
import {
  captionGraphemes,
  restoreCollapsedGreetingContinuation,
  sanitizeCaptionDisplayText,
} from "../overlay/captions";
import type { CaptionPayload } from "./types";

/** Delay between newly recognized graphemes while revealing a longer hypothesis. */
export const PROGRESSIVE_REVEAL_MS_PER_GRAPHEME = 12;
/** Cap so a long jump (e.g. silence interim) still finishes promptly. */
export const PROGRESSIVE_REVEAL_MAX_MS = 160;
/**
 * Hold the first visible paint for one display frame so a short first
 * hypothesis that is immediately extended does not become the Syphon/overlay
 * first caption. Matches native-renderer 2nd-frame rAF coalescing.
 */
export const PROGRESSIVE_FIRST_PAINT_COALESCE_MS = 16;

/**
 * Source string the progressive reveal should grow toward.
 *
 * Overlay/Syphon page finished clauses on punctuation, and on copulas only when
 * the next span is at least twice the lead. Revealing the raw full `sourceText`
 * character-by-character still recreates punctuated prefixes (`今日は晴れです。明`),
 * and sentence paging then collapses the plate to a one-grapheme fragment.
 * Target the same visible sentence the final paint would show so reveal
 * intermediates stay inside one clause.
 */
export const resolveProgressiveRevealSourceTarget = (caption: CaptionPayload): string => {
  const source = sanitizeCaptionDisplayText(caption.sourceText);
  return restoreCollapsedGreetingContinuation(
    source,
    selectVisibleCaptionSentence(source, {
      key: "source",
      azookeyInputText: caption.azookeyInputText,
      sentenceEndOffsets: caption.sentenceEndOffsets,
      softBreakOffsets: caption.softBreakOffsets,
      // Match overlay captionItems: only a provisional first hypothesis defers
      // copula paging, so 「です＋次節」 does not drop the lead sentence mid-reveal.
      deferSentencePaging: caption.provisional === true,
    }),
  );
};

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
 * Advance `displayed` toward `target`. An empty plate snaps to the full first
 * hypothesis; later prefix extensions grow one grapheme at a time; rewrites snap.
 */
export const advanceProgressiveReveal = (displayed: string, target: string): string => {
  const next = target;
  if (displayed === next) {
    return next;
  }
  // Empty plate must not typewriter the first hypothesis; that is a blank gap
  // on Live/Syphon until the grapheme timer catches up.
  if (!displayed.trim()) {
    return immediateProgressiveRevealStart(displayed, next);
  }
  if (!shouldProgressivelyReveal(displayed, next)) {
    return next;
  }
  const targetGraphemes = captionGraphemes(next);
  const displayedCount = captionGraphemes(displayed).length;
  if (displayedCount >= targetGraphemes.length) {
    return next;
  }
  return targetGraphemes.slice(0, displayedCount + 1).join("");
};

/**
 * First paint for a progressive jump from an empty plate.
 *
 * Callers must not wait a timer before showing the first hypothesis: paint the
 * full first visible sentence on the same update. Subsequent prefix extensions
 * still use the timer-driven grapheme steps so later growth stays live.
 */
export const immediateProgressiveRevealStart = (displayed: string, target: string): string => {
  if (displayed.trim()) {
    return displayed;
  }
  return target;
};

/**
 * First visible caption of a growing utterance must be the longest surface
 * already available. Typewriter steps start only after that first frame has
 * been committed, so a short prefix that is about to be replaced does not
 * paint to Syphon/overlay.
 */
export const shouldSnapProgressiveFirstPaint = (
  displayed: string,
  target: string,
  firstFramePending: boolean,
): boolean => firstFramePending && shouldProgressivelyReveal(displayed, target);

/**
 * Align a progressive paint with the offsets that describe that surface.
 *
 * Full-turn Vibrato/IPADIC `sentenceEndOffsets` (and soft-break indices) are
 * measured against the latest complete recognition. Applying them to an
 * intermediate progressive prefix pages away the head as soon as the paint
 * grows past an end (`selectVisibleCaptionSentence` → `sliceNewestSentence`).
 * After reveal already targets the newest clause, those full-text ends still
 * sit inside the last-sentence prefix (`今日はとて` + offset 4 → `て`).
 * Drop those pipeline ends until the paint has caught up to the reveal target.
 */
export const alignCaptionOffsetsToPaintedSource = (
  caption: CaptionPayload,
  paintSource: string,
): CaptionPayload => {
  const paint = restoreCollapsedGreetingContinuation(caption.sourceText, paintSource);
  if (paint === caption.sourceText) {
    return caption;
  }
  const aligned: CaptionPayload = { ...caption, sourceText: paint };
  delete aligned.sentenceEndOffsets;
  delete aligned.softBreakOffsets;
  return aligned;
};
