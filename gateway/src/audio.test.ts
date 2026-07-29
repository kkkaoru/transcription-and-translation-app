import { describe, expect, it } from "vitest";
import { pcm16FromWav, splitParapperFrames } from "./audio.js";

const wav = (
  data: number[],
  overrides: Partial<{ bits: number; channels: number; encoding: number; sampleRate: number }> = {},
  extraChunk?: Buffer,
): Uint8Array => {
  const values = { bits: 16, channels: 1, encoding: 1, sampleRate: 16000, ...overrides };
  const body = Buffer.from(data);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(values.encoding, 0);
  fmt.writeUInt16LE(values.channels, 2);
  fmt.writeUInt32LE(values.sampleRate, 4);
  fmt.writeUInt32LE((values.sampleRate * values.channels * values.bits) / 8, 8);
  fmt.writeUInt16LE((values.channels * values.bits) / 8, 12);
  fmt.writeUInt16LE(values.bits, 14);
  const fmtHeader = Buffer.concat([Buffer.from("fmt "), Buffer.from([16, 0, 0, 0]), fmt]);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0);
  dataHeader.writeUInt32LE(body.length, 4);
  const chunks = [fmtHeader, ...(extraChunk ? [extraChunk] : []), dataHeader, body];
  const size = chunks.reduce((total, chunk) => total + chunk.length, 4);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0);
  header.writeUInt32LE(size, 4);
  header.write("WAVE", 8);
  return new Uint8Array(Buffer.concat([header, ...chunks]));
};

describe("WAV adapter", () => {
  it("extracts 16 kHz mono PCM and skips an aligned unknown chunk", () => {
    const extra = Buffer.from([
      "J".charCodeAt(0),
      "U".charCodeAt(0),
      "N".charCodeAt(0),
      "K".charCodeAt(0),
      1,
      0,
      0,
      0,
      7,
      0,
    ]);
    expect([...pcm16FromWav(wav([0, 1, 254, 255], {}, extra))]).toEqual([0, 1, 254, 255]);
  });

  it("rejects malformed or incompatible WAV input", () => {
    expect(() => pcm16FromWav(new Uint8Array())).toThrow("RIFF/WAVE");
    expect(() => pcm16FromWav(Uint8Array.from(Buffer.from("RIFF0000NOPE")))).toThrow("RIFF/WAVE");
    expect(() => pcm16FromWav(wav([], {}))).toThrow("non-empty");
    expect(() => pcm16FromWav(wav([0], {}))).toThrow("signed 16-bit");
    expect(() => pcm16FromWav(wav([0, 0], { sampleRate: 44100 }))).toThrow("16000");
    expect(() => pcm16FromWav(wav([0, 0], { channels: 2 }))).toThrow("mono");
    expect(() => pcm16FromWav(wav([0, 0], { encoding: 3 }))).toThrow("PCM");
    expect(() => pcm16FromWav(wav([0, 0], { bits: 8 }))).toThrow("PCM s16le");
    const shortFormat = wav([0, 0]);
    shortFormat[16] = 15;
    expect(() => pcm16FromWav(shortFormat)).toThrow("fmt chunk is too small");
  });

  it("rejects a truncated or incomplete WAV chunk", () => {
    const truncated = wav([0, 0]);
    truncated[16] = 255;
    truncated[17] = 255;
    truncated[18] = 255;
    truncated[19] = 127;
    expect(() => pcm16FromWav(truncated)).toThrow("exceeds");
    const missingData = wav([0, 0]).slice(0, 36);
    expect(() => pcm16FromWav(missingData)).toThrow("fmt and data");
  });

  it("splits PCM into the Parapper 100 ms frame limit", () => {
    const frames = splitParapperFrames(new Uint8Array(6402).fill(1));
    expect(frames.map((frame) => frame.length)).toEqual([3200, 3200, 2]);
    expect(() => splitParapperFrames(new Uint8Array())).toThrow("non-empty");
    expect(() => splitParapperFrames(new Uint8Array(3))).toThrow("16-bit");
  });
});
