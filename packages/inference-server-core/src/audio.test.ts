import { describe, expect, it } from "vitest";
import { pcm16FromWav, pcm16ToWav, splitParapperFrames } from "./audio.js";

const wav = (
  data: number[],
  overrides: Partial<{ bits: number; channels: number; encoding: number; sampleRate: number }> = {},
  extraChunk?: Uint8Array,
): Uint8Array => {
  const values = { bits: 16, channels: 1, encoding: 1, sampleRate: 16_000, ...overrides };
  const body = Uint8Array.from(data);
  const fmt = new Uint8Array(16);
  const fmtView = new DataView(fmt.buffer);
  fmtView.setUint16(0, values.encoding, true);
  fmtView.setUint16(2, values.channels, true);
  fmtView.setUint32(4, values.sampleRate, true);
  fmtView.setUint32(8, (values.sampleRate * values.channels * values.bits) / 8, true);
  fmtView.setUint16(12, (values.channels * values.bits) / 8, true);
  fmtView.setUint16(14, values.bits, true);
  const fmtHeader = new Uint8Array(24);
  fmtHeader.set(new TextEncoder().encode("fmt "), 0);
  new DataView(fmtHeader.buffer).setUint32(4, 16, true);
  fmtHeader.set(fmt, 8);
  const dataHeader = new Uint8Array(8);
  dataHeader.set(new TextEncoder().encode("data"), 0);
  new DataView(dataHeader.buffer).setUint32(4, body.length, true);
  const chunks = [fmtHeader, ...(extraChunk ? [extraChunk] : []), dataHeader, body];
  const size = chunks.reduce((total, chunk) => total + chunk.length, 4);
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(header.buffer).setUint32(4, size, true);
  header.set(new TextEncoder().encode("WAVE"), 8);
  const result = new Uint8Array(
    header.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of [header, ...chunks]) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

describe("PCM/WAV adapter", () => {
  it("round-trips valid PCM and splits frames at the Parapper limit", () => {
    const pcm = Uint8Array.from([0, 1, 254, 255]);
    const encoded = pcm16ToWav(pcm);
    expect([...pcm16FromWav(encoded)]).toEqual([...pcm]);
    expect([...pcm16ToWav(pcm).slice(0, 4)]).toEqual([...new TextEncoder().encode("RIFF")]);
    expect(splitParapperFrames(new Uint8Array(6_402).fill(1)).map((frame) => frame.length)).toEqual(
      [3_200, 3_200, 2],
    );
  });

  it("skips unknown aligned chunks and rejects malformed or incompatible WAV input", () => {
    const extra = Uint8Array.from([74, 85, 78, 75, 1, 0, 0, 0, 7, 0]);
    expect([...pcm16FromWav(wav([0, 1, 254, 255], {}, extra))]).toEqual([0, 1, 254, 255]);
    expect(() => pcm16FromWav(new Uint8Array())).toThrow("RIFF/WAVE");
    expect(() => pcm16FromWav(Uint8Array.from(new TextEncoder().encode("RIFF0000NOPE")))).toThrow(
      "RIFF/WAVE",
    );
    expect(() => pcm16FromWav(wav([], {}))).toThrow("non-empty");
    expect(() => pcm16FromWav(wav([0], {}))).toThrow("signed 16-bit");
    expect(() => pcm16FromWav(wav([0, 0], { sampleRate: 44_100 }))).toThrow("16000");
    expect(() => pcm16FromWav(wav([0, 0], { channels: 2 }))).toThrow("mono");
    expect(() => pcm16FromWav(wav([0, 0], { encoding: 3 }))).toThrow("PCM");
    expect(() => pcm16FromWav(wav([0, 0], { bits: 8 }))).toThrow("PCM s16le");
    const shortFormat = wav([0, 0]);
    shortFormat[16] = 15;
    expect(() => pcm16FromWav(shortFormat)).toThrow("fmt chunk is too small");
    const truncated = wav([0, 0]);
    truncated[16] = 255;
    truncated[17] = 255;
    truncated[18] = 255;
    truncated[19] = 127;
    expect(() => pcm16FromWav(truncated)).toThrow("exceeds");
    expect(() => pcm16FromWav(wav([0, 0]).slice(0, 36))).toThrow("fmt and data");
  });

  it("rejects empty or odd PCM input", () => {
    expect(() => pcm16ToWav(new Uint8Array())).toThrow("non-empty");
    expect(() => pcm16ToWav(new Uint8Array(3))).toThrow("16-bit");
    expect(() => splitParapperFrames(new Uint8Array())).toThrow("non-empty");
    expect(() => splitParapperFrames(new Uint8Array(3))).toThrow("16-bit");
  });
});
