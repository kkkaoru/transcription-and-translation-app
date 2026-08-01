// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeCaptionPayload } from "./caption-updates";
import {
  clearChunkTimingStats,
  createLatestWinsProcessor,
  getChunkTimingStats,
} from "./chunkQueue";
import { mergeConfig, migrateSilenceGateDb } from "./defaults";
import { pushDiagnosticEvent } from "./diagnostics";
import {
  clearCaptionDisplayTiming,
  getCaptionDisplayTimingStats,
  markCaptionDisplay,
  subscribeCaptionDisplayTiming,
} from "./display-timing";
import { clearInputLevelDb, setInputLevelDb, subscribeInputLevel } from "./input-level";
import {
  clearPipelineStageEvents,
  getPipelineStageEvents,
  getUtteranceStageGroups,
  groupStagesByUtterance,
  hydratePipelineStageEvents,
  normalizePipelineStageEvent,
  pushPipelineStageEvent,
  readDebugPanelOpenPreference,
  relativeStageOffsetMs,
  setVerbosePipelineLogging,
  stageDisplayLabel,
  subscribePipelineStages,
  writeDebugPanelOpenPreference,
} from "./pipelineStages";
import {
  __resetStructuredLogForTests,
  appendStructuredLog,
  downloadStructuredLogs,
  estimateInputBytes,
  getStructuredLogs,
  logPipelineStageEvent,
  normalizeLogLevel,
  redactSensitiveText,
  setLogLevel,
} from "./structuredLog";
import { computePreviewFitScale } from "./style";
import type { CaptionPayload, PipelineStageEvent } from "./types";

const stage = (overrides: Partial<PipelineStageEvent> = {}): PipelineStageEvent => ({
  stage: "asr",
  utteranceId: "u-1",
  modelId: "parapper-ja",
  inputSnippet: "wavBytes=32",
  outputText: "こんにちは",
  startedAt: 100,
  at: 120,
  durationMs: 20,
  ok: true,
  error: null,
  ...overrides,
});

const caption = (overrides: Partial<CaptionPayload> = {}): CaptionPayload => ({
  id: "edge-caption",
  sourceText: "source",
  translationText: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 100,
  receivedAt: 110,
  stage: "source",
  sequence: 0,
  isFinal: false,
  confidence: undefined,
  ...overrides,
});

