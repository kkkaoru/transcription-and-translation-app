import { describe, expect, it } from "vitest";
import {
  NEMOTRON_35_160MS_SPEC,
  REAZONSPEECH_K2_V2_SPEC,
  parapperAsrModelById,
  requiredParapperAsrModels,
} from "./parapper-asr-models";
import { STREAMING_INTERIM_ASR_MODEL_ID } from "./streaming-interim-asr";

describe("parapper ASR model catalog", () => {
  it("documents the GitHub release URL for Nemotron 3.5 streaming interim", () => {
    expect(NEMOTRON_35_160MS_SPEC.id).toBe(STREAMING_INTERIM_ASR_MODEL_ID);
    expect(NEMOTRON_35_160MS_SPEC.sourceUrl).toBe(
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11.tar.bz2",
    );
    expect(NEMOTRON_35_160MS_SPEC.role).toBe("interim");
  });

  it("keeps ReazonSpeech as the Hugging Face completion model", () => {
    expect(REAZONSPEECH_K2_V2_SPEC.sourceUrl).toContain(
      "huggingface.co/reazon-research/reazonspeech-k2-v2",
    );
    expect(REAZONSPEECH_K2_V2_SPEC.role).toBe("completion");
  });

  it("requires Nemotron only while streaming interim ASR is enabled", () => {
    expect(requiredParapperAsrModels(true).map((model) => model.id)).toEqual([
      REAZONSPEECH_K2_V2_SPEC.id,
      NEMOTRON_35_160MS_SPEC.id,
    ]);
    expect(requiredParapperAsrModels(false).map((model) => model.id)).toEqual([
      REAZONSPEECH_K2_V2_SPEC.id,
    ]);
  });

  it("looks up catalog entries by model id", () => {
    expect(parapperAsrModelById(REAZONSPEECH_K2_V2_SPEC.id)).toEqual(REAZONSPEECH_K2_V2_SPEC);
    expect(parapperAsrModelById(STREAMING_INTERIM_ASR_MODEL_ID)).toEqual(NEMOTRON_35_160MS_SPEC);
    expect(parapperAsrModelById("unknown")).toBeNull();
  });
});
