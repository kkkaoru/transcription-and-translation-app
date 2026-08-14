import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_CHUNK_MAX_MS,
  AUDIO_CHUNK_MIN_MS,
  AUDIO_CHUNK_RUNTIME_MAX_MS,
  AUDIO_CHUNK_RUNTIME_MIN_MS,
  AUDIO_CHUNK_STEP_MS,
  BROWSER_SOURCE_PORT_MAX,
  BROWSER_SOURCE_PORT_MIN,
  createDefaultConfig,
  createTextStyle,
  DEFAULT_AUDIO_CHUNK_MS,
  DEFAULT_BROWSER_SOURCE_PORT,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_RECOGNITION_MODE,
  DEFAULT_VAD_INTERVAL_MS,
  DEFAULT_VAD_THRESHOLD,
  getDefaultRecognitionMode,
  isRecognitionMode,
  mergeBrowserSource,
  mergeConfig,
  migrateSilenceGateDb,
  normalizeVadIntervalMs,
  normalizeVadThreshold,
  RECOGNITION_MODES,
  resolveChunkMs,
  resolveSilenceGate,
  resolveSilenceGateDb,
  resolveSilenceGateMode,
} from "./defaults";

describe("default configuration", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to Japanese-to-English local processing", () => {
    const config = createDefaultConfig();
    expect(config.language).toEqual({ source: "ja", target: "en" });
    expect(config.recognitionMode).toBe(DEFAULT_RECOGNITION_MODE);
    expect(DEFAULT_RECOGNITION_MODE).toBe("parapper-azookey");
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
    // Noise cancelling / AGC on by default; user can toggle each in Settings.
    expect(config.audio.noiseSuppression).toBe(true);
    expect(config.audio.autoGainControl).toBe(true);
    // Adaptive noise-floor gate is the default; silenceGateDb is the fallback.
    expect(config.audio.adaptiveNoiseFloor).toBe(true);
    expect(config.audio.streamingInterimAsrEnabled).toBe(false);
    expect(config.audio.partialWindowAsrEnabled).toBe(true);
    expect(config.rescore.timeoutMs).toBe(500);
    expect(config.schemaVersion).toBe(2);
    expect(config.debug.verboseLogging).toBe(false);
    expect(config.debug.logLevel).toBe("info");
  });

  it("resolves runtime-aware default when Web Speech is available", () => {
    vi.stubGlobal("SpeechRecognition", class {});
    expect(getDefaultRecognitionMode()).toBe("web-speech");
    expect(createDefaultConfig().recognitionMode).toBe("web-speech");
  });

  it("falls back to historical default when Web Speech is unavailable", () => {
    expect(getDefaultRecognitionMode({ webSpeechAvailable: false })).toBe("parapper-azookey");
    vi.stubGlobal("SpeechRecognition", undefined);
    expect(createDefaultConfig().recognitionMode).toBe("parapper-azookey");
  });

  it("keeps recognition mode values compatible with legacy and future configs", () => {
    expect(RECOGNITION_MODES).toEqual(["parapper-raw", "web-speech", "parapper-azookey"]);
    expect(mergeConfig({}).recognitionMode).toBe(DEFAULT_RECOGNITION_MODE);
    expect(mergeConfig({ recognitionMode: "web-speech" }).recognitionMode).toBe("web-speech");
    expect(mergeConfig({ recognitionMode: "parapper-raw" }).recognitionMode).toBe("parapper-raw");
    vi.stubGlobal("SpeechRecognition", class {});
    expect(mergeConfig({ recognitionMode: "future-mode" as never }).recognitionMode).toBe(
      "web-speech",
    );
    vi.stubGlobal("SpeechRecognition", undefined);
    expect(mergeConfig({ recognitionMode: "future-mode" as never }).recognitionMode).toBe(
      DEFAULT_RECOGNITION_MODE,
    );
  });

  it("defaults missing noiseSuppression and autoGainControl to true when merging legacy config", () => {
    const merged = mergeConfig({ audio: { chunkMs: 1000 } });
    expect(merged.audio.noiseSuppression).toBe(true);
    expect(merged.audio.autoGainControl).toBe(true);
    const off = mergeConfig({ audio: { noiseSuppression: false, autoGainControl: false } });
    expect(off.audio.noiseSuppression).toBe(false);
    expect(off.audio.autoGainControl).toBe(false);
  });

  it("defaults missing adaptiveNoiseFloor to true when merging legacy config", () => {
    const merged = mergeConfig({ audio: { chunkMs: 1000 } });
    expect(merged.audio.adaptiveNoiseFloor).toBe(true);
    // Explicit opt-out into the fixed gate is preserved.
    const fixed = mergeConfig({ audio: { adaptiveNoiseFloor: false, silenceGateDb: -60 } });
    expect(fixed.audio.adaptiveNoiseFloor).toBe(false);
    expect(fixed.audio.silenceGateDb).toBe(-60);
  });

  it("defaults missing streamingInterimAsrEnabled to false when merging legacy config", () => {
    const merged = mergeConfig({ audio: { chunkMs: 1000 } });
    expect(merged.audio.streamingInterimAsrEnabled).toBe(false);
    const on = mergeConfig({ audio: { streamingInterimAsrEnabled: true } });
    expect(on.audio.streamingInterimAsrEnabled).toBe(true);
    const off = mergeConfig({ audio: { streamingInterimAsrEnabled: false } });
    expect(off.audio.streamingInterimAsrEnabled).toBe(false);
  });

  it("migrates v1 runtime defaults together while preserving unrelated settings", () => {
    const migrated = mergeConfig({
      schemaVersion: 1,
      audio: { partialWindowAsrEnabled: false, inputDeviceId: "preserved-device" },
      models: {
        normalizer: "zenz-v3.2-small-gguf",
        paths: { "azookey-user-dictionary": "/tmp/user.tsv" },
      },
      overlay: {
        x: 123,
        source: { fontFamily: "Preserved Font" },
      },
      rescore: { timeoutMs: 200 },
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.audio.partialWindowAsrEnabled).toBe(true);
    expect(migrated.models.normalizer).toBe("azookey-rust");
    expect(migrated.rescore.timeoutMs).toBe(500);
    expect(migrated.audio.inputDeviceId).toBe("preserved-device");
    expect(migrated.models.paths["azookey-user-dictionary"]).toBe("/tmp/user.tsv");
    expect(migrated.overlay.x).toBe(123);
    expect(migrated.overlay.source.fontFamily).toBe("Preserved Font");
  });

  it("preserves explicit v2 runtime choices and remains idempotent", () => {
    const v2 = mergeConfig({
      schemaVersion: 2,
      audio: { partialWindowAsrEnabled: false },
      models: { normalizer: "zenz-v3.2-small-gguf" },
      rescore: { timeoutMs: 350 },
    });
    expect(v2.audio.partialWindowAsrEnabled).toBe(false);
    expect(v2.models.normalizer).toBe("zenz-v3.2-small-gguf");
    expect(v2.rescore.timeoutMs).toBe(350);
    expect(mergeConfig(v2)).toEqual(v2);
  });

  it("keeps browser-only previews disabled until the native runtime supplies its platform default", () => {
    const config = createDefaultConfig();
    expect(config.overlay.browserSource).toEqual({ enabled: false, port: 1_421 });
    expect(DEFAULT_BROWSER_SOURCE_PORT).toBe(1_421);
    expect(BROWSER_SOURCE_PORT_MIN).toBe(1_024);
    expect(BROWSER_SOURCE_PORT_MAX).toBe(65_535);
  });

  it("keeps a legacy overlay without browserSource disabled on the default port", () => {
    const merged = mergeConfig({ overlay: { order: "translation-first" } });
    expect(merged.overlay.browserSource).toEqual({ enabled: false, port: 1_421 });
  });

  it("normalizes an out-of-range browser source port and preserves a valid one", () => {
    const fixed = mergeConfig({
      overlay: { browserSource: { enabled: true, port: 80 } },
    });
    expect(fixed.overlay.browserSource).toEqual({ enabled: true, port: 1_421 });
    const custom = mergeConfig({
      overlay: { browserSource: { enabled: true, port: 40_000 } },
    });
    expect(custom.overlay.browserSource).toEqual({ enabled: true, port: 40_000 });
  });

  it("keeps malformed browser source values on safe defaults", () => {
    const merged = mergeConfig({
      overlay: { browserSource: { enabled: "yes" as never, port: "1421" as never } },
    });
    expect(merged.overlay.browserSource).toEqual({ enabled: false, port: 1_421 });
  });

  it("normalizes a missing browser source block without a base config", () => {
    expect(mergeBrowserSource(undefined, undefined)).toEqual({
      enabled: false,
      port: DEFAULT_BROWSER_SOURCE_PORT,
    });
    expect(mergeBrowserSource(undefined, { enabled: true, port: BROWSER_SOURCE_PORT_MIN })).toEqual(
      {
        enabled: true,
        port: BROWSER_SOURCE_PORT_MIN,
      },
    );
  });

  it("resolves the effective silence gate without treating an adaptive fallback as active", () => {
    expect(resolveSilenceGateMode(undefined)).toBe("adaptive");
    expect(resolveSilenceGateMode(true)).toBe("adaptive");
    expect(resolveSilenceGateMode(false)).toBe("fixed");
    expect(resolveSilenceGate(true, -60)).toEqual({ mode: "adaptive", fixedGateDb: null });
    expect(resolveSilenceGate(false, -60)).toEqual({ mode: "fixed", fixedGateDb: -60 });
    // Runtime values are bounded to the same range as the settings slider.
    expect(resolveSilenceGateDb(Number.NaN)).toBe(-50);
    expect(resolveSilenceGateDb(-200)).toBe(-90);
    expect(resolveSilenceGateDb(12)).toBe(0);
  });

  it("normalizes malformed chunk windows while preserving valid legacy values", () => {
    expect(resolveChunkMs(Number.NaN)).toBe(DEFAULT_AUDIO_CHUNK_MS);
    expect(resolveChunkMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_AUDIO_CHUNK_MS);
    expect(resolveChunkMs(0)).toBe(DEFAULT_AUDIO_CHUNK_MS);
    expect(resolveChunkMs(-320)).toBe(DEFAULT_AUDIO_CHUNK_MS);
    expect(resolveChunkMs(100)).toBe(AUDIO_CHUNK_RUNTIME_MIN_MS);
    expect(resolveChunkMs(20_000)).toBe(AUDIO_CHUNK_RUNTIME_MAX_MS);
    // A pre-UI-cadence JSON value remains usable rather than being rounded.
    expect(resolveChunkMs(333)).toBe(333);
    expect(mergeConfig({ audio: { chunkMs: Number.NaN } }).audio.chunkMs).toBe(
      DEFAULT_AUDIO_CHUNK_MS,
    );
    expect(mergeConfig({ audio: { chunkMs: 333 } }).audio.chunkMs).toBe(333);
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

  it("getDefaultRecognitionMode respects webSpeechAvailable parameter", () => {
    // When explicitly true, should return web-speech
    expect(getDefaultRecognitionMode({ webSpeechAvailable: true })).toBe("web-speech");
    // When explicitly false, should return parapper-azookey
    expect(getDefaultRecognitionMode({ webSpeechAvailable: false })).toBe("parapper-azookey");
  });

  it("createDefaultConfig uses runtime-aware default", () => {
    // Without stub, uses actual global detection
    const configDefault = createDefaultConfig();
    expect(["web-speech", "parapper-azookey"]).toContain(configDefault.recognitionMode);

    // With stubs, should respect availability
    vi.stubGlobal("SpeechRecognition", class {});
    const configWithWeb = createDefaultConfig();
    expect(configWithWeb.recognitionMode).toBe("web-speech");

    vi.stubGlobal("SpeechRecognition", undefined);
    const configWithoutWeb = createDefaultConfig();
    expect(configWithoutWeb.recognitionMode).toBe("parapper-azookey");
  });

  it("mergeConfig preserves explicit recognitionMode over runtime default", () => {
    vi.stubGlobal("SpeechRecognition", class {});
    // Explicit mode should override runtime detection
    const preserved = mergeConfig({ recognitionMode: "parapper-azookey" });
    expect(preserved.recognitionMode).toBe("parapper-azookey");

    vi.stubGlobal("SpeechRecognition", undefined);
    // Invalid/unknown modes should fall back to runtime default
    const invalid = mergeConfig({ recognitionMode: "invalid-mode" as never });
    expect(invalid.recognitionMode).toBe("parapper-azookey");
  });

  it("normalizeVadIntervalMs handles undefined and finite values", () => {
    expect(normalizeVadIntervalMs(undefined)).toBe(DEFAULT_VAD_INTERVAL_MS);
    expect(normalizeVadIntervalMs(null as never)).toBe(DEFAULT_VAD_INTERVAL_MS);
    expect(normalizeVadIntervalMs(Number.NaN)).toBe(DEFAULT_VAD_INTERVAL_MS);
    expect(normalizeVadIntervalMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_VAD_INTERVAL_MS);
    // Clamps to range
    expect(normalizeVadIntervalMs(8)).toBe(16); // rounded up to step
    expect(normalizeVadIntervalMs(200)).toBe(128); // clamped to max
  });

  it("normalizeVadThreshold handles undefined and finite values", () => {
    expect(normalizeVadThreshold(undefined)).toBe(DEFAULT_VAD_THRESHOLD);
    expect(normalizeVadThreshold(null as never)).toBe(DEFAULT_VAD_THRESHOLD);
    expect(normalizeVadThreshold(Number.NaN)).toBe(DEFAULT_VAD_THRESHOLD);
    expect(normalizeVadThreshold(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_VAD_THRESHOLD);
    // Clamps to range
    expect(normalizeVadThreshold(0.02)).toBe(0.1); // clamped to min
    expect(normalizeVadThreshold(1.0)).toBe(0.9); // clamped to max
  });

  it("mergeConfig preserves null and false values correctly", () => {
    // Test that falsy non-defaults are preserved
    const allFalsy = mergeConfig({
      audio: {
        noiseSuppression: false,
        autoGainControl: false,
        adaptiveNoiseFloor: false,
        streamingInterimAsrEnabled: false,
        silenceGateDb: 0,
      },
    });
    expect(allFalsy.audio.noiseSuppression).toBe(false);
    expect(allFalsy.audio.autoGainControl).toBe(false);
    expect(allFalsy.audio.adaptiveNoiseFloor).toBe(false);
    expect(allFalsy.audio.streamingInterimAsrEnabled).toBe(false);
    expect(allFalsy.audio.silenceGateDb).toBe(0);
  });

  it("createTextStyle merges overrides correctly", () => {
    const defaults = createTextStyle();
    expect(defaults.fontFamily).toContain("Noto Sans JP");
    expect(defaults.fontSizePx).toBe(34);
    expect(defaults.opacity).toBe(1);

    const customized = createTextStyle({
      fontSizePx: 48,
      color: "#ff0000",
    });
    expect(customized.fontSizePx).toBe(48);
    expect(customized.color).toBe("#ff0000");
    expect(customized.fontFamily).toContain("Noto Sans JP"); // unchanged
    expect(customized.opacity).toBe(1); // unchanged
  });

  it("createDefaultConfig includes complete model catalog", () => {
    const config = createDefaultConfig();
    expect(config.models.asr).toBe("parapper-ja");
    expect(config.models.normalizer).toBe("azookey-rust");
    expect(config.models.translator).toBe("hy-mt2-1.8b-gguf");
    expect(config.models.paths).toEqual({});
  });

  it("createDefaultConfig sets correct audio defaults", () => {
    const config = createDefaultConfig();
    expect(config.audio.inputDeviceId).toBe("default");
    expect(config.audio.sampleRate).toBe(16_000);
    expect(config.audio.chunkMs).toBe(640);
    expect(config.audio.silenceGateDb).toBe(-50);
    expect(config.audio.vadIntervalMs).toBe(32);
    expect(config.audio.vadThreshold).toBe(0.5);
    expect(config.audio.noiseSuppression).toBe(true);
    expect(config.audio.autoGainControl).toBe(true);
    expect(config.audio.adaptiveNoiseFloor).toBe(true);
  });

  it("mergeConfig deep-merges nested overlay styles", () => {
    const merged = mergeConfig({
      overlay: {
        width: 1920,
        source: { fontSizePx: 72, color: "#ff0000" },
        translation: { opacity: 0.5 },
      },
    });
    expect(merged.overlay.width).toBe(1920);
    expect(merged.overlay.source.fontSizePx).toBe(72);
    expect(merged.overlay.source.color).toBe("#ff0000");
    expect(merged.overlay.source.fontFamily).toContain("Noto Sans JP"); // default preserved
    expect(merged.overlay.translation.opacity).toBe(0.5);
    expect(merged.overlay.translation.fontSizePx).toBe(29); // default preserved
  });

  it("mergeConfig normalizes non-finite/null/undefined overlay layout numerics to defaults", () => {
    // Legacy persisted configs may carry null (JSON) or NaN/Infinity for layout
    // numerics. The overlay spread must not copy those straight through or the
    // DOM/native renderer would paint at 0% / NaNpx instead of the documented
    // defaults.
    const merged = mergeConfig({
      overlay: {
        captionXPercent: null as never,
        captionYPercent: Number.NaN,
        gapPx: undefined,
        safeAreaPx: Number.POSITIVE_INFINITY,
        width: Number.NaN,
        height: null as never,
      },
    });
    expect(merged.overlay.captionXPercent).toBe(50);
    expect(merged.overlay.captionYPercent).toBe(88);
    expect(merged.overlay.gapPx).toBe(14);
    expect(merged.overlay.safeAreaPx).toBe(42);
    expect(merged.overlay.width).toBe(1_280);
    expect(merged.overlay.height).toBe(720);
  });

  it("mergeConfig preserves finite overlay layout values", () => {
    const merged = mergeConfig({
      overlay: {
        captionXPercent: 35,
        captionYPercent: 80,
        gapPx: 20,
        safeAreaPx: 60,
        width: 1_920,
        height: 1_080,
      },
    });
    expect(merged.overlay.captionXPercent).toBe(35);
    expect(merged.overlay.captionYPercent).toBe(80);
    expect(merged.overlay.gapPx).toBe(20);
    expect(merged.overlay.safeAreaPx).toBe(60);
    expect(merged.overlay.width).toBe(1_920);
    expect(merged.overlay.height).toBe(1_080);
  });

  it("isRecognitionMode validates mode values", () => {
    expect(isRecognitionMode("parapper-raw")).toBe(true);
    expect(isRecognitionMode("web-speech")).toBe(true);
    expect(isRecognitionMode("parapper-azookey")).toBe(true);
    expect(isRecognitionMode("invalid")).toBe(false);
    expect(isRecognitionMode(null)).toBe(false);
    expect(isRecognitionMode(123)).toBe(false);
    expect(isRecognitionMode(undefined)).toBe(false);
  });
});

describe("input-LM rescore configuration", () => {
  it("defaults the rescorer off with the measured recommended parameters", () => {
    const config = createDefaultConfig();
    expect(config.rescore.enabled).toBe(false);
    expect(config.rescore.lmWeight).toBe(0.5);
    expect(config.rescore.confusionWeight).toBe(0.5);
    expect(config.rescore.overcorrectionMargin).toBe(2.0);
    expect(config.rescore.timeoutMs).toBe(500);
    expect(config.rescore.modelPath).toBeNull();
  });

  it("keeps the rescorer off when a persisted config has no rescore block", () => {
    // A config written before the rescorer existed must load exactly as it
    // does today: rescore stays off and not present.
    const merged = mergeConfig({ recognitionMode: "parapper-azookey" });
    expect(merged.rescore.enabled).toBe(false);
    expect(merged.rescore.modelPath).toBeNull();
  });

  it("preserves an explicit rescore toggle through merge", () => {
    const merged = mergeConfig({ rescore: { enabled: true } });
    expect(merged.rescore.enabled).toBe(true);
    // Untouched parameters keep the recommended defaults.
    expect(merged.rescore.lmWeight).toBe(0.5);
    expect(merged.rescore.confusionWeight).toBe(0.5);
    expect(merged.rescore.overcorrectionMargin).toBe(2.0);
    expect(merged.rescore.timeoutMs).toBe(500);
  });

  it("round-trips a custom rescore block through merge", () => {
    const merged = mergeConfig({
      schemaVersion: 2,
      rescore: {
        enabled: true,
        lmWeight: 0.7,
        confusionWeight: 0.3,
        overcorrectionMargin: 2.5,
        timeoutMs: 350,
        modelPath: "/tmp/input-lm/lm",
      },
    });
    expect(merged.rescore).toEqual({
      enabled: true,
      lmWeight: 0.7,
      confusionWeight: 0.3,
      overcorrectionMargin: 2.5,
      timeoutMs: 350,
      modelPath: "/tmp/input-lm/lm",
    });
  });
});
