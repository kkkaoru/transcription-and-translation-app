import { describe, expect, it } from "vitest";
import { formatBridgeError, isNoSpeechBridgeError } from "./bridge";

describe("formatBridgeError", () => {
  it("extracts details from strings, Errors, and Tauri-shaped objects", () => {
    expect(formatBridgeError("gateway refused")).toBe("gateway refused");
    expect(formatBridgeError(new Error("boom"))).toBe("boom");
    expect(formatBridgeError({ message: "from message" })).toBe("from message");
    expect(formatBridgeError({ error: "from error" })).toBe("from error");
    expect(formatBridgeError({ detail: "from detail" })).toBe("from detail");
    expect(formatBridgeError(null)).toBeUndefined();
    expect(formatBridgeError(undefined)).toBeUndefined();
    expect(formatBridgeError(42)).toBeUndefined();
  });
});

describe("isNoSpeechBridgeError", () => {
  const parapper422 =
    'inference returned HTTP 422: {"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}';

  it("classifies Parapper transcript_missing 422 payloads as no-speech", () => {
    expect(isNoSpeechBridgeError(parapper422)).toBe(true);
    expect(isNoSpeechBridgeError(new Error(parapper422))).toBe(true);
    expect(isNoSpeechBridgeError({ message: parapper422 })).toBe(true);
    expect(
      isNoSpeechBridgeError({
        error:
          '{"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}',
      }),
    ).toBe(true);
  });

  it("classifies message-only no-transcript variants", () => {
    expect(isNoSpeechBridgeError("Parapper completed without a final transcript")).toBe(true);
    expect(isNoSpeechBridgeError("empty transcript")).toBe(true);
    expect(isNoSpeechBridgeError("no transcript available")).toBe(true);
  });

  it("does not soft-skip real audio/backend failures", () => {
    expect(isNoSpeechBridgeError("inference returned HTTP 500: boom")).toBe(false);
    expect(isNoSpeechBridgeError("inference returned HTTP 422: invalid_audio")).toBe(false);
    expect(isNoSpeechBridgeError("gateway refused")).toBe(false);
    expect(isNoSpeechBridgeError(null)).toBe(false);
    expect(isNoSpeechBridgeError(undefined)).toBe(false);
    expect(isNoSpeechBridgeError("")).toBe(false);
  });
});
