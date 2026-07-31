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
 * Merge progressive caption events:
 * - source-ready (empty translation) paints immediately
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

  return {
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
};
