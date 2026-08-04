import { describe, expect, it } from "vitest";

import {
  escapeCsvCell,
  formatCsvDateTime,
  formatLogTime,
  buildRecognitionCsvExport,
  float32SamplesToWavBytes,
} from "../src/lib/recognition-log-csv";

describe("formatLogTime", () => {
  it("formats milliseconds to locale time string, 24-hour", () => {
    const date = new Date(2026, 0, 15, 14, 5, 9);
    const result = formatLogTime(date.getTime(), "ja-JP");
    // ja-JP locale uses 14:05:09 24-hour format
    expect(result).toMatch(/^14:05:09/);
  });

  it("pads single-digit hours", () => {
    const date = new Date(2026, 5, 1, 3, 2, 1);
    const result = formatLogTime(date.getTime(), "ja-JP");
    expect(result).toMatch(/^03:02:01/);
  });
});

describe("formatCsvDateTime", () => {
  it("formats as YYYY-MM-DD HH:mm:ss", () => {
    const date = new Date(2026, 7, 5, 9, 3, 45);
    expect(formatCsvDateTime(date.getTime())).toBe("2026-08-05 09:03:45");
  });

  it("pads single-digit month and day", () => {
    const date = new Date(2026, 0, 3, 7, 8, 9);
    expect(formatCsvDateTime(date.getTime())).toBe("2026-01-03 07:08:09");
  });
});

describe("escapeCsvCell", () => {
  it("returns the value unchanged when no special characters are present", () => {
    expect(escapeCsvCell("hello world")).toBe("hello world");
    expect(escapeCsvCell(42)).toBe("42");
  });

  it("wraps in double quotes and escapes embedded double quotes", () => {
    expect(escapeCsvCell('say "hello"')).toBe('"say ""hello"""');
  });

  it("wraps in double quotes when value contains a comma", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
  });

  it("wraps in double quotes when value contains a newline", () => {
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("wraps in double quotes when value contains a carriage return", () => {
    expect(escapeCsvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
});
describe("buildRecognitionCsvExport", () => {
  const headers = {
    text: "テキスト",
    time: "時刻",
    seconds: "秒数",
    elapsedMs: "経過ms",
  };

  const entry = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: "evt-1",
    generation: undefined,
    source: {
      turn_session_id: 1,
      turn_id: 1,
      turn_revision: 0,
      output_sequence: 1,
      segment_id: 1,
      previous_segment_id: null,
    },
    is_final: true,
    update_mode: "replace" as const,
    text: "字幕1",
    source_asr_model: "reazonspeech_k2_v2" as const,
    source_language: "japanese",
    detected_language: "ja",
    recognized_at_millis: new Date(2026, 7, 5, 12, 0, 0).getTime(),
    audio_seconds: 1.234,
    elapsed_millis: 100,
    audio_frames: 1,
    debug_asr_audio_sample_rate: null,
    debug_asr_audio_samples: null,
    ...overrides,
  });

  it("produces a BOM-prefixed CSV with header and data rows", () => {
    const result = buildRecognitionCsvExport([entry()], headers);

    expect(result.content.startsWith("\uFEFF")).toBe(true);
    expect(result.content).toContain("テキスト,時刻,秒数,経過ms");
    expect(result.content).toContain("字幕1");
    expect(result.content).toContain("1.234");
    expect(result.content).toContain("100");
    expect(result.defaultFileName).toMatch(
      /^parapper-recognition-log-\d{8}-\d{6}\.csv$/,
    );
  });

  it("escapes cells that contain commas", () => {
    const result = buildRecognitionCsvExport(
      [entry({ text: "text,with,commas" })],
      headers,
    );
    expect(result.content).toContain('"text,with,commas"');
  });
});

describe("float32SamplesToWavBytes", () => {
  it("produces a WAV byte array with correct RIFF header", () => {
    const samples = [0.0, 0.5, -0.5, 1.0, -1.0];
    const sampleRate = 16000;
    const bytes = float32SamplesToWavBytes(samples, sampleRate);
    const view = new DataView(bytes.buffer);

    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(new TextDecoder().decode(bytes.slice(12, 16))).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(28, true)).toBe(sampleRate * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(new TextDecoder().decode(bytes.slice(36, 40))).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2); // data size
    expect(bytes.length).toBe(44 + samples.length * 2);
  });

  it("clamps samples to [-1, 1] and converts to 16-bit PCM", () => {
    const samples = [2.0, -2.0, 0.0];
    const bytes = float32SamplesToWavBytes(samples, 8000);
    const view = new DataView(bytes.buffer);
    const headerBytes = 44;

    expect(view.getInt16(headerBytes, true)).toBe(32767);
    expect(view.getInt16(headerBytes + 2, true)).toBe(-32768);
    expect(view.getInt16(headerBytes + 4, true)).toBe(0);
  });
});
