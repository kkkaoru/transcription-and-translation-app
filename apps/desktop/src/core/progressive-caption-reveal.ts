import { selectVisibleCaptionSentence } from "@caption-bridge/sentence-boundary";
import {
  captionGraphemes,
  restoreCollapsedContinuation,
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
  return restoreCollapsedContinuation(
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
 * Overlay/Syphon: the longer same-turn surface is already in the caption, so
 * paint it instead of typewriting from a committed lead. Does not wait for a
 * missing tail, and does not widen the 16ms single-grapheme first-paint hold.
 * Live keeps per-grapheme reveal after the first frame.
 */
export const shouldSnapAvailablePrefixExtension = (
  displayed: string,
  target: string,
  enabled: boolean,
): boolean => enabled && shouldProgressivelyReveal(displayed, target);

/** True when `text` is exactly one user-visible grapheme. */
export const isSingleGraphemeCaptionSurface = (text: string): boolean =>
  captionGraphemes(text.trim()).length === 1;

/**
 * Hold an empty plate for one display frame when the first hypothesis is a
 * single grapheme. ASR often extends `こ` → `こんにちは` before vsync; painting
 * the one-character prefix makes Syphon first-paint too short.
 */
export const shouldHoldSingleGraphemeFirstPaint = (
  displayed: string,
  target: string,
  firstFramePending: boolean,
): boolean => firstFramePending && !displayed.trim() && isSingleGraphemeCaptionSurface(target);

/**
 * Align a progressive paint with the offsets that describe that surface.
 *
 * Full-turn Vibrato/IPADIC offsets are measured against the latest complete
 * recognition. Mapping them onto an intermediate paint is a coordinate
 * transform, not a delete: keep prefix offsets that still sit on the paint,
 * subtract a dropped prefix for suffix paints, and drop rewrite paints that
 * have no shared scalar span. After that, drop sentence ends that would page
 * `selectVisibleCaptionSentence(paint)` to a shorter remainder (`今日はとて` →
 * `て`). Elongation-led remainders (`ー`) keep the offset because paging
 * already refuses to split there.
 */
export const alignCaptionOffsetsToPaintedSource = (
  caption: CaptionPayload,
  paintSource: string,
): CaptionPayload => {
  const paint = restoreCollapsedContinuation(caption.sourceText, paintSource);
  if (paint === caption.sourceText) {
    return caption;
  }
  const aligned: CaptionPayload = { ...caption, sourceText: paint };
  const shift = paintedSourceShift(caption.sourceText, paint);
  if (shift == null) {
    delete aligned.sentenceEndOffsets;
    delete aligned.softBreakOffsets;
    return aligned;
  }
  const paintLen = unicodeScalarCount(paint);
  aligned.softBreakOffsets = transformCaptionOffsets(caption.softBreakOffsets, shift, paintLen);
  aligned.sentenceEndOffsets = dropSentenceEndsThatPageToShorterRemainder(
    paint,
    transformCaptionOffsets(caption.sentenceEndOffsets, shift, paintLen),
  );
  return aligned;
};

const unicodeScalarCount = (text: string): number => Array.from(text).length;

/**
 * Scalar start of `paint` inside `full`, or `null` when the paint is a rewrite
 * that does not share a contiguous span (kana→kanji).
 *
 * Prefix → 0. Suffix → dropped prefix length. Interior substring (paged
 * remainder mid-reveal) → that start index. Never a naive `offset ≤ paintLen`
 * clip of the full-text coordinates.
 */
const paintedSourceShift = (full: string, paint: string): number | null => {
  if (!paint) {
    return null;
  }
  if (full.startsWith(paint)) {
    return 0;
  }
  const fullChars = Array.from(full);
  const paintChars = Array.from(paint);
  if (paintChars.length === 0 || paintChars.length > fullChars.length) {
    return null;
  }
  if (full.endsWith(paint)) {
    return fullChars.length - paintChars.length;
  }
  for (let start = 1; start <= fullChars.length - paintChars.length; start += 1) {
    let matches = true;
    for (let index = 0; index < paintChars.length; index += 1) {
      if (fullChars[start + index] !== paintChars[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return start;
    }
  }
  return null;
};

const transformCaptionOffsets = (
  offsets: number[] | undefined,
  shift: number,
  paintLen: number,
): number[] | undefined => {
  if (!offsets || offsets.length === 0) {
    return offsets;
  }
  const next = offsets
    .map((offset) => offset - shift)
    .filter((offset) => offset > 0 && offset <= paintLen);
  return next.length > 0 ? next : undefined;
};

const dropSentenceEndsThatPageToShorterRemainder = (
  paint: string,
  offsets: number[] | undefined,
): number[] | undefined => {
  if (!offsets || offsets.length === 0) {
    return offsets;
  }
  const kept = offsets.filter(
    (offset) => selectVisibleCaptionSentence(paint, { sentenceEndOffsets: [offset] }) === paint,
  );
  return kept.length > 0 ? kept : undefined;
};
