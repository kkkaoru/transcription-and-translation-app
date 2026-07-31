// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDiagnosticEvents, getDiagnosticEvents } from "./diagnostics";
import {
  clearPipelineStageEvents,
  getLatestPipelineStageByName,
  getPipelineStageEvents,
  getUtteranceStageGroups,
  isPipelineStageName,
  isVerbosePipelineLogging,
  normalizePipelineStageEvent,
  pushPipelineStageEvent,
  setVerbosePipelineLogging,
  stageDisplayLabel,
  subscribePipelineStages,
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
      at: 200,
    });
    expect(snake).toMatchObject({
      stage: "normalize",
      utteranceId: "u2",
      modelId: "azookey-rust",
      inputSnippet: "raw",
      outputText: "正規化",
      durationMs: 5,
      ok: true,
    });
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
      inputSnippet: "こんにちは",
      outputText: "Hello",
      durationMs: 80,
      ok: true,
      at: 9,
    });
    expect(info).toHaveBeenCalled();
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
      at: 1,
    });
    pushPipelineStageEvent({
      stage: "normalize",
      utteranceId: "utt-a",
      modelId: "azookey-rust",
      inputSnippet: "あ",
      outputText: "あ",
      durationMs: 2,
      ok: true,
      at: 2,
    });
    pushPipelineStageEvent({
      stage: "translate",
      utteranceId: "utt-a",
      modelId: "hy-mt2-1.8b-gguf",
      inputSnippet: "あ",
      outputText: "A",
      durationMs: 20,
      ok: true,
      at: 3,
    });
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "utt-b",
      modelId: "parapper-ja",
      inputSnippet: "wav",
      outputText: "い",
      durationMs: 11,
      ok: true,
      at: 4,
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
  });
});
