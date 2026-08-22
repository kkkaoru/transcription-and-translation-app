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
    expect(core.isValidZenzDelimitedPrompt).toBeTypeOf("function");
    expect(core.validateGatewayConfig).toBeTypeOf("function");
    expect(core.handleUserLexiconHttp).toBeTypeOf("function");
    expect(core.createMemoryUserLexicon).toBeTypeOf("function");
    expect(core.USER_LEXICON_BINDING).toBe("USER_LEXICON");
    expect(core.USER_LEXICON_DO_NAME).toBe("hosted-compare");
    expect(core.USER_LEXICON_MAX_ENTRIES).toBe(100_000);
    expect(core.USER_LEXICON_MIN_READING_CHARS).toBe(2);
    expect(core.USER_LEXICON_HTTP_PATH).toBe("/azookey/user-lexicon");
    expect(core.USER_LEXICON_CONVERT_PATH).toBe("/v1/azookey/convert");
  });
});
