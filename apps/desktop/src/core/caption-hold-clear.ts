import { appendStructuredLog } from "./structuredLog";
import type { CaptionPayload } from "./types";

/**
 * Readable minimum for a short finalized plate (one greeting / one short
 * line). Quality contracts require at least four seconds so the previous
 * string is not a flash.
 */
export const CAPTION_HOLD_CLEAR_MIN_MS = 4_000;

/**
 * Upper envelope under the judge stale bar (age_ms >= 8000). Two subtitle
 * lines follow the Díaz-Cintas six-second rule; longer strings must not
 * linger into a re-read / stale-caption regime.
 */
export const CAPTION_HOLD_CLEAR_MAX_MS = 7_000;

/**
 * Díaz-Cintas six-second rule: two subtitle lines stay up about six seconds.
 * Japanese live captions treat ~40 graphemes as that two-line block.
 */
export const CAPTION_HOLD_SIX_SECOND_RULE_MS = 6_000;
export const CAPTION_HOLD_TWO_LINE_GRAPHEMES = 40;

/**
 * Fallback / short-caption hold. Longer plates scale above this up to
 * {@link CAPTION_HOLD_CLEAR_MAX_MS}; do not use this as the hold for every
 * string length.
 */
export const CAPTION_HOLD_CLEAR_MS = CAPTION_HOLD_CLEAR_MIN_MS;

const CAPTION_HOLD_MS_PER_GRAPHEME =
  CAPTION_HOLD_SIX_SECOND_RULE_MS / CAPTION_HOLD_TWO_LINE_GRAPHEMES;

const SENTENCE_TERMINAL = /[。．！？!?]/u;
const COMPLETED_COPULA_END =
  /(?:ませんでした|でした|ました|ません|でしょう|だろう|だった|である|です)(?:[よねなわぞさか])?[。．！？!?]?\s*$/u;
/**
 * Frozen greetings that happen to end in は. That は is lexical, not a topic
 * particle, so these plates are finished turns and must still hold-clear.
 */
const GREETING_SURFACE = /^(?:こんにちは|こんばんは)[ー〜～]*[。．！？!?]*$/u;
/**
 * Mid-utterance syntax. Sentence-final か/ね/よ are complete and omitted.
 * Topic は is open only after {@link GREETING_SURFACE} is ruled out.
 */
const OPEN_CLAUSE_END =
  /(?:から|まで|より|など|って|では|には|とは|のは|けど|けれど|けれども|ので|が|を|に|へ|で|と|も|の|や|は|て|、|，|,)$/u;

export type CaptionDisplayLifecycle = "visible" | "hold" | "clear";

export const logCaptionDisplayLifecycle = (
  lifecycle: CaptionDisplayLifecycle,
  caption: CaptionPayload,
  nowMs: number = Date.now(),
): void => {
  const publishedAt = Math.max(0, Math.trunc(caption.receivedAt || caption.startedAt || 0));
  const ageMs = publishedAt > 0 ? Math.max(0, nowMs - publishedAt) : 0;
  const generation =
    typeof caption.captureGeneration === "number" && Number.isFinite(caption.captureGeneration)
      ? Math.trunc(caption.captureGeneration)
      : null;
  appendStructuredLog({
    level: "info",
    source: "frontend",
    stage: "display",
    chunkId: caption.id || null,
    message: `caption display lifecycle=${lifecycle} age_ms=${ageMs} generation=${generation ?? "none"} has_translation=${caption.translationText.trim().length > 0}`,
    durationMs: ageMs,
    epochMs: nowMs,
    fields: {
      lifecycle,
      ageMs,
      generation,
      isFinal: caption.isFinal === true,
      hasTranslation: caption.translationText.trim().length > 0,
    },
  });
};

/**
 * Identity of the held caption used to ignore stale hold-clear timers.
 *
 * A newer utterance can update `captionRef` / queue `setState` before React
 * runs the previous effect cleanup. Comparing this epoch at fire time keeps
 * that late timer from blanking the replacement caption.
 */
export const captionHoldClearEpoch = (caption: CaptionPayload): string =>
  [
    caption.id,
    caption.sourceText,
    caption.translationText,
    String(caption.isFinal),
    String(caption.provisional),
    String(caption.receivedAt),
  ].join("\u0000");

