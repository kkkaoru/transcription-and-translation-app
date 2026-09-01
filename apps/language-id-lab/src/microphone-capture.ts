// Runs with Bun during build and test.
import { MicVAD, type RealTimeVADOptions } from "@ricky0123/vad-web";

type SpeechProbabilities = Parameters<RealTimeVADOptions["onFrameProcessed"]>[0];

export interface MicrophoneCaptureEvents {
  onLevel: (level: number) => void;
  onSpeechProbability: (probability: number) => void;
  onSpeechStart: () => void;
  onSpeechEnd: (samples: Float32Array, capturedAtMs: number) => Promise<void>;
  onError: (message: string) => void;
}

export interface MicrophoneCaptureOptions {
  deviceId: string;
  events: MicrophoneCaptureEvents;
}

export interface AudioTrackToggle {
  enabled: boolean;
}

export interface AudioTrackSource {
  getAudioTracks: () => readonly AudioTrackToggle[];
}

const VAD_ASSET_PATH: string = "/vad/vad-web-0.0.30-ort-1.27.0/";
const LEVEL_BUFFER_SIZE: number = 1_024;
const LEVEL_REFERENCE_RMS: number = 0.18;
const MINIMUM_SPEECH_MS: number = 600;
const PRE_SPEECH_PAD_MS: number = 300;
const REDEMPTION_MS: number = 500;
const POSITIVE_SPEECH_THRESHOLD: number = 0.6;
const NEGATIVE_SPEECH_THRESHOLD: number = 0.35;

export const normalizedAudioLevel = (samples: Float32Array): number => {
  const squareSum: number = samples.reduce((sum, sample) => sum + sample * sample, 0);
  const rms: number = Math.sqrt(squareSum / Math.max(1, samples.length));
  return Math.min(1, rms / LEVEL_REFERENCE_RMS);
};

export const setStreamEnabled = (stream: AudioTrackSource, enabled: boolean): void => {
  stream.getAudioTracks().map((track) => {
    track.enabled = enabled;
    return track;
  });
};

export class MicrophoneCapture {
  private readonly options: MicrophoneCaptureOptions;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vad: MicVAD | null = null;
  private animationFrameId: number | null = null;

  public constructor(options: MicrophoneCaptureOptions) {
    this.options = options;
  }

  public async start(): Promise<void> {
    if (!navigator.mediaDevices) throw new Error("Microphone capture is unavailable");
    const stream: MediaStream = await navigator.mediaDevices.getUserMedia({
      audio:
        this.options.deviceId === ""
          ? { channelCount: 1, echoCancellation: false, noiseSuppression: false }
          : {
              deviceId: { exact: this.options.deviceId },
              channelCount: 1,
              echoCancellation: false,
              noiseSuppression: false,
            },
      video: false,
    });
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = LEVEL_BUFFER_SIZE * 2;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    this.stream = stream;
    this.audioContext = audioContext;
    this.analyser = analyser;
    try {
      const vad = await MicVAD.new({
        audioContext,
        baseAssetPath: VAD_ASSET_PATH,
        onnxWASMBasePath: VAD_ASSET_PATH,
        model: "legacy",
        processorType: "AudioWorklet",
        startOnLoad: false,
        positiveSpeechThreshold: POSITIVE_SPEECH_THRESHOLD,
        negativeSpeechThreshold: NEGATIVE_SPEECH_THRESHOLD,
        redemptionMs: REDEMPTION_MS,
        preSpeechPadMs: PRE_SPEECH_PAD_MS,
        minSpeechMs: MINIMUM_SPEECH_MS,
        submitUserSpeechOnPause: false,
        getStream: () => Promise.resolve(stream),
        pauseStream: (activeStream) => {
          setStreamEnabled(activeStream, false);
          return Promise.resolve();
        },
        resumeStream: (activeStream) => {
          setStreamEnabled(activeStream, true);
          return Promise.resolve(activeStream);
        },
        onSpeechStart: this.options.events.onSpeechStart,
        onSpeechEnd: this.handleSpeechEnd,
        onVADMisfire: () => this.options.events.onSpeechProbability(0),
        onFrameProcessed: this.handleFrameProcessed,
      } satisfies Partial<RealTimeVADOptions>);
      this.vad = vad;
      await audioContext.resume();
      this.sampleLevel();
      await vad.start();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  public async setMuted(muted: boolean): Promise<void> {
    const vad: MicVAD | null = this.vad;
    if (vad === null) return;
    if (muted) {
      await vad.pause();
      this.options.events.onLevel(0);
      this.options.events.onSpeechProbability(0);
      return;
    }
    await vad.start();
  }

  public async stop(): Promise<void> {
    if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
    this.animationFrameId = null;
    await this.vad?.destroy();
    this.vad = null;
    this.stream?.getTracks().map((track) => track.stop());
    this.stream = null;
    await this.audioContext?.close();
    this.audioContext = null;
    this.analyser = null;
    this.options.events.onLevel(0);
    this.options.events.onSpeechProbability(0);
  }

  private readonly handleFrameProcessed = (probabilities: SpeechProbabilities): void => {
    this.options.events.onSpeechProbability(probabilities.isSpeech);
  };

  private readonly handleSpeechEnd = async (samples: Float32Array): Promise<void> => {
    try {
      await this.options.events.onSpeechEnd(samples, Date.now());
    } catch (error) {
      this.options.events.onError(
        error instanceof Error ? error.message : "Language inference failed",
      );
    }
  };

  private readonly sampleLevel = (): void => {
    const analyser: AnalyserNode | null = this.analyser;
    if (analyser === null) return;
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    this.options.events.onLevel(normalizedAudioLevel(samples));
    this.animationFrameId = requestAnimationFrame(this.sampleLevel);
  };
}
