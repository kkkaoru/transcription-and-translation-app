import { captionGraphemes } from "../overlay/captions";
import type { CaptionPayload } from "./types";

/** Display-only TTL for completed caption chunks. Not a hold-clear epoch. */
export const CAPTION_FRESHNESS_MS = 5_000;

const ELONGATION = /[ー〜～]/u;
const SENTENCE_PUNCT = /[。．！？!?]/u;
const POLITE_MASU = /ます(?:[よねなわぞさか])?$/u;

export type CaptionFreshnessInput = {
  caption: CaptionPayload;
  now: number;
  graphemePaintedAt: number[];
  lastGrowthAt: number;
  previousSourceText: string;
  tokenCharEnds?: number[];
};

const unicodeScalars = (text: string): string[] => Array.from(text);

const scalarCount = (text: string): number => unicodeScalars(text).length;

/** Stamp grapheme appearance times. Prefix growth keeps earlier stamps. */
export const stampGraphemePaintedAt = (
  previousText: string,
  previousPaintedAt: readonly number[],
  nextText: string,
  now: number,
): number[] => {
  const next = captionGraphemes(nextText);
  if (next.length === 0) {
    return [];
  }
  const prev = captionGraphemes(previousText);
  if (previousText === nextText && previousPaintedAt.length === next.length) {
    return [...previousPaintedAt];
  }
  let shared = 0;
  const limit = Math.min(prev.length, next.length);
  while (shared < limit && prev[shared] === next[shared]) {
    shared += 1;
  }
  return next.map((_, index) => (index < shared ? (previousPaintedAt[index] ?? now) : now));
};

/**
 * Freshness close offsets: IPADIC completes with `E < textLen`, without 2× KEEP.
 * ます is never a close. Elongation-led remainders stay in the same chunk.
 */
export const freshnessCloseOffsets = (
  text: string,
  sentenceEndOffsets: number[] | undefined,
): number[] => {
  const chars = unicodeScalars(text);
  const textLen = chars.length;
  return [...new Set(sentenceEndOffsets ?? [])]
    .filter((end) => {
      if (!Number.isFinite(end) || end <= 0 || end >= textLen) {
        return false;
      }
      const remainder = chars.slice(end).join("");
      const first = unicodeScalars(remainder.trimStart())[0];
      if (first !== undefined && ELONGATION.test(first)) {
        return false;
      }
      const prefix = chars.slice(0, end).join("").trimEnd();
      const last = prefix.at(-1);
      if (last !== undefined && SENTENCE_PUNCT.test(last)) {
        return true;
      }
      if (POLITE_MASU.test(prefix)) {
        return false;
      }
      return true;
    })
    .sort((left, right) => left - right);
};

const roundRightToGrapheme = (text: string, scalarOffset: number): number => {
  if (scalarOffset <= 0) {
    return 0;
  }
  const graphemes = captionGraphemes(text);
  let scalar = 0;
  for (const grapheme of graphemes) {
    const length = scalarCount(grapheme);
    if (scalarOffset <= scalar) {
      return scalar;
    }
    if (scalarOffset < scalar + length) {
      return scalar + length;
    }
    scalar += length;
  }
  return scalarCount(text);
};

const walkBackElongationStart = (text: string, cut: number): number => {
  const chars = unicodeScalars(text);
  let next = cut;
  while (next > 0 && next < chars.length) {
    const character = chars[next];
    if (character !== undefined && ELONGATION.test(character)) {
      next -= 1;
      continue;
    }
    break;
  }
  return next;
};

const snapKeepFrom = (
  keepFrom: number,
  closes: number[],
  softs: number[],
  tokenCharEnds: number[],
  textLen: number,
): number => {
  if (keepFrom <= 0) {
    return 0;
  }
  const closeLeft = closes.filter((end) => end > 0 && end <= keepFrom);
  if (closeLeft.length > 0) {
    return Math.max(...closeLeft);
  }
  const softLeft = softs.filter((end) => end > 0 && end <= keepFrom);
  if (softLeft.length > 0) {
    return Math.max(...softLeft);
  }
  const nextTokenEnd = tokenCharEnds.find((end) => end > keepFrom) ?? textLen;
  const softInsideToken = softs.filter((end) => end >= keepFrom && end < nextTokenEnd);
  if (softInsideToken.length > 0) {
    return Math.min(...softInsideToken);
  }
  return keepFrom;
};