afterEach(() => {
  clearPipelineStageEvents();
  clearCaptionDisplayTiming();
  clearChunkTimingStats();
  setVerbosePipelineLogging(false);
  __resetStructuredLogForTests();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("coverage edge cases for pipeline stages", () => {
  it("covers empty/native stage hydration and an already-set first-caption waiter", async () => {
    expect(hydratePipelineStageEvents(undefined)).toEqual([]);
    expect(hydratePipelineStageEvents([])).toEqual([]);

    // Fill the native ring, then hydrate one additional row to exercise the
    // bounded-history trim path used after a reconnect.
    for (let index = 0; index < 96; index += 1) {
      pushPipelineStageEvent(stage({ utteranceId: `hydrated-${index}`, at: index }));
    }
    expect(
      hydratePipelineStageEvents([stage({ utteranceId: "hydrated-overflow", at: 1_000 })]),
    ).toHaveLength(1);
    expect(getPipelineStageEvents()).toHaveLength(96);
    hydratePipelineStageEvents([
      stage({ utteranceId: "failed-hydration", ok: false, error: "fallback", at: 2_000 }),
      stage({ utteranceId: "same-time-late", startedAt: 120, at: 2_001 }),
      stage({ utteranceId: "same-time-early", startedAt: 110, at: 2_001 }),
      stage({ utteranceId: "same-time-first", startedAt: 100, at: 2_002 }),
      stage({ utteranceId: "same-time-second", startedAt: 100, at: 2_002 }),
    ]);

    let processor!: ReturnType<typeof createLatestWinsProcessor<number>>;
    processor = createLatestWinsProcessor<number>({
      process: async (_item, { whenFirstCaption }) => {
        processor.markFirstCaption();
        // The caption is already marked, so this resolves through the fast path.
        await whenFirstCaption();
      },
    });
    processor.enqueue(1);
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
  });

  it("covers unavailable browser audio globals and the base64 fallback error", async () => {
    vi.stubGlobal("navigator", undefined);
    await expect(
      import("./audio").then(({ openMicrophoneStream }) => openMicrophoneStream("default")),
    ).rejects.toMatchObject({
      code: "microphone-unavailable",
    });
    vi.stubGlobal("btoa", undefined);
    const { bytesToBase64 } = await import("./audio");
    expect(() => bytesToBase64(new Uint8Array([1]))).toThrow("base64 encoding is unavailable");
  });

  it("handles missing storage and storage failures without throwing", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readDebugPanelOpenPreference()).toBe(true);
    writeDebugPanelOpenPreference(true);
    setVerbosePipelineLogging(true);

    vi.unstubAllGlobals();
    const storage = globalThis.localStorage;
    vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(storage, "removeItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(readDebugPanelOpenPreference()).toBe(true);
    writeDebugPanelOpenPreference(true);
    setVerbosePipelineLogging(false);
  });

  it("normalizes malformed payloads and keeps the ring bounded", () => {
    expect(normalizePipelineStageEvent(null)).toBeNull();
    expect(normalizePipelineStageEvent({})).toBeNull();
    const malformed = normalizePipelineStageEvent({
      stage: "custom",
      utterance_id: "snake-id",
      model_id: 42,
      duration_ms: Number.NaN,
      ended_at: Number.NaN,
      started_at: Number.NaN,
      input_snippet: "raw",
      output_text: "text",
      error: "  ",
      ok: false,
    });
    expect(malformed).toMatchObject({
      stage: "custom",
      utteranceId: "snake-id",
      modelId: "",
      durationMs: 0,
      inputSnippet: "raw",
      outputText: "text",
      error: null,
      ok: false,
    });
    expect(normalizePipelineStageEvent({ stage: "asr", modelId: "m", at: 4 })).toMatchObject({
      utteranceId: expect.stringMatching(/^stage-/),
    });
    expect(pushPipelineStageEvent(null)).toBeNull();

    setLogLevel("error");
    for (let index = 0; index < 100; index += 1) {
      pushPipelineStageEvent(
        stage({
          stage: index % 2 === 0 ? "custom" : "asr",
          utteranceId: `edge-${index}`,
          modelId: "",
          inputSnippet: "",
          outputText: "",
        }),
      );
    }
    expect(getPipelineStageEvents()).toHaveLength(96);
    expect(getUtteranceStageGroups(0)).toEqual([]);
    expect(stageDisplayLabel("custom")).toBe("custom");
  });

  it("covers optional diagnostic fields and deterministic grouping", () => {
    setLogLevel("trace");
    setVerbosePipelineLogging(true);
    const listener = vi.fn();
    const unsubscribe = subscribePipelineStages(listener);
    const failed = pushPipelineStageEvent(
      stage({
        stage: "custom",
        utteranceId: "group",
        modelId: "",
        inputSnippet: "",
        outputText: "",
        ok: false,
        error: "failed",
        startedAt: 0,
        at: 0,
        durationMs: 0,
      }),
    );
    expect(failed?.ok).toBe(false);
    expect(listener).toHaveBeenCalled();
    unsubscribe();

    const events = [
      stage({ stage: "custom", utteranceId: "same", at: 100, startedAt: 0 }),
      stage({ stage: "normalize", utteranceId: "same", at: 100, startedAt: 0 }),
      stage({ stage: "translate", utteranceId: "same", at: 100, startedAt: 0 }),
    ];
    const groups = groupStagesByUtterance(events, 1);
    expect(groups[0]?.stages).toHaveLength(3);
    const group = groups[0];
    if (!group) throw new Error("expected group");
    const firstEvent = events[0];
    if (!firstEvent) throw new Error("expected first event");
    expect(relativeStageOffsetMs(firstEvent, group)).toBe(0);
    expect(relativeStageOffsetMs(stage({ startedAt: Number.NaN }), group)).toBe(0);
  });
});

describe("coverage edge cases for structured logs", () => {
  it("supports unavailable storage, empty records, and ring eviction", () => {
    vi.stubGlobal("localStorage", undefined);
    setLogLevel("error");
    vi.unstubAllGlobals();
    const storage = globalThis.localStorage;
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    setLogLevel("warn");

    appendStructuredLog({ level: "error", message: "   " });
    expect(getStructuredLogs({ limit: 1 })[0]?.message).toBe("(empty)");
    for (let index = 0; index < 405; index += 1) {
      appendStructuredLog({ level: "debug", message: `row-${index}` });
    }
    expect(getStructuredLogs()).toHaveLength(400);
    expect(getStructuredLogs({ maxLevel: "error", limit: 0 })).toEqual([]);
  });

  it("handles stage warning paths, empty verbose samples, and document-less export", () => {
    setLogLevel("error");
    expect(normalizeLogLevel(42 as unknown as string, "warn")).toBe("warn");
    const warning = logPipelineStageEvent(
      stage({ ok: false, error: null, at: 0, inputSnippet: "", outputText: "" }),
    );
    expect(warning.level).toBe("warn");
    const verbose = logPipelineStageEvent(
      stage({ ok: true, at: 0, inputSnippet: "", outputText: "" }),
      { verbose: true },
    );
    expect(verbose.level).toBe("info");
    expect(verbose.fields["inputSnippet"]).toBeNull();
    expect(verbose.fields["outputText"]).toBeNull();

    vi.stubGlobal("document", undefined);
    expect(downloadStructuredLogs()).toBeNull();
    vi.unstubAllGlobals();
    const click = vi.fn();
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
      if (tag === "a") Object.defineProperty(element, "click", { value: click });
      return element as HTMLElement;
    });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:edge"), revokeObjectURL: vi.fn() });
    expect(downloadStructuredLogs("json", { maxLevel: "error", limit: 2 })).toMatch(/\.json$/);
    expect(click).toHaveBeenCalled();
  });

  it("uses the UTF-8 fallback and tolerates a missing console", () => {
    const encoder = globalThis.TextEncoder;
    vi.stubGlobal("TextEncoder", undefined);
    expect(estimateInputBytes("日本語")).toBeGreaterThan(0);
    vi.stubGlobal("console", undefined);
    appendStructuredLog({ level: "error", message: "quiet console" });
    vi.stubGlobal("TextEncoder", encoder);
  });

  it("covers malformed structured fields and duplicate input-level snapshots", () => {
    appendStructuredLog({
      level: "info",
      source: "frontend",
      message: "edge",
      stage: 42 as unknown as string,
      chunkId: "   ",
      error: 0 as unknown as string,
    });
    expect(redactSensitiveText("   ")).toBeNull();
    setInputLevelDb(Number.NaN);
    setInputLevelDb(-42);
    setInputLevelDb(-42);
    pushDiagnosticEvent("info", 42 as unknown as string, "   " as unknown as string, {
      mirrorStructured: false,
    });
    pushDiagnosticEvent("error", null as unknown as string, undefined, {
      mirrorStructured: true,
    });
  });

  it("isolates display and input-level listener failures", () => {
    const stopDisplay = subscribeCaptionDisplayTiming(() => {
      throw new Error("display listener failed");
    });
    markCaptionDisplay(caption({ id: "listener-display", sourceText: "x" }));
    stopDisplay();

    const stopInput = subscribeInputLevel(() => {
      throw new Error("input listener failed");
    });
    setInputLevelDb(-41);
    stopInput();
    clearInputLevelDb();
  });
});

