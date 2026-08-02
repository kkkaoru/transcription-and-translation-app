// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import { selectParapperSurfaceText } from "../core/parapperStream";
import type { AppConfig, ParapperRecognitionOutput } from "../core/types";
import { isWebSpeechRecognitionSupported } from "../core/webSpeechRecognition";
import {
  captureConfigRequiresRestart,
  clearLegacyFailureNotice,
  resolveTranscribeAudioChunkTimeoutMs,
  TRANSCRIBE_AUDIO_CHUNK_DEFAULT_TIMEOUT_MS,
  withFiniteTimeout,
} from "./MainApp";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Bug 1: Parapper raw mode sourceText handling", () => {
  it("prefers sourceText (mixed kanji/kana) over text (hiragana only) in raw mode", () => {
    // Simulate Parapper output with both text (kana) and sourceText (mixed script)
    const output: ParapperRecognitionOutput = {
      text: "ひらがなのみ", // kana only
      sourceText: "漢字とひらがな", // mixed script
      sessionId: "sess-1",
      turnSessionId: 1,
      turnId: 1,
      revision: 1,
      segmentId: 1,
      previousSegmentId: 0,
      sourceAsrModel: "test-model",
      sourceLanguage: "ja",
      detectedLanguage: "ja",
      elapsedMs: 100,
      audioDurationMs: 1000,
      isFinal: false,
    };

    const rawText = selectParapperSurfaceText(output);
    expect(rawText).toBe("漢字とひらがな");
  });

  it("falls back to text when sourceText is empty or absent", () => {
    const output: ParapperRecognitionOutput = {
      text: "ひらがなのみ",
      sourceText: "", // empty sourceText
      sessionId: "sess-1",
      turnSessionId: 1,
      turnId: 1,
      revision: 1,
      segmentId: 1,
      previousSegmentId: 0,
      sourceAsrModel: "test-model",
      sourceLanguage: "ja",
      detectedLanguage: "ja",
      elapsedMs: 100,
      audioDurationMs: 1000,
      isFinal: false,
    };

    const rawText = selectParapperSurfaceText(output);
    expect(rawText).toBe("ひらがなのみ");
  });

  it("falls back to text when sourceText is undefined", () => {
    const output: ParapperRecognitionOutput = {
      text: "ひらがなのみ",
      sourceText: undefined,
      sessionId: "sess-1",
      turnSessionId: 1,
      turnId: 1,
      revision: 1,
      segmentId: 1,
      previousSegmentId: 0,
      sourceAsrModel: "test-model",
      sourceLanguage: "ja",
      detectedLanguage: "ja",
      elapsedMs: 100,
      audioDurationMs: 1000,
      isFinal: false,
    };

    const rawText = selectParapperSurfaceText(output);
    expect(rawText).toBe("ひらがなのみ");
  });

  it("handles whitespace-only sourceText by falling back to text", () => {
    const output: ParapperRecognitionOutput = {
      text: "ひらがなのみ",
      sourceText: "  \t\n  ", // whitespace only
      sessionId: "sess-1",
      turnSessionId: 1,
      turnId: 1,
      revision: 1,
      segmentId: 1,
      previousSegmentId: 0,
      sourceAsrModel: "test-model",
      sourceLanguage: "ja",
      detectedLanguage: "ja",
      elapsedMs: 100,
      audioDurationMs: 1000,
      isFinal: false,
    };

    const rawText = selectParapperSurfaceText(output);
    expect(rawText).toBe("ひらがなのみ");
  });
});

