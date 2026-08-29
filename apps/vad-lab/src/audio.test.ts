// Runs with Bun.
import { expect, it } from "vitest";
import { encodeWav, measureAudioQuality } from "./audio";

it("encodes mono 16 kHz PCM as a valid WAV", async () => {
  const blob = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]));
  const view = new DataView(await blob.arrayBuffer());

  expect(blob.type).toBe("audio/wav");
  expect(blob.size).toBe(54);
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getInt16(44, true)).toBe(0);
  expect(view.getInt16(50, true)).toBe(32767);
  expect(view.getInt16(52, true)).toBe(-32768);
});

it("measures waveform quality and clipping", () => {
  const metrics = measureAudioQuality(new Float32Array([0, 1, -1, 0.5]), 52);

  expect(metrics).toStrictEqual({
    durationMs: 0.25,
    sampleRateHz: 16000,
    sampleCount: 4,
    byteLength: 52,
    peakAmplitude: 1,
    peakDbfs: 0,
    rmsAmplitude: 0.75,
    rmsDbfs: -2.4987747321659985,
    meanAmplitude: 0.125,
    standardDeviation: 0.739509972887452,
    minimumAmplitude: -1,
    maximumAmplitude: 1,
    crestFactor: 1.3333333333333333,
    clippingPercent: 50,
    silencePercent: 25,
    zeroCrossingRate: 100,
  });
});

it("returns finite zero metrics for empty audio", () => {
  const metrics = measureAudioQuality(new Float32Array(), 44);

  expect(metrics.durationMs).toBe(0);
  expect(metrics.rmsAmplitude).toBe(0);
  expect(metrics.rmsDbfs).toBe(null);
  expect(metrics.peakDbfs).toBe(null);
  expect(metrics.crestFactor).toBe(null);
  expect(metrics.minimumAmplitude).toBe(0);
  expect(metrics.maximumAmplitude).toBe(0);
  expect(metrics.clippingPercent).toBe(0);
  expect(metrics.silencePercent).toBe(0);
  expect(metrics.zeroCrossingRate).toBe(0);
});
