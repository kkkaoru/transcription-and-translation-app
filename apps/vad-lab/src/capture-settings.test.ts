// Runs with Bun.
import { afterEach, expect, it, vi } from "vitest";
import {
  audioWorkletAvailable,
  buildMicrophoneConstraints,
  captureConfigurationMetrics,
  DEFAULT_MICROPHONE_CONFIGURATION,
  DEFAULT_VAD_CONFIGURATION,
  resolveProcessorType,
} from "./capture-settings";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("builds every configurable microphone constraint", () => {
  expect(
    buildMicrophoneConstraints({
      deviceId: "mic-1",
      deviceLabel: "Test microphone",
      groupId: "group-1",
      echoCancellation: "disabled",
      noiseSuppression: "enabled",
      autoGainControl: "default",
      voiceIsolation: "enabled",
      suppressLocalAudioPlayback: "disabled",
      restrictOwnAudio: "enabled",
      channelCount: 2,
      sampleRate: 48000,
      sampleSize: 24,
      latency: 0.02,
      volume: 0.8,
    }),
  ).toStrictEqual({
    deviceId: "mic-1",
    groupId: "group-1",
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: undefined,
    voiceIsolation: true,
    suppressLocalAudioPlayback: false,
    restrictOwnAudio: true,
    channelCount: 2,
    sampleRate: 48000,
    sampleSize: 24,
    latency: 0.02,
    volume: 0.8,
  });
});

it("leaves optional microphone values to browser defaults", () => {
  expect(buildMicrophoneConstraints(DEFAULT_MICROPHONE_CONFIGURATION)).toStrictEqual({
    deviceId: undefined,
    groupId: undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    voiceIsolation: undefined,
    suppressLocalAudioPlayback: undefined,
    restrictOwnAudio: undefined,
    channelCount: 1,
    sampleRate: undefined,
    sampleSize: undefined,
    latency: undefined,
    volume: undefined,
  });
});

it("prefers AudioWorklet and permits a ScriptProcessor comparison", () => {
  expect(resolveProcessorType("auto", true)).toBe("AudioWorklet");
  expect(resolveProcessorType("auto", false)).toBe("ScriptProcessor");
  expect(resolveProcessorType("audio-worklet", false)).toBe("AudioWorklet");
  expect(resolveProcessorType("script-processor", true)).toBe("ScriptProcessor");
});

it("detects AudioWorklet runtime availability", () => {
  class MockAudioContext {}
  Object.defineProperty(MockAudioContext.prototype, "audioWorklet", { value: {} });
  vi.stubGlobal("AudioWorkletNode", class AudioWorkletNode {});
  vi.stubGlobal("AudioContext", MockAudioContext);

  expect(audioWorkletAvailable()).toBe(true);
});

it("records requested, supported, actual, and capable microphone values", () => {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getSupportedConstraints: () => ({ echoCancellation: true, sampleRate: true }),
    },
  });
  const metrics = captureConfigurationMetrics({
    microphone: DEFAULT_MICROPHONE_CONFIGURATION,
    vad: DEFAULT_VAD_CONFIGURATION,
    processorUsed: "AudioWorklet",
    audioWorkletAvailable: true,
    constraints: { echoCancellation: true },
    track: {
      getSettings: () => ({ echoCancellation: true, sampleRate: 48000 }),
      getCapabilities: () => ({
        echoCancellation: [true, false],
        sampleRate: { min: 8000, max: 48000 },
      }),
    },
  });

  expect(metrics.processorUsed).toBe("AudioWorklet");
  expect(metrics.audioWorkletAvailable).toBe(true);
  expect(metrics.requestedConstraintsJson).toMatch(/echoCancellation/u);
  expect(metrics.supportedConstraintsJson).toMatch(/sampleRate/u);
  expect(metrics.actualSettingsJson).toMatch(/48000/u);
  expect(metrics.capabilitiesJson).toMatch(/8000/u);
});
