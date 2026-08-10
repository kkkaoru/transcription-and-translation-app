import { describe, expect, it } from "vitest";
import {
  chunkCountForDurationMs,
  chunksForMillis,
  EnergyVadEngine,
  float32FromTimeDomainBytes,
  isSpeechRmsDb,
  probabilityFromRmsDb,
  resampleMono,
  resolveWorkersAiAsrVadConfig,
  rmsDbFromFloat32,
  rmsDbFromPcm16,
  rmsDbFromRms,
  rmsDbFromTimeDomainBytes,
  rmsFromFloat32,
  SILERO_CHUNK_SAMPLES,
  SILERO_SAMPLE_RATE,
  vadResultFromRmsDb,
  WORKERS_AI_ASR_VAD_DEFAULTS,
  WorkersAiAsrVad,
  type WorkersAiAsrVadEvent,
} from "./workers-ai-asr-vad";

const LOUD_DB = -20;
const SILENT_DB = -80;
const INTERVAL = WORKERS_AI_ASR_VAD_DEFAULTS.vadIntervalMs;

const eventTypes = (events: WorkersAiAsrVadEvent[]): string[] => events.map((event) => event.type);

const utteranceEndReason = (events: WorkersAiAsrVadEvent[]): string | undefined => {
  const end = events.find((event) => event.type === "utterance-end");
  return end?.type === "utterance-end" ? end.reason : undefined;
};

const pushSpeechMs = (vad: WorkersAiAsrVad, durationMs: number): WorkersAiAsrVadEvent[] =>
  vad.pushFrame({ rmsDb: LOUD_DB, durationMs });

const pushSilenceMs = (vad: WorkersAiAsrVad, durationMs: number): WorkersAiAsrVadEvent[] =>
  vad.pushFrame({ rmsDb: SILENT_DB, durationMs });

