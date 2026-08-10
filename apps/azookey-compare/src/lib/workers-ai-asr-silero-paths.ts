/**
 * Public URLs for compare-hosted Silero VAD v6 + onnxruntime-web WASM.
 * Web Speech must never fetch these; only Workers AI ASR loads them.
 *
 * Parapper catalog:
 * `packages/parapper-asr/src-tauri/src/model/catalog.rs`
 * Path convention: `silero_vad_v6/silero_vad.onnx`
 */

export const SILERO_VAD_VERSION = "v6.0";
export const SILERO_VAD_PUBLIC_MODEL_PATH = "/models/silero_vad_v6/silero_vad.onnx";
export const SILERO_ORT_WASM_PUBLIC_PATH = "/ort/";
export const SILERO_VAD_SOURCE_URL =
  "https://github.com/snakers4/silero-vad/raw/refs/tags/v6.0/src/silero_vad/data/silero_vad.onnx";
export const SILERO_FALLBACK_NOTICE_JA =
  "Silero VAD（ONNX / ORT WASM）を読み込めなかったため、-50 dBFS エネルギーゲートで発話を区切ります";
