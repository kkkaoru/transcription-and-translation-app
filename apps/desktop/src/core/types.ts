export type Platform = "macos" | "windows" | "linux" | "unknown";
export type AppStatus = "idle" | "starting" | "capturing" | "error";
export type BackendMode = "local" | "remote";
export type TextAlign = "left" | "center" | "right";
export type CaptionOrder = "source-first" | "translation-first";

export interface LanguageConfig {
  source: string;
  target: string;
}

export interface BackendEndpoint {
  mode: BackendMode;
  baseUrl: string;
  transcriptionPath: string;
  chatPath: string;
  timeoutMs: number;
}

export interface ModelSelection {
  asr: string;
  normalizer: string;
  translator: string;
  paths: Record<string, string>;
}

export interface AudioConfig {
  inputDeviceId: string;
  sampleRate: 16000;
  chunkMs: number;
  silenceGateDb: number;
}

export interface CaptionTextStyle {
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  color: string;
  opacity: number;
  letterSpacingPx: number;
  lineHeight: number;
  textAlign: TextAlign;
  maxWidthPercent: number;
  cullingEnabled: boolean;
  cullingColor: string;
  cullingWidthPx: number;
  cullingOpacity: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowBlurPx: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  backgroundEnabled: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  paddingX: number;
  paddingY: number;
  borderRadius: number;
}

export interface OverlayConfig {
  width: number;
  height: number;
  x: number;
  y: number;
  order: CaptionOrder;
  gapPx: number;
  safeAreaPx: number;
  captionXPercent: number;
  captionYPercent: number;
  source: CaptionTextStyle;
  translation: CaptionTextStyle;
}

export interface DebugConfig {
  /** When true, pipeline stage logs include truncated input/output samples. */
  verboseLogging: boolean;
}

export interface AppConfig {
  schemaVersion: 1;
  language: LanguageConfig;
  endpoint: BackendEndpoint;
  models: ModelSelection;
  audio: AudioConfig;
  overlay: OverlayConfig;
  debug: DebugConfig;
}

export type ModelFamily = "asr" | "normalizer" | "translator";

export interface ModelInfo {
  id: string;
  family: ModelFamily;
  label: string;
  description: string;
  languages: string[];
  localArtifact: string;
  recommended: boolean;
}

export interface ModelCatalog {
  asr: ModelInfo[];
  normalizer: ModelInfo[];
  translator: ModelInfo[];
}

export interface CaptionPayload {
  id: string;
  sourceText: string;
  translationText: string;
  sourceLanguage: string;
  targetLanguage: string;
  startedAt: number;
  receivedAt: number;
  stage?: "source" | "translation";
  sequence?: number;
  isFinal?: boolean;
  confidence?: number;
}

/** Independent pipeline stage for debug mode (parapper / azookey / HY-MT2). */
export type PipelineStageName = "asr" | "normalize" | "translate";

export interface PipelineStageEvent {
  stage: PipelineStageName | string;
  utteranceId: string;
  /** Selected model id for this stage (e.g. parapper-ja / azookey-rust / hy-mt2-…). */
  modelId: string;
  inputSnippet: string;
  outputText: string;
  /** Stage wall-clock start (epoch millis). */
  startedAt: number;
  /** Stage wall-clock end (epoch millis). Historical field name is `at`. */
  at: number;
  durationMs: number;
  ok: boolean;
  error?: string | null;
}

/** One live utterance with ordered stage rows for DebugPanel. */
export interface UtteranceStageGroup {
  utteranceId: string;
  at: number;
  stages: PipelineStageEvent[];
  totalDurationMs: number;
  ok: boolean;
}

export interface RuntimeStatus {
  status: AppStatus;
  platform: Platform;
  backendReachable: boolean;
  nativeOutput: "transparent-window" | "spout2" | "syphon" | "unsupported";
  lastError: string | null;
}

export interface AudioChunk {
  pcmBase64: string;
  sampleRate: number;
  channels: 1;
  durationMs: number;
}

export interface AudioInputDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

export type UnlistenFn = () => void;

export type ModelInstallStatus =
  | "ready"
  | "missing"
  | "corrupt"
  | "partial"
  | "downloading"
  | "error";

export interface ModelStatusEntry {
  modelId: string;
  status: ModelInstallStatus | string;
  installedBytes: number | null;
  expectedBytes: number;
  lastError: string | null;
}

export interface DownloadProgress {
  modelId: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  speedBps: number;
  elapsedMs: number;
}
