// Runs in the browser; built and tested with Bun.
import { MicVAD, type RealTimeVADOptions } from "@ricky0123/vad-web";
import { encodeWav, measureAudioQuality } from "./audio";
import {
  audioWorkletAvailable,
  buildMicrophoneConstraints,
  captureConfigurationMetrics,
  resolveProcessorType,
} from "./capture-settings";
import { BrowserLoadMonitor, buildMainThreadLoadMetrics, buildTimingMetrics } from "./diagnostics";
import {
  buildEnvironmentText,
  buildMemoryMetrics,
  type MeasuredMemory,
  measurePageMemory,
  readPageMemorySnapshot,
} from "./environment";
import type {
  ActiveSpeech,
  AudioRecord,
  CaptureConfigurationMetrics,
  EngineInitializationMetrics,
  MicrophoneConfiguration,
  RealtimeDiagnosticSample,
  VadConfiguration,
} from "./model";
import { VAD_FRAME_MS } from "./model";
import type { AudioSpeechRecognizer } from "./speech";
import { addAudioRecord, type NewAudioRecord, updateAudioTranscript } from "./storage";

interface VadRecorderOptions {
  getLanguageCode: () => string;
  recognitionLanguageFor: (languageCode: string) => string;
  microphoneConfiguration: MicrophoneConfiguration;
  vadConfiguration: VadConfiguration;
  speechRecognizer: AudioSpeechRecognizer;
  onActiveAudioChange: (audioId: string | null) => void;
  onSaved: (record: AudioRecord) => void;
  onTranscribed: (record: AudioRecord) => void;
  onError: (message: string) => void;
  onProbability: (probability: number) => void;
  onDiagnosticSample: (sample: RealtimeDiagnosticSample) => void;
}

interface ProbabilityInput {
  isSpeech: number;
}

const VAD_VERSION: string = "Silero legacy via @ricky0123/vad-web 0.0.30";
const VAD_BASE_PATH: string = "/vad/vad-web-0.0.30-ort-1.27.0/";
const MEMORY_SAMPLE_INTERVAL_MS: number = 250;
const CHART_SAMPLE_INTERVAL_MS: number = 100;
const UNAVAILABLE_MEMORY: MeasuredMemory = {
  bytes: null,
  method: "unavailable",
  breakdownJson: "[]",
  workerAttributedBytes: null,
  wasmAttributedBytes: null,
  workerWasmAttributedBytes: null,
};
const EMPTY_CAPTURE_METRICS: CaptureConfigurationMetrics = {
  requestedMicrophone: {
    deviceId: "",
    deviceLabel: "Browser default",
    groupId: "",
    echoCancellation: "default",
    noiseSuppression: "default",
    autoGainControl: "default",
    voiceIsolation: "default",
    suppressLocalAudioPlayback: "default",
    restrictOwnAudio: "default",
    channelCount: null,
    sampleRate: null,
    sampleSize: null,
    latency: null,
    volume: null,
  },
  vad: {
    positiveSpeechThreshold: 0,
    negativeSpeechThreshold: 0,
    redemptionMs: 0,
    preSpeechPadMs: 0,
    minSpeechMs: 0,
    processorPreference: "auto",
  },
  processorUsed: "ScriptProcessor",
  audioWorkletAvailable: false,
  requestedConstraintsJson: "{}",
  supportedConstraintsJson: "{}",
  actualSettingsJson: "{}",
  capabilitiesJson: "{}",
};
const EMPTY_ENGINE_METRICS: EngineInitializationMetrics = {
  initializationMs: 0,
  memoryBeforeBytes: null,
  memoryAfterBytes: null,
  measuredPageDeltaBytes: null,
  memoryMethod: "unavailable",
  memoryBeforeBreakdownJson: "[]",
  memoryAfterBreakdownJson: "[]",
  exactSileroWasmMemoryAvailable: false,
};

const probabilityAverage = (active: ActiveSpeech): number =>
  active.frameCount === 0 ? 0 : active.probabilitySum / active.frameCount;

const createActiveSpeech = (languageCode: string, memory: MeasuredMemory): ActiveSpeech => ({
  id: crypto.randomUUID(),
  languageCode,
  speechStartedAt: new Date().toISOString(),
  startedPerformanceMs: performance.now(),
  memoryStartBytes: memory.bytes,
  memoryStartBreakdownJson: memory.breakdownJson,
  memoryPeakBytes: memory.bytes,
  callbackProcessingMs: 0,
  frameCount: 0,
  probabilitySum: 0,
  probabilityMaximum: 0,
  probabilityMinimum: 1,
  memorySampleCount: memory.bytes === null ? 0 : 1,
  memoryMethod: memory.method,
  callbackDurationsMs: [],
  frameIntervalsMs: [],
  lastFrameAtMs: null,
  longTaskCount: 0,
  longTaskTotalMs: 0,
  longTaskMaximumMs: 0,
  eventLoopLagTotalMs: 0,
  eventLoopLagMaximumMs: 0,
  eventLoopSampleCount: 0,
});

