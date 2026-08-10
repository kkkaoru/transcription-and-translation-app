import { collapseRunawayGraphemeRuns } from "../overlay/captions";
import type { CaptionPayload } from "./types";

const NO_TIME_MS = 0;
const SOURCE_SEQUENCE = 0;
const TRANSLATION_SEQUENCE = 1;
const MIN_OVERLAP_CHARS = 2;
const INDEX_STEP = 1;
const MAX_PENDING_CROSS_ID_TRANSLATIONS = 64;
const HIRAGANA_START_CODE_POINT = 0x3041;
const KATAKANA_START_CODE_POINT = 0x30a1;
const KATAKANA_END_CODE_POINT = 0x30f6;
const KATAKANA_TO_HIRAGANA_OFFSET = KATAKANA_START_CODE_POINT - HIRAGANA_START_CODE_POINT;

const trim = (value: string): string => value.trim();

const hasText = (value: string): boolean => trim(value).length > 0;

const receivedAtOf = (caption: CaptionPayload): number =>
  typeof caption.receivedAt === "number" && Number.isFinite(caption.receivedAt)
    ? caption.receivedAt
    : NO_TIME_MS;

const startedAtOf = (caption: CaptionPayload): number =>
  typeof caption.startedAt === "number" && Number.isFinite(caption.startedAt)
    ? caption.startedAt
    : NO_TIME_MS;

/** Compare two revisions for one utterance (audio start before event receipt). */
const isOlderSameIdRevision = (current: CaptionPayload, next: CaptionPayload): boolean => {
  const currentStartedAt = startedAtOf(current);
  const nextStartedAt = startedAtOf(next);
  if (
    currentStartedAt > NO_TIME_MS &&
    nextStartedAt > NO_TIME_MS &&
    nextStartedAt !== currentStartedAt
  ) {
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
    return TRANSLATION_SEQUENCE;
  }
  return SOURCE_SEQUENCE;
};

/**
 * Translation completion can race the next source caption.  The live view has
 * one visible caption slot, so attaching an older translation to the newer
 * source would silently change its meaning.  Keep those completions in a
 * bounded side channel instead; a history/diagnostic consumer can claim the
 * payload for its original utterance ID without making the live slot regress.
 */
export interface CaptionMergeDiagnostics {
  /** Number of first-time IDs inserted into the bounded pending store. */
  crossIdTranslationIdsSaved: number;
  pendingCrossIdTranslations: number;
}

let crossIdTranslationIdsSaved = 0;
const pendingCrossIdTranslations = new Map<string, CaptionPayload>();

/**
 * Preserve a cross-ID translation outside React state updaters.
 *
 * The bounded store is intentionally keyed by utterance ID. Revisions for an
 * already-pending ID may replace its payload, but do not increment the
 * first-insert counter.
 */
export const savePendingCaptionTranslation = (caption: CaptionPayload): boolean => {
  // Gate empty/whitespace id: a malformed or placeholder payload (e.g. the
  // "empty" caption right after reset, or a silence skip) must never occupy a
  // Map key or inflate the saved counter. The caller still receives the merge
  // result, but side-channel storage is suppressed.
  if (!caption.id.trim()) {
    return false;
  }
  if (!pendingCrossIdTranslations.has(caption.id)) {
    while (pendingCrossIdTranslations.size >= MAX_PENDING_CROSS_ID_TRANSLATIONS) {
      const oldestId = pendingCrossIdTranslations.keys().next().value;
      if (typeof oldestId !== "string") {
        break;
      }
      pendingCrossIdTranslations.delete(oldestId);
    }
  }

  const previous = pendingCrossIdTranslations.get(caption.id);
  const shouldStore = !previous || !isOlderSameIdRevision(previous, caption);
  if (!shouldStore) {
    return false;
  }

  // Count IDs, not every newer revision stored for an existing ID.
  if (!previous) {
    crossIdTranslationIdsSaved += 1;
  }
  pendingCrossIdTranslations.set(caption.id, { ...caption });
  return true;
};

