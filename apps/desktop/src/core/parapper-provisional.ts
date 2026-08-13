import { asrLatencyFromUnknown } from "./caption-latency";
import { isShorterSameUtteranceSurface, mergeCaptionPayload } from "./caption-updates";
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
    | "asrLatency"
  >,
  languages: { sourceLanguage: string; targetLanguage: string },
): CaptionPayload | null => {
  if (event.stage !== "asr" || !event.ok) {
    return null;
  }
  const outputText = event.outputText.trim();
  const sourceText = event.surfaceText?.trim() || outputText;
  const utteranceId = event.utteranceId.trim();
  if (!sourceText || !utteranceId) {
    return null;
  }
  const asrLatency = event.asrLatency ?? asrLatencyFromUnknown(event);
  return {
    id: utteranceId,
    sourceText,
    ...(outputText ? { azookeyInputText: outputText } : {}),
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
    ...(asrLatency ? { asrLatency } : {}),
  };
};

const asrStageSurface = (event: Pick<PipelineStageEvent, "outputText" | "surfaceText">): string =>
  event.surfaceText?.trim() || event.outputText.trim();

const ASR_FOLD_LANGUAGES = { sourceLanguage: "ja", targetLanguage: "en" };

/** Fold same-utterance ASR rows in time order so keep-longer cannot drop a disjoint tail. */
const foldSameIdAsrSurface = (
  events: readonly Pick<
    PipelineStageEvent,
    | "stage"
    | "ok"
    | "utteranceId"
    | "outputText"
    | "surfaceText"
    | "startedAt"
    | "at"
    | "captureGeneration"
    | "asrLatency"
  >[],
  utteranceId: string,
): string | null => {
  const sameId = events
    .filter(
      (event) =>
        event.stage === "asr" &&
        event.ok &&
        event.utteranceId === utteranceId &&
        Boolean(asrStageSurface(event)),
    )
    .slice()
    .sort((left, right) => left.at - right.at || left.startedAt - right.startedAt);
  let merged: CaptionPayload | null = null;
  for (const event of sameId) {
    const caption = buildProvisionalCaptionFromAsrStage(event, ASR_FOLD_LANGUAGES);
    if (!caption) {
      continue;
    }
    merged = merged ? (mergeCaptionPayload(merged, caption) ?? merged) : caption;
  }
  const folded = merged?.sourceText.trim() ?? "";
  return folded || null;
};

/** Newest successful ASR row that can paint a provisional overlay caption. */
export const pickLatestSuccessfulAsrStage = (
  events: readonly Pick<
    PipelineStageEvent,
    | "stage"
    | "ok"
    | "utteranceId"
    | "outputText"
    | "surfaceText"
    | "startedAt"
    | "at"
    | "captureGeneration"
    | "asrLatency"
  >[],
): (typeof events)[number] | null => {
  let latest: (typeof events)[number] | null = null;
  for (const event of events) {
    if (event.stage !== "asr" || !event.ok) {
      continue;
    }
    const sourceText = asrStageSurface(event);
    if (!sourceText || !event.utteranceId.trim()) {
      continue;
    }
    if (
      !latest ||
      event.at > latest.at ||
      (event.at === latest.at && event.startedAt >= latest.startedAt)
    ) {
      latest = event;
    }
  }
  if (!latest) {
    return null;
  }
  // History replay must not first-paint a truncated same-id revision over a
  // longer surface already in the buffer, and must not keep-longer the lead
  // when a later disjoint clause of the same turn is also in history.
  const folded = foldSameIdAsrSurface(events, latest.utteranceId);
  if (folded && folded !== asrStageSurface(latest)) {
    return {
      ...latest,
      outputText: folded,
      surfaceText: folded,
    };
  }
  let best = latest;
  let bestText = asrStageSurface(latest);
  for (const event of events) {
    if (event.stage !== "asr" || !event.ok || event.utteranceId !== latest.utteranceId) {
      continue;
    }
    const sourceText = asrStageSurface(event);
    if (!sourceText) {
      continue;
    }
    if (isShorterSameUtteranceSurface(sourceText, bestText)) {
      continue;
    }
    if (isShorterSameUtteranceSurface(bestText, sourceText) || event.at >= best.at) {
      best = event;
      bestText = sourceText;
    }
  }
  return best;
};
