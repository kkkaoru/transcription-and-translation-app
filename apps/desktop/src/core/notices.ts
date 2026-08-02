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
 * Strip raw gateway JSON / HTTP wrappers from no-speech details so the toast
 * stays actionable (mic level / diagnostics) instead of looking like a crash.
 */
export const sanitizeNoSpeechDetail = (detail?: string): string | undefined => {
  const trimmed = detail?.trim();
  if (!trimmed) {
    return undefined;
  }
  // Session/turn identifiers are useful in verbose logs but are not
  // actionable user-facing diagnostics. Keep them out of the toast even when
  // a caller accidentally forwards an id instead of a capture detail.
  const internalId = /^(?:web-speech:|parapper:)?[0-9a-f]{8}-[0-9a-f-]{27,}(?::[^\s]+)*$/i;
  if (internalId.test(trimmed)) {
    return undefined;
  }
  // Prefer capture diagnostics over raw HTTP bodies when both are present.
  if (trimmed.includes("mode=") || trimmed.includes("rms=") || trimmed.includes("chunks=")) {
    // Drop a leading "inference returned HTTP …" prefix if diagnostics follow.
    const diagStart = trimmed.search(/(?:^| · )mode=/);
    if (diagStart >= 0) {
      return trimmed.slice(diagStart).replace(/^ · /, "").trim() || undefined;
    }
    return trimmed;
  }
  if (
    trimmed.includes("transcript_missing") ||
    trimmed.includes("without a final transcript") ||
    trimmed.includes("inference returned HTTP")
  ) {
    // Fall back to live capture diagnostics rather than the opaque 422 body.
    const diag = formatAudioCaptureDiagnostics(getLastAudioCaptureDiagnostics());
    return diag || undefined;
  }
  return trimmed;
};

/**
 * Non-fatal notice for silence / Parapper transcript_missing soft-skips.
 * Never uses message.audioProcessingFailed ("音声処理に失敗しました").
 */
export const noticeForNoSpeech = (detail?: string): Notice => {
  const clean = sanitizeNoSpeechDetail(detail);
  if (clean) {
    return { key: "message.noSpeechDetected", detail: clean };
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
      "microphone-track-muted": "message.microphoneTrackMuted",
      "audio-chunk-delivery-failed": "message.audioChunkDeliveryFailed",
      "parapper-transport-failed": "message.parapperTransportFailed",
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
