import { describe, expect, it } from "vitest";
import {
  isSpeechRmsDb,
  resolveWorkersAiAsrVadConfig,
  rmsDbFromFloat32,
  rmsDbFromPcm16,
  rmsDbFromRms,
  rmsDbFromTimeDomainBytes,
  rmsFromFloat32,
  WORKERS_AI_ASR_VAD_DEFAULTS,
  WorkersAiAsrVad,
  type WorkersAiAsrVadEvent,
} from "./workers-ai-asr-vad";

const LOUD_DB = -20;
const SILENT_DB = -80;

const eventTypes = (events: WorkersAiAsrVadEvent[]): string[] => events.map((event) => event.type);

const utteranceEndReason = (events: WorkersAiAsrVadEvent[]): string | undefined => {
  const end = events.find((event) => event.type === "utterance-end");
  return end?.type === "utterance-end" ? end.reason : undefined;
};

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

  it("detects loud synthetic PCM and AnalyserNode frames as speech", () => {
    const floatLoud = Float32Array.from({ length: 64 }, (_, index) =>
      index % 2 === 0 ? 0.5 : -0.5,
    );
    const pcmLoud = Int16Array.from({ length: 64 }, (_, index) =>
      index % 2 === 0 ? 20_000 : -20_000,
    );
    const byteLoud = new Uint8Array(64).fill(255);
    expect(rmsDbFromFloat32(floatLoud)).toBeGreaterThan(
      WORKERS_AI_ASR_VAD_DEFAULTS.speechThresholdDb,
    );
    expect(rmsDbFromPcm16(pcmLoud)).toBeGreaterThan(WORKERS_AI_ASR_VAD_DEFAULTS.speechThresholdDb);
    expect(rmsDbFromTimeDomainBytes(byteLoud)).toBeGreaterThan(
      WORKERS_AI_ASR_VAD_DEFAULTS.speechThresholdDb,
    );
    expect(isSpeechRmsDb(rmsDbFromFloat32(floatLoud))).toBe(true);
    expect(isSpeechRmsDb(SILENT_DB)).toBe(false);
    expect(isSpeechRmsDb(WORKERS_AI_ASR_VAD_DEFAULTS.speechThresholdDb)).toBe(true);
    expect(isSpeechRmsDb(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isSpeechRmsDb(Number.NaN)).toBe(false);
  });
});

describe("resolveWorkersAiAsrVadConfig", () => {
  it("keeps defaults and clamps invalid durations", () => {
    expect(resolveWorkersAiAsrVadConfig()).toEqual(WORKERS_AI_ASR_VAD_DEFAULTS);
    expect(
      resolveWorkersAiAsrVadConfig({
        speechThresholdDb: Number.NaN,
        minSpeechMs: -1,
        endSilenceMs: 0,
        maxUtteranceMs: Number.NaN,
      }),
    ).toEqual(WORKERS_AI_ASR_VAD_DEFAULTS);
    expect(
      resolveWorkersAiAsrVadConfig({
        speechThresholdDb: -30,
        minSpeechMs: 400,
        endSilenceMs: 900,
        maxUtteranceMs: 100,
      }),
    ).toEqual({
      speechThresholdDb: -30,
      minSpeechMs: 400,
      endSilenceMs: 900,
      maxUtteranceMs: 400,
    });
  });
});