describe("Workers AI ASR RMS helpers", () => {
  it("maps empty or digital silence to -Infinity dBFS", () => {
    expect(rmsFromFloat32([])).toBe(0);
    expect(rmsDbFromFloat32([])).toBe(Number.NEGATIVE_INFINITY);
    expect(rmsDbFromPcm16(new Int16Array(0))).toBe(Number.NEGATIVE_INFINITY);
    expect(rmsDbFromTimeDomainBytes(new Uint8Array(0))).toBe(Number.NEGATIVE_INFINITY);
    expect(rmsDbFromFloat32(new Float32Array(32))).toBe(Number.NEGATIVE_INFINITY);
    expect(rmsDbFromPcm16(new Int16Array(32))).toBe(Number.NEGATIVE_INFINITY);
    expect(rmsDbFromTimeDomainBytes(new Uint8Array(64).fill(128))).toBe(Number.NEGATIVE_INFINITY);
    expect(rmsDbFromRms(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(rmsDbFromRms(Number.NaN)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("detects loud synthetic PCM and AnalyserNode frames as speech at -50 dBFS", () => {
    const floatLoud = Float32Array.from({ length: 64 }, (_, index) =>
      index % 2 === 0 ? 0.5 : -0.5,
    );
    const pcmLoud = Int16Array.from({ length: 64 }, (_, index) =>
      index % 2 === 0 ? 20_000 : -20_000,
    );
    const byteLoud = new Uint8Array(64).fill(255);
    expect(rmsDbFromFloat32(floatLoud)).toBeGreaterThan(WORKERS_AI_ASR_VAD_DEFAULTS.silenceGateDb);
    expect(rmsDbFromPcm16(pcmLoud)).toBeGreaterThan(WORKERS_AI_ASR_VAD_DEFAULTS.silenceGateDb);
    expect(rmsDbFromTimeDomainBytes(byteLoud)).toBeGreaterThan(
      WORKERS_AI_ASR_VAD_DEFAULTS.silenceGateDb,
    );
    expect(isSpeechRmsDb(rmsDbFromFloat32(floatLoud))).toBe(true);
    expect(isSpeechRmsDb(SILENT_DB)).toBe(false);
    expect(isSpeechRmsDb(WORKERS_AI_ASR_VAD_DEFAULTS.silenceGateDb)).toBe(true);
    expect(isSpeechRmsDb(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isSpeechRmsDb(Number.NaN)).toBe(false);
    expect(probabilityFromRmsDb(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(probabilityFromRmsDb(-50)).toBeCloseTo(0.5);
    expect(probabilityFromRmsDb(0)).toBe(1);
    expect(vadResultFromRmsDb(-50).isSpeech).toBe(true);
    expect(vadResultFromRmsDb(-50).probability).toBeCloseTo(0.5);
  });

  it("converts Analyser bytes and resamples to 16 kHz", () => {
    const bytes = new Uint8Array([128, 255, 0, 128]);
    const samples = float32FromTimeDomainBytes(bytes);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBeCloseTo(127 / 128);
    expect(samples[2]).toBe(-1);
    expect(resampleMono(new Float32Array(0), 48_000).length).toBe(0);
    expect(resampleMono(new Float32Array([1, 2, 3]), 0).length).toBe(0);
    const native = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleMono(native, SILERO_SAMPLE_RATE)).toBe(native);
    const down = resampleMono(
      Float32Array.from({ length: 48 }, (_, index) => index / 48),
      48_000,
    );
    expect(down.length).toBe(16);
  });
});

describe("resolveWorkersAiAsrVadConfig", () => {
  it("keeps Parapper defaults and clamps invalid durations", () => {
    expect(resolveWorkersAiAsrVadConfig()).toEqual(WORKERS_AI_ASR_VAD_DEFAULTS);
    expect(WORKERS_AI_ASR_VAD_DEFAULTS).toMatchObject({
      vadIntervalMs: 32,
      vadThreshold: 0.5,
      segmentStartSpeechMs: 96,
      checkSilenceMs: 320,
      maxPhraseMs: 25_000,
      silenceGateDb: -50,
      sileroChunkSamples: 512,
    });
    expect(chunksForMillis(96, 32)).toBe(3);
    expect(chunksForMillis(320, 32)).toBe(10);
    expect(chunksForMillis(25_000, 32)).toBe(782);
    expect(chunkCountForDurationMs(80, 32)).toBe(2);
    expect(chunkCountForDurationMs(96, 32)).toBe(3);
    expect(chunkCountForDurationMs(0, 32)).toBe(0);
    expect(
      resolveWorkersAiAsrVadConfig({
        vadIntervalMs: Number.NaN,
        vadThreshold: Number.NaN,
        segmentStartSpeechMs: -1,
        checkSilenceMs: 0,
        maxPhraseMs: Number.NaN,
        silenceGateDb: Number.NaN,
        sileroChunkSamples: 0,
      }),
    ).toEqual(WORKERS_AI_ASR_VAD_DEFAULTS);
    expect(
      resolveWorkersAiAsrVadConfig({
        silenceGateDb: -40,
        segmentStartSpeechMs: 128,
        checkSilenceMs: 640,
        maxPhraseMs: 64,
        vadThreshold: 1.4,
      }),
    ).toMatchObject({
      silenceGateDb: -40,
      segmentStartSpeechMs: 128,
      checkSilenceMs: 640,
      maxPhraseMs: 128,
      vadThreshold: 1,
    });
  });
});

describe("EnergyVadEngine", () => {
  it("aggregates 512-sample windows with max probability like Silero", () => {
    const engine = new EnergyVadEngine();
    expect(engine.process(new Float32Array(0))).toEqual({ probability: 0, isSpeech: false });
    const loud = Float32Array.from({ length: SILERO_CHUNK_SAMPLES }, () => 0.4);
    const quiet = new Float32Array(SILERO_CHUNK_SAMPLES);
    const mixed = new Float32Array(SILERO_CHUNK_SAMPLES * 2);
    mixed.set(quiet, 0);
    mixed.set(loud, SILERO_CHUNK_SAMPLES);
    const result = engine.process(mixed);
    expect(result.isSpeech).toBe(true);
    expect(result.probability).toBeGreaterThan(0.5);
    expect(engine.process(quiet).isSpeech).toBe(false);
  });
});

describe("WorkersAiAsrVad Parapper segment machine", () => {
  it("does not start an utterance for speech shorter than 96ms", () => {
    const vad = new WorkersAiAsrVad();
    expect(eventTypes(pushSpeechMs(vad, 64))).toEqual(["pending-start"]);
    expect(vad.currentPhase).toBe("pending");
    expect(eventTypes(pushSilenceMs(vad, INTERVAL))).toEqual(["pending-cancel"]);
    expect(vad.currentPhase).toBe("idle");
    expect(pushSilenceMs(vad, 2_000)).toEqual([]);
  });

  it("ends with silence after speech ≥ 96ms then 320ms quiet", () => {
    const vad = new WorkersAiAsrVad();
    expect(eventTypes(pushSpeechMs(vad, WORKERS_AI_ASR_VAD_DEFAULTS.segmentStartSpeechMs))).toEqual(
      ["pending-start", "utterance-start"],
    );
    expect(vad.currentPhase).toBe("speech");
    expect(utteranceEndReason(pushSilenceMs(vad, 319))).toBeUndefined();
    expect(vad.currentPhase).toBe("speech");
    expect(utteranceEndReason(pushSilenceMs(vad, INTERVAL))).toBe("silence");
    expect(vad.currentPhase).toBe("idle");
  });

  it("does not start or end on silence only", () => {
    const vad = new WorkersAiAsrVad();
    expect(pushSilenceMs(vad, 5_000)).toEqual([]);
    expect(vad.pushFrame({ rmsDb: Number.NEGATIVE_INFINITY, durationMs: 2_000 })).toEqual([]);
    expect(vad.pushFrame({ rmsDb: Number.NaN, durationMs: 2_000 })).toEqual([]);
    expect(vad.currentPhase).toBe("idle");
  });

  it("force-ends at max phrase 25s", () => {
    expect(WORKERS_AI_ASR_VAD_DEFAULTS.maxPhraseMs).toBe(25_000);
    const vad = new WorkersAiAsrVad({
      maxPhraseMs: 96,
      segmentStartSpeechMs: 96,
      vadIntervalMs: 32,
    });
    expect(eventTypes(pushSpeechMs(vad, 96))).toEqual(["pending-start", "utterance-start"]);
    expect(utteranceEndReason(pushSpeechMs(vad, 32))).toBe("max-duration");
    expect(vad.currentPhase).toBe("idle");
  });

  it("keeps pre-speech padding out of the utterance chunk count", () => {
    const vad = new WorkersAiAsrVad();
    expect(pushSilenceMs(vad, 320)).toEqual([]);
    expect(vad.snapshot.preSpeechChunks).toBe(10);
    const events = pushSpeechMs(vad, 96);
    const start = events.find((event) => event.type === "utterance-start");
    expect(start?.type).toBe("utterance-start");
    if (start?.type === "utterance-start") {
      expect(start.preSpeechChunks).toBe(10);
      expect(start.utteranceChunks).toBe(3);
      expect(start.audioSoFar.length).toBeGreaterThan(0);
    }
    expect(vad.snapshot.audioChunks).toBe(3);
    expect(vad.snapshot.preSpeechChunks).toBe(0);
  });

  it("can start a second utterance after silence end without a new instance", () => {
    const vad = new WorkersAiAsrVad();
    pushSpeechMs(vad, 96);
    expect(utteranceEndReason(pushSilenceMs(vad, 320))).toBe("silence");
    expect(eventTypes(pushSpeechMs(vad, 96))).toEqual(["pending-start", "utterance-start"]);
    expect(utteranceEndReason(pushSilenceMs(vad, 320))).toBe("silence");
  });

  it("keeps speech alive across brief pauses shorter than 320ms", () => {
    const vad = new WorkersAiAsrVad();
    pushSpeechMs(vad, 96);
    expect(pushSilenceMs(vad, 160)).toEqual([]);
    expect(vad.currentPhase).toBe("speech");
    expect(pushSpeechMs(vad, 32)).toEqual([]);
    expect(vad.snapshot.silenceChunks).toBe(0);
    expect(utteranceEndReason(pushSilenceMs(vad, 320))).toBe("silence");
  });

  it("resets mid-utterance and ignores invalid frame durations", () => {
    const vad = new WorkersAiAsrVad();
    pushSpeechMs(vad, 96);
    expect(vad.currentPhase).toBe("speech");
    vad.reset();
    expect(vad.currentPhase).toBe("idle");
    expect(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 0 })).toEqual([]);
    expect(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: -10 })).toEqual([]);
    expect(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: Number.NaN })).toEqual([]);
  });

  it("emits pending-start and utterance-start together when start threshold is one chunk", () => {
    const vad = new WorkersAiAsrVad({ segmentStartSpeechMs: 32, vadIntervalMs: 32 });
    expect(eventTypes(pushSpeechMs(vad, 32))).toEqual(["pending-start", "utterance-start"]);
  });

  it("accepts synthetic isSpeech frames without RMS", () => {
    const vad = new WorkersAiAsrVad();
    expect(vad.pushVadResult({ probability: 0.9, isSpeech: true })).toEqual([
      { type: "pending-start" },
    ]);
    expect(vad.pushVadResult({ probability: 0.9, isSpeech: true })).toEqual([]);
    const started = vad.pushVadResult({ probability: 0.9, isSpeech: true });
    expect(started.map((event) => event.type)).toEqual(["utterance-start"]);
  });

  it("omits turn-check trailing silence from uploaded fullAudio (keeps ≤1 chunk pad)", () => {
    const vad = new WorkersAiAsrVad();
    const speech = Float32Array.from({ length: SILERO_CHUNK_SAMPLES }, () => 0.4);
    const quiet = new Float32Array(SILERO_CHUNK_SAMPLES);
    const speechVad = { probability: 0.92, isSpeech: true };
    const silenceVad = { probability: 0.02, isSpeech: false };

    for (let index = 0; index < 3; index += 1) {
      vad.pushVadResult(speechVad, speech);
    }
    let end: WorkersAiAsrVadEvent | undefined;
    for (let index = 0; index < 10; index += 1) {
      const events = vad.pushVadResult(silenceVad, quiet);
      end = events.find((event) => event.type === "utterance-end");
      if (end) {
        break;
      }
    }
    expect(end?.type).toBe("utterance-end");
    if (end?.type !== "utterance-end") {
      return;
    }
    // 3 speech chunks + at most 1 trailing pad (not all 10 silence chunks).
    const maxSamples = SILERO_CHUNK_SAMPLES * 4;
    expect(end.fullAudio.length).toBeLessThanOrEqual(maxSamples);
    expect(end.fullAudio.length).toBeGreaterThanOrEqual(SILERO_CHUNK_SAMPLES * 3);
    expect(vad.snapshot.preSpeechChunks).toBe(10);
  });
});
