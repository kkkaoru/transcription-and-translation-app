import { describe, expect, it } from "vitest";
import {
  AUDIO_CHUNK_MAX_MS,
  AUDIO_CHUNK_MIN_MS,
  AUDIO_CHUNK_STEP_MS,
  createDefaultConfig,
  DEFAULT_AUDIO_CHUNK_MS,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_VAD_INTERVAL_MS,
  DEFAULT_VAD_THRESHOLD,
  mergeConfig,
  migrateSilenceGateDb,
  normalizeVadIntervalMs,
  normalizeVadThreshold,
} from "./defaults";

describe("default configuration", () => {
  it("defaults to Japanese-to-English local processing", () => {
    const config = createDefaultConfig();
    expect(config.language).toEqual({ source: "ja", target: "en" });
    expect(config.models.asr).toBe("parapper-ja");
    expect(config.overlay.source.fontFamily).toContain("Noto Sans JP Variable");
    // 640ms default: lower TTFS while retaining enough 32ms VAD frames for ASR.
    expect(config.audio.chunkMs).toBe(DEFAULT_AUDIO_CHUNK_MS);
    expect(AUDIO_CHUNK_MIN_MS).toBe(320);
    expect(AUDIO_CHUNK_MAX_MS).toBe(2_000);
    expect(AUDIO_CHUNK_STEP_MS).toBe(32);
    expect(config.audio.silenceGateDb).toBe(-50);
    expect(config.audio.vadIntervalMs).toBe(DEFAULT_VAD_INTERVAL_MS);
    expect(config.audio.vadThreshold).toBe(DEFAULT_VAD_THRESHOLD);
    // Noise cancelling on by default; user can toggle off in Settings.
    expect(config.audio.noiseSuppression).toBe(true);
    // Adaptive noise-floor gate is the default; silenceGateDb is the fallback.
    expect(config.audio.adaptiveNoiseFloor).toBe(true);
    expect(config.debug.verboseLogging).toBe(false);
    expect(config.debug.logLevel).toBe("info");
  });

  it("defaults missing noiseSuppression to true when merging legacy config", () => {
    const merged = mergeConfig({ audio: { chunkMs: 1000 } });
    expect(merged.audio.noiseSuppression).toBe(true);
    const off = mergeConfig({ audio: { noiseSuppression: false } });
    expect(off.audio.noiseSuppression).toBe(false);
  });

  it("defaults missing adaptiveNoiseFloor to true when merging legacy config", () => {
    const merged = mergeConfig({ audio: { chunkMs: 1000 } });
    expect(merged.audio.adaptiveNoiseFloor).toBe(true);
    // Explicit opt-out into the fixed gate is preserved.
    const fixed = mergeConfig({ audio: { adaptiveNoiseFloor: false, silenceGateDb: -60 } });
    expect(fixed.audio.adaptiveNoiseFloor).toBe(false);
    expect(fixed.audio.silenceGateDb).toBe(-60);
  });

  it("migrates the legacy -55 silence gate that let ambient -54.2 dB through", () => {
    expect(migrateSilenceGateDb(-55)).toBe(-50);
    expect(migrateSilenceGateDb(-55.0)).toBe(-50);
    // Intentional custom values must not be rewritten.
    expect(migrateSilenceGateDb(-60)).toBe(-60);
    expect(migrateSilenceGateDb(-45)).toBe(-45);
    const migrated = mergeConfig({ audio: { silenceGateDb: -55 } });
    expect(migrated.audio.silenceGateDb).toBe(-50);
    const custom = mergeConfig({ audio: { silenceGateDb: -48 } });
    expect(custom.audio.silenceGateDb).toBe(-48);
  });

  it("normalizes malformed sidecar VAD settings to safe slider values", () => {
    expect(normalizeVadIntervalMs(Number.NaN)).toBe(DEFAULT_VAD_INTERVAL_MS);
    expect(normalizeVadIntervalMs(0)).toBe(16);
    expect(normalizeVadIntervalMs(99)).toBe(96);
    expect(normalizeVadIntervalMs(999)).toBe(128);
    expect(normalizeVadThreshold(Number.POSITIVE_INFINITY)).toBe(DEFAULT_VAD_THRESHOLD);
    expect(normalizeVadThreshold(0)).toBe(0.1);
    expect(normalizeVadThreshold(0.73)).toBe(0.75);
    expect(normalizeVadThreshold(2)).toBe(0.9);
    const merged = mergeConfig({ audio: { vadIntervalMs: 0, vadThreshold: Number.NaN } });
    expect(merged.audio.vadIntervalMs).toBe(16);
    expect(merged.audio.vadThreshold).toBe(DEFAULT_VAD_THRESHOLD);
  });

  it("keeps nested defaults when loading a partial config", () => {
    const config = mergeConfig({
      endpoint: { baseUrl: "http://example.test" },
      overlay: { source: { fontSizePx: 48 } },
      models: { paths: { "zenz-v3.2-small-gguf": "/models/zenz.gguf" } },
    });
    expect(config.endpoint.transcriptionPath).toBe("/v1/audio/transcriptions");
    expect(config.overlay.source.fontSizePx).toBe(48);
    expect(config.overlay.translation.fontSizePx).toBe(29);
    expect(config.models.paths).toEqual({ "zenz-v3.2-small-gguf": "/models/zenz.gguf" });
  });

  it("exposes only the MVP model families", () => {
    expect(DEFAULT_MODEL_CATALOG.asr).toHaveLength(1);
    expect(DEFAULT_MODEL_CATALOG.normalizer.map((entry) => entry.id)).toContain(
      "zenz-v3.2-small-gguf",
    );
    expect(DEFAULT_MODEL_CATALOG.translator.every((entry) => entry.languages.includes("ja"))).toBe(
      true,
    );
  });
});