const updateActiveFrame = (
  active: ActiveSpeech,
  probability: number,
  callbackMs: number,
  frameAtMs: number,
): void => {
  active.callbackProcessingMs += callbackMs;
  active.callbackDurationsMs.push(callbackMs);
  active.frameCount += 1;
  active.probabilitySum += probability;
  active.probabilityMaximum = Math.max(active.probabilityMaximum, probability);
  active.probabilityMinimum = Math.min(active.probabilityMinimum, probability);
  if (active.lastFrameAtMs !== null) {
    active.frameIntervalsMs.push(frameAtMs - active.lastFrameAtMs);
  }
  active.lastFrameAtMs = frameAtMs;
};

const updateActiveMemory = (active: ActiveSpeech, measurement: MeasuredMemory): void => {
  if (measurement.bytes === null) {
    return;
  }
  active.memoryPeakBytes = Math.max(active.memoryPeakBytes ?? measurement.bytes, measurement.bytes);
  active.memorySampleCount += 1;
  active.memoryMethod = measurement.method;
};

export class VadRecorder {
  private readonly options: VadRecorderOptions;
  private readonly microphoneConstraints: MediaTrackConstraints;
  private readonly workletAvailable: boolean;
  private readonly processorUsed: "AudioWorklet" | "ScriptProcessor";
  private readonly loadMonitor: BrowserLoadMonitor;
  private micVad: MicVAD | null = null;
  private audioContext: AudioContext | null = null;
  private pendingMicrophoneStream: MediaStream | null = null;
  private active: ActiveSpeech | null = null;
  private latestMemory: MeasuredMemory = UNAVAILABLE_MEMORY;
  private memorySampleInFlight = false;
  private lastMemorySampleMs = 0;
  private lastChartSampleMs = 0;
  private lastFrameAtMs: number | null = null;
  private latestEventLoopLagMs = 0;
  private captureMetrics: CaptureConfigurationMetrics = EMPTY_CAPTURE_METRICS;
  private engineMetrics: EngineInitializationMetrics = EMPTY_ENGINE_METRICS;

  public constructor(options: VadRecorderOptions) {
    this.options = options;
    this.microphoneConstraints = buildMicrophoneConstraints(options.microphoneConfiguration);
    this.workletAvailable = audioWorkletAvailable();
    this.processorUsed = resolveProcessorType(
      options.vadConfiguration.processorPreference,
      this.workletAvailable,
    );
    this.loadMonitor = new BrowserLoadMonitor({
      onLongTask: this.handleLongTask,
      onEventLoopLag: this.handleEventLoopLag,
    });
  }

  public async start(): Promise<void> {
    const audioContext: AudioContext = this.getOrCreateAudioContext();
    this.stopPendingMicrophoneStream();
    this.pendingMicrophoneStream = await this.acquireMicrophoneStream();
    try {
      const vad: MicVAD = await this.getOrCreateVad();
      await audioContext.resume();
      this.latestMemory = readPageMemorySnapshot();
      this.loadMonitor.start();
      await vad.start();
    } catch (error: unknown) {
      this.loadMonitor.stop();
      this.stopPendingMicrophoneStream();
      throw error;
    }
  }

  public async pause(): Promise<void> {
    this.loadMonitor.stop();
    await this.micVad?.pause();
  }

  public async destroy(): Promise<void> {
    this.loadMonitor.stop();
    this.stopPendingMicrophoneStream();
    await this.micVad?.destroy();
    this.micVad = null;
    this.active = null;
    this.options.onActiveAudioChange(null);
    await this.audioContext?.close();
    this.audioContext = null;
  }