describe("coverage edge cases for display timing", () => {
  it("covers undefined stage labels and non-finite style/config fallbacks", () => {
    setVerbosePipelineLogging(true);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    markCaptionDisplay(
      caption({
        id: "translation-without-stage",
        stage: undefined,
        sourceText: "",
        translationText: "translated",
        isFinal: true,
      }),
    );
    expect(getCaptionDisplayTimingStats().utteranceId).toBe("translation-without-stage");

    expect(migrateSilenceGateDb(undefined)).toBe(-50);
    expect(migrateSilenceGateDb(Number.NaN)).toBe(-50);
    const merged = mergeConfig({ audio: { silenceGateDb: Number.NaN } });
    expect(merged.audio.silenceGateDb).toBe(-50);
    expect(computePreviewFitScale(100, 100, Number.NaN, Number.NaN)).toBe(1);
    expect(computePreviewFitScale(100, Number.NaN, 1280, 720)).toBe(1);
  });

  it("records invalid origins, translation-first paints, and map eviction", () => {
    setVerbosePipelineLogging(true);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const listener = vi.fn();
    const unsubscribe = subscribeCaptionDisplayTiming(listener);
    markCaptionDisplay(
      caption({ startedAt: Number.NaN, receivedAt: 0, stage: "source", sourceText: "first" }),
    );
    markCaptionDisplay(
      caption({
        id: "translation-first",
        startedAt: 0,
        receivedAt: Number.NaN,
        sourceText: "",
        translationText: "translated",
        stage: "translation",
        sequence: 1,
        isFinal: true,
      }),
    );
    markCaptionDisplay(
      caption({
        id: "final-source",
        stage: "source",
        isFinal: true,
        translationText: "final translation",
      }),
    );
    markCaptionDisplay(
      caption({
        id: "translation-with-source",
        stage: "translation",
        sourceText: "source too",
        translationText: "translated",
        isFinal: true,
      }),
    );
    setVerbosePipelineLogging(false);
    markCaptionDisplay(
      caption({
        id: "quiet-translation",
        stage: "translation",
        sourceText: "",
        translationText: "quiet",
        isFinal: true,
      }),
    );
    expect(getCaptionDisplayTimingStats().translationSinceSourcePaintMs).toBeNull();
    markCaptionDisplay(caption({ sourceText: "same-id-again" }));
    for (let index = 0; index < 34; index += 1) {
      markCaptionDisplay(caption({ id: `evict-${index}` }));
    }
    expect(info).toHaveBeenCalled();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});

describe("coverage edge cases for latest-wins queue", () => {
  it("handles inactive queues and publishes optional stats", async () => {
    const inactive = createLatestWinsProcessor({
      isActive: () => false,
      process: vi.fn(),
    });
    inactive.enqueue(1);
    expect(inactive.getStats().inFlight).toBe(false);

    let active = true;
    let contextRef: { whenFirstCaption: () => Promise<void> } | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onStatsChange = vi.fn();
    const processor = createLatestWinsProcessor<number>({
      isActive: () => active,
      onStatsChange,
      process: async (_item, context) => {
        contextRef = context;
        const first = context.whenFirstCaption();
        await first;
        await gate;
      },
    });
    processor.markFirstCaption();
    processor.enqueue(1);
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(true));
    await vi.waitFor(() => expect(contextRef).toBeDefined());
    const waitBeforePaint = contextRef?.whenFirstCaption();
    processor.markFirstCaption();
    await expect(waitBeforePaint).resolves.toBeUndefined();
    const waitAfterPaint = contextRef?.whenFirstCaption();
    await expect(waitAfterPaint).resolves.toBeUndefined();
    await vi.waitFor(() => expect(processor.getStats().lastFirstCaptionMs).not.toBeNull());
    processor.markFirstCaption();
    active = false;
    processor.enqueue(2);
    release();
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    expect(onStatsChange).toHaveBeenCalled();
  });

  it("resolves stale first-caption waiters and swallows process failures", async () => {
    let contextRef: { whenFirstCaption: () => Promise<void> } | undefined;
    const processor = createLatestWinsProcessor({
      process: async (_item, context) => {
        contextRef = context;
        await new Promise<void>(() => undefined);
      },
    });
    processor.enqueue(1);
    await vi.waitFor(() => expect(contextRef).toBeDefined());
    const currentContext = contextRef;
    if (!currentContext) throw new Error("expected process context");
    const pending = currentContext.whenFirstCaption();
    processor.reset();
    await expect(pending).resolves.toBeUndefined();
    await expect(currentContext.whenFirstCaption()).resolves.toBeUndefined();

    const failed = createLatestWinsProcessor({
      process: () => Promise.reject(new Error("expected")),
    });
    failed.enqueue(1);
    await vi.waitFor(() => expect(failed.getStats().inFlight).toBe(false));
    expect(getChunkTimingStats().inFlight).toBe(false);
  });
});

describe("coverage edge cases for small pure helpers", () => {
  it("normalizes non-boolean legacy audio flags", () => {
    const merged = mergeConfig({
      audio: {
        noiseSuppression: "legacy" as unknown as boolean,
        adaptiveNoiseFloor: 1 as unknown as boolean,
      },
    });
    expect(merged.audio.noiseSuppression).toBe(true);
    expect(merged.audio.adaptiveNoiseFloor).toBe(true);
  });

  it("drops same-time stale captions and preserves a source for empty placeholders", () => {
    const current = caption({ id: "same-time", startedAt: 100, receivedAt: 20 });
    const stale = caption({
      id: "older",
      sourceText: "older",
      startedAt: 100,
      receivedAt: 19,
    });
    expect(mergeCaptionPayload(current, stale)).toBeNull();
    const placeholder = caption({
      id: "placeholder",
      sourceText: "",
      translationText: "diagnostic translation",
      startedAt: 200,
      receivedAt: 200,
    });
    expect(mergeCaptionPayload(current, placeholder)).toBe(current);
    const translatedNew = caption({
      id: "translated-new",
      sourceText: "new",
      translationText: "new translation",
      startedAt: 200,
      receivedAt: 200,
    });
    expect(mergeCaptionPayload(current, translatedNew)?.translationText).toBe("new translation");
  });
});
