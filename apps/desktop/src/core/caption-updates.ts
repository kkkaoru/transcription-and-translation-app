import type { CaptionPayload } from "./types";

const trim = (value: string): string => value.trim();

const hasText = (value: string): boolean => trim(value).length > 0;

const receivedAtOf = (caption: CaptionPayload): number =>
  typeof caption.receivedAt === "number" && Number.isFinite(caption.receivedAt)
    ? caption.receivedAt
    : 0;

const startedAtOf = (caption: CaptionPayload): number =>
  typeof caption.startedAt === "number" && Number.isFinite(caption.startedAt)
    ? caption.startedAt
    : 0;

/** Compare two revisions for one utterance (audio start before event receipt). */
const isOlderSameIdRevision = (current: CaptionPayload, next: CaptionPayload): boolean => {
  const currentStartedAt = startedAtOf(current);
  const nextStartedAt = startedAtOf(next);
  if (currentStartedAt > 0 && nextStartedAt > 0 && nextStartedAt !== currentStartedAt) {
    return nextStartedAt < currentStartedAt;
  }
  return receivedAtOf(next) < receivedAtOf(current);
};

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

/** Max wall-clock gap for chunks that may share rolling ASR context. */
const SOURCE_CONTINUATION_GAP_MS = 3_200;
/**
 * A short Japanese chunk can be a perfectly valid prefix even when it ends
 * in a content word (for example `あつい`).  Parapper may close an interim
 * segment at a natural breath, so do not require a particle-only suffix in
 * that bounded case.  The timing and same-utterance checks remain the safety
 * boundary; this is deliberately script/length based rather than a custom
 * word dictionary.
 */
const SHORT_SOURCE_CONTINUATION_MAX_CHARS = 8;
const sourceBoundary = /[。．！？!?]$/u;
const incompleteSourceEnding =
  /(?:は|が|を|に|へ|で|と|も|の|や|か|ね|よ|な|ま|て|is|are|the|a|an|to|of|and|but|with|for|in|on|at)$/iu;
const japaneseSourceText = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]+$/u;

const isShortJapaneseContinuation = (current: CaptionPayload, next: CaptionPayload): boolean => {
  const currentText = trim(current.sourceText);
  const nextText = trim(next.sourceText);
  if (
    current.id !== next.id ||
    current.stage !== "source" ||
    next.stage !== "source" ||
    current.isFinal === true ||
    next.isFinal === true ||
    sourceBoundary.test(currentText) ||
    sourceBoundary.test(nextText) ||
    [...currentText].length > SHORT_SOURCE_CONTINUATION_MAX_CHARS ||
    [...currentText].length === 0 ||
    [...nextText].length === 0
  ) {
    return false;
  }
  return japaneseSourceText.test(currentText) && japaneseSourceText.test(nextText);
};

/**
 * A stable audio utterance can produce several source-only revisions while a
 * long phrase is still being spoken.  Those revisions are not necessarily
 * particles or short words: a 640 ms window may end at any mora (for example
 * `となりのきゃくはよく`), so requiring a lexical/incomplete ending drops the
 * next suffix and makes a single sentence appear as a stream of tiny captions.
 * Same-id, advancing, non-final source payloads are safe to append because the
 * microphone rotates the id after a full gated-silence boundary.  Prefix and
 * overlap checks still run first, so normal ASR revisions are not duplicated.
 */
const isAdvancingSameIdSource = (current: CaptionPayload, next: CaptionPayload): boolean =>
  current.id === next.id &&
  current.stage === "source" &&
  next.stage === "source" &&
  current.isFinal !== true &&
  next.isFinal !== true &&
  startedAtOf(next) > startedAtOf(current);

const isSourceStagePayload = (caption: CaptionPayload): boolean =>
  caption.stage === "source" ||
  (caption.stage === undefined && sequenceOf(caption) === 0 && !hasText(caption.translationText));

const sourceOverlapLength = (current: string, next: string): number => {
  const max = Math.min(current.length, next.length);
  for (let length = max; length >= 2; length -= 1) {
    if (current.endsWith(next.slice(0, length))) {
      return length;
    }
  }
  return 0;
};

const hasLexicalSourceContinuation = (current: CaptionPayload, next: CaptionPayload): boolean => {
  const currentText = trim(current.sourceText);
  const nextText = trim(next.sourceText);
  if (!currentText || !nextText) {
    return false;
  }
  return (
    nextText.startsWith(currentText) ||
    currentText.startsWith(nextText) ||
    sourceOverlapLength(currentText, nextText) > 0
  );
};

