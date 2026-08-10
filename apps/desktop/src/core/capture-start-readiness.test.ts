import { describe, expect, it } from "vitest";
import {
  canStartCaptionCapture,
  resolveCaptureStartBlockReason,
  resolveParapperHealthyFromSidecars,
} from "./capture-start-readiness";
import { NEMOTRON_35_160MS_SPEC, REAZONSPEECH_K2_V2_SPEC } from "./parapper-asr-models";

describe("capture start readiness", () => {
  it("blocks Parapper modes while required ASR models are still downloading", () => {
    const reason = resolveCaptureStartBlockReason({
      recognitionMode: "parapper-azookey",
      streamingInterimAsrEnabled: true,
      modelStatus: [
        { modelId: REAZONSPEECH_K2_V2_SPEC.id, status: "ready" },
        { modelId: NEMOTRON_35_160MS_SPEC.id, status: "downloading" },
      ],
      parapperHealthy: false,
      webSpeechSupported: true,
    });
    expect(reason).toBe("models-preparing");
    expect(canStartCaptionCapture(reason)).toBe(false);
  });

  it("blocks when Parapper is unhealthy even after models are ready", () => {
    const reason = resolveCaptureStartBlockReason({
      recognitionMode: "parapper-raw",
      streamingInterimAsrEnabled: false,
      modelStatus: [{ modelId: REAZONSPEECH_K2_V2_SPEC.id, status: "ready" }],
      parapperHealthy: false,
      webSpeechSupported: true,
    });
    expect(reason).toBe("services-unhealthy");
  });

  it("allows start when required models are ready and Parapper is healthy", () => {
    const reason = resolveCaptureStartBlockReason({
      recognitionMode: "parapper-azookey",
      streamingInterimAsrEnabled: true,
      modelStatus: [
        { modelId: REAZONSPEECH_K2_V2_SPEC.id, status: "ready" },
        { modelId: NEMOTRON_35_160MS_SPEC.id, status: "ready" },
      ],
      parapperHealthy: true,
      webSpeechSupported: true,
    });
    expect(reason).toBeNull();
    expect(canStartCaptionCapture(reason)).toBe(true);
  });

  it("skips ASR model checks for Web Speech and only requires browser support", () => {
    expect(
      resolveCaptureStartBlockReason({
        recognitionMode: "web-speech",
        streamingInterimAsrEnabled: true,
        modelStatus: [],
        parapperHealthy: false,
        webSpeechSupported: true,
      }),
    ).toBeNull();
    expect(
      resolveCaptureStartBlockReason({
        recognitionMode: "web-speech",
        streamingInterimAsrEnabled: true,
        modelStatus: [],
        parapperHealthy: true,
        webSpeechSupported: false,
      }),
    ).toBe("web-speech-unsupported");
  });

  it("reads Parapper health from kotoba-parapper sidecar diagnostics", () => {
    expect(resolveParapperHealthyFromSidecars(null)).toBeNull();
    expect(resolveParapperHealthyFromSidecars([])).toBe(false);
    expect(
      resolveParapperHealthyFromSidecars([{ id: "kotoba-parapper", health: "unhealthy" }]),
    ).toBe(false);
    expect(resolveParapperHealthyFromSidecars([{ id: "kotoba-parapper", health: "healthy" }])).toBe(
      true,
    );
  });
});
