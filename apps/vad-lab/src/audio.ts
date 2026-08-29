// Runs in the browser; built and tested with Bun.
import type { AudioQualityMetrics } from "./model";
import { VAD_SAMPLE_RATE_HZ } from "./model";

interface AudioAccumulator {
  sum: number;
  sumSquares: number;
  peak: number;
  minimum: number;
  maximum: number;
  clipped: number;
  silent: number;
  zeroCrossings: number;
  previous: number;
}

const WAV_HEADER_BYTES: number = 44;
const PCM_BYTES_PER_SAMPLE: number = 2;
const PCM_MAX: number = 32_767;
const PCM_MIN: number = -32_768;
const CLIPPING_THRESHOLD: number = 0.99;
const SILENCE_THRESHOLD: number = 0.01;
const INITIAL_ACCUMULATOR: AudioAccumulator = {
  sum: 0,
  sumSquares: 0,
  peak: 0,
  minimum: 1,
  maximum: -1,
  clipped: 0,
  silent: 0,
  zeroCrossings: 0,
  previous: 0,
};

const writeAscii = (view: DataView, offset: number, value: string): void => {
  Array.from(value).map((character, index) =>
    view.setUint8(offset + index, character.charCodeAt(0)),
  );
};

const clampSample = (sample: number): number => Math.max(-1, Math.min(1, sample));

const writePcmSample = (view: DataView, sample: number, index: number): void => {
  const clamped: number = clampSample(sample);
  const integer: number = clamped < 0 ? clamped * -PCM_MIN : clamped * PCM_MAX;
  view.setInt16(WAV_HEADER_BYTES + index * PCM_BYTES_PER_SAMPLE, integer, true);
};

export const encodeWav = (samples: Float32Array): Blob => {
  const buffer: ArrayBuffer = new ArrayBuffer(
    WAV_HEADER_BYTES + samples.length * PCM_BYTES_PER_SAMPLE,
  );
  const view: DataView = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VAD_SAMPLE_RATE_HZ, true);
  view.setUint32(28, VAD_SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE, true);
  view.setUint16(32, PCM_BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * PCM_BYTES_PER_SAMPLE, true);
  samples.reduce((written, sample, index) => {
    writePcmSample(view, sample, index);
    return written + 1;
  }, 0);
  return new Blob([buffer], { type: "audio/wav" });
};

const accumulateSample = (
  accumulator: AudioAccumulator,
  sample: number,
  index: number,
): AudioAccumulator => {
  const absolute: number = Math.abs(sample);
  accumulator.sum += sample;
  accumulator.sumSquares += sample * sample;
  accumulator.peak = Math.max(accumulator.peak, absolute);
  accumulator.minimum = Math.min(accumulator.minimum, sample);
  accumulator.maximum = Math.max(accumulator.maximum, sample);
  accumulator.clipped += absolute >= CLIPPING_THRESHOLD ? 1 : 0;
  accumulator.silent += absolute <= SILENCE_THRESHOLD ? 1 : 0;
  accumulator.zeroCrossings +=
    index > 0 && Math.sign(sample) !== Math.sign(accumulator.previous) ? 1 : 0;
  accumulator.previous = sample;
  return accumulator;
};

const percent = (count: number, total: number): number => (total === 0 ? 0 : (count / total) * 100);
const decibels = (amplitude: number): number | null =>
  amplitude <= 0 ? null : 20 * Math.log10(amplitude);

export const measureAudioQuality = (
  samples: Float32Array,
  byteLength: number,
): AudioQualityMetrics => {
  const metrics: AudioAccumulator = samples.reduce(accumulateSample, { ...INITIAL_ACCUMULATOR });
  const meanAmplitude: number = samples.length === 0 ? 0 : metrics.sum / samples.length;
  const rmsAmplitude: number =
    samples.length === 0 ? 0 : Math.sqrt(metrics.sumSquares / samples.length);
  const variance: number = Math.max(0, rmsAmplitude ** 2 - meanAmplitude ** 2);
  return {
    durationMs: (samples.length / VAD_SAMPLE_RATE_HZ) * 1_000,
    sampleRateHz: VAD_SAMPLE_RATE_HZ,
    sampleCount: samples.length,
    byteLength,
    peakAmplitude: metrics.peak,
    peakDbfs: decibels(metrics.peak),
    rmsAmplitude,
    rmsDbfs: decibels(rmsAmplitude),
    meanAmplitude,
    standardDeviation: Math.sqrt(variance),
    minimumAmplitude: samples.length === 0 ? 0 : metrics.minimum,
    maximumAmplitude: samples.length === 0 ? 0 : metrics.maximum,
    crestFactor: rmsAmplitude === 0 ? null : metrics.peak / rmsAmplitude,
    clippingPercent: percent(metrics.clipped, samples.length),
    silencePercent: percent(metrics.silent, samples.length),
    zeroCrossingRate: percent(metrics.zeroCrossings, Math.max(0, samples.length - 1)),
  };
};