const hasCloseSourceTiming = (current: CaptionPayload, next: CaptionPayload): boolean => {
  const currentStartedAt =
    typeof current.startedAt === "number" && Number.isFinite(current.startedAt)
      ? current.startedAt
      : 0;
  const nextStartedAt =
    typeof next.startedAt === "number" && Number.isFinite(next.startedAt) ? next.startedAt : 0;
  if (currentStartedAt <= 0 || nextStartedAt <= 0 || nextStartedAt < currentStartedAt) {
    return false;
  }
  return nextStartedAt - currentStartedAt <= SOURCE_CONTINUATION_GAP_MS;
};

/**
 * Join source text from adjacent rolling-context revisions without duplicating
 * an overlap. A complete prior source starts a new caption; otherwise a
 * full-prefix, suffix-overlap, or short continuation can carry the phrase
 * forward. Same-id revisions only use the no-overlap suffix path when their
 * audio start advances, so equal-start semantic corrections still replace the
 * old text (for example `雨` → `晴れ`).
 */
const mergeSourceText = (
  current: CaptionPayload,
  next: CaptionPayload,
  allowNoOverlapSuffix: boolean,
): string => {
  const currentText = trim(current.sourceText);
  const nextText = trim(next.sourceText);
  if (!currentText || !nextText) {
    return nextText || currentText;
  }
  // Resolve lexical prefix/overlap first. This preserves a complete current
  // source when a later contextual revision is only a shorter prefix.
  if (nextText.startsWith(currentText)) {
    return nextText;
  }
  if (currentText.startsWith(nextText)) {
    return currentText;
  }
  const overlap = sourceOverlapLength(currentText, nextText);
  if (overlap > 0) {
    return `${currentText}${nextText.slice(overlap)}`;
  }
  // A completed prior chunk starts a new caption when there is no lexical
  // relation; otherwise a no-overlap suffix may continue an incomplete phrase.
  if (sourceBoundary.test(currentText)) {
    return nextText;
  }
  if (
    !allowNoOverlapSuffix ||
    (!incompleteSourceEnding.test(currentText) &&
      !isShortJapaneseContinuation(current, next) &&
      !isAdvancingSameIdSource(current, next))
  ) {
    return nextText;
  }
  // With no lexical overlap, only append when the two source events are close
  // enough to plausibly be adjacent rolling windows. Japanese does not need a
  // separator; Latin words do.
  const separator = /[A-Za-z0-9]$/u.test(currentText) && /^[A-Za-z0-9]/u.test(nextText) ? " " : "";
  return `${currentText}${separator}${nextText}`;
};

const mergeCrossIdSourceText = (current: CaptionPayload, next: CaptionPayload): string =>
  mergeSourceText(current, next, true);

const mergeSameIdSourceText = (current: CaptionPayload, next: CaptionPayload): string => {
  const currentStartedAt = startedAtOf(current);
  const nextStartedAt = startedAtOf(next);
  const gap = nextStartedAt - currentStartedAt;
  return mergeSourceText(
    current,
    next,
    nextStartedAt > currentStartedAt && gap <= SOURCE_CONTINUATION_GAP_MS,
  );
};

/**
 * A source-stage payload can be a newer recognition revision for the same
 * utterance.  Translation is sequence 1, so a naïve sequence comparison would
 * drop that revision whenever the translator happened to finish first.  Keep
 * the replacement opt-in to an actually changed source and a non-older event;
 * an unchanged late invoke is still ignored below to protect the translation.
 */
const isNewerSourceRevision = (current: CaptionPayload, next: CaptionPayload): boolean => {
  if (!isSourceStagePayload(next) || !hasText(next.sourceText)) {
    return false;
  }
  if (trim(next.sourceText) === trim(current.sourceText)) {
    return false;
  }

  // Audio start is the primary revision signal; receipt is the tie-breaker for
  // native event/invoke payloads that share an utterance start millisecond.
  return !isOlderSameIdRevision(current, next);
};

