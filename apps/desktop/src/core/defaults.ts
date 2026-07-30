import type { AppConfig, CaptionTextStyle, ModelCatalog, ModelInfo, RuntimeStatus } from "./types";

export interface PartialAppConfig {
  schemaVersion?: 1;
  language?: Partial<AppConfig["language"]>;
  endpoint?: Partial<AppConfig["endpoint"]>;
  models?: Partial<AppConfig["models"]>;
  audio?: Partial<AppConfig["audio"]>;
  overlay?: Omit<Partial<AppConfig["overlay"]>, "source" | "translation"> & {
    source?: Partial<CaptionTextStyle>;
    translation?: Partial<CaptionTextStyle>;
  };
}

export const DEFAULT_FONT_FAMILY = '"Noto Sans JP Variable", "Noto Sans JP", sans-serif';

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
    chunkMs: 1_200,
    silenceGateDb: -55,
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

export const mergeConfig = (candidate: PartialAppConfig): AppConfig => {
  const base = createDefaultConfig();
  const input = candidate;
  return {
    ...base,
    ...input,
    language: { ...base.language, ...input.language },
    endpoint: { ...base.endpoint, ...input.endpoint },
    models: {
      ...base.models,
      ...input.models,
      paths: { ...base.models.paths, ...input.models?.paths },
    },
    audio: { ...base.audio, ...input.audio },
    overlay: {
      ...base.overlay,
      ...input.overlay,
      source: { ...base.overlay.source, ...input.overlay?.source },
      translation: { ...base.overlay.translation, ...input.overlay?.translation },
    },
  };
};
