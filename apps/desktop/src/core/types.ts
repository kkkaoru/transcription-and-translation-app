export type Platform = "macos" | "windows" | "linux" | "unknown";
export type AppStatus = "idle" | "starting" | "capturing" | "error";
export type BackendMode = "local" | "remote";
export type TextAlign = "left" | "center" | "right";
export type CaptionOrder = "source-first" | "translation-first";

/**
 * Selects the recognition path used by the live/debug pipeline.
 *
 * `parapper-azookey` is the historical migration-safe fallback path (Parapper ASR followed
 * by the local AzooKey kana-kanji normalizer), used when Web Speech API is not
 * usable in the current runtime.  The other two values are intentionally explicit
 * so a future runtime can switch paths without changing the persisted config
 * shape.
 */
export type RecognitionMode = "parapper-raw" | "web-speech" | "parapper-azookey";

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
  /**
   * Frontend capture window sent to the inference gateway. This is the
   * `audio.chunkMs` setting shown in the UI; it is separate from Parapper's
   * internal `vad_interval_ms` (currently 32 ms in the headless sidecar).
   */
  chunkMs: number;
  /**
   * Parapper/Silero's true VAD frame interval. Saved to the desktop config and
   * passed to the headless sidecar on its next launch.
   */
  vadIntervalMs: number;
  /**
   * Parapper/Silero speech-confidence threshold (0…1). Higher values reject
   * more noise but can miss quiet speech; applied by the sidecar, not the
   * frontend RMS gate.
   */
  vadThreshold: number;
  /**
   * Fixed RMS gate (dBFS) used only when adaptiveNoiseFloor is false. The
   * frontend applies this before `transcribe_audio_chunk` is invoked.
   */
  silenceGateDb: number;
  /**
   * Browser noise suppression / echo cancellation for getUserMedia.
   * Default true; set false for unprocessed "raw" capture (AGC still on).
   */
  noiseSuppression: boolean;
  /**
   * Adaptive noise-floor gate: chunk passes when it exceeds the rolling
   * ambient floor estimate by a margin. Default true; silenceGateDb is the
   * fallback fixed gate when disabled.
   */
  adaptiveNoiseFloor: boolean;
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

/** Structured debug log severity (frontend ring buffer + backend filtering). */
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface DebugConfig {
  /** When true, pipeline stage logs include truncated input/output samples. */
  verboseLogging: boolean;
  /**
   * Maximum structured log severity retained in the Debug panel console feed
   * and mirrored to the browser console. Default: info.
   */
  logLevel: LogLevel;
}

export interface AppConfig {
  schemaVersion: 1;
  /** Recognition path selected for live/debug capture. */
  recognitionMode: RecognitionMode;
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

/**
 * User-facing caption phases. The backend only ever emits `source` (post
 * normalize) and `translation`. `source` with `provisional: true` is a
 * frontend-synthesized paint from the raw ASR pipeline stage event (see
 * {@link CaptionPayload.provisional}) — it never comes from the Rust side.
 */
export type CaptionStage = "source" | "translation";

export interface CaptionPayload {
  id: string;
  sourceText: string;
  translationText: string;
  sourceLanguage: string;
  targetLanguage: string;
  startedAt: number;
  receivedAt: number;
  /**
   * The backend emits `source` only after the selected normalizer
   * (AzooKey/zenz) has completed. The frontend additionally paints a
   * `source`-stage caption immediately from the raw ASR `pipeline:stage`
   * event, before normalization finishes, so first paint is not gated on
   * the normalizer; that provisional caption is marked with
   * {@link CaptionPayload.provisional} and is replaced in place (same `id`)
   * once the real normalized `source` caption arrives.
   */
  stage?: CaptionStage;
  sequence?: number;
  isFinal?: boolean;
  confidence?: number;
  /**
   * True only for the frontend-synthesized raw-ASR paint described above.
   * Never set by the backend. Consumers should render this at reduced
   * visual emphasis (it is likely to be replaced within one normalizer
   * pass) and must treat it as superseded once a non-provisional caption
   * with the same `id` and `stage: "source"` arrives.
   */
  provisional?: boolean;
  /** Native capture generation used to fence delayed source-caption invokes. */
  captureGeneration?: number;
}

/** One structured interim/final output from the persistent Parapper session. */
export interface ParapperRecognitionOutput {
  text: string;
  /** Original ASR surface retained by Parapper's Vibrato→Hiragana sink. */
  sourceText?: string | null;
  /** Explicit phonetic input for the native AzooKey normalizer. */
  azookeyInputText?: string | null;
  sessionId: string;
  turnSessionId: number;
  turnId: number;
  revision: number;
  /** Monotonic sidecar output cursor within a recognition session. */
  outputSequence?: number;
  segmentId: number;
  previousSegmentId?: number | null;
  sourceAsrModel: string;
  sourceLanguage: string;
  detectedLanguage?: string | null;
  elapsedMs: number;
  audioDurationMs?: number | null;
  isFinal: boolean;
  /** Native capture generation captured when the output entered the queue. */
  captureGeneration?: number;
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
  /** Original Vibrato surface when an ASR stage also exposes a Hiragana reading. */
  surfaceText?: string;
  /** Stage wall-clock start (epoch millis). */
  startedAt: number;
  /** Stage wall-clock end (epoch millis). Historical field name is `at`. */
  at: number;
  durationMs: number;
  ok: boolean;
  error?: string | null;
  /** Native capture generation for stale-session diagnostics. */
  captureGeneration?: number;
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

/**
 * Native updater state exposed to the Debug panel.  The updater is optional in
 * development/browser builds, so consumers must also accept `unsupported` and
 * unknown future states.
 */
export type UpdateStatusKind =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installed"
  | "failed"
  | "unsupported";

export interface UpdateMetadata {
  version: string;
  date: string | null;
  body: string | null;
  target: string | null;
  source: string | null;
  channel: string | null;
}

export interface UpdateStatus {
  status: UpdateStatusKind | string;
  currentVersion: string | null;
  availableVersion: string | null;
  checkedAt: string | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  error: string | null;
  source: string | null;
  channel: string | null;
  /** Result of the post-install bundle switch/relaunch, when requested. */
  switchResult?: string | null;
  relaunchDeferred?: boolean;
  metadata?: UpdateMetadata | null;
}

export interface RelaunchResult {
  deferred: boolean;
  reason: string;
}

/** Health/version snapshot for one bundled or remote sidecar. */
export interface SidecarStatus {
  id: string;
  kind: string;
  version: string | null;
  versionSource: string | null;
  health: string;
  healthUrl: string | null;
  port: number | null;
  active: boolean;
  lastError: string | null;
  startedAt: string | null;
  switchResult: string | null;
}

export interface RuntimeDiagnostics {
  update: UpdateStatus;
  sidecars: SidecarStatus[];
  updateHistory?: Array<Record<string, unknown>>;
}

export interface AudioChunk {
  pcmBase64: string;
  sampleRate: number;
  channels: 1;
  durationMs: number;
  /** Stable capture-session utterance key for rolling/contextual windows. */
  utteranceId?: string;
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
