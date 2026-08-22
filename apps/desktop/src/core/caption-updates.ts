import { collapseRunawayGraphemeRuns } from "../overlay/captions";
import { recordCaptionTranslationDisposition } from "./caption-translation-diagnostics";
import type { CaptionPayload } from "./types";

const NO_TIME_MS = 0;
const SOURCE_SEQUENCE = 0;
const TRANSLATION_SEQUENCE = 1;
const MIN_OVERLAP_CHARS = 2;
const INDEX_STEP = 1;
const MAX_PAINTED_HEAD_REWRITE_CHARS = 3;
const PAINTED_HEAD_REWRITE_DENOMINATOR = 8;
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
  const shouldStore =
    !previous ||
    isNewerFinalTranslationRevision(previous, caption) ||
    !isOlderSameIdRevision(previous, caption);
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
/** Disjoint same-start clauses shorter than this are corrections (`雨`→`晴れ`), not tails. */
const MIN_DISJOINT_CLAUSE_GRAPHEMES = 4;
const sourceBoundary = /[。．！？!?]$/u;
const incompleteSourceEnding =
  /(?:は|が|を|に|へ|で|と|も|の|や|か|ね|よ|な|ま|て|is|are|the|a|an|to|of|and|but|with|for|in|on|at)$/iu;
const japaneseSourceText = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]+$/u;
/** Short ack finals that ASR sometimes substitutes for an already-painted clause. */
const SHORT_ACK_SURFACE = /^(?:はい|うん|ええ|いいえ)$/u;

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
 * Prefer an already-painted longer surface over a short ack that ASR sometimes
 * emits as a rewrite (`会議を始めます` → `はい`). Same-id always keeps the
 * longer plate; cross-id only when the ack is still inside the continuation
 * window, so a later real `はい` turn can replace.
 */
const shouldKeepSurfaceOverShortAck = (current: CaptionPayload, next: CaptionPayload): boolean => {
  if (!isSourceStagePayload(current) || !isSourceStagePayload(next)) {
    return false;
  }
  const currentText = trim(current.sourceText);
  const nextText = trim(next.sourceText);
  if (!currentText || SHORT_ACK_SURFACE.test(currentText) || !SHORT_ACK_SURFACE.test(nextText)) {
    return false;
  }
  if ([...currentText].length <= [...nextText].length) {
    return false;
  }
  if (current.id === next.id) {
    return true;
  }
  const bothUnset = startedAtOf(current) === NO_TIME_MS && startedAtOf(next) === NO_TIME_MS;
  const currentReceivedAt = receivedAtOf(current);
  const nextReceivedAt = receivedAtOf(next);
  const closeReceipt =
    currentReceivedAt > NO_TIME_MS &&
    nextReceivedAt >= currentReceivedAt &&
    nextReceivedAt - currentReceivedAt <= SOURCE_CONTINUATION_GAP_MS;
  return hasCloseSourceTiming(current, next) || bothUnset || closeReceipt;
};

/**
 * When Parapper seals a turn early, the continuation can arrive on a new id
 * (`会議を始めます` then `続きがあります`). Append that disjoint tail while
 * the tail's audio start is still inside the continuation window and not
 * earlier than the sealed lead's receipt. Two finalized turns still replace,
 * and a punctuated lead pages to the next caption instead of concatenating.
 */
const shouldAppendCloseDisjointTurnContinuation = (
  current: CaptionPayload,
  next: CaptionPayload,
): boolean => {
  if (!isSourceStagePayload(current) || !isSourceStagePayload(next)) {
    return false;
  }
  if (current.id === next.id || current.isFinal !== true || next.isFinal === true) {
    return false;
  }
  const currentText = trim(current.sourceText);
  if (!currentText || sourceBoundary.test(currentText)) {
    return false;
  }
  if (hasLexicalSourceContinuation(current, next)) {
    return false;
  }
  if (!hasCloseSourceTiming(current, next)) {
    return false;
  }
  const currentReceivedAt = receivedAtOf(current);
  if (currentReceivedAt > NO_TIME_MS && startedAtOf(next) < currentReceivedAt) {
    return false;
  }
  return shouldAppendDisjointSameTurnSurfaces(current.sourceText, next.sourceText);
};

const appendDisjointContinuation = (currentText: string, nextText: string): string => {
  const lead = trim(currentText);
  const tail = trim(nextText);
  const separator = /[A-Za-z0-9]$/u.test(lead) && /^[A-Za-z0-9]/u.test(tail) ? " " : "";
  return collapseRunawayGraphemeRuns(`${lead}${separator}${tail}`);
};

const stripElongationMarks = (text: string): string => text.replace(/[ー〜～]/gu, "");

