import { describe, expect, it } from "vitest";
import * as core from "./index.js";

describe("core public exports", () => {
  it("exposes the portable audio, configuration, and HTTP contract", () => {
    expect(core.PARAPPER_SAMPLE_RATE).toBe(16_000);
    expect(core.PARAPPER_MAX_FRAME_BYTES).toBe(3_200);
    expect(core.MAX_AUDIO_BYTES).toBe(2 * 1024 * 1024);
    expect(core.MAX_JSON_BYTES).toBe(256 * 1024);
    expect(core.GatewayError).toBeTypeOf("function");
    expect(core.SerialGate).toBeTypeOf("function");
    expect(core.createGatewayFetchHandler).toBeTypeOf("function");
    expect(core.validateGatewayConfig).toBeTypeOf("function");
  });
});