/** True when a scheduled hold-clear still refers to the visible caption. */
export const shouldApplyCaptionHoldClear = (
  expectedEpoch: string,
  current: CaptionPayload,
): boolean => expectedEpoch === captionHoldClearEpoch(current);

/**
 * Decide whether a hold-clear timer may blank the visible caption.
 *
 * Epoch mismatch rejects a stale timer after a newer utterance landed.
 * Preview / already-empty plates stay put even if a timer somehow fires.
 */
export const shouldBlankCaptionForHoldClear = (
  expectedEpoch: string,
  current: CaptionPayload,
): boolean => {
  if (!shouldApplyCaptionHoldClear(expectedEpoch, current)) {
    return false;
  }
  if (current.id === "preview") {
    return false;
  }
  return Boolean(current.sourceText.trim() || current.translationText.trim());
};

const captionHoldGraphemeCount = (text: string): number => {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(trimmed)].length;
  }
  return [...trimmed].length;
};

const visibleHoldGraphemeCount = (caption: CaptionPayload): number =>
  Math.max(
    captionHoldGraphemeCount(caption.sourceText),
    captionHoldGraphemeCount(caption.translationText),
  );

const scaledCaptionHoldMs = (caption: CaptionPayload): number => {
  const graphemes = visibleHoldGraphemeCount(caption);
  const scaled = Math.round(graphemes * CAPTION_HOLD_MS_PER_GRAPHEME);
  return Math.min(CAPTION_HOLD_CLEAR_MAX_MS, Math.max(CAPTION_HOLD_CLEAR_MIN_MS, scaled));
};

/**
 * True when the visible source is still mid-clause (topic/case/continuative)
 * and speech is expected to continue. Greetings ending in は are finished.
 */
export const isOpenCaptionClause = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (GREETING_SURFACE.test(trimmed)) {
    return false;
  }
  const last = trimmed.at(-1);
  if (last !== undefined && SENTENCE_TERMINAL.test(last)) {
    return false;
  }
  if (COMPLETED_COPULA_END.test(trimmed)) {
    return false;
  }
  return OPEN_CLAUSE_END.test(trimmed);
};

const hasLetterOrNumber = (text: string): boolean => /[\p{L}\p{N}]/u.test(text.trim());

/**
 * True when `next` continues the same spoken turn (same id, prefix growth, or
 * an unfinished open clause waiting for text) rather than a new turn.
 * A greeting such as こんにちは is not an open clause.
 */
export const isRelatedCaptionContinuation = (
  current: CaptionPayload,
  next: CaptionPayload,
): boolean => {
  if (current.id === next.id) {
    return true;
  }
  const currentText = current.sourceText.trim();
  const nextText = next.sourceText.trim();
  if (!currentText) {
    return false;
  }
  if (nextText.startsWith(currentText) || (nextText && currentText.startsWith(nextText))) {
    return true;
  }
  if (!nextText) {
    return isOpenCaptionClause(currentText);
  }
  return false;
};

/**
 * Non-final captions must not auto-clear on a short idle: long utterances can
 * pause between ASR revisions for several seconds, and blanking the plate then
 * hides the only readable text. Only finalized/translated captions hold-clear.
 *
 * Hold scales with visible graphemes (six-second rule / characters-per-second).
 * A finalized open clause uses the 7000 ms max envelope so the live hook still
 * blanks after idle (not unbounded linger / ≥8000 ms). Incoming revisions
 * change the hold epoch and restart that timer while speech continues.
 * Finished turns, including greetings that end in は, stay inside 4000–7000 ms.
 */
export const captionHoldClearDelayMs = (
  caption: CaptionPayload,
  _next?: CaptionPayload,
): number | null => {
  const hasText = Boolean(caption.sourceText.trim() || caption.translationText.trim());
  if (!hasText) {
    return null;
  }
  if (caption.id === "preview" || caption.id === "empty") {
    return null;
  }
  if (caption.isFinal !== true && !caption.translationText.trim()) {
    return null;
  }
  if (isOpenCaptionClause(caption.sourceText) && !hasLetterOrNumber(caption.translationText)) {
    return CAPTION_HOLD_CLEAR_MAX_MS;
  }
  return scaledCaptionHoldMs(caption);
};
