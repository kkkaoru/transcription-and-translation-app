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
      durationMs: 42.6,
      ok: true,
      error: null,
      startedAt: 57,
      at: 100,
    });
    expect(camel).toMatchObject({
      stage: "asr",
      utteranceId: "u1",
      modelId: "parapper-ja",
      inputSnippet: "wavBytes=12",
      outputText: "こんにちは",
      durationMs: 43,
      ok: true,
      error: null,
      startedAt: 57,
      at: 100,
    });

    const snake = normalizePipelineStageEvent({
      stage: "normalize",
      utterance_id: "u2",
      model_id: "azookey-rust",
      input_snippet: "raw",
      output_text: "正規化",
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
});
