import type {
  AppConfig,
  CaptionTextStyle,
  ModelCatalog,
  ModelInfo,
  RecognitionMode,
  RuntimeStatus,
} from "./types";

/** Persisted recognition paths exposed by the debug controls. */
export const RECOGNITION_MODES = [
  "parapper-raw",
  "web-speech",
  "parapper-azookey",
] as const satisfies readonly RecognitionMode[];

/** Keep the existing Parapper + AzooKey path as the migration-safe default. */
export const DEFAULT_RECOGNITION_MODE: RecognitionMode = "parapper-azookey";

export const isRecognitionMode = (value: unknown): value is RecognitionMode =>
  typeof value === "string" && (RECOGNITION_MODES as readonly string[]).includes(value);

export interface PartialAppConfig {
  schemaVersion?: 1;
  recognitionMode?: RecognitionMode;
  language?: Partial<AppConfig["language"]>;
  endpoint?: Partial<AppConfig["endpoint"]>;
  models?: Partial<AppConfig["models"]>;
  audio?: Partial<AppConfig["audio"]>;
  overlay?: Omit<Partial<AppConfig["overlay"]>, "source" | "translation"> & {
    source?: Partial<CaptionTextStyle>;
    translation?: Partial<CaptionTextStyle>;
  };
  debug?: Partial<AppConfig["debug"]>;
}

export const DEFAULT_FONT_FAMILY = '"Noto Sans JP Variable", "Noto Sans JP", sans-serif';

/**
 * Frontend live-caption audio window (not Parapper's internal VAD interval).
 *
 * 640 ms is a useful middle ground for live captions: it is short enough to
 * keep the first caption responsive, while still giving Parapper more than a
 * handful of 32 ms VAD frames to recognise a Japanese mora/word.  The range
 * exposed in SettingsView is intentionally aligned to 32 ms VAD frames.
 */
export const DEFAULT_AUDIO_CHUNK_MS = 640;
export const AUDIO_CHUNK_MIN_MS = 320;
export const AUDIO_CHUNK_MAX_MS = 2_000;
export const AUDIO_CHUNK_STEP_MS = 32;

/** Parapper headless sidecar's internal VAD interval (one frame cadence). */
export const DEFAULT_VAD_INTERVAL_MS = 32;
export const VAD_INTERVAL_MIN_MS = 16;
export const VAD_INTERVAL_MAX_MS = 128;
export const VAD_INTERVAL_STEP_MS = 16;

/** Silero VAD speech-confidence threshold used by the headless sidecar. */
export const DEFAULT_VAD_THRESHOLD = 0.5;
export const VAD_THRESHOLD_MIN = 0.1;
export const VAD_THRESHOLD_MAX = 0.9;
export const VAD_THRESHOLD_STEP = 0.05;

export const normalizeVadIntervalMs = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_VAD_INTERVAL_MS;
  }
  const rounded = Math.round(value / VAD_INTERVAL_STEP_MS) * VAD_INTERVAL_STEP_MS;
  return Math.min(VAD_INTERVAL_MAX_MS, Math.max(VAD_INTERVAL_MIN_MS, rounded));
};

export const normalizeVadThreshold = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_VAD_THRESHOLD;
  }
  const rounded = Math.round(value / VAD_THRESHOLD_STEP) * VAD_THRESHOLD_STEP;
  return Math.min(VAD_THRESHOLD_MAX, Math.max(VAD_THRESHOLD_MIN, rounded));
};

/**
 * Default RMS silence gate (dBFS) used when adaptive noise-floor gating is
 * disabled. Ambient noise with AGC-off raw capture often sits around -54 dBFS
 * and must not be sent to Parapper (yields transcript_missing).
 */
export const DEFAULT_SILENCE_GATE_DB = -50;

/**
 * Adaptive noise-floor gating is the default: each chunk is compared against a
 * rolling ambient floor estimate instead of a fixed threshold, so quiet speech
 * (~-54 dB) in a normal room (~-65 dB floor) passes while true ambient is
 * rejected. Set false to fall back to the fixed {@link DEFAULT_SILENCE_GATE_DB}.
 */
export const DEFAULT_ADAPTIVE_NOISE_FLOOR = true;