/**
 * Surface-only half of a same-turn disjoint continuation. Queue latest-wins
 * and history keep-longer use this so a later clause is not dropped as a
 * "much shorter rewrite" of the painted lead.
 */
export const shouldAppendDisjointSameTurnSurfaces = (
  currentText: string,
  nextText: string,
): boolean => {
  const current = trim(currentText);
  const next = trim(nextText);
  if (!current || !next || current === next) {
    return false;
  }
  if (SHORT_ACK_SURFACE.test(next)) {
    return false;
  }
  if (
    next.startsWith(current) ||
    current.startsWith(next) ||
    isShorterSuffixSurface(next, current)
  ) {
    return false;
  }
  const currentBare = stripElongationMarks(current).replace(/[。．.、！？!?]+$/u, "");
  const nextBare = stripElongationMarks(next).replace(/[。．.、！？!?]+$/u, "");
  if (
    !currentBare ||
    !nextBare ||
    currentBare.includes(nextBare) ||
    nextBare.includes(currentBare)
  ) {
    return false;
  }
  if (
    [...currentBare].length < MIN_DISJOINT_CLAUSE_GRAPHEMES ||
    [...nextBare].length < MIN_DISJOINT_CLAUSE_GRAPHEMES
  ) {
    return false;
  }
  if (!japaneseSourceText.test(currentBare) || !japaneseSourceText.test(nextBare)) {
    return false;
  }
  return sharedGraphemePrefixLength(current, next) < MIN_OVERLAP_CHARS;
};

/**
 * Same-id ASR can emit two clauses of one turn without a shared prefix
 * (`会議を始めます` then `続きがあります`). That is not a shorter rewrite and
 * not an unrelated remint (those use a new id or a later `startedAt`).
 * Append so overlay does not first-paint the lead and then drop the tail.
 */
const shouldAppendDisjointSameIdContinuation = (
  current: CaptionPayload,
  next: CaptionPayload,
): boolean => {
  if (current.id !== next.id || !isSourceStagePayload(current) || !isSourceStagePayload(next)) {
    return false;
  }
  const currentStartedAt = startedAtOf(current);
  const nextStartedAt = startedAtOf(next);
  if (
    currentStartedAt <= NO_TIME_MS ||
    nextStartedAt <= NO_TIME_MS ||
    currentStartedAt !== nextStartedAt
  ) {
    return false;
  }
  return shouldAppendDisjointSameTurnSurfaces(current.sourceText, next.sourceText);
};

/**
 * Join source text from adjacent rolling-context revisions without duplicating
 * an overlap. A complete prior source starts a new caption; otherwise a
 * full-prefix, suffix-overlap, or short continuation can carry the phrase
 * forward. Same-id revisions only use the no-overlap suffix path when their
 * audio start advances, so equal-start semantic corrections still replace the
 * old text (for example `雨` → `晴れ`).
 *
 * Parapper turns emit a full growing hypothesis per id. Unrelated or shorter
 * surfaces replace the previous string instead of concatenating onto it, so a
 * mid-turn restart/correction does not leave prior utterance characters on
 * screen. Legacy chunk ids keep the historical keep-longer / append behavior.
 *
 * Every accepted join is run through Kanji-stutter collapse so a rolling
 * `為` → `為為` → `為為為…` revision cannot accumulate on screen.
 */