  private async getOrCreateVad(): Promise<MicVAD> {
    if (this.micVad !== null) {
      return this.micVad;
    }
    const memoryBefore: MeasuredMemory = readPageMemorySnapshot();
    const initializationStartedMs: number = performance.now();
    const audioContext: AudioContext = this.getOrCreateAudioContext();
    const vad: MicVAD = await MicVAD.new({
      audioContext,
      baseAssetPath: VAD_BASE_PATH,
      onnxWASMBasePath: VAD_BASE_PATH,
      model: "legacy",
      processorType: this.processorUsed,
      startOnLoad: false,
      positiveSpeechThreshold: this.options.vadConfiguration.positiveSpeechThreshold,
      negativeSpeechThreshold: this.options.vadConfiguration.negativeSpeechThreshold,
      redemptionMs: this.options.vadConfiguration.redemptionMs,
      preSpeechPadMs: this.options.vadConfiguration.preSpeechPadMs,
      minSpeechMs: this.options.vadConfiguration.minSpeechMs,
      submitUserSpeechOnPause: true,
      getStream: this.getMicrophoneStream,
      resumeStream: this.getMicrophoneStream,
      onSpeechStart: this.handleSpeechStart,
      onSpeechRealStart: this.handleSpeechRealStart,
      onSpeechEnd: this.handleSpeechEnd,
      onVADMisfire: this.handleMisfire,
      onFrameProcessed: this.handleFrameProcessed,
    } satisfies Partial<RealTimeVADOptions>);
    const memoryAfter: MeasuredMemory = readPageMemorySnapshot();
    this.engineMetrics = {
      initializationMs: performance.now() - initializationStartedMs,
      memoryBeforeBytes: memoryBefore.bytes,
      memoryAfterBytes: memoryAfter.bytes,
      measuredPageDeltaBytes:
        memoryBefore.bytes === null || memoryAfter.bytes === null
          ? null
          : memoryAfter.bytes - memoryBefore.bytes,
      memoryMethod: memoryAfter.method,
      memoryBeforeBreakdownJson: memoryBefore.breakdownJson,
      memoryAfterBreakdownJson: memoryAfter.breakdownJson,
      exactSileroWasmMemoryAvailable: false,
    };
    this.micVad = vad;
    return vad;
  }

