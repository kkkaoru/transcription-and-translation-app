// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import { clearDiagnosticEvents, getDiagnosticEvents } from "../core/diagnostics";
import { clearPipelineDrops, snapshotPipelineDrops } from "../core/dropDiagnostics";
import { selectParapperSurfaceText } from "../core/parapperStream";
import type { AppConfig, ParapperRecognitionOutput } from "../core/types";
import { isWebSpeechRecognitionSupported } from "../core/webSpeechRecognition";
import { createPreviewCaption } from "../overlay/captions";
import {
  acceptsPipelineStageGeneration,
  captureConfigRequiresRestart,
  clearLegacyFailureNotice,
  createCaptureRestartCoordinator,
  handlePipelineDropSignal,
  mergeCaptionForDisplay,
  reportCrossIdTranslationSaved,
  resolveLiveNoticeText,
  resolveTranscribeAudioChunkTimeoutMs,
  shouldShowPipelineDropNotice,
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
  it("surfaces native pipeline drops through the normal Live notice path", () => {
    clearDiagnosticEvents();
    clearPipelineDrops();
    const notify = vi.fn();
    handlePipelineDropSignal({ source: "translation", reason: "retired", count: 1 }, notify);

    expect(notify).toHaveBeenCalledWith({
      key: "message.pipelineDrop",
      detail: "source=translation · reason=retired · count=1",
    });
    expect(snapshotPipelineDrops().bySource).toEqual({ translation: 1 });
    expect(getDiagnosticEvents()).toHaveLength(1);
    expect(getDiagnosticEvents()[0]).toMatchObject({
      kind: "caption",
      message: "Pipeline drop signal",
    });
  });

  it("paints provisional ASR only for the generation that owns the live caption", () => {
    // A Stop+Start can advance the native generation while an older ASR stage
    // is still in flight. That stale row stays in the Debug panel, but must
    // not repaint the replacement session's caption.
    expect(acceptsPipelineStageGeneration(2, 2)).toBe(true);
    expect(acceptsPipelineStageGeneration(1, 2)).toBe(false);
    expect(acceptsPipelineStageGeneration(2, 1)).toBe(false);
    // No active capture owns the view, so a generation-tagged row cannot paint.
    expect(acceptsPipelineStageGeneration(1, null)).toBe(false);
    // Older bundles omit the field entirely; they keep the historical
    // behaviour rather than silently losing every provisional paint.
    expect(acceptsPipelineStageGeneration(undefined, 2)).toBe(true);
    expect(acceptsPipelineStageGeneration(null, 2)).toBe(true);
    expect(acceptsPipelineStageGeneration(undefined, null)).toBe(true);
  });

  it("logs one diagnostic per newly saved cross-ID translation", () => {
    clearDiagnosticEvents();
    reportCrossIdTranslationSaved(0, 1, "late-translation", 1);
    reportCrossIdTranslationSaved(1, 1, "late-translation", 1);

    expect(
      getDiagnosticEvents().filter(
        (event) => event.message === "Late translation preserved for prior utterance",
      ),
    ).toHaveLength(1);
  });

  it("gates low-priority drop notices per capture session and preserves errors", () => {
    expect(shouldShowPipelineDropNotice(false, null)).toBe(true);
    expect(shouldShowPipelineDropNotice(true, null)).toBe(false);
    expect(shouldShowPipelineDropNotice(false, { key: "message.pipelineDrop" })).toBe(true);
    expect(shouldShowPipelineDropNotice(false, { key: "message.audioProcessingFailed" })).toBe(
      false,
    );
    expect(shouldShowPipelineDropNotice(false, null, "persistent runtime failure")).toBe(false);
    expect(
      shouldShowPipelineDropNotice(
        false,
        { key: "message.pipelineDrop" },
        "persistent runtime failure",
      ),
    ).toBe(false);
    expect(shouldShowPipelineDropNotice(false, null, "no usable speech")).toBe(true);
  });

  it("keeps a persistent runtime error above a low-priority pipeline notice", () => {
    const translate = (key: string): string => `translated:${key}`;
    expect(resolveLiveNoticeText(null, "persistent runtime failure", translate)).toBe(
      "persistent runtime failure",
    );
    expect(
      resolveLiveNoticeText(
        {
          key: "message.pipelineDrop",
          detail: "source=translation · reason=retired · count=1",
        },
        "persistent runtime failure",
        translate,
      ),
    ).toBe("persistent runtime failure");
    expect(
      resolveLiveNoticeText(
        { key: "message.noSpeechDetected", detail: "ambient" },
        "persistent runtime failure",
        translate,
      ),
    ).toBe("persistent runtime failure");
    expect(
      resolveLiveNoticeText({ key: "message.saved" }, "persistent runtime failure", translate),
    ).toBe("persistent runtime failure");
    expect(
      resolveLiveNoticeText(
        { key: "message.audioProcessingFailed", detail: "persistent runtime failure" },
        "persistent runtime failure",
        translate,
      ),
    ).toBe("translated:message.audioProcessingFailed persistent runtime failure");
  });

  it("allows an older latest-caption replay to replace the design preview", () => {
    const preview = createPreviewCaption();
    const latest = {
      ...preview,
      id: "captured-utterance",
      sourceText: "過去に認識した発話",
      translationText: "A caption from the active session",
      startedAt: 1,
      receivedAt: 2,
      stage: "translation" as const,
      sequence: 1,
      isFinal: true,
    };

    expect(mergeCaptionForDisplay(preview, latest)).toBeNull();
    expect(mergeCaptionForDisplay(preview, latest, true)).toEqual(latest);
  });

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

describe("Capture restart latest-wins coalescing", () => {
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it("starts only the second device after two rapid restarts share one stop", async () => {
    let resolveStop!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const start = vi.fn((_device: string) => Promise.resolve());
    const onApplyFailed = vi.fn();
    const coordinator = createCaptureRestartCoordinator({
      stop,
      start,
      onApplyFailed,
    });

    coordinator.requestRestart("device-A");
    coordinator.requestRestart("device-B");

    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();

    resolveStop();
    await flush();
    await flush();

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("device-B");
    expect(onApplyFailed).not.toHaveBeenCalled();
    expect(coordinator.isBusy()).toBe(false);
    expect(coordinator.getPending()).toBeNull();
  });

  it("applies a mid-startup request after the in-flight start settles", async () => {
    let resolveStop!: () => void;
    let resolveStartA!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const start = vi.fn(async (device: string) => {
      if (device === "device-A") {
        await new Promise<void>((resolve) => {
          resolveStartA = resolve;
        });
      }
    });
    const coordinator = createCaptureRestartCoordinator({ stop, start });

    coordinator.requestRestart("device-A");
    await flush();
    resolveStop();
    await flush();
    expect(start).toHaveBeenCalledWith("device-A");

    // Second device arrives while A is still starting.
    coordinator.requestRestart("device-B");
    expect(coordinator.getPending()).toBe("device-B");
    expect(start).toHaveBeenCalledTimes(1);

    resolveStartA();
    await flush();
    // Drain stops again then starts B.
    resolveStop();
    await flush();
    await flush();

    expect(start.mock.calls.map((call) => call[0])).toEqual(["device-A", "device-B"]);
    expect(coordinator.isBusy()).toBe(false);
  });

  it("does not leave the latest config unstarted after a stale start rejection", async () => {
    let resolveStop!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const start = vi.fn((device: string) => {
      if (device === "device-A") {
        return Promise.reject(new Error("stale start failed"));
      }
      return Promise.resolve();
    });
    const onApplyFailed = vi.fn();
    const coordinator = createCaptureRestartCoordinator({
      stop,
      start,
      onApplyFailed,
    });

    coordinator.requestRestart("device-A");
    await flush();
    // Supersede A while stop is still open so A is never started.
    coordinator.requestRestart("device-B");
    resolveStop();
    await flush();
    await flush();

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("device-B");
    expect(onApplyFailed).not.toHaveBeenCalled();

    // A failing start that is still the newest request must surface.
    let resolveStop2!: () => void;
    stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStop2 = resolve;
        }),
    );
    start.mockImplementation(() => Promise.reject(new Error("latest start failed")));
    coordinator.requestRestart("device-C");
    await flush();
    resolveStop2();
    await flush();
    await flush();

    expect(start).toHaveBeenLastCalledWith("device-C");
    expect(onApplyFailed).toHaveBeenCalledTimes(1);
    expect(onApplyFailed.mock.calls[0]?.[0]).toBe("device-C");
    expect(String(onApplyFailed.mock.calls[0]?.[1])).toContain("latest start failed");
  });

  it("cancelPending prevents a planned start after an explicit stop", async () => {
    let resolveStop!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const start = vi.fn(() => Promise.resolve());
    const coordinator = createCaptureRestartCoordinator({ stop, start });

    coordinator.requestRestart("device-A");
    await flush();
    coordinator.cancelPending();
    resolveStop();
    await flush();
    await flush();

    expect(start).not.toHaveBeenCalled();
    expect(coordinator.isBusy()).toBe(false);
  });
});