describe("Bug 2: Web Speech Recognition support detection", () => {
  beforeEach(() => {
    // Clean up any stubs
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when neither SpeechRecognition nor webkitSpeechRecognition is available", () => {
    // jsdom doesn't provide SpeechRecognition
    const supported = isWebSpeechRecognitionSupported();
    expect(supported).toBe(false);
  });

  it("returns true when SpeechRecognition is available (Chrome)", () => {
    const mockRecognition = class {};
    vi.stubGlobal("SpeechRecognition", mockRecognition);
    const supported = isWebSpeechRecognitionSupported();
    expect(supported).toBe(true);
  });

  it("returns true when webkitSpeechRecognition is available (older WebKit)", () => {
    const mockRecognition = class {};
    vi.stubGlobal("webkitSpeechRecognition", mockRecognition);
    const supported = isWebSpeechRecognitionSupported();
    expect(supported).toBe(true);
  });

  it("prefers SpeechRecognition over webkitSpeechRecognition", () => {
    const mockChrome = class MockChrome {};
    const mockWebKit = class MockWebKit {};
    vi.stubGlobal("SpeechRecognition", mockChrome);
    vi.stubGlobal("webkitSpeechRecognition", mockWebKit);
    // Both are available; SpeechRecognition should be preferred
    const supported = isWebSpeechRecognitionSupported();
    expect(supported).toBe(true);
  });

  it("returns false when globals are not constructors", () => {
    // Set to non-constructor values
    vi.stubGlobal("SpeechRecognition", "not a constructor");
    vi.stubGlobal("webkitSpeechRecognition", "not a constructor");
    const supported = isWebSpeechRecognitionSupported();
    expect(supported).toBe(false);
  });
});

describe("MainApp ASR lifecycle guards", () => {
  it("restarts for capture settings that affect an active or starting stream", () => {
    const before = createDefaultConfig();
    const changed = (patch: Partial<AppConfig["audio"]>): AppConfig => ({
      ...before,
      audio: { ...before.audio, ...patch },
    });
    expect(
      captureConfigRequiresRestart(before, changed({ chunkMs: before.audio.chunkMs + 1 })),
    ).toBe(true);
    expect(
      captureConfigRequiresRestart(
        before,
        changed({ silenceGateDb: before.audio.silenceGateDb + 1 }),
      ),
    ).toBe(true);
    const modelOnlyChange: AppConfig = {
      ...before,
      models: { ...before.models, asr: `${before.models.asr}-next` },
    };
    expect(captureConfigRequiresRestart(before, modelOnlyChange)).toBe(false);
    expect(captureConfigRequiresRestart(before, before)).toBe(false);
  });

  it("clears stale transient failure notices after a legacy caption succeeds", () => {
    expect(clearLegacyFailureNotice({ key: "message.audioProcessingFailed" })).toBeNull();
    expect(clearLegacyFailureNotice({ key: "message.noSpeechDetected" })).toBeNull();
    const persistent = { key: "message.saved" } as const;
    expect(clearLegacyFailureNotice(persistent)).toBe(persistent);
    expect(clearLegacyFailureNotice(null)).toBeNull();
  });

  it("normalizes invalid endpoint timeouts to a finite bounded value", () => {
    expect(resolveTranscribeAudioChunkTimeoutMs(Number.NaN)).toBe(
      TRANSCRIBE_AUDIO_CHUNK_DEFAULT_TIMEOUT_MS,
    );
    expect(resolveTranscribeAudioChunkTimeoutMs(Number.POSITIVE_INFINITY)).toBe(
      TRANSCRIBE_AUDIO_CHUNK_DEFAULT_TIMEOUT_MS,
    );
    expect(resolveTranscribeAudioChunkTimeoutMs(1)).toBe(1_000);
    expect(resolveTranscribeAudioChunkTimeoutMs(999_999)).toBe(120_000);
    expect(Number.isFinite(resolveTranscribeAudioChunkTimeoutMs(-1))).toBe(true);
  });

  it("reports a delayed rejection after the renderer timeout", async () => {
    vi.useFakeTimers();
    try {
      let rejectRaw!: (error: unknown) => void;
      const raw = new Promise<never>((_, reject) => {
        rejectRaw = reject;
      });
      const lateError = new Error("native ASR rejected after timeout");
      const onLateReject = vi.fn();
      const bounded = withFiniteTimeout(raw, 5, "ASR timed out", onLateReject);
      const timeoutExpectation = expect(bounded).rejects.toMatchObject({ name: "TimeoutError" });

      await vi.advanceTimersByTimeAsync(5);
      await timeoutExpectation;

      rejectRaw(lateError);
      await Promise.resolve();
      expect(onLateReject).toHaveBeenCalledWith(lateError);
    } finally {
      vi.useRealTimers();
    }
  });
});
