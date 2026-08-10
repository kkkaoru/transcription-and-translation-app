/**
 * Parapper ASR models downloaded into the desktop sidecar runtime directory.
 *
 * Nemotron archives come from the sherpa-onnx GitHub release assets; ReazonSpeech
 * files come from Hugging Face. Keep these strings aligned with
 * `packages/parapper-asr/src-tauri/src/model/catalog.rs`.
 */
import { STREAMING_INTERIM_ASR_MODEL_ID } from "./streaming-interim-asr";

export type ParapperAsrModelRole = "completion" | "interim";

export type ParapperAsrModelSpec = {
  id: string;
  role: ParapperAsrModelRole;
  label: string;
  /** Directory name under `<appData>/parapper/models/`. */
  dirName: string;
  /** Exact download URL the sidecar fetches (archive or file base). */
  sourceUrl: string;
  requiredFiles: readonly string[];
};

const SHERPA_ONNX_ASR_RELEASES =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

export const REAZONSPEECH_K2_V2_MODEL_ID = "reazonspeech_k2_v2" as const;

export const REAZONSPEECH_K2_V2_SPEC: ParapperAsrModelSpec = {
  id: REAZONSPEECH_K2_V2_MODEL_ID,
  role: "completion",
  label: "ReazonSpeech K2 v2 (completion)",
  dirName: "sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01",
  sourceUrl:
    "https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/main",
  requiredFiles: [
    "encoder-epoch-99-avg-1.int8.onnx",
    "decoder-epoch-99-avg-1.onnx",
    "joiner-epoch-99-avg-1.int8.onnx",
    "tokens.txt",
  ],
};

export const NEMOTRON_35_160MS_DIR_NAME =
  "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11";

export const NEMOTRON_35_160MS_SPEC: ParapperAsrModelSpec = {
  id: STREAMING_INTERIM_ASR_MODEL_ID,
  role: "interim",
  label: "Nemotron 3.5 ASR Streaming 160ms int8 (interim)",
  dirName: NEMOTRON_35_160MS_DIR_NAME,
  sourceUrl: `${SHERPA_ONNX_ASR_RELEASES}/${NEMOTRON_35_160MS_DIR_NAME}.tar.bz2`,
  requiredFiles: [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
  ],
};

/** Models the desktop headless sidecar must keep ready for the current setting. */
export const requiredParapperAsrModels = (
  streamingInterimAsrEnabled: boolean,
): readonly ParapperAsrModelSpec[] =>
  streamingInterimAsrEnabled
    ? [REAZONSPEECH_K2_V2_SPEC, NEMOTRON_35_160MS_SPEC]
    : [REAZONSPEECH_K2_V2_SPEC];

export const parapperAsrModelById = (id: string): ParapperAsrModelSpec | null => {
  if (id === REAZONSPEECH_K2_V2_SPEC.id) {
    return REAZONSPEECH_K2_V2_SPEC;
  }
  if (id === NEMOTRON_35_160MS_SPEC.id) {
    return NEMOTRON_35_160MS_SPEC;
  }
  return null;
};
