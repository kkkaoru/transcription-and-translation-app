import { float32ToPcm16, pcm16ToWavBytes } from "./pcm-wav";

export const WORKERS_AI_ASR_UNSUPPORTED_JA =
  "このブラウザは Cloudflare Workers AI ASR 録音に対応していません（マイクまたは AudioContext が利用できません）";
export const WORKERS_AI_ASR_PREPARING_JA =
  "Cloudflare Workers AI ASR を準備しています。少し待ってからもう一度お試しください";
export const WEB_SPEECH_UNSUPPORTED_JA = "このブラウザは Web Speech API に対応していません";
export const WORKERS_AI_ASR_GRAPH_UNAVAILABLE_JA = "マイク音声の解析を開始できません";
export const WORKERS_AI_ASR_MIC_GENERIC_JA = "マイクを開始できません";

type NavigatorWithMedia = Navigator & {
  mediaDevices?: {
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  };
};

type AudioContextCtor = new () => AudioContext;

const GET_USER_MEDIA_DENIED = new Set(["NotAllowedError", "PermissionDeniedError"]);
const GET_USER_MEDIA_MISSING = new Set(["NotFoundError", "DevicesNotFoundError"]);
const GET_USER_MEDIA_BUSY = new Set(["NotReadableError", "TrackStartError"]);
const GET_USER_MEDIA_CONSTRAINT = new Set(["OverconstrainedError", "ConstraintNotSatisfiedError"]);
const GET_USER_MEDIA_SECURE = new Set(["SecurityError", "NotSupportedError"]);

export const audioContextConstructor = (): AudioContextCtor | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }
  const standard = window.AudioContext;
  if (typeof standard === "function") {
    return standard;
  }
  const webkit = (window as unknown as { webkitAudioContext?: AudioContextCtor })
    .webkitAudioContext;
  return typeof webkit === "function" ? webkit : undefined;
};

export const isWorkersAiAsrCaptureSupported = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  const nav = typeof navigator !== "undefined" ? (navigator as NavigatorWithMedia) : undefined;
  return Boolean(nav?.mediaDevices?.getUserMedia && audioContextConstructor());
};

export const hasMediaRecorderSupport = (): boolean => typeof MediaRecorder === "function";

const errorName = (error: unknown): string =>
  error && typeof error === "object" && "name" in error && typeof error.name === "string"
    ? error.name
    : "";

const hasJapanese = (text: string): boolean => /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);

/** Map getUserMedia failures to Japanese UI copy. Never show English-only browser strings. */
export const getUserMediaErrorMessageJa = (error: unknown): string => {
  const name = errorName(error);
  if (GET_USER_MEDIA_DENIED.has(name)) {
    return "マイク許可が必要です。ブラウザの設定でマイクを許可してください";
  }
  if (GET_USER_MEDIA_MISSING.has(name)) {
    return "マイクが見つかりません。接続を確認してください";
  }
  if (GET_USER_MEDIA_BUSY.has(name)) {
    return "マイクを開始できません。他のアプリが使用中の可能性があります";
  }
  if (GET_USER_MEDIA_CONSTRAINT.has(name)) {
    return "この端末のマイク設定では録音できません";
  }
  if (GET_USER_MEDIA_SECURE.has(name)) {
    return "このページではマイクを使用できません（HTTPS が必要な場合があります）";
  }
  if (name === "AbortError") {
    return "マイクの開始が中断されました";
  }
  const message = error instanceof Error ? error.message.trim() : "";
  if (message && hasJapanese(message)) {
    return message;
  }
  return WORKERS_AI_ASR_MIC_GENERIC_JA;
};

export const wavFileFromPcmFloat32 = (samples: Float32Array, name = "utterance.wav"): File =>
  new File([pcm16ToWavBytes(float32ToPcm16(samples))], name, { type: "audio/wav" });
