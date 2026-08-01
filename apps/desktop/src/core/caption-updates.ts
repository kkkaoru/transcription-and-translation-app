import type { CaptionPayload } from "./types";

const trim = (value: string): string => value.trim();

const hasText = (value: string): boolean => trim(value).length > 0;

const sequenceOf = (caption: CaptionPayload): number => {
  if (typeof caption.sequence === "number" && Number.isFinite(caption.sequence)) {
    return caption.sequence;
  }
  // Fall back for older payloads without stage/sequence fields.
  if (caption.stage === "translation" || caption.isFinal || hasText(caption.translationText)) {
    return 1;
  }
  return 0;
};

const isOutOfOrder = (current: CaptionPayload, next: CaptionPayload): boolean => {
  if (current.id === next.id) {
    // Same utterance: a late source-stage invoke/event must not regress past translation.
    return sequenceOf(next) < sequenceOf(current);
  }

  if (current.startedAt > 0 && next.startedAt > 0) {
    if (next.startedAt < current.startedAt) {
      return true;
    }
    if (next.startedAt === current.startedAt && next.receivedAt < current.receivedAt) {
      return true;
    }
  }

  return false;
};

/**
 * True when two captions would paint the same visible subtitle content.
 * Used to skip React state updates / native frame republish on no-op merges
 * (e.g. invoke result repeating an already-emitted progressive event).
 */
export const captionsDisplayEqual = (a: CaptionPayload, b: CaptionPayload): boolean =>
  a.id === b.id &&
  a.sourceText === b.sourceText &&
  a.translationText === b.translationText &&
  a.stage === b.stage &&
  a.sequence === b.sequence &&
  a.isFinal === b.isFinal;

/**
 * Merge progressive caption events:
 * - source-ready (empty translation) paints immediately
 * - same-id progressive ASR → normalize upgrades sourceText without clearing UI
 * - same-id translation fills in without blocking source
 * - late updates for older chunks are dropped
 * - late same-id source-stage results after translation are dropped (no stage regression)
 * - silence / empty soft-skips never clear the live caption
 */
export const mergeCaptionPayload = (
  current: CaptionPayload,
  incoming: CaptionPayload,
): CaptionPayload | null => {
  // Soft-skip silence / no-speech — keep the last live caption visible.
  if (!hasText(incoming.sourceText) && !hasText(incoming.translationText)) {
    return null;
  }

  if (isOutOfOrder(current, incoming)) {
    return null;
  }

  const sameChunk = current.id === incoming.id;
  const hasIncomingSource = hasText(incoming.sourceText);
  const hasIncomingTranslation = hasText(incoming.translationText);

  // New chunk updates that are missing source text can still be stale diagnostics,
  // placeholder updates, or partial transport events. Keep the live source visible.
  if (!sameChunk && !hasIncomingSource) {
    return current;
  }

  const merged: CaptionPayload = {
    ...current,
    ...incoming,
    sourceText: hasIncomingSource ? incoming.sourceText : current.sourceText,
    translationText: sameChunk
      ? hasIncomingTranslation
        ? incoming.translationText
        : current.translationText
      : hasIncomingTranslation
        ? incoming.translationText
        : "",
  };

  // Preserve React identity when event + invoke deliver the same paint payload.
  if (captionsDisplayEqual(current, merged)) {
    return current;
  }

  return merged;
};