const isParapperTurnId = (id: string): boolean => id.startsWith("parapper:");

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
  const parapperTurn = isParapperTurnId(current.id) && current.id === next.id;
  // Resolve lexical prefix/overlap first. A later shorter prefix must not erase
  // the already-painted utterance tail (Parapper and legacy alike) — that made
  // endings flicker or disappear before the turn closed.
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
  // Parapper: no lexical relation means replace, never append old+new.
  if (parapperTurn) {
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

export const normalizeAzookeyReading = (value: string): string =>
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

const punctuationInsensitiveSource = (caption: CaptionPayload): string =>
  trim(caption.sourceText)
    .normalize("NFKC")
    .replace(/[\p{P}\p{Z}]/gu, "");

/** A normalizer may insert punctuation without changing the spoken revision. */
const hasEquivalentTranslationSource = (current: CaptionPayload, next: CaptionPayload): boolean => {
  const currentSource = punctuationInsensitiveSource(current);
  const nextSource = punctuationInsensitiveSource(next);
  return Boolean(currentSource && nextSource && currentSource === nextSource);
};

/** Same utterance grew or shrank as a prefix; keep the completed translation. */
const isSameTurnSourceContinuation = (current: CaptionPayload, next: CaptionPayload): boolean => {
  const currentSource = punctuationInsensitiveSource(current);
  const nextSource = punctuationInsensitiveSource(next);
  return Boolean(
    currentSource &&
      nextSource &&
      (currentSource.startsWith(nextSource) || nextSource.startsWith(currentSource)),
  );
};

/**
 * Parapper finals are backdated to the full audio-window start. For equivalent
 * translated surfaces, receipt order identifies the newer final revision.
 */
const isNewerFinalTranslationRevision = (current: CaptionPayload, next: CaptionPayload): boolean =>
  sequenceOf(current) >= TRANSLATION_SEQUENCE &&
  sequenceOf(next) >= TRANSLATION_SEQUENCE &&
  next.isFinal === true &&
  hasEquivalentTranslationSource(current, next) &&
  receivedAtOf(next) >= receivedAtOf(current);

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

/**
 * True when a provisional same-id revision continues an already-normalized
 * interim so the utterance tail can paint before the next normalize completes.
 *
 * After the first normalize lands, Parapper still emits longer partials. The
 * historical "drop late provisional" guard blocked those extensions and left
 * only the beginning of the utterance on screen until a later normalize (or
 * forever, when that normalize was truncated). The same restore is needed after
 * a truncated `isFinal` from completion ASR (Reazon) that raced ahead of a
 * longer Nemotron provisional.
 */
const isProgressiveProvisionalExtension = (
  current: CaptionPayload,
  next: CaptionPayload,
): boolean => {
  if (
    next.provisional !== true ||
    current.id !== next.id ||
    !isSourceStagePayload(current) ||
    !isSourceStagePayload(next) ||
    !hasText(current.sourceText) ||
    !hasText(next.sourceText)
  ) {
    return false;
  }
  const currentText = trim(current.sourceText);
  const nextText = trim(next.sourceText);
  const currentReading = trimmedAzookeyReading(current);
  const nextReading = trimmedAzookeyReading(next);
  if (currentReading && nextReading) {
    // Growing reading = same turn still speaking.
    if (nextReading.startsWith(currentReading) && nextReading !== currentReading) {
      return true;
    }
    // Equal reading with a kana surface is the late raw-ASR rewrite we still
    // want to reject. Unrelated readings still fall through: same-start
    // disjoint tails (`会議を始めます` then `続きがあります`) share an id.
    if (nextReading === currentReading) {
      return false;
    }
  }
  // Short kanji (今日は) then a longer kana ASR tail share no prefix. Treat
  // the painted surface as stale-shorter so overlay first paint can grow.
  if (isStaleShorterCaptionSurface(currentText, nextText)) {
    return true;
  }
  // A later shorter suffix/prefix of the painted lead is keep-longer, not a
  // stale rewrite. Accept so merge can retain the longer surface instead of
  // dropping the event as out-of-order (which tests as a missing caption).
  if (isShorterSameUtteranceSurface(nextText, currentText)) {
    return true;
  }
  if (shouldAppendDisjointSameIdContinuation(current, next)) {
    return true;
  }
  return nextText.startsWith(currentText) && nextText !== currentText;
};

/**
 * True when a non-provisional source would erase mid-utterance characters that
 * a newer provisional already painted.
 *
 * Parapper keeps at most one pending partial, but the in-flight normalizer for
 * an older revision still completes. That stale normalize must not replace a
 * longer provisional that was painted from a later turn cursor. Completed
 * finals bypass this guard and replace the provisional surface instead.
 */
const isStaleNormalizedAgainstProvisional = (
  current: CaptionPayload,
  next: CaptionPayload,
): boolean => {
  if (
    current.provisional !== true ||
    next.provisional === true ||
    !isSourceStagePayload(current) ||
    !isSourceStagePayload(next) ||
    !hasText(current.sourceText) ||
    !hasText(next.sourceText)
  ) {
    return false;
  }
  const currentText = trim(current.sourceText);
  const nextText = trim(next.sourceText);
  if ([...currentText].length <= [...nextText].length) {
    return false;
  }
  const currentReading = trimmedAzookeyReading(current);
  const nextReading = trimmedAzookeyReading(next);
  if (currentReading && nextReading) {
    // Later provisional reading strictly extends the stale normalize reading.
    return currentReading.startsWith(nextReading) && currentReading !== nextReading;
  }
  // Without readings, a longer provisional that already contains the normalize
  // surface as a prefix is still ahead of the in-flight older revision.
  if (currentText.startsWith(nextText) && currentText !== nextText) {
    return true;
  }
  // Overlay native-renderer often paints ASR kana (no shared kanji prefix) and
  // then a delayed `caption:update` / getLatestCaption replay delivers an older
  // in-flight normalize such as 今日は. A same-revision conversion (きょうは →
  // 今日は) stays similar length; a prefix cut of a longer tail does not.
  return isMuchShorterSurface(nextText, currentText);
};

/** True when `incoming` cannot be a full conversion of `painted` (prefix cut). */
const isMuchShorterSurface = (incoming: string, painted: string): boolean =>
  [...incoming].length * 2 < [...painted].length;

const sharedGraphemePrefixLength = (left: string, right: string): number => {
  const leftChars = [...left];
  const rightChars = [...right];
  const limit = Math.min(leftChars.length, rightChars.length);
  let shared = 0;
  while (shared < limit && leftChars[shared] === rightChars[shared]) {
    shared += 1;
  }
  return shared;
};

/**
 * True when `next` is a longer same-turn revision of `current` even though
 * conversion rewrote a mid-span, so `next` is not a clean prefix of `current`.
 */
const isLongerSameUtteranceRevision = (currentText: string, nextText: string): boolean => {
  const currentChars = [...currentText];
  const nextChars = [...nextText];
  if (nextChars.length <= currentChars.length || currentChars.length === 0) {
    return false;
  }
  const shared = sharedGraphemePrefixLength(currentText, nextText);
  return shared >= Math.max(MIN_OVERLAP_CHARS, Math.ceil(currentChars.length / 2));
};

/**
 * True when a longer `next` continues the already-painted `current` surface.
 *
 * A strict prefix extension is a continuation. A short conversion rewrite at
 * the first mismatch is also a continuation when the remaining painted
 * characters are still a prefix of `next` (してただ → してた, then more tail).
 * Sharing only a majority head is not enough: that would accept an unrelated
 * question that happens to reuse 「明日の天気は」.
 */
const isLongerSurfaceContinuation = (currentText: string, nextText: string): boolean => {
  const currentChars = [...currentText];
  const nextChars = [...nextText];
  if (nextChars.length <= currentChars.length || currentChars.length === 0) {
    return false;
  }
  if (nextText.startsWith(currentText)) {
    return true;
  }
  const shared = sharedGraphemePrefixLength(currentText, nextText);
  if (shared < MIN_OVERLAP_CHARS) {
    return false;
  }
  const remCurrent = currentChars.slice(shared);
  const remNext = nextChars.slice(shared);
  const maxRewrite = Math.max(
    INDEX_STEP,
    Math.min(
      MAX_PAINTED_HEAD_REWRITE_CHARS,
      Math.ceil(currentChars.length / PAINTED_HEAD_REWRITE_DENOMINATOR),
    ),
  );
  for (
    let dropCurrent = 0;
    dropCurrent <= Math.min(maxRewrite, remCurrent.length);
    dropCurrent += INDEX_STEP
  ) {
    for (
      let dropNext = 0;
      dropNext <= Math.min(maxRewrite, remNext.length);
      dropNext += INDEX_STEP
    ) {
      if (dropCurrent === 0 && dropNext === 0) {
        continue;
      }
      const restCurrent = remCurrent.slice(dropCurrent).join("");
      const restNext = remNext.slice(dropNext).join("");
      if (restCurrent.length === 0) {
        // The painted remainder was only the conversion rewrite; `next` still
        // has tail after that window, so this is a continuation.
        return true;
      }
      if (restNext.startsWith(restCurrent)) {
        return true;
      }
    }
  }
  return false;
};

/**
 * When `longer` continues `shorter` after a short conversion rewrite, return
 * the converted head plus any extra painted tail. Prefix extensions return
 * `longer` unchanged. Unrelated pairs return null.
 */
/**
 * True when `incoming` is a shorter truncated rewrite of already-painted
 * `painted` — a prefix cut, or a short mid-span conversion that dropped the tail.
 */
export const isTruncatedCaptionRewrite = (incoming: string, painted: string): boolean => {
  const nextText = incoming.trim();
  const currentText = painted.trim();
  if (!nextText || !currentText) {
    return false;
  }
  return isLongerSurfaceContinuation(nextText, currentText);
};

/**
 * True when `incoming` is a prefix cut or a much shorter conversion of
 * `painted` (今日は vs a long kana tail). Same-revision きょうは → 今日は stays
 * similar length and is not stale.
 */
export const isStaleShorterCaptionSurface = (incoming: string, painted: string): boolean => {
  const nextText = incoming.trim();
  const currentText = painted.trim();
  if (!nextText || !currentText || [...nextText].length >= [...currentText].length) {
    return false;
  }
  return (
    isTruncatedCaptionRewrite(nextText, currentText) || isMuchShorterSurface(nextText, currentText)
  );
};

/**
 * True when `incoming` is a shorter suffix of `painted` (hearing-check tail
 * after a greeting). Prefix cuts and mid-span conversion rewrites are handled
 * by stitch / isStaleShorterCaptionSurface instead.
 */
export const isShorterSuffixSurface = (incoming: string, painted: string): boolean => {
  const nextText = incoming.trim();
  const currentText = painted.trim();
  if (!nextText || !currentText || [...nextText].length >= [...currentText].length) {
    return false;
  }
  return currentText.endsWith(nextText);
};

/**
 * Same-utterance ASR that dropped an already-painted tail, including a
 * hearing-check suffix (`こんにちはきこえますか` → `きこえますか`) that is not
 * a prefix cut and is not always "much shorter" by grapheme count.
 */
export const isShorterSameUtteranceSurface = (incoming: string, painted: string): boolean =>
  isStaleShorterCaptionSurface(incoming, painted) || isShorterSuffixSurface(incoming, painted);

const stitchConvertedHeadWithPaintedTail = (shorter: string, longer: string): string | null => {
  if (!shorter || !longer || [...longer].length <= [...shorter].length) {
    return null;
  }
  if (longer.startsWith(shorter)) {
    return longer;
  }
  if (!isLongerSurfaceContinuation(shorter, longer)) {
    return null;
  }
  const shorterChars = [...shorter];
  const longerChars = [...longer];
  const shared = sharedGraphemePrefixLength(shorter, longer);
  const remShorter = shorterChars.slice(shared);
  const remLonger = longerChars.slice(shared);
  const maxRewrite = Math.max(
    INDEX_STEP,
    Math.min(
      MAX_PAINTED_HEAD_REWRITE_CHARS,
      Math.ceil(shorterChars.length / PAINTED_HEAD_REWRITE_DENOMINATOR),
    ),
  );
  for (
    let dropShorter = 0;
    dropShorter <= Math.min(maxRewrite, remShorter.length);
    dropShorter += INDEX_STEP
  ) {
    for (
      let dropLonger = 0;
      dropLonger <= Math.min(maxRewrite, remLonger.length);
      dropLonger += INDEX_STEP
    ) {
      if (dropShorter === 0 && dropLonger === 0) {
        continue;
      }
      const restShorter = remShorter.slice(dropShorter).join("");
      const restLonger = remLonger.slice(dropLonger).join("");
      if (restShorter.length === 0) {
        return longer;
      }
      if (restLonger.startsWith(restShorter)) {
        return `${shorter}${restLonger.slice(restShorter.length)}`;
      }
    }
  }
  return longer;
};

/**
 * After `isFinal`, accept a same-id continuation that is still the same
 * utterance: a strict longer prefix, a growing AzooKey reading, or a longer
 * surface that continues the painted characters after a short conversion
 * rewrite. Drop late shorter/equal interims, raw kana rewrites, majority-head
 * questions that replace the painted remainder, and unrelated same-id speech.
 * Genuinely new utterances should arrive with a new Parapper turn id.
 */
const isStaleNonFinalAfterFinal = (current: CaptionPayload, next: CaptionPayload): boolean => {
  const currentText = trim(current.sourceText);
  const nextText = trim(next.sourceText);
  if (!nextText) {
    return true;
  }
  if (nextText.startsWith(currentText) && nextText !== currentText) {
    return false;
  }
  if (shouldAppendDisjointSameIdContinuation(current, next)) {
    return false;
  }
  const currentReading = trimmedAzookeyReading(current);
  const nextReading = trimmedAzookeyReading(next);
  if (currentReading && nextReading) {
    if (nextReading.startsWith(currentReading) && nextReading !== currentReading) {
      return false;
    }
    // Same audio span with a longer converted surface (early final cut the
    // tail). A raw kana echo of that reading is still a late ASR rewrite.
    if (
      nextReading === currentReading &&
      isLongerSameUtteranceRevision(currentText, nextText) &&
      nextText !== nextReading
    ) {
      return false;
    }
    return true;
  }
  return !isLongerSurfaceContinuation(currentText, nextText);
};

const mergeSameIdSourceText = (current: CaptionPayload, next: CaptionPayload): string => {
  const currentText = trim(current.sourceText);
  const nextText = trim(next.sourceText);
  // Live same-id ASR can rewrite a painted greeting+hearing plate down to the
  // hearing tail. Keep the longer surface; do not concatenate a different turn.
  if (
    isSourceStagePayload(current) &&
    isSourceStagePayload(next) &&
    hasText(currentText) &&
    hasText(nextText) &&
    isShorterSuffixSurface(nextText, currentText)
  ) {
    return collapseRunawayGraphemeRuns(currentText);
  }
  // Same-id ASR can emit two clauses without a shared prefix. Keep-longer of
  // the lead would drop that tail; append so the full spoken line can paint.
  if (shouldAppendDisjointSameIdContinuation(current, next)) {
    return appendDisjointContinuation(currentText, nextText);
  }
  // Prefer a completed conversion/final, but do not let a truncated final erase
  // a longer already-painted surface (completion ASR often cuts the tail). That
  // truncation reads as worse 変換 quality on the overlay.
  if (next.isFinal === true && isSourceStagePayload(next) && hasText(next.sourceText)) {
    const currentText = trim(current.sourceText);
    const nextText = trim(next.sourceText);
    if (shouldKeepSurfaceOverShortAck(current, next)) {
      return collapseRunawayGraphemeRuns(currentText);
    }
    // Prefer a completed conversion, but keep any already-painted tail when
    // the final is a prefix cut or a short conversion rewrite of that surface.
    const stitched = stitchConvertedHeadWithPaintedTail(nextText, currentText);
    if (stitched) {
      return collapseRunawayGraphemeRuns(stitched);
    }
    // Completion ASR / a late in-flight final can be kanji for only the first
    // words (今日は) while overlay already painted a longer kana provisional.
    // Shared-prefix stitch misses that pair; keep the longer tail instead of
    // treating the short final as a full conversion.
    if (current.provisional === true && isMuchShorterSurface(nextText, currentText)) {
      return collapseRunawayGraphemeRuns(currentText);
    }
    return collapseRunawayGraphemeRuns(nextText);
  }

  // Same keep-tail rule for later non-finals. Latest-wins / a newer provisional
  // can rewrite してただ → してた and drop the still-spoken tail before a final.
  if (isSourceStagePayload(next) && hasText(next.sourceText) && hasText(current.sourceText)) {
    const currentText = trim(current.sourceText);
    const nextText = trim(next.sourceText);
    const stitched = stitchConvertedHeadWithPaintedTail(nextText, currentText);
    if (stitched && [...stitched].length > [...nextText].length) {
      return collapseRunawayGraphemeRuns(stitched);
    }
    // Short first caption (今日は) then a longer kana ASR tail share no prefix,
    // so rolling append would concatenate. Prefer the longer surface.
    if (next.provisional === true && isStaleShorterCaptionSurface(currentText, nextText)) {
      return collapseRunawayGraphemeRuns(nextText);
    }
  }

  if (
    current.id === next.id &&
    current.provisional === true &&
    next.provisional !== true &&
    isSourceStagePayload(current) &&
    isSourceStagePayload(next)
  ) {
    // Keep the painted provisional when the arriving normalize is an older
    // in-flight revision; a later non-stale normalize still upgrades in place.
    if (isStaleNormalizedAgainstProvisional(current, next)) {
      return current.sourceText;
    }
    return next.sourceText;
  }

  if (hasSameOrExtendedAzookeyReading(current, next)) {
    // A truncated non-final revision with a shorter reading/surface must not
    // erase the longer same-id interim that already painted the utterance tail.
    // Finals are handled above (keep longer on prefix truncation).
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
    // the real normalized source carries the pipeline start. Always accept the real one
    // — unless that normalize is a stale in-flight revision for an older cursor that
    // would erase mid-utterance characters the newer provisional already painted.
    if (current.provisional === true && next.provisional !== true && isSourceStagePayload(next)) {
      // Finals always merge so the completed conversion replaces any longer
      // provisional tail. Non-final stale normalizes remain out-of-order drops.
      if (next.isFinal === true) {
        return false;
      }
      return isStaleNormalizedAgainstProvisional(current, next);
    }
    // After a normalized interim is on screen, still accept a longer same-id
    // provisional so the utterance tail can paint before the next normalize.
    // Late kana rewrites that do not extend the reading/surface stay rejected.
    if (
      current.provisional !== true &&
      next.provisional === true &&
      hasText(current.sourceText) &&
      isSourceStagePayload(next)
    ) {
      if (current.isFinal === true) {
        // Finalized turns still accept a real continuation/restart on the same
        // id (early final + more speech). Only drop stale shorter/equal/kana
        // rewrites that would freeze the plate on the old final text.
        return isStaleNonFinalAfterFinal(current, next);
      }
      return !isProgressiveProvisionalExtension(current, next);
    }

    // In-flight queue drain re-paints a stale shorter provisional with a later
    // receivedAt (Date.now() at process time). A much shorter surface cannot be
    // a full conversion of the painted tail; truncated same-script rewrites
    // still merge so stitch can keep the converted head plus the spoken tail.
    if (
      current.provisional === true &&
      next.provisional === true &&
      isSourceStagePayload(current) &&
      isSourceStagePayload(next) &&
      hasText(current.sourceText) &&
      hasText(next.sourceText)
    ) {
      const currentText = trim(current.sourceText);
      const nextText = trim(next.sourceText);
      if (
        nextText !== currentText &&
        isMuchShorterSurface(nextText, currentText) &&
        !shouldAppendDisjointSameIdContinuation(current, next)
      ) {
        return true;
      }
    }

    const nextSequence = sequenceOf(next);
    const currentSequence = sequenceOf(current);

    // Parapper completion backdates the final payload to the full audio-window
    // start. A newer final translation for the same punctuation-insensitive
    // source must replace its translated interim instead of looking stale by
    // startedAt. Receipt ordering still rejects genuinely late old revisions.
    if (isNewerFinalTranslationRevision(current, next)) {
      return false;
    }

    // A completed source turn rejects late shorter/equal interims, but must
    // still accept a same-id continuation or rewrite so new characters paint
    // after an early final instead of freezing the previous surface.
    if (
      currentSequence === SOURCE_SEQUENCE &&
      nextSequence === SOURCE_SEQUENCE &&
      current.isFinal === true &&
      next.isFinal !== true &&
      isSourceStagePayload(current) &&
      isSourceStagePayload(next)
    ) {
      return isStaleNonFinalAfterFinal(current, next);
    }

    // Parapper backdates a final caption's `startedAt` by its measured audio
    // duration, while an interim has no duration and therefore starts at the
    // receive time. A same-id final must still merge even though its audio
    // start is numerically earlier — both the first completion (interim →
    // final) and a later longer completion after an early short final
    // (こんにちは → こんにちはきこえますか). Rejecting the longer final as
    // "older" freezes the plate on the prefix until hold-clear blanks it.
    // Truncated finals still reach mergeSameIdSourceText, which keeps the
    // longer already-painted surface. A backdated final that diverges from an
    // already-final surface is not that continuation and must keep ordering.
    if (
      currentSequence === SOURCE_SEQUENCE &&
      nextSequence === SOURCE_SEQUENCE &&
      next.isFinal === true &&
      isSourceStagePayload(current) &&
      isSourceStagePayload(next)
    ) {
      if (current.isFinal === true) {
        const currentText = trim(current.sourceText);
        const nextText = trim(next.sourceText);
        if (!hasText(nextText)) {
          return true;
        }
        if (
          nextText === currentText ||
          currentText.startsWith(nextText) ||
          isLongerSurfaceContinuation(currentText, nextText)
        ) {
          return false;
        }
        return isOlderSameIdRevision(current, next);
      }
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

  // Distinct Parapper turns use receipt order. Completion finals backdate
  // `startedAt` by audio duration, which can make a newer turn look older than
  // the painted final and freeze the previous characters on screen.
  if (
    current.id.startsWith("parapper:") &&
    next.id.startsWith("parapper:") &&
    current.id !== next.id
  ) {
    return receivedAtOf(next) < receivedAtOf(current);
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
 * - silence / empty soft-skips never clear the live caption (UI hold-clear
 *   blanks the plate after a short idle once updates stop)
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
  const finish = (output: CaptionPayload | null, reason: string): CaptionPayload | null => {
    recordCaptionTranslationDisposition(current, incoming, output, reason);
    return output;
  };

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
      return finish(current, "cross-id-translation-retained");
    }
  }

  if (isOutOfOrder(current, incoming)) {
    return finish(null, "out-of-order");
  }

  // Drop short-ack ASR substitutes for an already-painted longer surface.
  if (shouldKeepSurfaceOverShortAck(current, incoming)) {
    return finish(null, "short-ack-surface-kept");
  }

  if (crossIdTranslation) {
    // A cross-ID translation with source text is still never eligible to
    // replace the current live slot. The older source-bearing path reaches
    // here only when its timing is not stale; retain the current caption while
    // the side channel holds the original payload.
    return finish(current, "cross-id-translation-retained");
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
    sourceChanged &&
    !hasEquivalentTranslationSource(current, incoming)
  ) {
    if (isSameTurnSourceContinuation(current, incoming)) {
      if (hasText(current.translationText)) {
        return finish(current, "source-changed-translation");
      }
      return finish(
        {
          ...current,
          translationText: incoming.translationText,
        },
        "same-turn-translation-kept",
      );
    }
    return finish(current, "source-changed-translation");
  }

  // New chunk updates that are missing source text can still be stale diagnostics,
  // placeholder updates, or partial transport events. Keep the live source visible.
  if (!sameChunk && !hasIncomingSource) {
    return finish(current, "cross-id-missing-source");
  }

  const resolveMergedSourceText = (): string => {
    if (!hasIncomingSource) {
      return current.sourceText;
    }
    if (sameChunk) {
      return mergeSameIdSourceText(current, incoming);
    }
    if (shouldAppendCloseDisjointTurnContinuation(current, incoming)) {
      return appendDisjointContinuation(current.sourceText, incoming.sourceText);
    }
    if (isSourceStagePayload(incoming) && isLikelyCrossIdSourceRevision(current, incoming)) {
      return collapseRunawayGraphemeRuns(trim(incoming.sourceText));
    }
    if (isSourceStagePayload(incoming) && canMergeCrossIdSource(current, incoming)) {
      return mergeCrossIdSourceText(current, incoming);
    }
    return collapseRunawayGraphemeRuns(incoming.sourceText);
  };

  const mergedSourceText = resolveMergedSourceText();
  const currentSource = trim(current.sourceText);
  const nextSource = trim(mergedSourceText);
  const incomingSource = trim(incoming.sourceText);
  // Keep a painted translation only while the source is unchanged or grows as
  // a prefix extension. A rewrite / restart must clear the old translation line
  // so prior-utterance characters do not linger beside the new source.
  const sourceKeepsTranslation =
    !currentSource ||
    !nextSource ||
    nextSource === currentSource ||
    nextSource.startsWith(currentSource) ||
    hasEquivalentTranslationSource(current, incoming);

  const currentWithoutProvisional = { ...current };
  delete currentWithoutProvisional.provisional;
  const merged: CaptionPayload = {
    ...currentWithoutProvisional,
    ...incoming,
    sourceText: mergedSourceText,
    translationText: sameChunk
      ? hasIncomingTranslation
        ? incoming.translationText
        : sourceKeepsTranslation
          ? current.translationText
          : ""
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
  } else if (
    current.provisional === true &&
    nextSource === trim(current.sourceText) &&
    hasIncomingSource &&
    nextSource.length > incomingSource.length
  ) {
    // Kept the longer provisional surface over a truncated normalize/final.
    // Stay provisional so overlay copula paging does not drop the spoken tail.
    merged.provisional = true;
  } else {
    delete merged.provisional;
  }

  // Morph offsets and AzooKey readings are measured against a specific surface.
  // When we keep a longer painted/provisional surface over a truncated incoming
  // revision, adopting the incoming offsets pages mid-utterance
  // (こんにちは|きこえますか → only the tail, or 明日の天気は|… → only the suffix)
  // and hides already-recognized text. Adopting a shorter reading likewise
  // desyncs reading-prefix merge gates from the characters still on screen.
  if (
    hasIncomingSource &&
    nextSource.length > incomingSource.length &&
    nextSource !== incomingSource
  ) {
    const keptCurrentSurface = trim(current.sourceText) === nextSource;
    if (
      Array.isArray(current.sentenceEndOffsets) &&
      current.sentenceEndOffsets.length > 0 &&
      keptCurrentSurface
    ) {
      merged.sentenceEndOffsets = current.sentenceEndOffsets;
    } else {
      delete merged.sentenceEndOffsets;
    }
    if (
      Array.isArray(current.softBreakOffsets) &&
      current.softBreakOffsets.length > 0 &&
      keptCurrentSurface
    ) {
      merged.softBreakOffsets = current.softBreakOffsets;
    } else {
      delete merged.softBreakOffsets;
    }
    if (keptCurrentSurface) {
      const currentReading = trimmedAzookeyReading(current);
      const incomingReading = trimmedAzookeyReading(incoming);
      if (
        currentReading &&
        (!incomingReading || [...currentReading].length >= [...incomingReading].length) &&
        typeof current.azookeyInputText === "string"
      ) {
        merged.azookeyInputText = current.azookeyInputText;
      }
    }
  } else if (
    // Converse of the keep-longer path: accepting incoming's changed surface
    // while it omits morph offsets must not inherit ends measured against the
    // previous shorter span via `{...current, ...incoming}` (短いです|[4] then
    // 短いです続く文). Remainder-dominance also keeps that short tail from
    // replacing the lead; dropping stale offsets remains the merge-path guard.
    hasIncomingSource &&
    nextSource === incomingSource &&
    nextSource !== currentSource
  ) {
    if (!Array.isArray(incoming.sentenceEndOffsets) || incoming.sentenceEndOffsets.length === 0) {
      delete merged.sentenceEndOffsets;
    }
    if (!Array.isArray(incoming.softBreakOffsets) || incoming.softBreakOffsets.length === 0) {
      delete merged.softBreakOffsets;
    }
  }

  // A source-stage revision that changes the visible text after a final must
  // reopen the turn. Incoming payloads often omit `isFinal: false`, and leaving
  // the previous `isFinal: true` would freeze later prefix continuations.
  if (incoming.isFinal === true) {
    merged.isFinal = true;
  } else if (
    current.isFinal === true &&
    hasIncomingSource &&
    isSourceStagePayload(incoming) &&
    trim(mergedSourceText) !== trim(current.sourceText)
  ) {
    merged.isFinal = false;
  } else if (incoming.isFinal === false) {
    merged.isFinal = false;
  }

  // Preserve React identity when event + invoke deliver the same paint payload.
  if (captionsDisplayEqual(current, merged)) {
    return finish(current, "duplicate-visible-caption");
  }

  return finish(merged, "accepted");
};
