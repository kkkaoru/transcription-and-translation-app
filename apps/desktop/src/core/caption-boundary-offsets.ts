import { invoke } from "@tauri-apps/api/core";
import type { CaptionPayload } from "./types";

export type CaptionBoundaryToken = {
  surface: string;
  feature: string;
  charEnd: number;
};

export type CaptionBoundaryOffsets = {
  tokens: CaptionBoundaryToken[];
  sentenceEnds: number[];
  softBreaks: number[];
};

const cache = new Map<string, CaptionBoundaryOffsets>();

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

/** True when merge dropped morph offsets for a non-empty source surface. */
export const captionMissingBoundaryOffsets = (caption: CaptionPayload): boolean => {
  const text = caption.sourceText.trim();
  if (!text) {
    return false;
  }
  const hasEnds =
    Array.isArray(caption.sentenceEndOffsets) && caption.sentenceEndOffsets.length > 0;
  const hasSoft = Array.isArray(caption.softBreakOffsets) && caption.softBreakOffsets.length > 0;
  return !hasEnds || !hasSoft;
};

export const cachedCaptionBoundaryOffsets = (sourceText: string): CaptionBoundaryOffsets | null =>
  cache.get(sourceText.trim()) ?? null;

export const resetCaptionBoundaryOffsetCache = (): void => {
  cache.clear();
};

export const applyCaptionBoundaryOffsets = (
  caption: CaptionPayload,
  offsets: CaptionBoundaryOffsets,
): CaptionPayload => ({
  ...caption,
  sentenceEndOffsets: offsets.sentenceEnds,
  softBreakOffsets: offsets.softBreaks,
});

/**
 * Recompute Vibrato offsets from Rust. Cached by exact `sourceText`.
 * On invoke failure, keep the last successful offsets (or `null`) so the plate
 * is never blanked.
 */
export const fetchCaptionBoundaryOffsets = async (
  sourceText: string,
): Promise<CaptionBoundaryOffsets | null> => {
  const text = sourceText.trim();
  if (!text) {
    return null;
  }
  const cached = cache.get(text);
  if (cached) {
    return cached;
  }
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    const result = await invoke<CaptionBoundaryOffsets>("caption_boundary_offsets", { text });
    cache.set(text, result);
    return result;
  } catch {
    return cache.get(text) ?? null;
  }
};

export const ensureCaptionBoundaryOffsets = async (
  caption: CaptionPayload,
): Promise<CaptionPayload> => {
  if (!captionMissingBoundaryOffsets(caption)) {
    return caption;
  }
  const fetched = await fetchCaptionBoundaryOffsets(caption.sourceText);
  if (!fetched) {
    return caption;
  }
  return applyCaptionBoundaryOffsets(caption, fetched);
};