/** Return and remove a translation preserved for a different caption ID. */
export const takePendingCaptionTranslation = (id: string): CaptionPayload | null => {
  const pending = pendingCrossIdTranslations.get(id);
  if (!pending) {
    return null;
  }
  pendingCrossIdTranslations.delete(id);
  return { ...pending };
};

/** Inspect cross-ID translation preservation without mutating the pending store. */
export const getCaptionMergeDiagnostics = (): CaptionMergeDiagnostics => ({
  crossIdTranslationIdsSaved,
  pendingCrossIdTranslations: pendingCrossIdTranslations.size,
});

/** Clear caption merge diagnostics and pending cross-ID translations. */
export const clearCaptionMergeDiagnostics = (): void => {
  crossIdTranslationIdsSaved = 0;
  pendingCrossIdTranslations.clear();
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
    [...currentText].length === NO_TIME_MS ||
    [...nextText].length === NO_TIME_MS
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
  (caption.stage === undefined &&
    sequenceOf(caption) === SOURCE_SEQUENCE &&
    !hasText(caption.translationText));

const sourceOverlapLength = (current: string, next: string): number => {
  const max = Math.min(current.length, next.length);
  for (let length = max; length >= MIN_OVERLAP_CHARS; length -= INDEX_STEP) {
    if (current.endsWith(next.slice(0, length))) {
      return length;
    }
  }
  return NO_TIME_MS;
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
    sourceOverlapLength(currentText, nextText) > NO_TIME_MS
  );
};