export const createTextStyle = (overrides: Partial<CaptionTextStyle> = {}): CaptionTextStyle => ({
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSizePx: 34,
  fontWeight: 700,
  color: "#ffffff",
  opacity: 1,
  letterSpacingPx: 0.2,
  lineHeight: 1.3,
  textAlign: "center",
  maxWidthPercent: 86,
  cullingEnabled: true,
  cullingColor: "#061018",
  cullingWidthPx: 3,
  cullingOpacity: 0.92,
  shadowEnabled: true,
  shadowColor: "#000000",
  shadowBlurPx: 8,
  shadowOffsetX: 0,
  shadowOffsetY: 3,
  backgroundEnabled: false,
  backgroundColor: "#061018",
  backgroundOpacity: 0.72,
  paddingX: 14,
  paddingY: 7,
  borderRadius: 9,
  ...overrides,
});

export const createDefaultConfig = (): AppConfig => ({
  schemaVersion: 1,
  recognitionMode: DEFAULT_RECOGNITION_MODE,
  language: {
    source: "ja",
    target: "en",
  },
  endpoint: {
    mode: "local",
    baseUrl: "http://127.0.0.1:8765",
    transcriptionPath: "/v1/audio/transcriptions",
    chatPath: "/v1/chat/completions",
    timeoutMs: 18_000,
  },
  models: {
    asr: "parapper-ja",
    normalizer: "azookey-rust",
    translator: "hy-mt2-1.8b-gguf",
    paths: {},
  },
  audio: {
    inputDeviceId: "default",
    sampleRate: 16_000,
    chunkMs: DEFAULT_AUDIO_CHUNK_MS,
    silenceGateDb: DEFAULT_SILENCE_GATE_DB,
    // Parapper's true VAD settings are passed to the headless sidecar at launch.
    vadIntervalMs: DEFAULT_VAD_INTERVAL_MS,
    vadThreshold: DEFAULT_VAD_THRESHOLD,
    // Browser NS/AEC on by default; user can disable for raw capture.
    noiseSuppression: true,
    // Adaptive floor gate on by default; silenceGateDb is the fixed fallback.
    adaptiveNoiseFloor: DEFAULT_ADAPTIVE_NOISE_FLOOR,
  },
  overlay: {
    width: 1_280,
    height: 720,
    x: 0,
    y: 0,
    order: "source-first",
    gapPx: 14,
    safeAreaPx: 42,
    captionXPercent: 50,
    captionYPercent: 88,
    source: createTextStyle({ fontSizePx: 36, fontWeight: 750 }),
    translation: createTextStyle({
      fontSizePx: 29,
      fontWeight: 650,
      color: "#bfe8ff",
      cullingColor: "#07121d",
    }),
  },
  debug: {
    verboseLogging: false,
    logLevel: "info",
  },
});

const model = (
  family: ModelInfo["family"],
  id: string,
  label: string,
  description: string,
  localArtifact: string,
  languages: string[],
  recommended = false,
): ModelInfo => ({
  family,
  id,
  label,
  description,
  localArtifact,
  languages,
  recommended,
});

