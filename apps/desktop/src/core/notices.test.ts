import { describe, expect, it } from "vitest";
import { isNoSpeechBridgeError } from "./bridge";
import {
  isTransientAudioNotice,
  noticeForNoSpeech,
  noticeFromError,
  sanitizeNoSpeechDetail,
  shouldToastAudioProcessingFailure,
} from "./notices";

/** Exact user-facing Parapper 422 payload (with/without bridge prefix). */
const PARAPPER_422 =
  'inference returned HTTP 422: {"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}';
const PARAPPER_BODY =
  '{"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}';
const PARAPPER_WITH_DIAG = `${PARAPPER_422} · mode=worklet · constraints=default-raw · context=running · sr=48000 · track=live · rms=-54.2dB · chunks=8`;

describe("audio processing notice mapping", () => {
  it("does not toast transcript_missing / no-speech as audioProcessingFailed", () => {
    expect(isNoSpeechBridgeError(PARAPPER_422)).toBe(true);
    expect(isNoSpeechBridgeError(PARAPPER_BODY)).toBe(true);
    expect(shouldToastAudioProcessingFailure(PARAPPER_422)).toBe(false);
    expect(shouldToastAudioProcessingFailure(new Error(PARAPPER_422))).toBe(false);
    expect(shouldToastAudioProcessingFailure("Parapper completed without a final transcript")).toBe(
      false,
    );
    // Nested Tauri-shaped objects must still soft-skip.
    expect(shouldToastAudioProcessingFailure({ data: { message: PARAPPER_422 } })).toBe(false);
  });

  it("maps transcript_missing to non-fatal noSpeechDetected notice", () => {
    const soft = noticeFromError(PARAPPER_422, "message.audioProcessingFailed");
    expect(soft.key).toBe("message.noSpeechDetected");
    expect(soft.key).not.toBe("message.audioProcessingFailed");

    const direct = noticeForNoSpeech("mode=worklet · rms=-54.2dB · chunks=8");
    expect(direct.key).toBe("message.noSpeechDetected");
    expect(direct.detail).toContain("rms=-54.2dB");
    expect(isTransientAudioNotice(soft)).toBe(true);
    expect(isTransientAudioNotice({ key: "message.saved" })).toBe(false);
  });

  it("sanitizes raw 422 bodies out of no-speech toast details", () => {
    const cleaned = sanitizeNoSpeechDetail(PARAPPER_WITH_DIAG);
    expect(cleaned).toContain("mode=worklet");
    expect(cleaned).toContain("rms=-54.2dB");
    expect(cleaned).not.toContain("transcript_missing");
    expect(cleaned).not.toContain("inference returned HTTP");

    const bare = noticeForNoSpeech(PARAPPER_422);
    expect(bare.key).toBe("message.noSpeechDetected");
    // Prefer empty/diag over opaque gateway JSON in the toast.
    expect(bare.detail ?? "").not.toContain("inference returned HTTP 422");
  });

  it("still toasts real inference failures", () => {
    expect(shouldToastAudioProcessingFailure("inference returned HTTP 500: boom")).toBe(true);
    expect(
      shouldToastAudioProcessingFailure(
        'inference returned HTTP 422: {"error":{"code":"invalid_audio","message":"bad wav"}}',
      ),
    ).toBe(true);
    expect(shouldToastAudioProcessingFailure("gateway refused")).toBe(true);
  });

  it("noticeFromError keeps diagnostic detail for real failures", () => {
    const notice = noticeFromError(
      "inference returned HTTP 500: model crashed",
      "message.audioProcessingFailed",
    );
    expect(notice.key).toBe("message.audioProcessingFailed");
    expect(notice.detail).toContain("model crashed");
  });

  it("maps DOMException names to microphone-specific keys", () => {
    const denied = new DOMException("denied", "NotAllowedError");
    expect(noticeFromError(denied, "message.audioProcessingFailed").key).toBe(
      "message.microphonePermissionDenied",
    );
  });
});