const hasCloseSourceTiming = (current: CaptionPayload, next: CaptionPayload): boolean => {
  const currentStartedAt =
    typeof current.startedAt === "number" && Number.isFinite(current.startedAt)
      ? current.startedAt
      : NO_TIME_MS;
  const nextStartedAt =
    typeof next.startedAt === "number" && Number.isFinite(next.startedAt)
      ? next.startedAt
      : NO_TIME_MS;
  if (
    currentStartedAt <= NO_TIME_MS ||
    nextStartedAt <= NO_TIME_MS ||
    nextStartedAt < currentStartedAt
  ) {
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
 *
 * Every accepted join is run through Kanji-stutter collapse so a rolling
 * `為` → `為為` → `為為為…` revision cannot accumulate on screen.
 */
const mergeSourceText = (
  current: CaptionPayload,
  next: CaptionPayload,
  allowNoOverlapSuffix: boolean,
): string => {
  const currentText = trim(current.sourceText);
  const nextText = trim(next.sourceText);
  if (!currentText || !nextText) {
    return collapseRunawayGraphemeRuns(nextText || currentText);
  }
  // Resolve lexical prefix/overlap first. This preserves a complete current
  // source when a later contextual revision is only a shorter prefix.
  if (nextText.startsWith(currentText)) {
    return collapseRunawayGraphemeRuns(nextText);
  }
  if (currentText.startsWith(nextText)) {
    return collapseRunawayGraphemeRuns(currentText);
  }
  const overlap = sourceOverlapLength(currentText, nextText);
  if (overlap > NO_TIME_MS) {
    return collapseRunawayGraphemeRuns(`${currentText}${nextText.slice(overlap)}`);
  }
  // A completed prior chunk starts a new caption when there is no lexical
  // relation; otherwise a no-overlap suffix may continue an incomplete phrase.
  if (sourceBoundary.test(currentText)) {
    return collapseRunawayGraphemeRuns(nextText);
  }
  if (
    !allowNoOverlapSuffix ||
    (!incompleteSourceEnding.test(currentText) &&
      !isShortJapaneseContinuation(current, next) &&
      !isAdvancingSameIdSource(current, next))
  ) {
    return collapseRunawayGraphemeRuns(nextText);
  }
  // With no lexical overlap, only append when the two source events are close
  // enough to plausibly be adjacent rolling windows. Japanese does not need a
  // separator; Latin words do.
  const separator = /[A-Za-z0-9]$/u.test(currentText) && /^[A-Za-z0-9]/u.test(nextText) ? " " : "";
  const joined = `${currentText}${separator}${nextText}`;
  // Guard against pathological single-grapheme stutter appends (為為為…).
  if ([...nextText].length === 1 && currentText.endsWith(nextText)) {
    return collapseRunawayGraphemeRuns(currentText);
  }
  return collapseRunawayGraphemeRuns(joined);
};

const mergeCrossIdSourceText = (current: CaptionPayload, next: CaptionPayload): string => {
  // A finalized turn is a hard caption boundary. Do not let a repeated suffix
  // from a genuinely new turn reopen it through the lexical-overlap path.
  return current.isFinal === true ? trim(next.sourceText) : mergeSourceText(current, next, true);
};

/**
 * A Parapper turn usually preserves `id` across interim/final revisions, but
 * older sidecars can rotate ids when a completed segment is normalized.  A
 * cross-id replacement is safe only when AzooKey reports exactly the same
 * reading: an extended reading is a rolling continuation and must append,
 * while an equal reading is the same utterance rendered with a new surface.
 * This keeps the merge generic and avoids a surface/dictionary heuristic.
 */
const isLikelyCrossIdSourceRevision = (current: CaptionPayload, next: CaptionPayload): boolean => {
  if (
    !isSourceStagePayload(current) ||
    !isSourceStagePayload(next) ||
    !hasText(current.sourceText) ||
    !hasText(next.sourceText)
  ) {
    return false;
  }

  const currentText = trim(current.sourceText);
  const nextText = trim(next.sourceText);
  if (
    nextText.startsWith(currentText) ||
    currentText.startsWith(nextText) ||
    sourceOverlapLength(currentText, nextText) > NO_TIME_MS
  ) {
    return false;
  }

  const currentReading = trimmedAzookeyReading(current);
  const nextReading = trimmedAzookeyReading(next);
  return Boolean(currentReading && nextReading && currentReading === nextReading);
};

const normalizeAzookeyReading = (value: string): string =>
  [...value.normalize("NFKC")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? NO_TIME_MS;
      return codePoint >= KATAKANA_START_CODE_POINT && codePoint <= KATAKANA_END_CODE_POINT
        ? String.fromCodePoint(codePoint - KATAKANA_TO_HIRAGANA_OFFSET)
        : character;
    })
    .join("");

const trimmedAzookeyReading = (caption: CaptionPayload): string =>
  typeof caption.azookeyInputText === "string"
    ? normalizeAzookeyReading(caption.azookeyInputText.trim())
    : "";

/**
 * A normalizer can rewrite the same rolling span from kana to kanji. When the
 * incoming AzooKey reading is the current reading or a strict continuation of
 * it, the two surfaces describe one span and the incoming normalized surface
 * replaces the old one. If either reading is missing, retain the historical
 * lexical/rolling merge behavior instead of guessing from surface text.
 */
const hasSameOrExtendedAzookeyReading = (
  current: CaptionPayload,
  next: CaptionPayload,
): boolean => {
  const currentReading = trimmedAzookeyReading(current);
  const nextReading = trimmedAzookeyReading(next);
  return Boolean(
    currentReading &&
      nextReading &&
      (nextReading === currentReading || nextReading.startsWith(currentReading)),
  );
};

const mergeSameIdSourceText = (current: CaptionPayload, next: CaptionPayload): string => {
  if (
    current.id === next.id &&
    current.provisional === true &&
    next.provisional !== true &&
    isSourceStagePayload(current) &&
    isSourceStagePayload(next)
  ) {
    return next.sourceText;
  }

  if (hasSameOrExtendedAzookeyReading(current, next)) {
    // A truncated revision with a shorter reading/surface must not erase the
    // longer same-id interim that already painted the utterance tail.
    const currentText = trim(current.sourceText);
    const nextText = trim(next.sourceText);
    const currentReading = trimmedAzookeyReading(current);
    const nextReading = trimmedAzookeyReading(next);
    if (
      currentText &&
      nextText &&
      [...currentText].length > [...nextText].length &&
      currentReading &&
      nextReading &&
      currentReading.startsWith(nextReading) &&
      currentReading !== nextReading
    ) {
      return currentText;
    }
    return next.sourceText;
  }

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
 * Decide whether a cross-id source pair may enter {@link mergeCrossIdSourceText}.
 *
 * Parapper turn ids are stable per utterance (`parapper:session:turnSession:turnId`),
 * so two different Parapper ids are different turns. Close timing alone must not
 * concatenate them when an earlier turn is still non-final (the output queue can
 * interleave turn N+1 ahead of turn N's final). Legacy chunk ids still allow a
 * close-timing no-overlap suffix for rolling ASR windows.
 */
const canMergeCrossIdSource = (current: CaptionPayload, next: CaptionPayload): boolean => {
  const bothUnset = startedAtOf(current) === NO_TIME_MS && startedAtOf(next) === NO_TIME_MS;
  const bothParapperTurns = current.id.startsWith("parapper:") && next.id.startsWith("parapper:");
  const related =
    hasLexicalSourceContinuation(current, next) || hasSameOrExtendedAzookeyReading(current, next);
  if (related && bothParapperTurns) {
    // Parapper turn ids are stable per utterance, so two different Parapper
    // ids are two distinct utterances. A reading/lexical relation plus close
    // timing is still not enough to concatenate them: the exact-reading
    // same-utterance id-rotation path is handled earlier via
    // isLikelyCrossIdSourceRevision, and everything else must stay separate.
    return false;
  }
  if (related) {
    return hasCloseSourceTiming(current, next) || bothUnset;
  }

  if (bothParapperTurns) {
    return false;
  }

  // Legacy rolling-context chunks can continue an incomplete phrase across ids
  // when the audio starts are still inside the continuation window.
  return hasCloseSourceTiming(current, next);
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
    // The Tauri event channel and the invoke that resolves the normalized
    // caption are independent deliveries.  A pipeline:stage ASR event can
    // therefore arrive after the real normalized source even though the
    // backend emitted it first.  Once a non-provisional source is on screen,
    // never append that late raw-kana revision as a rolling suffix (for
    // example `明日は` + `あしたは`); keep the canonical source instead.
    if (
      current.provisional !== true &&
      next.provisional === true &&
      hasText(current.sourceText) &&
      isSourceStagePayload(next)
    ) {
      return true;
    }

    const nextSequence = sequenceOf(next);
    const currentSequence = sequenceOf(current);

    // A completed source turn is terminal at this merge boundary.  The event
    // and invoke paths can race, so an earlier interim may be delivered after
    // its final counterpart; receipt time alone must not let that stale
    // interim replace the completed text.
    if (
      currentSequence === SOURCE_SEQUENCE &&
      nextSequence === SOURCE_SEQUENCE &&
      current.isFinal === true &&
      next.isFinal !== true &&
      isSourceStagePayload(current) &&
      isSourceStagePayload(next)
    ) {
      return true;
    }

    // Parapper backdates a final caption's `startedAt` by its measured audio
    // duration, while an interim has no duration and therefore starts at the
    // receive time.  A final for the same source turn must still replace that
    // interim even though its audio start is numerically earlier.  The
    // persistent stream queue already orders/filters turn cursors, so this is
    // only the completion upgrade at the caption merge boundary.
    if (
      currentSequence === SOURCE_SEQUENCE &&
      nextSequence === SOURCE_SEQUENCE &&
      current.isFinal !== true &&
      next.isFinal === true &&
      isSourceStagePayload(current) &&
      isSourceStagePayload(next)
    ) {
      return false;
    }

    if (nextSequence > currentSequence) {
      return false;
    }

    if (nextSequence === currentSequence) {
      // Progressive source revisions use sequence 0. Keep a later revision,
      // but reject a changed source that arrived before the one on screen.
      // Identical source payloads remain no-ops (and preserve React identity).
      const sourceChanged =
        nextSequence === SOURCE_SEQUENCE &&
        hasText(current.sourceText) &&
        hasText(next.sourceText) &&
        trim(current.sourceText) !== trim(next.sourceText);
      if (sourceChanged) {
        return isOlderSameIdRevision(current, next);
      }
      // Translation revisions are also ordered by utterance start/receipt. This prevents
      // a late same-id translation for an older source from rolling back a
      // newer translated payload while keeping same-timestamp duplicates safe.
      return nextSequence >= TRANSLATION_SEQUENCE && isOlderSameIdRevision(current, next);
    }

    // Sequence 0 normally must not regress past a translated sequence 1
    // payload.  Do allow a changed, newer recognition revision to replace the
    // source text, however; the translation remains merged until its own
    // sequence-1 update arrives.  This is the progressive path for e.g.
    // 「明日の天気は」 → 「明日の天気は晴れ」.
    return !isNewerSourceRevision(current, next);
  }

  const currentStartedAt = startedAtOf(current);
  const nextStartedAt = startedAtOf(next);
  if (currentStartedAt > NO_TIME_MS && nextStartedAt > NO_TIME_MS) {
    if (nextStartedAt < currentStartedAt) {
      return true;
    }
    if (nextStartedAt === currentStartedAt && receivedAtOf(next) < receivedAtOf(current)) {
      return true;
    }
    return false;
  }

  // Legacy/transport payloads can use zero as an unknown audio start. In
  // that case retain ordering protection between utterance ids using receipt
  // time rather than treating every event as a newer caption.
  return receivedAtOf(next) < receivedAtOf(current);
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

  const sameChunk = current.id === incoming.id;
  const hasIncomingSource = hasText(incoming.sourceText);
  const hasIncomingTranslation = hasText(incoming.translationText);
  const incomingIsTranslationPayload = sequenceOf(incoming) >= TRANSLATION_SEQUENCE;
  const crossIdTranslation = !sameChunk && incomingIsTranslationPayload && hasIncomingTranslation;

  // A translator may finish turn N after turn N+1 has already become the
  // visible caption. Never merge that text into N+1 (whether the payload also
  // carries sourceText or is translation-only). Preserve it by utterance ID
  // for history/debug consumers instead. Translation-only payloads return the
  // current reference so the visible caption is explicitly unchanged; the
  // source-bearing legacy path keeps its null/drop contract after the ordering
  // guard below.
  if (crossIdTranslation) {
    savePendingCaptionTranslation(incoming);
    if (!hasIncomingSource) {
      return current;
    }
  }

  if (isOutOfOrder(current, incoming)) {
    return null;
  }

  if (crossIdTranslation) {
    // A cross-ID translation with source text is still never eligible to
    // replace the current live slot. The older source-bearing path reaches
    // here only when its timing is not stale; retain the current caption while
    // the side channel holds the original payload.
    return current;
  }

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

  const resolveMergedSourceText = (): string => {
    if (!hasIncomingSource) {
      return current.sourceText;
    }
    if (sameChunk) {
      return mergeSameIdSourceText(current, incoming);
    }
    if (isSourceStagePayload(incoming) && isLikelyCrossIdSourceRevision(current, incoming)) {
      return collapseRunawayGraphemeRuns(trim(incoming.sourceText));
    }
    if (isSourceStagePayload(incoming) && canMergeCrossIdSource(current, incoming)) {
      return mergeCrossIdSourceText(current, incoming);
    }
    return collapseRunawayGraphemeRuns(incoming.sourceText);
  };

  const currentWithoutProvisional = { ...current };
  delete currentWithoutProvisional.provisional;
  const merged: CaptionPayload = {
    ...currentWithoutProvisional,
    ...incoming,
    sourceText: resolveMergedSourceText(),
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