export const DEFAULT_MODEL_CATALOG: ModelCatalog = {
  asr: [
    model(
      "asr",
      "parapper-ja",
      "Parapper ASR / 日本語",
      "Parakeet-Inc Parapper-ASRを日本語のストリーミング認識に使用します。",
      "Parapper-ASR runtime",
      ["ja"],
      true,
    ),
  ],
  normalizer: [
    model(
      "normalizer",
      "azookey-rust",
      "AzooKey Rust（内蔵）",
      "AzooKeyの変換処理をRustのViterbi変換器として実行します。",
      "内蔵辞書 / optional AzooKey dictionary",
      ["ja"],
      true,
    ),
    model(
      "normalizer",
      "zenz-v3.2-xsmall-gguf",
      "zenz v3.2 xsmall",
      "低レイテンシー向けのzenz GGUFモデルです。",
      "ggml-model-Q5_K_M.gguf",
      ["ja"],
    ),
    model(
      "normalizer",
      "zenz-v3.2-small-gguf",
      "zenz v3.2 small",
      "変換精度を優先するzenz GGUFモデルです。",
      "ggml-model-Q5_K_M.gguf",
      ["ja"],
    ),
    model(
      "normalizer",
      "zenz-v2-q5-k-m-gguf",
      "Zenzai v2 Q5_K_M",
      "低メモリ環境向けのZenzai v2互換GGUFモデルです。",
      "zenz-v2-Q5_K_M.gguf",
      ["ja"],
    ),
  ],
  translator: [
    model(
      "translator",
      "hy-mt2-1.8b-gguf",
      "Hy-MT2 1.8B GGUF",
      "日本語から英語へのライブ字幕に適した標準量子化モデルです。",
      "Hy-MT2-1.8B-GGUF",
      ["ja", "en"],
      true,
    ),
    model(
      "translator",
      "hy-mt2-1.8b-2bit-gguf",
      "Hy-MT2 1.8B 2-bit GGUF",
      "メモリ使用量と速度を優先するモデルです。",
      "Hy-MT2-1.8B-2bit-GGUF",
      ["ja", "en"],
    ),
    model(
      "translator",
      "hy-mt2-1.8b-1.25bit-gguf",
      "Hy-MT2 1.8B 1.25-bit GGUF",
      "オンデバイス実行のための最小モデルです。",
      "Hy-MT2-1.8B-1.25bit-GGUF",
      ["ja", "en"],
    ),
    model(
      "translator",
      "hy-mt2-7b-gguf",
      "Hy-MT2 7B GGUF",
      "レイテンシーより翻訳品質を優先するモデルです。",
      "Hy-MT2-7B-GGUF",
      ["ja", "en"],
    ),
  ],
};

export const DEFAULT_RUNTIME_STATUS: RuntimeStatus = {
  status: "idle",
  platform: "unknown",
  backendReachable: false,
  nativeOutput: "unsupported",
  lastError: null,
};

/**
 * Legacy installs used silenceGateDb=-55, which lets ambient ~-54 dBFS through
 * to Parapper (transcript_missing) whenever the fixed gate is active. Bump only
 * that old default; intentional lower gates set by the user are left alone.
 * (Adaptive noise-floor gating is now the default path; this migration keeps
 * the fixed-gate fallback sane for users who disable it.)
 */
export const migrateSilenceGateDb = (gateDb: number | undefined): number => {
  if (gateDb === undefined || !Number.isFinite(gateDb)) {
    return DEFAULT_SILENCE_GATE_DB;
  }
  // Exact legacy default (float JSON may be -55 or -55.0).
  if (Math.abs(gateDb - -55) < 1e-6) {
    return DEFAULT_SILENCE_GATE_DB;
  }
  return gateDb;
};

export const mergeConfig = (candidate: PartialAppConfig): AppConfig => {
  const base = createDefaultConfig();
  const input = candidate;
  // Recognition mode was added after the original config schema. Treat a
  // missing, malformed, or future value as the safe historical pipeline so
  // old localStorage/config.json files continue to load.
  const recognitionMode = isRecognitionMode(input.recognitionMode)
    ? input.recognitionMode
    : DEFAULT_RECOGNITION_MODE;
  const audio = { ...base.audio, ...input.audio };
  audio.silenceGateDb = migrateSilenceGateDb(audio.silenceGateDb);
  audio.vadIntervalMs = normalizeVadIntervalMs(audio.vadIntervalMs);
  audio.vadThreshold = normalizeVadThreshold(audio.vadThreshold);
  // Missing / non-boolean legacy values default to enabled.
  if (typeof audio.noiseSuppression !== "boolean") {
    audio.noiseSuppression = true;
  }
  if (typeof audio.adaptiveNoiseFloor !== "boolean") {
    audio.adaptiveNoiseFloor = DEFAULT_ADAPTIVE_NOISE_FLOOR;
  }
  return {
    ...base,
    ...input,
    recognitionMode,
    language: { ...base.language, ...input.language },
    endpoint: { ...base.endpoint, ...input.endpoint },
    models: {
      ...base.models,
      ...input.models,
      paths: { ...base.models.paths, ...input.models?.paths },
    },
    audio,
    overlay: {
      ...base.overlay,
      ...input.overlay,
      source: { ...base.overlay.source, ...input.overlay?.source },
      translation: { ...base.overlay.translation, ...input.overlay?.translation },
    },
    debug: { ...base.debug, ...input.debug },
  };
};
