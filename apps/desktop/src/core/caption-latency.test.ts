import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captionLatencyJoinKey,
  clearCaptionLatency,
  getCaptionLatencyRevision,
  getCaptionLatencySpan,
  getCaptionLatencyStats,
  markCaptionConvertDone,
  markCaptionFirstPaint,
  markCaptionIpcReceived,
  markCaptionVisible,
  parseAsrLatencyTimestamps,
  parseNumericTurnId,
  setCaptionLatencyClockForTests,
  subscribeCaptionLatency,
} from "./caption-latency";
import { clearPipelineStageEvents, pushPipelineStageEvent } from "./pipelineStages";
import { __resetStructuredLogForTests, getStructuredLogs } from "./structuredLog";

afterEach(() => {
  setCaptionLatencyClockForTests(null);
  clearCaptionLatency();
  clearPipelineStageEvents();
  __resetStructuredLogForTests();
  vi.restoreAllMocks();
});

describe("caption latency spans", () => {
  it("joins desktop paints with ASR timestamps on turn_id", () => {
    let now = 10_000;
    setCaptionLatencyClockForTests(() => now);
    const turnId = captionLatencyJoinKey({ sessionId: "s1", turnSessionId: 2, turnId: 8 });

    markCaptionIpcReceived(turnId, {
      turnId: 8,
      turnSessionId: 2,
      asrLatency: {
        speech_start: 9_200,
        asr_dispatch: 9_240,
        first_partial: 9_800,
      },
    });
    now = 10_040;
    markCaptionFirstPaint(turnId);
    now = 10_080;
    markCaptionConvertDone(turnId, { at: 10_070, durationMs: 28 });
    now = 10_120;
    markCaptionVisible(turnId);

    expect(getCaptionLatencySpan(turnId)).toMatchObject({
      turn_id: turnId,
      numeric_turn_id: 8,
      turn_session_id: 2,
      ipc_or_event_received_at: 10_000,
      first_caption_paint_at: 10_040,
      convert_done_at: 10_070,
      convert_duration_ms: 28,
      visible_caption_at: 10_120,
      speech_start: 9_200,
      asr_dispatch: 9_240,
      first_partial: 9_800,
      speech_to_first_paint_ms: 840,
      ipc_to_first_paint_ms: 40,
      paint_to_visible_ms: 80,
    });
    expect(getCaptionLatencyStats()).toMatchObject({
      turnId,
      speechToFirstPaintMs: 840,
      ipcToFirstPaintMs: 40,
      paintToVisibleMs: 80,
      convertDurationMs: 28,
    });
    expect(getCaptionLatencyRevision()).toBeGreaterThan(0);
    const logs = getStructuredLogs({ maxLevel: "trace" });
    expect(logs.map((row) => row.message)).toEqual(["caption visible", "caption first paint"]);
    expect(logs.find((row) => row.message === "caption first paint")?.fields).toMatchObject({
      turn_id: 8,
      speech_start: 9_200,
      speech_to_first_paint_ms: 840,
      ipc_or_event_received_at: 10_000,
      first_caption_paint_at: 10_040,
    });
  });

  it("omits speech_to_first_paint_ms when speech_start is absent", () => {
    setCaptionLatencyClockForTests(() => 5_000);
    markCaptionIpcReceived("parapper:s:1:3", { turnId: 3 });
    markCaptionFirstPaint("parapper:s:1:3");
    expect(getCaptionLatencySpan("parapper:s:1:3")?.speech_to_first_paint_ms).toBeNull();
    expect(getCaptionLatencySpan("parapper:s:1:3")?.ipc_to_first_paint_ms).toBe(0);
  });

  it("keeps the first ipc receipt and fills final later", () => {
    let now = 1_000;
    setCaptionLatencyClockForTests(() => now);
    markCaptionIpcReceived("u-1", {
      asrLatency: { first_partial: 900 },
    });
    now = 1_500;
    markCaptionIpcReceived("u-1", {
      asrLatency: { final: 1_400, first_partial: 880 },
    });
    const span = getCaptionLatencySpan("u-1");
    expect(span?.ipc_or_event_received_at).toBe(1_000);
    expect(span?.first_partial).toBe(900);
    expect(span?.final).toBe(1_400);
  });

  it("records convert duration from the normalize stage without inventing ASR times", () => {
    setCaptionLatencyClockForTests(() => 8_000);
    markCaptionIpcReceived("u-convert");
    markCaptionConvertDone("u-convert", { at: 8_040, durationMs: 18.6 });
    expect(getCaptionLatencySpan("u-convert")).toMatchObject({
      convert_done_at: 8_040,
      convert_duration_ms: 19,
      speech_start: null,
    });
    markCaptionConvertDone("u-convert", { at: 9_000, durationMs: 99 });
    expect(getCaptionLatencySpan("u-convert")?.convert_duration_ms).toBe(19);
  });

  it("derives convert duration from ipc when duration is omitted", () => {
    let now = 2_000;
    setCaptionLatencyClockForTests(() => now);
    markCaptionIpcReceived("u-derived");
    now = 2_055;
    markCaptionConvertDone("u-derived");
    expect(getCaptionLatencySpan("u-derived")?.convert_duration_ms).toBe(55);
  });

  it("ignores preview and blank join keys", () => {
    expect(markCaptionIpcReceived("preview")).toBeNull();
    expect(markCaptionIpcReceived("   ")).toBeNull();
    expect(markCaptionFirstPaint("preview")).toBeNull();
    expect(markCaptionVisible("")).toBeNull();
    expect(markCaptionConvertDone("preview")).toBeNull();
    expect(getCaptionLatencySpan("preview")).toBeNull();
  });

  it("is a no-op when first paint or visible is already recorded", () => {
    let now = 3_000;
    setCaptionLatencyClockForTests(() => now);
    markCaptionFirstPaint("u-once");
    now = 3_100;
    markCaptionFirstPaint("u-once");
    markCaptionVisible("u-once");
    now = 3_200;
    markCaptionVisible("u-once");
    expect(getCaptionLatencySpan("u-once")?.first_caption_paint_at).toBe(3_000);
    expect(getCaptionLatencySpan("u-once")?.visible_caption_at).toBe(3_100);
    expect(getCaptionLatencySpan("u-once")?.paint_to_visible_ms).toBe(100);
  });

  it("parses sibling ASR timestamp fields and skips empty payloads", () => {
    expect(
      parseAsrLatencyTimestamps({
        speech_start: 10,
        asr_dispatch: 11,
        first_partial: 12,
        final: 13,
      }),
    ).toEqual({
      speech_start: 10,
      asr_dispatch: 11,
      first_partial: 12,
      final: 13,
    });
    expect(parseAsrLatencyTimestamps({ speech_start: 0, final: Number.NaN })).toBeUndefined();
    expect(parseNumericTurnId("parapper:s:1:9")).toBe(9);
    expect(parseNumericTurnId("utterance-hello")).toBeNull();
    expect(parseNumericTurnId("")).toBeNull();
  });

  it("evicts the oldest span after 32 turns", () => {
    setCaptionLatencyClockForTests(() => 1);
    for (let index = 0; index < 33; index += 1) {
      markCaptionIpcReceived(`turn-${index}`);
    }
    expect(getCaptionLatencySpan("turn-0")).toBeNull();
    expect(getCaptionLatencySpan("turn-32")).not.toBeNull();
  });

  it("notifies subscribers and recovers when one throws", () => {
    const throwing = vi.fn(() => {
      throw new Error("latency listener failed");
    });
    const ok = vi.fn();
    const stopThrowing = subscribeCaptionLatency(throwing);
    const stopOk = subscribeCaptionLatency(ok);
    setCaptionLatencyClockForTests(() => 4_000);
    markCaptionFirstPaint("u-sub");
    expect(throwing).toHaveBeenCalled();
    expect(ok).toHaveBeenCalled();
    stopThrowing();
    stopOk();
    markCaptionVisible("u-sub");
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("clears spans and stats", () => {
    setCaptionLatencyClockForTests(() => 6_000);
    markCaptionIpcReceived("u-clear");
    markCaptionFirstPaint("u-clear");
    clearCaptionLatency();
    expect(getCaptionLatencySpan("u-clear")).toBeNull();
    expect(getCaptionLatencyStats()).toMatchObject({
      turnId: null,
      speechToFirstPaintMs: null,
      ipcToFirstPaintMs: null,
      paintToVisibleMs: null,
      convertDurationMs: null,
      updatedAt: null,
    });
  });

  it("records convert_done from a successful normalize stage only", () => {
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "u-norm",
      modelId: "parapper-ja",
      inputSnippet: "きょうは",
      outputText: "きょうは",
      startedAt: 100,
      at: 140,
      durationMs: 40,
      ok: true,
    });
    expect(getCaptionLatencySpan("u-norm")).toBeNull();
    pushPipelineStageEvent({
      stage: "normalize",
      utteranceId: "u-norm",
      modelId: "azookey-rust",
      inputSnippet: "きょうは",
      outputText: "今日は",
      startedAt: 140,
      at: 155,
      durationMs: 15,
      ok: false,
      error: "timeout",
    });
    expect(getCaptionLatencySpan("u-norm")).toBeNull();
    pushPipelineStageEvent({
      stage: "normalize",
      utteranceId: "u-norm",
      modelId: "azookey-rust",
      inputSnippet: "きょうは",
      outputText: "今日は",
      startedAt: 140,
      at: 158,
      durationMs: 18,
      ok: true,
    });
    expect(getCaptionLatencySpan("u-norm")).toMatchObject({
      convert_done_at: 158,
      convert_duration_ms: 18,
    });
  });
});
