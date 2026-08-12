/**
 * Progressive interim ASR paired with the primary ReazonSpeech completion model.
 *
 * When enabled (off by default; opt in from settings), the desktop headless
 * Parapper sidecar loads this Nemotron 3.5 streaming model for mid-utterance
 * hypotheses while ReazonSpeech K2 v2 remains the final/completion ASR.
 */
export const STREAMING_INTERIM_ASR_MODEL_ID = "nemotron_3_5_asr_streaming_0_6b_160ms_int8" as const;

/** Sentinel passed to the headless sidecar when streaming interim ASR is off. */
export const STREAMING_INTERIM_ASR_MODEL_OFF = "none" as const;

export type StreamingInterimAsrModelId = typeof STREAMING_INTERIM_ASR_MODEL_ID;
export type StreamingInterimAsrCliValue =
  | StreamingInterimAsrModelId
  | typeof STREAMING_INTERIM_ASR_MODEL_OFF;

/**
 * Resolve the CLI value for `--interim-asr-model` from the desktop setting.
 * Always returns an explicit value so a stale Parapper runtime profile cannot
 * silently keep a previous interim model.
 */
export const resolveStreamingInterimAsrCliValue = (
  enabled: boolean,
): StreamingInterimAsrCliValue =>
  enabled ? STREAMING_INTERIM_ASR_MODEL_ID : STREAMING_INTERIM_ASR_MODEL_OFF;

/** Model id used when the setting is on; `null` when off. */
export const resolveStreamingInterimAsrModel = (
  enabled: boolean,
): StreamingInterimAsrModelId | null => (enabled ? STREAMING_INTERIM_ASR_MODEL_ID : null);
