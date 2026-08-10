import { describe, expect, it } from "vitest";
import {
  SILERO_FALLBACK_NOTICE_JA,
  SILERO_ORT_WASM_ASSET_NAMES,
  SILERO_ORT_WASM_PUBLIC_PATH,
  SILERO_VAD_PUBLIC_MODEL_PATH,
  SILERO_VAD_SOURCE_URL,
  SILERO_VAD_VERSION,
} from "./workers-ai-asr-silero-paths";

describe("Silero VAD public asset paths", () => {
  it("pins Parapper Silero v6 URL and compare public paths", () => {
    expect(SILERO_VAD_VERSION).toBe("v6.0");
    expect(SILERO_VAD_PUBLIC_MODEL_PATH).toBe("/models/silero_vad_v6/silero_vad.onnx");
    expect(SILERO_ORT_WASM_PUBLIC_PATH).toBe("/ort/");
    expect(SILERO_ORT_WASM_ASSET_NAMES).toEqual([
      "ort-wasm-simd-threaded.wasm",
      "ort-wasm-simd-threaded.mjs",
    ]);
    expect(SILERO_VAD_SOURCE_URL).toBe(
      "https://github.com/snakers4/silero-vad/raw/refs/tags/v6.0/src/silero_vad/data/silero_vad.onnx",
    );
    expect(SILERO_FALLBACK_NOTICE_JA).toContain("エネルギーゲート");
    expect(SILERO_FALLBACK_NOTICE_JA).toContain("-50 dBFS");
  });
});