describe("WorkersAiAsrVad", () => {
  it("emits utterance-end after loud frames then silence past the hangover", () => {
    const vad = new WorkersAiAsrVad();
    expect(eventTypes(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 300 }))).toEqual([
      "utterance-start",
    ]);
    expect(vad.currentPhase).toBe("speech");
    expect(
      utteranceEndReason(vad.pushFrame({ rmsDb: SILENT_DB, durationMs: 749 })),
    ).toBeUndefined();
    expect(vad.currentPhase).toBe("speech");
    expect(utteranceEndReason(vad.pushFrame({ rmsDb: SILENT_DB, durationMs: 1 }))).toBe("silence");
    expect(vad.currentPhase).toBe("idle");
    expect(vad.snapshot).toEqual({ phase: "idle", speechMs: 0, silenceMs: 0, utteranceMs: 0 });
  });

  it("does not end an utterance on silence only", () => {
    const vad = new WorkersAiAsrVad();
    expect(vad.pushFrame({ rmsDb: SILENT_DB, durationMs: 5_000 })).toEqual([]);
    expect(vad.pushFrame({ rmsDb: Number.NEGATIVE_INFINITY, durationMs: 2_000 })).toEqual([]);
    expect(vad.pushFrame({ rmsDb: Number.NaN, durationMs: 2_000 })).toEqual([]);
    expect(vad.currentPhase).toBe("idle");
  });

  it("ignores a short blip followed by silence", () => {
    const vad = new WorkersAiAsrVad();
    expect(eventTypes(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 80 }))).toEqual([
      "candidate-start",
    ]);
    expect(vad.currentPhase).toBe("candidate");
    expect(eventTypes(vad.pushFrame({ rmsDb: SILENT_DB, durationMs: 800 }))).toEqual([
      "candidate-cancel",
    ]);
    expect(vad.currentPhase).toBe("idle");
    expect(vad.pushFrame({ rmsDb: SILENT_DB, durationMs: 2_000 })).toEqual([]);
  });

  it("force-ends speech that exceeds the max utterance cap", () => {
    const vad = new WorkersAiAsrVad({ maxUtteranceMs: 1_000, minSpeechMs: 200 });
    expect(eventTypes(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 200 }))).toEqual([
      "utterance-start",
    ]);
    expect(utteranceEndReason(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 800 }))).toBe(
      "max-duration",
    );
    expect(vad.currentPhase).toBe("idle");
  });

  it("commits and force-ends a single oversized loud frame", () => {
    const vad = new WorkersAiAsrVad({ minSpeechMs: 250, maxUtteranceMs: 1_000 });
    const events = vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 5_000 });
    expect(eventTypes(events)).toEqual(["utterance-start", "utterance-end"]);
    expect(utteranceEndReason(events)).toBe("max-duration");
    expect(vad.currentPhase).toBe("idle");
  });

  it("accumulates consecutive candidate frames until minSpeechMs", () => {
    const vad = new WorkersAiAsrVad({ minSpeechMs: 250 });
    expect(eventTypes(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 100 }))).toEqual([
      "candidate-start",
    ]);
    expect(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 100 })).toEqual([]);
    expect(eventTypes(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 50 }))).toEqual([
      "utterance-start",
    ]);
    expect(vad.currentPhase).toBe("speech");
    expect(vad.snapshot.speechMs).toBe(250);
  });

  it("resets mid-utterance and ignores invalid frame durations", () => {
    const vad = new WorkersAiAsrVad();
    vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 300 });
    expect(vad.currentPhase).toBe("speech");
    vad.reset();
    expect(vad.currentPhase).toBe("idle");
    expect(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 0 })).toEqual([]);
    expect(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: -10 })).toEqual([]);
    expect(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: Number.NaN })).toEqual([]);
  });

  it("can start a second utterance after a silence end without constructing a new VAD", () => {
    const vad = new WorkersAiAsrVad({ minSpeechMs: 200, endSilenceMs: 400 });
    vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 200 });
    expect(utteranceEndReason(vad.pushFrame({ rmsDb: SILENT_DB, durationMs: 400 }))).toBe(
      "silence",
    );
    expect(eventTypes(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 200 }))).toEqual([
      "utterance-start",
    ]);
    expect(utteranceEndReason(vad.pushFrame({ rmsDb: SILENT_DB, durationMs: 400 }))).toBe(
      "silence",
    );
  });

  it("keeps speech alive across brief pauses shorter than the hangover", () => {
    const vad = new WorkersAiAsrVad({ minSpeechMs: 200, endSilenceMs: 600 });
    vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 200 });
    expect(vad.pushFrame({ rmsDb: SILENT_DB, durationMs: 200 })).toEqual([]);
    expect(vad.currentPhase).toBe("speech");
    expect(vad.pushFrame({ rmsDb: LOUD_DB, durationMs: 100 })).toEqual([]);
    expect(vad.snapshot.silenceMs).toBe(0);
    expect(utteranceEndReason(vad.pushFrame({ rmsDb: SILENT_DB, durationMs: 600 }))).toBe(
      "silence",
    );
  });
});
