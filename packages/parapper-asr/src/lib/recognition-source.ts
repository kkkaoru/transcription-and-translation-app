import type {
  RecognitionSourceMeta,
  RecognizedTextEvent,
  TranslationTextEvent,
} from "./types";

/**
 * Return the stable row id used by the logs.  The legacy one-argument form is
 * kept for exports/older callers; UI rows pass the local sidecar generation so
 * a restarted process cannot reuse a previous turn's React identity.
 */
export const recognitionSourceRowId = (
  source: RecognitionSourceMeta,
  generation?: number,
) =>
  generation === undefined
    ? `turn-${source.turn_session_id}-${source.turn_id}`
    : `turn-${generation}-${source.turn_session_id}-${source.turn_id}`;

const sourceCursorId = (source: RecognitionSourceMeta) =>
  [
    source.turn_revision,
    source.output_sequence,
    source.segment_id,
    source.previous_segment_id ?? "",
  ].join("-");

/** Return a unique DOM/React row id for one recognized event. */
export const recognitionTextRowId = (event: RecognizedTextEvent) => {
  const base = recognitionSourceRowId(event.source, event.generation);
  return event.update_mode === "append"
    ? `${base}|append-${event.id}-${sourceCursorId(event.source)}`
    : base;
};

/** Return a unique DOM/React row id for one translated event. */
export const translationTextRowId = (event: TranslationTextEvent) => {
  const base = recognitionSourceRowId(event.source, event.generation);
  return event.update_mode === "append"
    ? `${base}|append-${event.source_recognition_id}-${sourceCursorId(event.source)}`
    : base;
};
