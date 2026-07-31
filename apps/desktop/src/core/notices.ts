import type { MessageKey } from "../i18n/messages";
import {
  AudioCaptureError,
  formatAudioCaptureDiagnostics,
  getLastAudioCaptureDiagnostics,
} from "./audio";
import { formatBridgeError, isNoSpeechBridgeError } from "./bridge";

export type Notice = { detail?: string; key: MessageKey };

/**
 * Decide whether a process() rejection should toast as audioProcessingFailed.
 * No-speech / transcript_missing must soft-skip (diagnostics only).
 */
export const shouldToastAudioProcessingFailure = (error: unknown): boolean =>
  !isNoSpeechBridgeError(error);

/**
 * Non-fatal notice for silence / Parapper transcript_missing soft-skips.
 * Never uses message.audioProcessingFailed ("音声処理に失敗しました").
 */
export const noticeForNoSpeech = (detail?: string): Notice => {
  const explicit = detail?.trim();
  if (explicit) {
    return { key: "message.noSpeechDetected", detail: explicit };
  }
  const diag = formatAudioCaptureDiagnostics(getLastAudioCaptureDiagnostics());
  return diag
    ? { key: "message.noSpeechDetected", detail: diag }
    : { key: "message.noSpeechDetected" };
};

/** Clear sticky processing / silence notices when a real caption arrives. */
export const isTransientAudioNotice = (notice: Notice | null | undefined): boolean =>
  notice?.key === "message.audioProcessingFailed" || notice?.key === "message.noSpeechDetected";

/** Map rejections to i18n notice keys (+ optional diagnostic detail). */
export const noticeFromError = (error: unknown, fallback: MessageKey): Notice => {
  if (isNoSpeechBridgeError(error)) {
    return noticeForNoSpeech(formatBridgeError(error));
  }
  if (error instanceof AudioCaptureError) {
    const keys: Record<AudioCaptureError["code"], MessageKey> = {
      "microphone-unavailable": "message.microphoneUnavailable",
      "audio-context-failed": "message.audioContextFailed",
      "audio-context-suspended": "message.audioContextFailed",
      "microphone-track-ended": "message.microphoneTrackEnded",
    };
    const detail =
      error.causeError instanceof DOMException
        ? error.causeError.message
        : error.message !== error.code
          ? error.message
          : formatAudioCaptureDiagnostics(getLastAudioCaptureDiagnostics()) || undefined;
    return { key: keys[error.code], detail: detail || undefined };
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    const keys: Partial<Record<string, MessageKey>> = {
      NotAllowedError: "message.microphonePermissionDenied",
      SecurityError: "message.microphonePermissionDenied",
      NotFoundError: "message.microphoneNotFound",
      NotReadableError: "message.microphoneBusy",
      OverconstrainedError: "message.microphoneConstraint",
      AbortError: "message.microphoneStartFailed",
    };
    const key = keys[error.name];
    const diag = formatAudioCaptureDiagnostics(getLastAudioCaptureDiagnostics());
    if (key) {
      return diag ? { key, detail: diag } : { key };
    }
    return {
      key: fallback,
      detail: [error.message, diag].filter(Boolean).join(" · ") || undefined,
    };
  }
  const detail = formatBridgeError(error);
  const diag = formatAudioCaptureDiagnostics(getLastAudioCaptureDiagnostics());
  const combined = [detail, diag].filter(Boolean).join(" · ");
  return combined ? { key: fallback, detail: combined } : { key: fallback };
};
