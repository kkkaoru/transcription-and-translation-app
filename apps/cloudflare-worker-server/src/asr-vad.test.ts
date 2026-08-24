import { readFileSync } from "node:fs";
import { pcm16FromWav } from "@caption-bridge/inference-server-core";
import { describe, expect, it } from "vitest";
import {
  float32FromPcm16Bytes,
  isSpeechRmsDb,
  pcm16BytesFromFloat32,
  probabilityFromRmsDb,
  rmsDbFromFloat32,
  rmsFromFloat32,
  segmentPcm16Utterances,
  vadResultFromRmsDb,
  WORKER_ASR_VAD_DEFAULTS,
  WorkerAsrVad,
  WorkerEnergyVadEngine,
} from "./asr-vad.js";

const greetingWav = readFileSync(
  new URL("../../desktop/src/overlay/fixtures/greeting-kikoemasu.wav", import.meta.url),
);

const loudPcm = (samples: number): Uint8Array => {
  const values = Int16Array.from({ length: samples }, (_, index) =>
    index % 2 === 0 ? 20_000 : -20_000,
  );
  return new Uint8Array(values.buffer);
};

const silentPcm = (samples: number): Uint8Array => new Uint8Array(samples * 2);

describe("Worker Parapper-aligned energy VAD", () => {
  it("pins the same defaults as Parapper / compare", () => {
    expect(WORKER_ASR_VAD_DEFAULTS).toStrictEqual({
      vadIntervalMs: 32,
      vadThreshold: 0.5,
      segmentStartSpeechMs: 96,
      checkSilenceMs: 480,
      maxPhraseMs: 25_000,
      silenceGateDb: -50,
      chunkSamples: 512,
    });
  });

  it("maps digital silence and loud frames at the -50 dBFS gate", () => {
    expect(rmsFromFloat32([])).toBe(0);
    expect(rmsFromFloat32([1, -1])).toBe(1);
    expect(rmsDbFromFloat32([])).toBe(Number.NEGATIVE_INFINITY);
    expect(rmsDbFromFloat32(new Float32Array(32))).toBe(Number.NEGATIVE_INFINITY);
    expect(isSpeechRmsDb(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isSpeechRmsDb(-50)).toBe(true);
    expect(probabilityFromRmsDb(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(vadResultFromRmsDb(-20).isSpeech).toBe(true);
    expect(vadResultFromRmsDb(-80).isSpeech).toBe(false);
  });

  it("round-trips silent PCM16 through float32", () => {
    expect(pcm16BytesFromFloat32(float32FromPcm16Bytes(new Uint8Array(8)))).toStrictEqual(
      new Uint8Array(8),
    );
  });

  it("does not emit an utterance for silence-only PCM", () => {
    expect(segmentPcm16Utterances(silentPcm(2048))).toStrictEqual([]);
    expect(segmentPcm16Utterances(new Uint8Array([0]))).toStrictEqual([]);
  });

  it("starts after 96 ms of speech and flushes a single utterance at file end", () => {
    const utterances = segmentPcm16Utterances(loudPcm(2048));
    expect(utterances.length).toBe(1);
    expect(utterances[0]?.reason).toBe("flush");
    expect((utterances[0]?.pcm.length ?? 0) > 0).toBe(true);
  });

  it("keeps a 256 ms mid-phrase gap inside one utterance", () => {
    const speech = loudPcm(512 * 4);
    const gap = silentPcm(512 * 8);
    const pcm = new Uint8Array(speech.length + gap.length + speech.length);
    pcm.set(speech, 0);
    pcm.set(gap, speech.length);
    pcm.set(speech, speech.length + gap.length);
    const utterances = segmentPcm16Utterances(pcm);
    expect(utterances.length).toBe(1);
    expect(utterances[0]?.reason).toBe("flush");
  });

  it("splits when silence reaches the 480 ms turn check", () => {
    const speech = loudPcm(512 * 4);
    const gap = silentPcm(512 * 15);
    const pcm = new Uint8Array(speech.length + gap.length + speech.length);
    pcm.set(speech, 0);
    pcm.set(gap, speech.length);
    pcm.set(speech, speech.length + gap.length);
    const utterances = segmentPcm16Utterances(pcm);
    expect(utterances.length).toBe(2);
    expect(utterances[0]?.reason).toBe("silence");
    expect(utterances[1]?.reason).toBe("flush");
  });

  it("segments the greeting speech fixture as one Nova-3 utterance", () => {
    const pcm = pcm16FromWav(greetingWav);
    const utterances = segmentPcm16Utterances(pcm);
    expect(utterances.length).toBe(1);
    expect(utterances[0]?.reason).toBe("flush");
    expect((utterances[0]?.pcm.length ?? 0) > 8_000).toBe(true);
  });

  it("treats an empty energy frame as non-speech", () => {
    expect(new WorkerEnergyVadEngine().process(new Float32Array(0))).toStrictEqual({
      probability: 0,
      isSpeech: false,
    });
  });

  it("selects speech from a multi-frame energy buffer without temporary chunk arrays", () => {
    const mixed = new Float32Array(1_024);
    mixed.fill(0.5, 512);
    expect(new WorkerEnergyVadEngine().process(mixed).isSpeech).toBe(true);
  });

  it("ends an utterance at the 25 s max phrase bound", () => {
    const utterances = segmentPcm16Utterances(loudPcm(512 * 782));
    expect(utterances.length).toBe(1);
    expect(utterances[0]?.reason).toBe("max-duration");
  });

  it("cancels pending speech shorter than 96 ms", () => {
    const engine = new WorkerEnergyVadEngine();
    const vad = new WorkerAsrVad();
    const loud = float32FromPcm16Bytes(loudPcm(512));
    const quiet = float32FromPcm16Bytes(silentPcm(512));
    expect(vad.pushVadResult(engine.process(loud), loud)).toStrictEqual([]);
    expect(vad.pushVadResult(engine.process(loud), loud)).toStrictEqual([]);
    expect(vad.pushVadResult(engine.process(quiet), quiet)).toStrictEqual([]);
    expect(vad.flush()).toStrictEqual([]);
  });
});