const sliceSourceFrom = (caption: CaptionPayload, keepFrom: number): CaptionPayload => {
  const chars = unicodeScalars(caption.sourceText);
  if (keepFrom <= 0) {
    return caption;
  }
  if (keepFrom >= chars.length) {
    return { ...caption, sourceText: "", translationText: "" };
  }
  const paint = chars.slice(keepFrom).join("");
  const paintLen = chars.length - keepFrom;
  const transform = (offsets: number[] | undefined): number[] | undefined => {
    if (!offsets || offsets.length === 0) {
      return offsets;
    }
    const next = offsets
      .map((offset) => offset - keepFrom)
      .filter((offset) => offset > 0 && offset <= paintLen);
    return next.length > 0 ? next : undefined;
  };
  return {
    ...caption,
    sourceText: paint,
    sentenceEndOffsets: transform(caption.sentenceEndOffsets),
    softBreakOffsets: transform(caption.softBreakOffsets),
  };
};

const newestChunkStart = (closes: number[]): number =>
  closes.length > 0 ? (closes[closes.length - 1] as number) : 0;

/**
 * Cut the display surface to the last 5s of speech, snapped to POS close/soft
 * boundaries. Does not mutate merge state, hold-clear epochs, or `captionRef`.
 */
export const applyCaptionFreshnessWindow = (input: CaptionFreshnessInput): CaptionPayload => {
  const { caption, now, lastGrowthAt, previousSourceText } = input;
  const sourceText = caption.sourceText;
  if (!sourceText.trim()) {
    return {
      ...caption,
      sourceText: "",
      translationText: "",
    };
  }
  if (caption.id === "preview" || caption.id === "empty") {
    return caption;
  }
  const graphemes = captionGraphemes(sourceText);
  const paintedAt =
    previousSourceText === sourceText && input.graphemePaintedAt.length === graphemes.length
      ? input.graphemePaintedAt
      : stampGraphemePaintedAt(previousSourceText, input.graphemePaintedAt, sourceText, now);
  if (caption.isFinal !== true && !(caption.translationText ?? "").trim()) {
    return caption;
  }
  const textLen = scalarCount(sourceText);
  const closes = freshnessCloseOffsets(sourceText, caption.sentenceEndOffsets);
  const softs = [...new Set(caption.softBreakOffsets ?? [])]
    .filter((offset) => offset > 0 && offset <= textLen)
    .sort((left, right) => left - right);
  const tokenCharEnds = [...new Set(input.tokenCharEnds ?? [])]
    .filter((offset) => offset > 0 && offset <= textLen)
    .sort((left, right) => left - right);

  let keepGrapheme = graphemes.findIndex(
    (_, index) => now - (paintedAt[index] ?? 0) < CAPTION_FRESHNESS_MS,
  );
  if (keepGrapheme < 0) {
    keepGrapheme = graphemes.length;
  }
  let keepFrom = scalarCount(graphemes.slice(0, keepGrapheme).join(""));
  const grewThisTick = sourceText !== previousSourceText;
  const chunkStart = newestChunkStart(closes);
  if (grewThisTick && keepFrom > chunkStart && keepFrom < textLen) {
    keepFrom = chunkStart;
  }
  keepFrom = roundRightToGrapheme(sourceText, keepFrom);
  keepFrom = snapKeepFrom(keepFrom, closes, softs, tokenCharEnds, textLen);
  keepFrom = walkBackElongationStart(sourceText, keepFrom);

  let display = sliceSourceFrom(caption, keepFrom);
  if (!display.sourceText.trim()) {
    if (grewThisTick) {
      display = sliceSourceFrom(caption, chunkStart);
    } else if (now >= lastGrowthAt + CAPTION_FRESHNESS_MS) {
      display = { ...caption, sourceText: "", translationText: "" };
    } else {
      display = sliceSourceFrom(caption, chunkStart);
    }
  }
  if (!display.sourceText.trim()) {
    display = { ...display, translationText: "" };
  } else {
    display = { ...display, translationText: caption.translationText };
  }
  return display;
};
