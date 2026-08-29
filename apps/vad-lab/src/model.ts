// Runs in the browser; built and tested with Bun.
export type MemoryMeasurementMethod =
  | "measureUserAgentSpecificMemory"
  | "performance.memory.usedJSHeapSize"
  | "unavailable";

export interface VadMemoryMetrics {
  supported: boolean;
  method: MemoryMeasurementMethod;
  scope: "page";
  sampleCount: number;
  startBreakdownJson: string;
  endBreakdownJson: string;
  startBytes: number | null;
  endBytes: number | null;
  peakBytes: number | null;
  deltaBytes: number | null;
  workerAttributedBytes: number | null;
  wasmAttributedBytes: number | null;
  workerWasmAttributedBytes: number | null;
}

export interface VadTimingMetrics {
  segmentationWallMs: number;
  callbackProcessingMs: number;
  callbackAverageMs: number;
  callbackMaximumMs: number;
  postProcessingMs: number;
  frameCount: number;
  audioFrameMs: number;
  frameIntervalAverageMs: number;
  frameIntervalP50Ms: number;
  frameIntervalP95Ms: number;
  frameIntervalMaximumMs: number;
  frameIntervalJitterMs: number;
  framesPerSecond: number;
  realTimeFactor: number;
  delayedFrameCount: number;
}

export interface MainThreadLoadMetrics {
  longTaskSupported: boolean;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaximumMs: number;
  eventLoopLagAverageMs: number;
  eventLoopLagMaximumMs: number;
  eventLoopSampleCount: number;
}

export interface EngineInitializationMetrics {
  initializationMs: number;
  memoryBeforeBytes: number | null;
  memoryAfterBytes: number | null;
  measuredPageDeltaBytes: number | null;
  memoryMethod: MemoryMeasurementMethod;
  memoryBeforeBreakdownJson: string;
  memoryAfterBreakdownJson: string;
  exactSileroWasmMemoryAvailable: false;
}

export interface VadProbabilityMetrics {
  averageSpeechProbability: number;
  maximumSpeechProbability: number;
  minimumSpeechProbability: number;
}

export interface MicrophoneConfiguration {
  deviceId: string;
  deviceLabel: string;
  groupId: string;
  echoCancellation: "default" | "enabled" | "disabled";
  noiseSuppression: "default" | "enabled" | "disabled";
  autoGainControl: "default" | "enabled" | "disabled";
  voiceIsolation: "default" | "enabled" | "disabled";
  suppressLocalAudioPlayback: "default" | "enabled" | "disabled";
  restrictOwnAudio: "default" | "enabled" | "disabled";
  channelCount: number | null;
  sampleRate: number | null;
  sampleSize: number | null;
  latency: number | null;
  volume: number | null;
}

export interface VadConfiguration {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  redemptionMs: number;
  preSpeechPadMs: number;
  minSpeechMs: number;
  processorPreference: "auto" | "audio-worklet" | "script-processor";
}

export interface CaptureConfigurationMetrics {
  requestedMicrophone: MicrophoneConfiguration;
  vad: VadConfiguration;
  processorUsed: "AudioWorklet" | "ScriptProcessor";
  audioWorkletAvailable: boolean;
  requestedConstraintsJson: string;
  supportedConstraintsJson: string;
  actualSettingsJson: string;
  capabilitiesJson: string;
}

export interface AudioQualityMetrics {
  durationMs: number;
  sampleRateHz: number;
  sampleCount: number;
  byteLength: number;
  peakAmplitude: number;
  peakDbfs: number | null;
  rmsAmplitude: number;
  rmsDbfs: number | null;
  meanAmplitude: number;
  standardDeviation: number;
  minimumAmplitude: number;
  maximumAmplitude: number;
  crestFactor: number | null;
  clippingPercent: number;
  silencePercent: number;
  zeroCrossingRate: number;
}

export type SttStatus = "pending" | "processing" | "completed" | "unsupported" | "failed";

export interface AudioRecord {
  schemaVersion: 3;
  id: string;
  previousAudioId: string | null;
  nextAudioId: string | null;
  sequence: number;
  speechStartedAt: string;
  speechEndedAt: string;
  languageCode: string;
  transcript: string;
  sttSupported: boolean;
  sttStatus: SttStatus;
  sttError: string | null;
  sttProcessingMs: number | null;
  sttConfidence: number | null;
  vadTiming: VadTimingMetrics;
  mainThreadLoad: MainThreadLoadMetrics;
  engineInitialization: EngineInitializationMetrics;
  captureConfiguration: CaptureConfigurationMetrics;
  vadMemory: VadMemoryMetrics;
  vadProbabilities: VadProbabilityMetrics;
  audioQuality: AudioQualityMetrics;
  environment: string;
  audioBlob: Blob;
}

export interface ActiveSpeech {
  id: string;
  languageCode: string;
  speechStartedAt: string;
  startedPerformanceMs: number;
  memoryStartBytes: number | null;
  memoryStartBreakdownJson: string;
  memoryPeakBytes: number | null;
  callbackProcessingMs: number;
  frameCount: number;
  probabilitySum: number;
  probabilityMaximum: number;
  probabilityMinimum: number;
  memorySampleCount: number;
  memoryMethod: MemoryMeasurementMethod;
  callbackDurationsMs: number[];
  frameIntervalsMs: number[];
  lastFrameAtMs: number | null;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaximumMs: number;
  eventLoopLagTotalMs: number;
  eventLoopLagMaximumMs: number;
  eventLoopSampleCount: number;
}

export interface RealtimeDiagnosticSample {
  timestampMs: number;
  speechProbability: number;
  memoryBytes: number | null;
  frameIntervalMs: number | null;
  callbackMs: number;
  eventLoopLagMs: number;
}

export type SortDirection = "asc" | "desc";

export interface LanguageOption {
  code: string;
  label: string;
  recognitionCode: string;
}

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { code: "ja", label: "日本語 (ja)", recognitionCode: "ja-JP" },
  { code: "en", label: "English (en)", recognitionCode: "en-US" },
  { code: "zh-CN", label: "简体中文 (zh-CN)", recognitionCode: "zh-CN" },
  { code: "zh-TW", label: "繁體中文 (zh-TW)", recognitionCode: "zh-TW" },
  { code: "ko", label: "한국어 (ko)", recognitionCode: "ko-KR" },
  { code: "de", label: "Deutsch (de)", recognitionCode: "de-DE" },
  { code: "fr", label: "Français (fr)", recognitionCode: "fr-FR" },
  { code: "es", label: "Español (es)", recognitionCode: "es-ES" },
] satisfies readonly LanguageOption[];

export const DEFAULT_LANGUAGE_CODE: string = "ja";
export const VAD_SAMPLE_RATE_HZ: number = 16_000;
export const VAD_FRAME_SAMPLES: number = 512;
export const VAD_FRAME_MS: number = (VAD_FRAME_SAMPLES / VAD_SAMPLE_RATE_HZ) * 1_000;
