// Runs with Bun.
import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import {
  addAudioRecord,
  clearAudioRecords,
  type LegacyAudioRecord,
  listAudioRecords,
  type NewAudioRecord,
  normalizeRecord,
  updateAudioTranscript,
} from "./storage";

const input = (id: string, startedAt: string): NewAudioRecord => ({
  id,
  speechStartedAt: startedAt,
  speechEndedAt: startedAt,
  languageCode: "ja",
  transcript: "",
  sttSupported: true,
  sttStatus: "processing",
  sttError: null,
  sttProcessingMs: null,
  sttConfidence: null,
  vadTiming: {
    segmentationWallMs: 100,
    callbackProcessingMs: 2,
    callbackAverageMs: 0.5,
    callbackMaximumMs: 0.8,
    postProcessingMs: 3,
    frameCount: 4,
    audioFrameMs: 128,
    frameIntervalAverageMs: 32,
    frameIntervalP50Ms: 32,
    frameIntervalP95Ms: 34,
    frameIntervalMaximumMs: 35,
    frameIntervalJitterMs: 1,
    framesPerSecond: 31.25,
    realTimeFactor: 0.78,
    delayedFrameCount: 0,
  },
  mainThreadLoad: {
    longTaskSupported: true,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    longTaskMaximumMs: 0,
    eventLoopLagAverageMs: 1,
    eventLoopLagMaximumMs: 2,
    eventLoopSampleCount: 3,
  },
  engineInitialization: {
    initializationMs: 120,
    memoryBeforeBytes: 1000,
    memoryAfterBytes: 2000,
    measuredPageDeltaBytes: 1000,
    memoryMethod: "performance.memory.usedJSHeapSize",
    memoryBeforeBreakdownJson: "[]",
    memoryAfterBreakdownJson: "[]",
    exactSileroWasmMemoryAvailable: false,
  },
  captureConfiguration: {
    requestedMicrophone: {
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
    },
    vad: {
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      redemptionMs: 800,
      preSpeechPadMs: 300,
      minSpeechMs: 250,
      processorPreference: "auto",
    },
    processorUsed: "AudioWorklet",
    audioWorkletAvailable: true,
    requestedConstraintsJson: "{}",
    supportedConstraintsJson: "{}",
    actualSettingsJson: "{}",
    capabilitiesJson: "{}",
  },
  vadMemory: {
    supported: false,
    method: "unavailable",
    scope: "page",
    sampleCount: 0,
    startBreakdownJson: "[]",
    endBreakdownJson: "[]",
    startBytes: null,
    endBytes: null,
    peakBytes: null,
    deltaBytes: null,
    workerAttributedBytes: null,
    wasmAttributedBytes: null,
    workerWasmAttributedBytes: null,
  },
  vadProbabilities: {
    averageSpeechProbability: 0.7,
    maximumSpeechProbability: 0.9,
    minimumSpeechProbability: 0.5,
  },
  audioQuality: {
    durationMs: 250,
    sampleRateHz: 16000,
    sampleCount: 4000,
    byteLength: 8044,
    peakAmplitude: 0.8,
    peakDbfs: -1.938,
    rmsAmplitude: 0.2,
    rmsDbfs: -13.979,
    meanAmplitude: 0,
    standardDeviation: 0.2,
    minimumAmplitude: -0.8,
    maximumAmplitude: 0.8,
    crestFactor: 4,
    clippingPercent: 0,
    silencePercent: 5,
    zeroCrossingRate: 10,
  },
  environment: "test",
  audioBlob: new Blob(["audio"], { type: "audio/wav" }),
});

beforeEach(async () => {
  await clearAudioRecords();
});

it("links recordings in insertion order", async () => {
  await addAudioRecord(input("audio-1", "2026-08-28T01:00:00.000Z"));
  await addAudioRecord(input("audio-2", "2026-08-28T01:01:00.000Z"));
  const records = await listAudioRecords("asc");

  expect(records).toHaveLength(2);
  expect(records[0]?.id).toBe("audio-1");
  expect(records[0]?.previousAudioId).toBe(null);
  expect(records[0]?.nextAudioId).toBe("audio-2");
  expect(records[0]?.sequence).toBe(1);
  expect(records[0]?.schemaVersion).toBe(3);
  expect(records[1]?.id).toBe("audio-2");
  expect(records[1]?.previousAudioId).toBe("audio-1");
  expect(records[1]?.nextAudioId).toBe(null);
  expect(records[1]?.sequence).toBe(2);
});

it("returns descending records without changing their links", async () => {
  await addAudioRecord(input("audio-1", "2026-08-28T01:00:00.000Z"));
  await addAudioRecord(input("audio-2", "2026-08-28T01:01:00.000Z"));
  const records = await listAudioRecords("desc");

  expect(records.map((record) => record.id)).toStrictEqual(["audio-2", "audio-1"]);
  expect(records[0]?.previousAudioId).toBe("audio-1");
});

it("normalizes pre-schema records with metric defaults", async () => {
  const current = await addAudioRecord(input("legacy", "2026-08-28T01:00:00.000Z"));
  const legacy: LegacyAudioRecord = { ...current, schemaVersion: 2 };
  Reflect.set(legacy, "sttStatus", undefined);
  Reflect.set(legacy, "sttProcessingMs", undefined);
  Reflect.set(legacy, "sttConfidence", undefined);
  Reflect.set(legacy, "mainThreadLoad", undefined);
  Reflect.set(legacy, "engineInitialization", undefined);
  Reflect.set(legacy, "captureConfiguration", undefined);
  Reflect.deleteProperty(legacy.audioQuality, "peakDbfs");
  Reflect.deleteProperty(legacy.vadMemory, "startBreakdownJson");
  Reflect.deleteProperty(legacy.vadTiming, "callbackAverageMs");
  const normalized = normalizeRecord(legacy);

  expect(normalized.schemaVersion).toBe(3);
  expect(normalized.sttStatus).toBe("completed");
  expect(normalized.sttProcessingMs).toBe(null);
  expect(normalized.sttConfidence).toBe(null);
  expect(normalized.audioQuality.peakDbfs).toBe(null);
  expect(normalized.vadMemory.startBreakdownJson).toBe("[]");
  expect(normalized.vadTiming.callbackAverageMs).toBe(0);
  expect(normalized.mainThreadLoad.longTaskCount).toBe(0);
  expect(normalized.engineInitialization.memoryMethod).toBe("unavailable");
  expect(normalized.captureConfiguration.processorUsed).toBe("ScriptProcessor");
});

it("updates Web Speech API text after a segment is saved", async () => {
  await addAudioRecord(input("audio-1", "2026-08-28T01:00:00.000Z"));
  await updateAudioTranscript({
    id: "audio-1",
    transcript: "こんにちは",
    status: "completed",
    error: null,
    processingMs: 320,
    confidence: 0.92,
  });
  const records = await listAudioRecords();

  expect(records[0]?.transcript).toBe("こんにちは");
  expect(records[0]?.sttStatus).toBe("completed");
  expect(records[0]?.sttError).toBe(null);
  expect(records[0]?.sttProcessingMs).toBe(320);
  expect(records[0]?.sttConfidence).toBe(0.92);
});

it("ignores a late transcript for an unknown segment", async () => {
  await updateAudioTranscript({
    id: "missing",
    transcript: "late",
    status: "failed",
    error: "network",
    processingMs: 12,
    confidence: null,
  });

  expect(await listAudioRecords()).toStrictEqual([]);
});
