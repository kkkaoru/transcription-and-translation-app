// Runs in the browser; built and tested with Bun.
import type {
  CaptureConfigurationMetrics,
  MicrophoneConfiguration,
  VadConfiguration,
} from "./model";

interface CaptureSnapshotInput {
  microphone: MicrophoneConfiguration;
  vad: VadConfiguration;
  processorUsed: "AudioWorklet" | "ScriptProcessor";
  audioWorkletAvailable: boolean;
  constraints: MediaTrackConstraints;
  track: Pick<MediaStreamTrack, "getSettings" | "getCapabilities">;
}

export const DEFAULT_MICROPHONE_CONFIGURATION: MicrophoneConfiguration = {
  deviceId: "",
  deviceLabel: "Browser default",
  groupId: "",
  echoCancellation: "enabled",
  noiseSuppression: "enabled",
  autoGainControl: "enabled",
  voiceIsolation: "default",
  suppressLocalAudioPlayback: "default",
  restrictOwnAudio: "default",
  channelCount: 1,
  sampleRate: null,
  sampleSize: null,
  latency: null,
  volume: null,
};

export const DEFAULT_VAD_CONFIGURATION: VadConfiguration = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  redemptionMs: 800,
  preSpeechPadMs: 300,
  minSpeechMs: 250,
  processorPreference: "auto",
};

const configuredBoolean = (value: "default" | "enabled" | "disabled"): boolean | undefined =>
  value === "default" ? undefined : value === "enabled";

export const buildMicrophoneConstraints = (
  configuration: MicrophoneConfiguration,
): MediaTrackConstraints => ({
  deviceId: configuration.deviceId || undefined,
  groupId: configuration.groupId || undefined,
  echoCancellation: configuredBoolean(configuration.echoCancellation),
  noiseSuppression: configuredBoolean(configuration.noiseSuppression),
  autoGainControl: configuredBoolean(configuration.autoGainControl),
  voiceIsolation: configuredBoolean(configuration.voiceIsolation),
  suppressLocalAudioPlayback: configuredBoolean(configuration.suppressLocalAudioPlayback),
  restrictOwnAudio: configuredBoolean(configuration.restrictOwnAudio),
  channelCount: configuration.channelCount ?? undefined,
  sampleRate: configuration.sampleRate ?? undefined,
  sampleSize: configuration.sampleSize ?? undefined,
  latency: configuration.latency ?? undefined,
  volume: configuration.volume ?? undefined,
});

export const audioWorkletAvailable = (): boolean =>
  typeof AudioWorkletNode === "function" && "audioWorklet" in AudioContext.prototype;

export const resolveProcessorType = (
  preference: VadConfiguration["processorPreference"],
  workletAvailable: boolean,
): "AudioWorklet" | "ScriptProcessor" =>
  preference === "script-processor" || (!workletAvailable && preference === "auto")
    ? "ScriptProcessor"
    : "AudioWorklet";

const json = (value: object): string => JSON.stringify(value, null, 2);

export const captureConfigurationMetrics = ({
  microphone,
  vad,
  processorUsed,
  audioWorkletAvailable: workletAvailable,
  constraints,
  track,
}: CaptureSnapshotInput): CaptureConfigurationMetrics => ({
  requestedMicrophone: microphone,
  vad,
  processorUsed,
  audioWorkletAvailable: workletAvailable,
  requestedConstraintsJson: json(constraints),
  supportedConstraintsJson: json(navigator.mediaDevices.getSupportedConstraints()),
  actualSettingsJson: json(track.getSettings()),
  capabilitiesJson: json(track.getCapabilities()),
});
