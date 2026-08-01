// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDiagnosticEvents, getDiagnosticEvents } from "./diagnostics";
import {
  clearPipelineStageEvents,
  DEBUG_PANEL_OPEN_STORAGE_KEY,
  getLatestPipelineStageByName,
  getPipelineStageEvents,
  getUtteranceStageGroups,
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

afterEach(() => {
  clearPipelineStageEvents();
  clearDiagnosticEvents();
  setVerbosePipelineLogging(false);
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

  it("notifies subscribers and supports verbose console + diagnostic logging", () => {
    const listener = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const unsubscribe = subscribePipelineStages(listener);

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
    expect(info).toHaveBeenCalledWith(
      "[pipeline:translate] ok 80ms",
      expect.stringContaining("model=hy-mt2-1.8b-gguf"),
    );
    expect(info).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("startedAt=920"));
    expect(info).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("endedAt=1000"));
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
    expect(readDebugPanelOpenPreference()).toBe(false);
    writeDebugPanelOpenPreference(true);
    expect(localStorage.getItem(DEBUG_PANEL_OPEN_STORAGE_KEY)).toBe("1");
    expect(readDebugPanelOpenPreference()).toBe(true);
    writeDebugPanelOpenPreference(false);
    expect(localStorage.getItem(DEBUG_PANEL_OPEN_STORAGE_KEY)).toBeNull();
    expect(readDebugPanelOpenPreference()).toBe(false);
  });
});