  private getOrCreateAudioContext(): AudioContext {
    if (this.audioContext === null) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  private readonly acquireMicrophoneStream = async (): Promise<MediaStream> => {
    const stream: MediaStream = await navigator.mediaDevices.getUserMedia({
      audio: this.microphoneConstraints,
      video: false,
    });
    const track: MediaStreamTrack | undefined = stream.getAudioTracks()[0];
    if (track === undefined) {
      stream.getTracks().map((streamTrack) => streamTrack.stop());
      throw new Error("Microphone stream did not provide an audio track");
    }
    this.captureMetrics = captureConfigurationMetrics({
      microphone: this.options.microphoneConfiguration,
      vad: this.options.vadConfiguration,
      processorUsed: this.processorUsed,
      audioWorkletAvailable: this.workletAvailable,
      constraints: this.microphoneConstraints,
      track,
    });
    return stream;
  };

  private readonly getMicrophoneStream = (): Promise<MediaStream> => {
    const stream: MediaStream | null = this.pendingMicrophoneStream;
    this.pendingMicrophoneStream = null;
    return stream === null ? this.acquireMicrophoneStream() : Promise.resolve(stream);
  };

  private stopPendingMicrophoneStream(): void {
    this.pendingMicrophoneStream?.getTracks().map((track) => track.stop());
    this.pendingMicrophoneStream = null;
  }

  private readonly handleSpeechStart = (): void => {
    const active: ActiveSpeech = createActiveSpeech(
      this.options.getLanguageCode(),
      this.latestMemory,
    );
    this.active = active;
    this.options.onActiveAudioChange(active.id);
  };

  private readonly handleSpeechRealStart = (): void => {
    this.options.onActiveAudioChange(this.active?.id ?? null);
  };

  private readonly handleMisfire = (): void => {
    this.active = null;
    this.options.onActiveAudioChange(null);
  };

  private readonly handleLongTask = (durationMs: number): void => {
    const active: ActiveSpeech | null = this.active;
    if (active !== null) {
      active.longTaskCount += 1;
      active.longTaskTotalMs += durationMs;
      active.longTaskMaximumMs = Math.max(active.longTaskMaximumMs, durationMs);
    }
  };

  private readonly handleEventLoopLag = (lagMs: number): void => {
    this.latestEventLoopLagMs = lagMs;
    const active: ActiveSpeech | null = this.active;
    if (active !== null) {
      active.eventLoopLagTotalMs += lagMs;
      active.eventLoopLagMaximumMs = Math.max(active.eventLoopLagMaximumMs, lagMs);
      active.eventLoopSampleCount += 1;
    }
  };

  private readonly handleFrameProcessed = (probabilities: ProbabilityInput): void => {
    const callbackStartedMs: number = performance.now();
    this.options.onProbability(probabilities.isSpeech);
    const active: ActiveSpeech | null = this.active;
    const frameIntervalMs: number | null =
      this.lastFrameAtMs === null ? null : callbackStartedMs - this.lastFrameAtMs;
    this.lastFrameAtMs = callbackStartedMs;
    this.sampleMemory(active);
    const callbackMs: number = performance.now() - callbackStartedMs;
    if (active !== null) {
      updateActiveFrame(active, probabilities.isSpeech, callbackMs, callbackStartedMs);
    }
    this.publishChartSample(probabilities.isSpeech, frameIntervalMs, callbackMs);
  };

  private publishChartSample(
    probability: number,
    frameIntervalMs: number | null,
    callbackMs: number,
  ): void {
    const nowMs: number = performance.now();
    if (nowMs - this.lastChartSampleMs < CHART_SAMPLE_INTERVAL_MS) {
      return;
    }
    this.lastChartSampleMs = nowMs;
    this.options.onDiagnosticSample({
      timestampMs: nowMs,
      speechProbability: probability,
      memoryBytes: this.latestMemory.bytes,
      frameIntervalMs,
      callbackMs,
      eventLoopLagMs: this.latestEventLoopLagMs,
    });
  }

  private sampleMemory(active: ActiveSpeech | null): void {
    const nowMs: number = performance.now();
    if (this.memorySampleInFlight || nowMs - this.lastMemorySampleMs < MEMORY_SAMPLE_INTERVAL_MS) {
      return;
    }
    this.memorySampleInFlight = true;
    this.lastMemorySampleMs = nowMs;
    void measurePageMemory()
      .then((measurement) => {
        this.latestMemory = measurement;
        if (active !== null && this.active?.id === active.id) {
          updateActiveMemory(active, measurement);
        }
      })
      .finally(() => {
        this.memorySampleInFlight = false;
      });
  }

  private readonly handleSpeechEnd = async (samples: Float32Array): Promise<void> => {
    const active: ActiveSpeech | null = this.active;
    this.active = null;
    this.options.onActiveAudioChange(null);
    if (active === null) {
      return;
    }
    const speechEndedPerformanceMs: number = performance.now();
    const postProcessingStartedMs: number = performance.now();
    const speechEndedAt: string = new Date().toISOString();
    const endMemory: MeasuredMemory =
      this.latestMemory.bytes === null ? readPageMemorySnapshot() : this.latestMemory;
    updateActiveMemory(active, endMemory);
    const audioBlob: Blob = encodeWav(samples);
    const audioQuality = measureAudioQuality(samples, audioBlob.size);
    const sttSupported: boolean = this.options.speechRecognizer.supported;
    const environment: string = buildEnvironmentText({
      audioContextSampleRate: this.audioContext?.sampleRate ?? null,
      vadVersion: VAD_VERSION,
      sttSupported,
    });
    const segmentationWallMs: number = speechEndedPerformanceMs - active.startedPerformanceMs;
    const audioFrameMs: number = active.frameCount * VAD_FRAME_MS;
    const postProcessingMs: number = performance.now() - postProcessingStartedMs;
    const input: NewAudioRecord = {
      id: active.id,
      speechStartedAt: active.speechStartedAt,
      speechEndedAt,
      languageCode: active.languageCode,
      transcript: "",
      sttSupported,
      sttStatus: sttSupported ? "processing" : "unsupported",
      sttError: sttSupported ? null : "Web Speech API is unavailable",
      sttProcessingMs: null,
      sttConfidence: null,
      vadTiming: buildTimingMetrics({
        active,
        segmentationWallMs,
        postProcessingMs,
        audioFrameMs,
      }),
      mainThreadLoad: buildMainThreadLoadMetrics(active),
      engineInitialization: this.engineMetrics,
      captureConfiguration: this.captureMetrics,
      vadMemory: buildMemoryMetrics({
        startBytes: active.memoryStartBytes,
        endBytes: endMemory.bytes,
        peakBytes: active.memoryPeakBytes,
        method: active.memoryMethod,
        sampleCount: active.memorySampleCount,
        startBreakdownJson: active.memoryStartBreakdownJson,
        endBreakdownJson: endMemory.breakdownJson,
        workerAttributedBytes: endMemory.workerAttributedBytes,
        wasmAttributedBytes: endMemory.wasmAttributedBytes,
        workerWasmAttributedBytes: endMemory.workerWasmAttributedBytes,
      }),
      vadProbabilities: {
        averageSpeechProbability: probabilityAverage(active),
        maximumSpeechProbability: active.probabilityMaximum,
        minimumSpeechProbability: active.frameCount === 0 ? 0 : active.probabilityMinimum,
      },
      audioQuality,
      environment,
      audioBlob,
    };
    try {
      const saved: AudioRecord = await addAudioRecord(input);
      this.options.onSaved(saved);
      if (!sttSupported) {
        return;
      }
      const transcription = await this.options.speechRecognizer.transcribe({
        audioBlob,
        language: this.options.recognitionLanguageFor(active.languageCode),
      });
      const updated: AudioRecord | null = await updateAudioTranscript({
        id: saved.id,
        transcript: transcription.transcript,
        status: transcription.status,
        error: transcription.error,
        processingMs: transcription.processingMs,
        confidence: transcription.confidence,
      });
      if (updated !== null) {
        this.options.onTranscribed(updated);
      }
    } catch (error: unknown) {
      this.options.onError(error instanceof Error ? error.message : "Failed to save audio");
    }
  };
}
