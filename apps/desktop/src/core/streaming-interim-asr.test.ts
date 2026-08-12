import { describe, expect, it } from "vitest";
import {
  resolveStreamingInterimAsrCliValue,
  resolveStreamingInterimAsrModel,
  STREAMING_INTERIM_ASR_MODEL_ID,
  STREAMING_INTERIM_ASR_MODEL_OFF,
} from "./streaming-interim-asr";

describe("streaming interim ASR setting", () => {
  it("pins the recommended Nemotron 3.5 160ms int8 model id", () => {
    expect(STREAMING_INTERIM_ASR_MODEL_ID).toBe("nemotron_3_5_asr_streaming_0_6b_160ms_int8");
  });

  it("resolves the model when the desktop setting is enabled (default path)", () => {
    expect(resolveStreamingInterimAsrModel(true)).toBe(STREAMING_INTERIM_ASR_MODEL_ID);
    expect(resolveStreamingInterimAsrCliValue(true)).toBe(STREAMING_INTERIM_ASR_MODEL_ID);
  });

  it("clears the model with an explicit none sentinel when disabled", () => {
    expect(resolveStreamingInterimAsrModel(false)).toBeNull();
    expect(resolveStreamingInterimAsrCliValue(false)).toBe(STREAMING_INTERIM_ASR_MODEL_OFF);
  });
});
