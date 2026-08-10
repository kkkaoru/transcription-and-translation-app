import { requiredParapperAsrModelsForCaptureStart } from "./parapper-asr-models";
import type { RecognitionMode } from "./types";

export type CaptureStartBlockReason =
  | null
  | "models-preparing"
  | "services-unhealthy"
  | "web-speech-unsupported";

export type CaptureStartModelStatus = {
  modelId: string;
  status: string;
};

export type CaptureStartReadinessInput = {
  recognitionMode: RecognitionMode;
  streamingInterimAsrEnabled: boolean;
  modelStatus: readonly CaptureStartModelStatus[];
  /** `null` when health is unknown (browser preview / not polled yet). */
  parapperHealthy: boolean | null;
  webSpeechSupported: boolean;
};

/**
 * Decide why live caption capture cannot start. Returns `null` when start is
 * allowed. Stop remains available while capturing/starting regardless of this.
 *
 * Interim-only ASR (Nemotron) may still be downloading in the background; capture
 * only requires the completion ASR that Parapper listens with at startup.
 */
export const resolveCaptureStartBlockReason = (
  input: CaptureStartReadinessInput,
): CaptureStartBlockReason => {
  if (input.recognitionMode === "web-speech") {
    return input.webSpeechSupported ? null : "web-speech-unsupported";
  }

  const required = requiredParapperAsrModelsForCaptureStart();
  for (const spec of required) {
    const entry = input.modelStatus.find((model) => model.modelId === spec.id);
    if (entry?.status !== "ready") {
      return "models-preparing";
    }
  }

  if (input.parapperHealthy === false) {
    return "services-unhealthy";
  }

  return null;
};

export const canStartCaptionCapture = (reason: CaptureStartBlockReason): boolean => reason == null;

/** Map runtime sidecar diagnostics to Parapper readiness (`null` = unknown). */
export const resolveParapperHealthyFromSidecars = (
  sidecars: readonly { id: string; health: string }[] | null | undefined,
): boolean | null => {
  if (sidecars == null) {
    return null;
  }
  const parapper = sidecars.find((sidecar) => sidecar.id === "kotoba-parapper");
  if (!parapper) {
    return false;
  }
  return parapper.health === "healthy";
};
