import { describe, expect, it } from "vitest";
import type { MessageKey } from "../i18n/messages";
import { AudioCaptureError, MicrophoneCapture } from "./audio";
import { isNoSpeechBridgeError } from "./bridge";
import {
  isTransientAudioNotice,
  noticeForNoSpeech,
  noticeFromError,
  sanitizeNoSpeechDetail,
  shouldToastAudioProcessingFailure,
} from "./notices";

const FALLBACK: MessageKey = "message.audioProcessingFailed";

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

describe("AudioCaptureError → notice mapping", () => {
  it("maps every capture error code to its own message key", () => {
    expect(noticeFromError(new AudioCaptureError("microphone-unavailable"), FALLBACK).key).toBe(
      "message.microphoneUnavailable",
    );
    expect(noticeFromError(new AudioCaptureError("audio-context-failed"), FALLBACK).key).toBe(
      "message.audioContextFailed",
    );
    expect(noticeFromError(new AudioCaptureError("audio-context-suspended"), FALLBACK).key).toBe(
      "message.audioContextFailed",
    );
    expect(noticeFromError(new AudioCaptureError("microphone-track-ended"), FALLBACK).key).toBe(
      "message.microphoneTrackEnded",
    );
    expect(noticeFromError(new AudioCaptureError("microphone-track-muted"), FALLBACK).key).toBe(
      "message.microphoneTrackMuted",
    );
    expect(
      noticeFromError(new AudioCaptureError("audio-chunk-delivery-failed"), FALLBACK).key,
    ).toBe("message.audioChunkDeliveryFailed");
    expect(noticeFromError(new AudioCaptureError("parapper-transport-failed"), FALLBACK).key).toBe(
      "message.parapperTransportFailed",
    );
  });

  it("prefers a DOMException cause message as the detail", () => {
    const cause = new DOMException("device in use by another app", "NotReadableError");
    const notice = noticeFromError(
      new AudioCaptureError("microphone-unavailable", cause),
      FALLBACK,
    );
    expect(notice.key).toBe("message.microphoneUnavailable");
    expect(notice.detail).toBe("device in use by another app");
  });

  it("falls back to the error message when it carries more than the bare code", () => {
    const notice = noticeFromError(
      new AudioCaptureError("audio-context-failed", "sample rate rejected"),
      FALLBACK,
    );
    expect(notice.detail).toBe("audio-context-failed: sample rate rejected");
  });

  it("omits detail when the message is only the code and no diagnostics exist", () => {
    const notice = noticeFromError(new AudioCaptureError("microphone-track-ended"), FALLBACK);
    // Detail is either live capture diagnostics or absent — never the bare code.
    expect(notice.detail).not.toBe("microphone-track-ended");
  });

  it("uses the fallback key for an unrecognised DOMException name", () => {
    const notice = noticeFromError(
      new DOMException("weird failure", "TypeMismatchError"),
      FALLBACK,
    );
    expect(notice.key).toBe(FALLBACK);
    expect(notice.detail).toContain("weird failure");
  });
});

describe("notice helpers", () => {
  it("treats only processing/no-speech notices as transient", () => {
    expect(isTransientAudioNotice({ key: "message.audioProcessingFailed" })).toBe(true);
    expect(isTransientAudioNotice({ key: "message.noSpeechDetected" })).toBe(true);
    expect(isTransientAudioNotice({ key: "message.microphoneNotFound" })).toBe(false);
    expect(isTransientAudioNotice(null)).toBe(false);
    expect(isTransientAudioNotice(undefined)).toBe(false);
  });

  it("drops blank no-speech details", () => {
    expect(sanitizeNoSpeechDetail(undefined)).toBeUndefined();
    expect(sanitizeNoSpeechDetail("   ")).toBeUndefined();
  });

  it("does not expose internal session identifiers in no-speech toasts", () => {
    expect(
      sanitizeNoSpeechDetail("parapper:123e4567-e89b-12d3-a456-426614174000:turn-1"),
    ).toBeUndefined();
    expect(
      sanitizeNoSpeechDetail("web-speech:123e4567-e89b-12d3-a456-426614174000"),
    ).toBeUndefined();
  });

  it("passes through a detail that is neither diagnostics nor a 422 body", () => {
    expect(sanitizeNoSpeechDetail("mic muted")).toBe("mic muted");
  });

  it("keeps diagnostics that already start at mode=", () => {
    expect(sanitizeNoSpeechDetail("mode=worklet · rms=-54.2dB")).toBe("mode=worklet · rms=-54.2dB");
  });

  it("keeps diagnostics that do not include a mode prefix", () => {
    expect(sanitizeNoSpeechDetail("rms=-54.2dB · chunks=8")).toBe("rms=-54.2dB · chunks=8");
  });

  it("keeps a malformed rejection on the fallback key without fabricated detail", () => {
    expect(noticeFromError(null, FALLBACK)).toEqual({ key: FALLBACK });
  });

  it("uses the latest capture diagnostics for no-speech and mapped DOM errors", () => {
    const capture = new MicrophoneCapture();
    const publishDiagnostics = (
      capture as unknown as {
        publishDiagnostics: (error: AudioCaptureError | null) => void;
      }
    ).publishDiagnostics.bind(capture);
    publishDiagnostics(new AudioCaptureError("microphone-track-muted"));

    const noSpeech = noticeForNoSpeech();
    expect(noSpeech.key).toBe("message.noSpeechDetected");
    expect(noSpeech.detail).toContain("error=microphone-track-muted");

    const denied = noticeFromError(new DOMException("denied", "NotAllowedError"), FALLBACK);
    expect(denied.key).toBe("message.microphonePermissionDenied");
    expect(denied.detail).toContain("error=microphone-track-muted");

    publishDiagnostics(null);
  });
});
