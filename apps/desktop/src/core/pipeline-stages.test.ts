// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDiagnosticEvents, getDiagnosticEvents } from "./diagnostics";
import {
  clearPipelineStageEvents,
  DEBUG_PANEL_OPEN_STORAGE_KEY,
  getLatestPipelineStageByName,
  getPipelineStageEvents,
  getUtteranceStageGroups,
  hydratePipelineStageEvents,
  isPipelineStageName,
  isVerbosePipelineLogging,
  normalizePipelineStageEvent,
  pushPendingCaptionTranslationStage,
  pushPipelineStageEvent,
  readDebugPanelOpenPreference,
  relativeStageOffsetMs,
  setVerbosePipelineLogging,
  stageDisplayLabel,
  subscribePipelineStages,
  writeDebugPanelOpenPreference,
} from "./pipelineStages";
import { __resetStructuredLogForTests, getStructuredLogs, setLogLevel } from "./structuredLog";

afterEach(() => {
  clearPipelineStageEvents();
  clearDiagnosticEvents();
  setVerbosePipelineLogging(false);
  __resetStructuredLogForTests();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("pipeline stage events", () => {
  it("normalizes camelCase and snake_case payloads", () => {
    const camel = normalizePipelineStageEvent({
      stage: "asr",
      utteranceId: "u1",
      modelId: "parapper-ja",
      inputSnippet: "wavBytes=12",
      outputText: "こんにちは",
      surfaceText: "今日は",
      durationMs: 42.6,
      ok: true,
      error: null,
      startedAt: 57,
      at: 100,
      captureGeneration: 3,
    });
    expect(camel).toMatchObject({
      stage: "asr",
      utteranceId: "u1",
      modelId: "parapper-ja",
      inputSnippet: "wavBytes=12",
      outputText: "こんにちは",
      surfaceText: "今日は",
      durationMs: 43,
      ok: true,
      error: null,
      startedAt: 57,
      at: 100,
      captureGeneration: 3,
    });
    expect(camel?.asrLatency).toBeUndefined();

    const withLatency = normalizePipelineStageEvent({
      stage: "asr",
      utteranceId: "u-at",
      outputText: "きょうは",
      ok: true,
      at: 40,
      startedAt: 10,
      caption_latency: {},
      speech_start_at: 1,
      first_partial_at: 3,
    });
    expect(withLatency?.asrLatency).toEqual({
      speech_start_at: 1,
      asr_dispatch_at: null,
      first_partial_at: 3,
      asr_final_at: null,
    });

    const snake = normalizePipelineStageEvent({
      stage: "normalize",
      utterance_id: "u2",
      model_id: "azookey-rust",
      input_snippet: "raw",
      output_text: "正規化",
      surface_text: "表面",
      duration_ms: 5,
      ok: true,
      started_at: 195,
      at: 200,
    });
    expect(snake).toMatchObject({
      stage: "normalize",
      utteranceId: "u2",
      modelId: "azookey-rust",
      inputSnippet: "raw",
      outputText: "正規化",
      surfaceText: "表面",
      durationMs: 5,
      startedAt: 195,
      ok: true,
    });

    // Missing startedAt is derived from end - duration.
    const derived = normalizePipelineStageEvent({
      stage: "translate",
      utteranceId: "u3",
      durationMs: 20,
      at: 500,
      ok: true,
    });
    expect(derived?.startedAt).toBe(480);
  });

  it("treats error fields as failed stages", () => {
    const failed = normalizePipelineStageEvent({
      stage: "translate",
      utteranceId: "u3",
      inputSnippet: "こんにちは",
      outputText: "",
      durationMs: 12,
      ok: true,
      error: "gateway down",
      at: 1,
    });
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toBe("gateway down");
  });

  it("stores newest-first and keeps latest-by-stage", () => {
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "a",
      inputSnippet: "wav",
      outputText: "いち",
      durationMs: 10,
      ok: true,
      at: 1,
    });
    pushPipelineStageEvent({
      stage: "normalize",
      utteranceId: "a",
      inputSnippet: "いち",
      outputText: "一",
      durationMs: 2,
      ok: true,
      at: 2,
    });
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "b",
      inputSnippet: "wav2",
      outputText: "に",
      durationMs: 11,
      ok: true,
      at: 3,
    });

    const events = getPipelineStageEvents();
    expect(events[0]?.utteranceId).toBe("b");
    expect(getLatestPipelineStageByName("asr")?.outputText).toBe("に");
    expect(getLatestPipelineStageByName("normalize")?.outputText).toBe("一");
    expect(getLatestPipelineStageByName("translate")).toBeNull();
  });

  it("records a retained caption translation as a synthetic translate stage", () => {
    const event = pushPendingCaptionTranslationStage(
      {
        id: "utterance-retained",
        sourceText: "",
        translationText: "Recovered translation",
        sourceLanguage: "ja",
        targetLanguage: "en",
        startedAt: 100,
        receivedAt: 145,
      },
      "元の発話",
    );

    expect(event).toMatchObject({
      stage: "translate",
      utteranceId: "utterance-retained",
      modelId: "frontend-pending-translation",
      inputSnippet: "元の発話",
      outputText: "Recovered translation",
      startedAt: 100,
      at: 145,
      durationMs: 45,
      ok: true,
    });
    expect(getLatestPipelineStageByName("translate")).toEqual(event);
    expect(
      pushPendingCaptionTranslationStage({
        id: "",
        sourceText: "",
        translationText: "ignored",
        sourceLanguage: "ja",
        targetLanguage: "en",
        startedAt: 0,
        receivedAt: 0,
      }),
    ).toBeNull();
  });

  it("hydrates backend stage history without duplicating live events", () => {
    const live = {
      stage: "normalize",
      utteranceId: "history-1",
      modelId: "azookey-rust",
      inputSnippet: "かな",
      outputText: "仮名",
      durationMs: 3,
      startedAt: 100,
      at: 103,
      ok: true,
    };
    pushPipelineStageEvent(live);

    const hydrated = hydratePipelineStageEvents([
      live,
      {
        stage: "asr",
        utterance_id: "history-1",
        model_id: "parapper-ja",
        input_snippet: "wavBytes=64",
        output_text: "かな",
        duration_ms: 14,
        started_at: 86,
        at: 100,
        ok: true,
      },
    ]);

    expect(hydrated).toHaveLength(2);
    expect(getPipelineStageEvents()).toHaveLength(2);
    expect(getPipelineStageEvents()[0]?.stage).toBe("normalize");
    expect(getPipelineStageEvents()[1]?.stage).toBe("asr");

    // Re-reading the same native snapshot is idempotent and does not append a
    // second copy of the normalize row.
    hydratePipelineStageEvents([live]);
    expect(getPipelineStageEvents()).toHaveLength(2);

    // A stale native snapshot must not make an older normalize row appear as
    // the latest card after a newer live event has already arrived.
    pushPipelineStageEvent({
      ...live,
      outputText: "仮名更新",
      startedAt: 200,
      at: 203,
    });
    hydratePipelineStageEvents([{ ...live, outputText: "仮名古い", at: 103 }]);
    expect(getLatestPipelineStageByName("normalize")?.outputText).toBe("仮名更新");
  });

  it("notifies subscribers and supports verbose structured + diagnostic logging", () => {
    const listener = vi.fn();
    // Successes are always logged at info level. Verbose flag controls payload detail (I/O samples).
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const unsubscribe = subscribePipelineStages(listener);

    setLogLevel("trace");
    setVerbosePipelineLogging(true);
    expect(isVerbosePipelineLogging()).toBe(true);
    expect(listener).toHaveBeenCalled();
    expect(localStorage.getItem("kotoba-beacon.debug.verbosePipeline")).toBe("1");

    pushPipelineStageEvent({
      stage: "translate",
      utteranceId: "u",
      modelId: "hy-mt2-1.8b-gguf",
      inputSnippet: "こんにちは",
      outputText: "Hello",
      durationMs: 80,
      ok: true,
      at: 1_000,
    });
    expect(info).toHaveBeenCalled();
    const structured = getStructuredLogs({ maxLevel: "trace" });
    expect(structured[0]?.stage).toBe("translate");
    expect(structured[0]?.level).toBe("info");
    expect(structured[0]?.fields["modelId"]).toBe("hy-mt2-1.8b-gguf");
    expect(structured[0]?.fields["outputText"]).toBe("Hello");
    expect(structured[0]?.durationMs).toBe(80);
    expect(getDiagnosticEvents()[0]?.message).toContain("translate");

    setVerbosePipelineLogging(false);
    expect(localStorage.getItem("kotoba-beacon.debug.verbosePipeline")).toBeNull();
    expect(isVerbosePipelineLogging()).toBe(false);
    unsubscribe();
  });

  it("exposes stage name helpers for UI labels", () => {
    expect(isPipelineStageName("asr")).toBe(true);
    expect(isPipelineStageName("source")).toBe(false);
    expect(stageDisplayLabel("asr")).toContain("parapper");
    expect(stageDisplayLabel("normalize")).toContain("azookey");
    expect(stageDisplayLabel("translate")).toContain("HY-MT2");
  });

  it("groups stages by utterance with total duration", () => {
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "utt-a",
      modelId: "parapper-ja",
      inputSnippet: "wav",
      outputText: "あ",
      durationMs: 10,
      ok: true,
      startedAt: 1000,
      at: 1010,
    });
    pushPipelineStageEvent({
      stage: "normalize",
      utteranceId: "utt-a",
      modelId: "azookey-rust",
      inputSnippet: "あ",
      outputText: "あ",
      durationMs: 2,
      ok: true,
      startedAt: 1010,
      at: 1012,
    });
    pushPipelineStageEvent({
      stage: "translate",
      utteranceId: "utt-a",
      modelId: "hy-mt2-1.8b-gguf",
      inputSnippet: "あ",
      outputText: "A",
      durationMs: 20,
      ok: true,
      startedAt: 1012,
      at: 1032,
    });
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "utt-b",
      modelId: "parapper-ja",
      inputSnippet: "wav",
      outputText: "い",
      durationMs: 11,
      ok: true,
      startedAt: 2000,
      at: 2011,
    });

    const groups = getUtteranceStageGroups();
    expect(groups[0]?.utteranceId).toBe("utt-b");
    expect(groups[1]?.utteranceId).toBe("utt-a");
    expect(groups[1]?.totalDurationMs).toBe(32);
    expect(groups[1]?.stages.map((stage) => stage.stage)).toEqual([
      "asr",
      "normalize",
      "translate",
    ]);
    const groupA = groups[1];
    expect(groupA).toBeDefined();
    if (!groupA) {
      return;
    }
    const [asrStage, normalizeStage, translateStage] = groupA.stages;
    expect(asrStage).toBeDefined();
    expect(normalizeStage).toBeDefined();
    expect(translateStage).toBeDefined();
    if (!asrStage || !normalizeStage || !translateStage) {
      return;
    }
    expect(relativeStageOffsetMs(asrStage, groupA)).toBe(0);
    expect(relativeStageOffsetMs(normalizeStage, groupA)).toBe(10);
    expect(relativeStageOffsetMs(translateStage, groupA)).toBe(12);
  });

  it("persists debug panel open preference for development", () => {
    expect(readDebugPanelOpenPreference()).toBe(true);
    writeDebugPanelOpenPreference(true);
    expect(localStorage.getItem(DEBUG_PANEL_OPEN_STORAGE_KEY)).toBe("1");
    expect(readDebugPanelOpenPreference()).toBe(true);
    writeDebugPanelOpenPreference(false);
    expect(localStorage.getItem(DEBUG_PANEL_OPEN_STORAGE_KEY)).toBe("0");
    expect(readDebugPanelOpenPreference()).toBe(false);
  });

  it("shows successful stage completions in structured log at default info level (no verbose toggle needed)", () => {
    // Regression test: user opens debug panel with default settings (no level change, verbose=false)
    // and should see real per-stage activity in the structured log, not an empty feed.
    // Related to: 「デバッグモードで常に確認してください」 constraint.

    const base = Date.now();
    // Push a full asr→normalizer→translator sequence (all successful).
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "regression-seq-1",
      modelId: "parapper-ja",
      inputSnippet: "wavBytes=2048",
      outputText: "こんにちは",
      durationMs: 120,
      ok: true,
      startedAt: base,
      at: base + 120,
    });
    pushPipelineStageEvent({
      stage: "normalize",
      utteranceId: "regression-seq-1",
      modelId: "azookey-rust",
      inputSnippet: "こんにちは",
      outputText: "こんにちは",
      durationMs: 2,
      ok: true,
      startedAt: base + 120,
      at: base + 122,
    });
    pushPipelineStageEvent({
      stage: "translate",
      utteranceId: "regression-seq-1",
      modelId: "hy-mt2-1.8b-gguf",
      inputSnippet: "こんにちは",
      outputText: "Hello",
      durationMs: 90,
      ok: true,
      startedAt: base + 122,
      at: base + 212,
    });

    // Default settings: info level, no verbose toggle.
    expect(isVerbosePipelineLogging()).toBe(false);

    // With default info level, successful stages must be visible (not hidden at debug level).
    const logs = getStructuredLogs({ maxLevel: "info" });
    const successLogs = logs.filter(
      (l) => l.stage && ["asr", "normalize", "translate"].includes(l.stage) && l.level !== "error",
    );

    expect(successLogs).toHaveLength(3);
    expect(successLogs.map((l) => l.stage)).toEqual(
      expect.arrayContaining(["asr", "normalize", "translate"]),
    );

    // Each row must include elapsed ms.
    for (const log of successLogs) {
      expect(log.durationMs).toBeGreaterThan(0);
    }

    // ASR row details.
    const asrLog = successLogs.find((l) => l.stage === "asr");
    expect(asrLog).toBeDefined();
    expect(asrLog?.durationMs).toBe(120);
    expect(asrLog?.message).toContain("asr");
    expect(asrLog?.message).toContain("ok");

    // Normalizer row details.
    const normalizeLog = successLogs.find((l) => l.stage === "normalize");
    expect(normalizeLog?.durationMs).toBe(2);

    // Translator row details.
    const translateLog = successLogs.find((l) => l.stage === "translate");
    expect(translateLog?.durationMs).toBe(90);
  });

  it("handles invalid payloads gracefully", () => {
    expect(normalizePipelineStageEvent(null)).toBeNull();
    expect(normalizePipelineStageEvent(undefined)).toBeNull();
    expect(normalizePipelineStageEvent("string")).toBeNull();
    expect(normalizePipelineStageEvent(42)).toBeNull();
    expect(normalizePipelineStageEvent({})).toBeNull();
    expect(normalizePipelineStageEvent({ stage: null })).toBeNull();
    expect(normalizePipelineStageEvent({ stage: 123 })).toBeNull();
  });

  it("synthesizes stage IDs when utteranceId is missing", () => {
    const event1 = normalizePipelineStageEvent({
      stage: "asr",
      at: 100,
      ok: true,
    });
    expect(event1?.utteranceId).toMatch(/^stage-\d+-\d+$/);
  });

  it("handles non-finite and invalid durationMs", () => {
    const nonFinite = normalizePipelineStageEvent({
      stage: "translate",
      utteranceId: "u1",
      durationMs: NaN,
      at: 100,
      ok: true,
    });
    expect(nonFinite?.durationMs).toBe(0);

    const invalid = normalizePipelineStageEvent({
      stage: "translate",
      utteranceId: "u2",
      durationMs: "not-a-number",
      at: 100,
      ok: true,
    });
    expect(invalid?.durationMs).toBe(0);
  });

  it("rejects pushes and returns null when normalization fails", () => {
    const result1 = pushPipelineStageEvent(null);
    expect(result1).toBeNull();

    const result2 = pushPipelineStageEvent({ stage: null });
    expect(result2).toBeNull();

    expect(getPipelineStageEvents()).toHaveLength(0);
  });

  it("caps ring buffer at MAX_STAGE_EVENTS (96)", () => {
    // Push 97 events; the ring should keep only the last 96.
    for (let i = 0; i < 97; i++) {
      pushPipelineStageEvent({
        stage: "asr",
        utteranceId: `u-${i}`,
        inputSnippet: "wav",
        outputText: `text-${i}`,
        durationMs: 10,
        ok: true,
        at: i,
      });
    }

    const events = getPipelineStageEvents();
    expect(events).toHaveLength(96);
    // Oldest (newest-first) should be utterance 1, not 0.
    expect(events[events.length - 1]?.utteranceId).toBe("u-1");
    expect(events[0]?.utteranceId).toBe("u-96");
  });

  it("notifies listeners when an event is added", () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsubscribe1 = subscribePipelineStages(listener1);
    const unsubscribe2 = subscribePipelineStages(listener2);

    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "u1",
      inputSnippet: "wav",
      outputText: "text",
      durationMs: 10,
      ok: true,
      at: 100,
    });

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);

    unsubscribe1();
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "u2",
      inputSnippet: "wav",
      outputText: "text2",
      durationMs: 10,
      ok: true,
      at: 101,
    });

    expect(listener1).toHaveBeenCalledTimes(1); // No additional call.
    expect(listener2).toHaveBeenCalledTimes(2); // Called again.
    unsubscribe2();
  });

  it("recovers gracefully when a listener throws", () => {
    const throwingListener = vi.fn(() => {
      throw new Error("Listener error");
    });
    const goodListener = vi.fn();
    subscribePipelineStages(throwingListener);
    subscribePipelineStages(goodListener);

    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "u1",
      inputSnippet: "wav",
      outputText: "text",
      durationMs: 10,
      ok: true,
      at: 100,
    });

    // Both should be called despite the throw.
    expect(throwingListener).toHaveBeenCalled();
    expect(goodListener).toHaveBeenCalled();
  });

  it("hydrates from invalid inputs safely", () => {
    expect(hydratePipelineStageEvents(null)).toEqual([]);
    expect(hydratePipelineStageEvents("not-array")).toEqual([]);
    expect(hydratePipelineStageEvents(123)).toEqual([]);
    expect(hydratePipelineStageEvents([])).toEqual([]);
    expect(hydratePipelineStageEvents([null, {}, undefined])).toEqual([]);
  });

  it("sorts hydrated events chronologically by at/startedAt and respects tiebreakers", () => {
    // Two events with same `at` but different `startedAt`.
    hydratePipelineStageEvents([
      {
        stage: "normalize",
        utteranceId: "u1",
        startedAt: 100,
        at: 200,
        durationMs: 100,
        ok: true,
      },
      {
        stage: "asr",
        utteranceId: "u1",
        startedAt: 50,
        at: 200,
        durationMs: 150,
        ok: true,
      },
    ]);

    const events = getPipelineStageEvents();
    // After sort: asr (started 50) comes before normalize (started 100).
    expect(events[1]?.stage).toBe("asr");
    expect(events[0]?.stage).toBe("normalize");
  });

  it("deduplicates hydrated events by their identity signature", () => {
    const event = {
      stage: "asr",
      utteranceId: "u1",
      startedAt: 100,
      at: 200,
      durationMs: 100,
      modelId: "parapper-ja",
      inputSnippet: "wav",
      outputText: "text",
      ok: true,
    };

    hydratePipelineStageEvents([event]);
    expect(getPipelineStageEvents()).toHaveLength(1);

    // Hydrating the same event again should not create a duplicate.
    hydratePipelineStageEvents([event]);
    expect(getPipelineStageEvents()).toHaveLength(1);
  });

  it("caps hydrated buffer at MAX_STAGE_EVENTS", () => {
    // Create 97 distinct events for hydration.
    const events = Array.from({ length: 97 }, (_, i) => ({
      stage: "asr",
      utteranceId: `u-${i}`,
      startedAt: i * 100,
      at: i * 100 + 50,
      durationMs: 50,
      ok: true,
    }));

    hydratePipelineStageEvents(events);
    expect(getPipelineStageEvents()).toHaveLength(96);
  });

  it("groups stages by utterance with event sorting within groups", () => {
    // Create events with out-of-order arrival but should be sorted within groups.
    pushPipelineStageEvent({
      stage: "translate",
      utteranceId: "utt-mixed",
      modelId: "hy-mt2",
      inputSnippet: "text",
      outputText: "translation",
      durationMs: 20,
      ok: true,
      startedAt: 1012,
      at: 1032,
    });
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "utt-mixed",
      modelId: "parapper-ja",
      inputSnippet: "wav",
      outputText: "text",
      durationMs: 10,
      ok: true,
      startedAt: 1000,
      at: 1010,
    });

    const groups = getUtteranceStageGroups();
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.stages).toHaveLength(2);
    // Should be sorted: asr (started 1000) before translate (started 1012).
    expect(group?.stages[0]?.stage).toBe("asr");
    expect(group?.stages[1]?.stage).toBe("translate");
  });

  it("handles unknown stage names in groupStagesByUtterance with default ordering", () => {
    pushPipelineStageEvent({
      stage: "unknown-future-stage",
      utteranceId: "utt-future",
      inputSnippet: "data",
      outputText: "processed",
      durationMs: 5,
      ok: true,
      at: 3000,
    });
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "utt-future",
      inputSnippet: "wav",
      outputText: "text",
      durationMs: 10,
      ok: true,
      at: 2000,
    });

    const groups = getUtteranceStageGroups();
    const group = groups[0];
    expect(group?.stages).toHaveLength(2);
    // asr (order=0) should come before unknown (order=9).
    expect(group?.stages[0]?.stage).toBe("asr");
    expect(group?.stages[1]?.stage).toBe("unknown-future-stage");
  });

  it("handles tie-breaking in groupStagesByUtterance for events with identical at/startedAt", () => {
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "utt-tie",
      inputSnippet: "wav",
      outputText: "text",
      durationMs: 10,
      ok: true,
      startedAt: 1000,
      at: 1000,
    });
    pushPipelineStageEvent({
      stage: "normalize",
      utteranceId: "utt-tie",
      inputSnippet: "text",
      outputText: "normalized",
      durationMs: 2,
      ok: true,
      startedAt: 1000,
      at: 1000,
    });

    const groups = getUtteranceStageGroups();
    const group = groups[0];
    // asr (order=0) before normalize (order=1) even with identical timing.
    expect(group?.stages[0]?.stage).toBe("asr");
    expect(group?.stages[1]?.stage).toBe("normalize");
  });

  it("returns correct display labels for known and unknown stages", () => {
    expect(stageDisplayLabel("asr")).toBe("ASR (parapper)");
    expect(stageDisplayLabel("normalize")).toBe("Normalizer (azookey/zenz)");
    expect(stageDisplayLabel("translate")).toBe("Translator (HY-MT2)");
    expect(stageDisplayLabel("custom-stage")).toBe("custom-stage");
    expect(stageDisplayLabel("")).toBe("");
  });

  it("computes relative stage offset within an utterance group", () => {
    const event1 = {
      stage: "asr" as const,
      utteranceId: "utt",
      modelId: "parapper",
      inputSnippet: "wav",
      outputText: "text",
      startedAt: 1000,
      at: 1010,
      durationMs: 10,
      ok: true,
    };
    const event2 = {
      ...event1,
      stage: "normalize" as const,
      startedAt: 1010,
      at: 1012,
      durationMs: 2,
    };
    const group = {
      utteranceId: "utt",
      at: 1012,
      stages: [event1, event2],
      totalDurationMs: 12,
      ok: true,
    };

    expect(relativeStageOffsetMs(event1, group)).toBe(0);
    expect(relativeStageOffsetMs(event2, group)).toBe(10);
  });

  it("handles non-finite and zero origins in relativeStageOffsetMs", () => {
    const event = {
      stage: "asr" as const,
      utteranceId: "utt",
      modelId: "parapper",
      inputSnippet: "wav",
      outputText: "text",
      startedAt: 0,
      at: 10,
      durationMs: 10,
      ok: true,
    };
    const group = {
      utteranceId: "utt",
      at: 10,
      stages: [event],
      totalDurationMs: 10,
      ok: true,
    };

    expect(relativeStageOffsetMs(event, group)).toBe(0);
  });

  it("reads and writes debug panel open preference with localStorage", () => {
    expect(readDebugPanelOpenPreference()).toBe(true);
    writeDebugPanelOpenPreference(false);
    expect(readDebugPanelOpenPreference()).toBe(false);
    writeDebugPanelOpenPreference(true);
    expect(readDebugPanelOpenPreference()).toBe(true);
  });

  it("defaults to open when localStorage is unavailable", async () => {
    // Reset modules with stubbed localStorage.
    vi.stubGlobal("localStorage", undefined);
    const { readDebugPanelOpenPreference: readPref } = await import("./pipelineStages");
    expect(readPref()).toBe(true);
    vi.unstubAllGlobals();
  });

  it("catches localStorage errors gracefully during reads", () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Access denied");
    });
    expect(readDebugPanelOpenPreference()).toBe(true);
    getItemSpy.mockRestore();
  });

  it("catches localStorage errors gracefully during writes", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    // Should not throw.
    writeDebugPanelOpenPreference(false);
    expect(isVerbosePipelineLogging()).toBe(false);
    setItemSpy.mockRestore();
  });

  it("verbose logging persists to localStorage and survives errors", () => {
    setVerbosePipelineLogging(true);
    expect(localStorage.getItem("kotoba-beacon.debug.verbosePipeline")).toBe("1");

    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("Read-only");
    });
    setVerbosePipelineLogging(false);
    // In-memory flag should still be false despite the error.
    expect(isVerbosePipelineLogging()).toBe(false);
    removeItemSpy.mockRestore();
  });
});
