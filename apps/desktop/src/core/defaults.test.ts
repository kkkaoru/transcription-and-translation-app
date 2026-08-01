import { describe, expect, it } from "vitest";
import {
  createDefaultConfig,
  DEFAULT_MODEL_CATALOG,
  mergeConfig,
  migrateSilenceGateDb,
} from "./defaults";

describe("default configuration", () => {
  it("defaults to Japanese-to-English local processing", () => {
    const config = createDefaultConfig();
    expect(config.language).toEqual({ source: "ja", target: "en" });
    expect(config.models.asr).toBe("parapper-ja");
    expect(config.overlay.source.fontFamily).toContain("Noto Sans JP Variable");
    // ~900ms default: lower TTFS than 1.2s while still enough speech for Parapper.
    expect(config.audio.chunkMs).toBe(900);
    expect(config.audio.silenceGateDb).toBe(-50);
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
