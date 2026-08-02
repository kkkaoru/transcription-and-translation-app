import type {
  RecognitionSourceMeta,
  RecognizedTextEvent,
  TranslationTextEvent,
} from "./types";

/**
 * The interactive log is intentionally bounded even when the persisted
 * setting is "unlimited".  A sidecar can keep producing events for days and
 * an unbounded React array eventually makes every repaint more expensive.
 * Five thousand rows is well above the normal 500-row setting while keeping
 * the UI state finite.
 */
export const MAX_RECOGNITION_LOG_ROWS = 5_000;

export type RecognitionLogEvent = RecognizedTextEvent | TranslationTextEvent;

/**
 * The source comparison predates the richer cursor metadata.  Keep accepting
 * the two-field shape used by callers that only need turn identity while
 * allowing full native source metadata for event processing.
 */
type RecognitionSourceIdentity = Pick<
  RecognitionSourceMeta,
  "turn_session_id" | "turn_id"
> &
  Partial<Omit<RecognitionSourceMeta, "turn_session_id" | "turn_id">>;

export const eventGeneration = (event: RecognitionLogEvent): number =>
  event.generation ?? 0;

/**
 * Attach the frontend generation to a native event without mutating the
 * object received from Tauri.  Native payloads do not carry this field: it is
 * local UI metadata used to keep rows from two sidecar lifetimes distinct.
 */
export const withEventGeneration = <T extends RecognitionLogEvent>(
  event: T,
  generation: number,
): T & { generation: number } =>
  event.generation === generation
    ? (event as T & { generation: number })
    : { ...event, generation };

export const recognitionTurnKey = (
  source: Pick<RecognitionSourceMeta, "turn_session_id" | "turn_id">,
  generation = 0,
) => `${generation}|${source.turn_session_id}|${source.turn_id}`;

const sourceCursorKey = (source: RecognitionSourceMeta) =>
  [
    source.turn_session_id,
    source.turn_id,
    source.turn_revision,
    source.output_sequence,
    source.segment_id,
    source.previous_segment_id ?? "",
  ].join("|");

const eventIdentity = (event: RecognitionLogEvent) => {
  const target = "target_lang" in event ? event.target_lang : "";
  const appendPayload =
    event.update_mode === "append"
      ? "text" in event
        ? event.text
        : `${event.translated_text}|${event.status}|${event.error ?? ""}`
      : "";
  return [
    eventGeneration(event),
    event.id,
    event.update_mode,
    event.is_final ? 1 : 0,
    sourceCursorKey(event.source),
    target,
    appendPayload,
  ].join("|");
};

export const recognitionTextEventKey = (event: RecognizedTextEvent) =>
  `${recognitionTurnKey(event.source, eventGeneration(event))}|${sourceCursorKey(event.source)}|${event.update_mode}|${event.id}|${event.update_mode === "append" ? event.text : ""}`;

export const translationTextEventKey = (event: TranslationTextEvent) =>
  `${recognitionTurnKey(event.source, eventGeneration(event))}|${sourceCursorKey(event.source)}|${event.target_lang}|${event.update_mode}|${event.id}|${event.update_mode === "append" ? `${event.translated_text}|${event.status}|${event.error ?? ""}` : ""}`;

export const sameRecognitionSource = (
  left: RecognitionLogEvent | RecognitionSourceIdentity,
  right: RecognitionLogEvent | RecognitionSourceIdentity,
) => {
  const leftSource = "source" in left ? left.source : left;
  const rightSource = "source" in right ? right.source : right;
  const leftGeneration = "source" in left ? eventGeneration(left) : 0;
  const rightGeneration = "source" in right ? eventGeneration(right) : 0;
  return (
    recognitionTurnKey(leftSource, leftGeneration) ===
    recognitionTurnKey(rightSource, rightGeneration)
  );
};

const shouldReplaceRecognitionEvent = (
  current: Pick<RecognitionLogEvent, "source" | "is_final">,
  incoming: Pick<RecognitionLogEvent, "source" | "is_final">,
) => {
  if (current.is_final && !incoming.is_final) {
    return false;
  }
  if (incoming.source.turn_revision !== current.source.turn_revision) {
    return incoming.source.turn_revision > current.source.turn_revision;
  }
  if (incoming.source.output_sequence !== current.source.output_sequence) {
    return incoming.source.output_sequence > current.source.output_sequence;
  }
  return incoming.is_final || !current.is_final;
};

/**
 * Merge a recognized-text event into the display log.
 *
 * Append events keep their cumulative rows, but an event replay with the same
 * stable identity is idempotent. Replace events update only the matching
 * turn in the same frontend generation, so a restarted sidecar cannot replace
 * an older turn whose native session/turn numbers were reused.
 */
export const upsertRecognizedText = (
  texts: RecognizedTextEvent[],
  event: RecognizedTextEvent,
): RecognizedTextEvent[] => {
  const duplicate = eventIdentity(event);
  if (texts.some((text) => eventIdentity(text) === duplicate)) {
    return texts;
  }

  if (event.update_mode !== "replace") {
    return [...texts, event];
  }

  const index = texts.findIndex((text) => sameRecognitionSource(text, event));
  if (index < 0) {
    return [...texts, event];
  }

  const current = texts[index];
  if (!shouldReplaceRecognitionEvent(current, event)) {
    return texts;
  }

  return texts.map((text, currentIndex) =>
    currentIndex === index ? event : text,
  );
};

/** Merge a translated-text event using the same generation-aware semantics. */
export const upsertTranslatedText = (
  texts: TranslationTextEvent[],
  event: TranslationTextEvent,
): TranslationTextEvent[] => {
  const duplicate = eventIdentity(event);
  if (texts.some((text) => eventIdentity(text) === duplicate)) {
    return texts;
  }

  if (event.update_mode !== "replace") {
    return [...texts, event];
  }

  const index = texts.findIndex(
    (text) =>
      sameRecognitionSource(text, event) &&
      text.target_lang === event.target_lang,
  );
  if (index < 0) {
    return [...texts, event];
  }

  const current = texts[index];
  if (!shouldReplaceRecognitionEvent(current, event)) {
    return texts;
  }

  return texts.map((text, currentIndex) =>
    currentIndex === index ? event : text,
  );
};

/** Keep the newest rows while preserving the configured display amount. */
export const trimRecognitionLogRows = <T>(
  texts: T[],
  limit: number | null | undefined,
  fallback = MAX_RECOGNITION_LOG_ROWS,
): T[] => {
  const requested = limit === null ? fallback : (limit ?? fallback);
  const normalized = Number.isFinite(requested) ? requested : fallback;
  const bounded = Math.min(
    MAX_RECOGNITION_LOG_ROWS,
    Math.max(1, Math.floor(normalized)),
  );
  return texts.length > bounded ? texts.slice(-bounded) : texts;
};
