import { selectParapperSurfaceText } from "./parapperStream";
import type { CaptionPayload, PipelineStageEvent } from "./types";

/** Parapper turn fields needed to synthesize an immediate provisional caption. */
export type ParapperProvisionalInput = {
  text: string;
  sourceText?: string | null;
  azookeyInputText?: string | null;
  sessionId: string;
  turnSessionId: number;
  turnId: number;
  elapsedMs: number;
  isFinal: boolean;
  captureGeneration?: number | null;
};

/**
 * Build a low-emphasis provisional source caption from a Parapper turn event.
 *
 * Called on enqueue (before AzooKey normalize) so Live/Syphon paint recognized
 * characters without waiting for the serial output queue's in-flight normalize.
 * Returns null when there is no paintable surface text.
 */
export const buildParapperProvisionalCaption = (
  output: ParapperProvisionalInput,
  languages: { sourceLanguage: string; targetLanguage: string },
  nowMs: number = Date.now(),
): CaptionPayload | null => {
  const provisionalSurface =
    selectParapperSurfaceText(output) || output.azookeyInputText?.trim() || output.text.trim();
  if (!provisionalSurface) {
    return null;
  }
  const receivedAt = nowMs;
  const provisionalStartedAt = Math.max(0, receivedAt - Math.max(0, output.elapsedMs));
  return {
    id: `parapper:${output.sessionId}:${output.turnSessionId}:${output.turnId}`,
    sourceText: provisionalSurface,
    azookeyInputText: output.azookeyInputText ?? output.text,
    translationText: "",
    sourceLanguage: languages.sourceLanguage,
    targetLanguage: languages.targetLanguage,
    startedAt: provisionalStartedAt,
    receivedAt,
    stage: "source",
    sequence: 0,
    isFinal: false,
    provisional: true,
    ...(typeof output.captureGeneration === "number"
      ? { captureGeneration: output.captureGeneration }
      : {}),
  };
};

/**
 * Synthesize the same provisional source caption Live paints from `pipeline:stage`.
 *
 * The off-screen native-renderer (primary Syphon/Spout publisher) only sees
 * `caption:update` from the native pipeline, which waits for AzooKey. ASR stage
 * events are already app-wide; mapping them here lets overlay/Syphon paint the
 * recognized surface without waiting on normalize.
 */
export const buildProvisionalCaptionFromAsrStage = (
  event: Pick<
    PipelineStageEvent,
    | "stage"
    | "ok"
    | "utteranceId"
    | "outputText"
    | "surfaceText"
    | "startedAt"
    | "at"
    | "captureGeneration"
  >,
  languages: { sourceLanguage: string; targetLanguage: string },
): CaptionPayload | null => {
  if (event.stage !== "asr" || !event.ok) {
    return null;
  }
  const sourceText = event.surfaceText?.trim() || event.outputText.trim();
  const utteranceId = event.utteranceId.trim();
  if (!sourceText || !utteranceId) {
    return null;
  }
  return {
    id: utteranceId,
    sourceText,
    translationText: "",
    sourceLanguage: languages.sourceLanguage,
    targetLanguage: languages.targetLanguage,
    startedAt: event.startedAt,
    receivedAt: event.at,
    stage: "source",
    sequence: 0,
    isFinal: false,
    provisional: true,
    ...(typeof event.captureGeneration === "number"
      ? { captureGeneration: event.captureGeneration }
      : {}),
  };
};