const isOutOfOrder = (current: CaptionPayload, next: CaptionPayload): boolean => {
  if (current.id === next.id) {
    // Provisional ASR captions synthesized client-side must never block a real backend
    // source caption with the same utterance ID, regardless of startedAt ordering.
    // The provisional carries ASR stage timing (later than pipeline/chunk start);
    // the real normalized source carries the pipeline start. Always accept the real one.
    if (current.provisional === true && next.provisional !== true && isSourceStagePayload(next)) {
      return false;
    }

    const nextSequence = sequenceOf(next);
    const currentSequence = sequenceOf(current);
    if (nextSequence > currentSequence) {
      return false;
    }

    if (nextSequence === currentSequence) {
      // Progressive source revisions use sequence 0. Keep a later revision,
      // but reject a changed source that arrived before the one on screen.
      // Identical source payloads remain no-ops (and preserve React identity).
      const sourceChanged =
        nextSequence === 0 &&
        hasText(current.sourceText) &&
        hasText(next.sourceText) &&
        trim(current.sourceText) !== trim(next.sourceText);
      if (sourceChanged) {
        return isOlderSameIdRevision(current, next);
      }
      // Translation revisions are also ordered by utterance start/receipt. This prevents
      // a late same-id translation for an older source from rolling back a
      // newer translated payload while keeping same-timestamp duplicates safe.
      return nextSequence > 0 && isOlderSameIdRevision(current, next);
    }

    // Sequence 0 normally must not regress past a translated sequence 1
    // payload.  Do allow a changed, newer recognition revision to replace the
    // source text, however; the translation remains merged until its own
    // sequence-1 update arrives.  This is the progressive path for e.g.
    // 「明日の天気は」 → 「明日の天気は晴れ」.
    return !isNewerSourceRevision(current, next);
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
 *
 * `provisional` is included so a provisional→normalized upgrade that happens
 * to produce identical text (e.g. ASR and the normalizer agree verbatim)
 * still counts as a real change — the caller must still clear the reduced-
 * emphasis provisional styling even though the visible characters match.
 */
export const captionsDisplayEqual = (a: CaptionPayload, b: CaptionPayload): boolean =>
  a.id === b.id &&
  a.sourceText === b.sourceText &&
  a.translationText === b.translationText &&
  a.stage === b.stage &&
  a.sequence === b.sequence &&
  a.isFinal === b.isFinal &&
  Boolean(a.provisional) === Boolean(b.provisional);

/**
 * Merge progressive caption events:
 * - source-ready (empty translation) paints immediately
 * - a frontend-synthesized provisional ASR caption (see
 *   {@link CaptionPayload.provisional}) paints immediately on receipt and is
 *   replaced in place (same id, no new caption entry) once the normalized
 *   `source` caption for the same id arrives
 * - same-id progressive ASR → normalize upgrades sourceText without clearing UI
 * - same-id translation fills in without blocking source
 * - nearby rolling-context source chunks can continue text across backend ids
 * - late updates for older chunks are dropped
 * - unchanged late same-id source-stage results after translation are dropped
 * - newer same-id source revisions replace the visible source even if translation landed first
 * - silence / empty soft-skips never clear the live caption
 * - any accepted merge clears `provisional` unless the incoming payload itself
 *   is provisional, so a real (backend) update always ends the reduced-
 *   emphasis state even though the incoming payload has no `provisional` key
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

  // A source revision may arrive after an earlier translation was painted.
  // That revision keeps the prior translation visible while the new translation
  // is computed, so a late translation for the old source must not roll the
  // source text back (or replace the translation attached to the revision).
  // Translation payloads for the current source still merge normally because
  // their sourceText matches `current.sourceText`.
  const incomingIsTranslation =
    incoming.stage === "translation" || sequenceOf(incoming) > sequenceOf(current);
  const sourceChanged =
    hasText(current.sourceText) &&
    hasIncomingSource &&
    trim(current.sourceText) !== trim(incoming.sourceText);
  if (
    sameChunk &&
    current.stage === "source" &&
    incomingIsTranslation &&
    hasIncomingTranslation &&
    sourceChanged
  ) {
    return current;
  }

  // New chunk updates that are missing source text can still be stale diagnostics,
  // placeholder updates, or partial transport events. Keep the live source visible.
  if (!sameChunk && !hasIncomingSource) {
    return current;
  }

  const currentWithoutProvisional = { ...current };
  delete currentWithoutProvisional.provisional;
  const merged: CaptionPayload = {
    ...currentWithoutProvisional,
    ...incoming,
    sourceText: hasIncomingSource
      ? sameChunk
        ? mergeSameIdSourceText(current, incoming)
        : isSourceStagePayload(incoming) &&
            (hasCloseSourceTiming(current, incoming) ||
              hasLexicalSourceContinuation(current, incoming))
          ? mergeCrossIdSourceText(current, incoming)
          : incoming.sourceText
      : current.sourceText,
    translationText: sameChunk
      ? hasIncomingTranslation
        ? incoming.translationText
        : current.translationText
      : hasIncomingTranslation
        ? incoming.translationText
        : "",
    // Only the incoming payload can mark a result provisional. A real
    // (backend-sourced) CaptionPayload never carries the `provisional` key,
    // so the `{...current, ...incoming}` spread above would otherwise leave
    // a stale `provisional: true` in place forever once accepted here.
  };
  if (incoming.provisional === true) {
    merged.provisional = true;
  }

  // Preserve React identity when event + invoke deliver the same paint payload.
  if (captionsDisplayEqual(current, merged)) {
    return current;
  }

  return merged;
};
