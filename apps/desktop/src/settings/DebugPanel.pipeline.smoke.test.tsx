// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCaptionDisplayTiming, markCaptionDisplay } from "../core/display-timing";
import { clearPipelineDrops, recordPipelineDrop } from "../core/dropDiagnostics";
import {
  clearPipelineStageEvents,
  isVerbosePipelineLogging,
  pushPipelineStageEvent,
  setVerbosePipelineLogging,
} from "../core/pipelineStages";
import {
  __resetStructuredLogForTests,
  appendStructuredLog,
  formatLogsAsJson,
  formatLogsAsJsonl,
  getLogLevel,
  getStructuredLogs,
  setLogLevel,
} from "../core/structuredLog";
import { I18nProvider } from "../i18n/I18nProvider";
import { DebugPanel } from "./DebugPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("../core/bridge", () => ({
  bridge: {
    isDesktop: () => false,
    getConfig: async () => ({
      schemaVersion: 1,
      language: { source: "ja", target: "en" },
      endpoint: {
        mode: "local",
        baseUrl: "http://127.0.0.1:8765",
        transcriptionPath: "/v1/audio/transcriptions",
        chatPath: "/v1/chat/completions",
        timeoutMs: 18_000,
      },
      models: {
        asr: "parapper-ja",
        normalizer: "azookey-rust",
        translator: "hy-mt2-1.8b-gguf",
        paths: {},
      },
      audio: { chunkMs: 1200, silenceGateDb: -45, sampleRate: 16000, inputDeviceId: "default" },
      overlay: {
        width: 1920,
        height: 1080,
        order: "source-first",
        captionXPercent: 50,
        captionYPercent: 88,
        gapPx: 8,
      },
      debug: { verboseLogging: false, logLevel: "info" },
    }),
    saveConfig: async () => undefined,
    exportDebugLogs: async () => "/tmp/kotoba-logs/export.jsonl",
    getDebugInfo: async () => ({
      platform: "browser",
      version: "test",
      logDir: "/tmp/kotoba-logs",
      env: { pkgVersion: "0.0.0", platform: "browser", arch: "test" },
      runtimeStatus: { status: "idle", nativeOutput: "unsupported", backendReachable: false },
      modelSummary: { ready: 0, total: 0 },
      debug: { verboseLogging: false, logLevel: "info", logDir: "/tmp/kotoba-logs" },
      config: {
        audio: { chunkMs: 1200, silenceGateDb: -45, sampleRate: 16000, inputDeviceId: "default" },
        overlay: {
          width: 1920,
          height: 1080,
          order: "source-first",
          captionXPercent: 50,
          captionYPercent: 88,
          gapPx: 8,
        },
        debug: { verboseLogging: false, logLevel: "info" },
      },
      translationRetired: 4,
    }),
    listModelStatus: async () => [],
  },
}));

vi.mock("../core/audio", () => ({
  enumerateAudioInputDevices: async () => [],
  getLastAudioCaptureDiagnostics: () => null,
}));

describe("DebugPanel pipeline stages", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    // Match other smoke tests: UI copy assertions use Japanese strings.
    localStorage.setItem("caption-bridge.ui-locale.v1", "ja");
    clearPipelineStageEvents();
    clearPipelineDrops();
    clearCaptionDisplayTiming();
    setVerbosePipelineLogging(false);
    __resetStructuredLogForTests();
    setLogLevel("info");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    clearPipelineStageEvents();
    clearPipelineDrops();
    clearCaptionDisplayTiming();
    setVerbosePipelineLogging(false);
    __resetStructuredLogForTests();
    localStorage.clear();
  });

  const openPanel = async (): Promise<void> => {
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    await act(async () => {
      if (!details) {
        throw new Error("details missing");
      }
      // Controlled <details open={open}> — set open + fire toggle so React state follows.
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      // fetchInfo() finishes after open; drain microtasks so backend verbose=false applies first.
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("shows independent ASR / normalizer / translator sections and utterance stage rows", async () => {
    recordPipelineDrop("audio", 2, "silence-gate");
    recordPipelineDrop("chunk-queue", 1, "pending-replaced");
    recordPipelineDrop("parapper-output-queue", 3, "stale-final-cursor");
    const base = Date.now();
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "utt-1",
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
      utteranceId: "utt-1",
      modelId: "azookey-rust",
      inputSnippet: "こんにちは",
      outputText: "こんにちは",
      durationMs: 3,
      ok: true,
      startedAt: base + 120,
      at: base + 123,
    });
    pushPipelineStageEvent({
      stage: "translate",
      utteranceId: "utt-1",
      modelId: "hy-mt2-1.8b-gguf",
      inputSnippet: "こんにちは",
      outputText: "Hello",
      durationMs: 90,
      ok: true,
      startedAt: base + 123,
      at: base + 213,
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    await openPanel();

    const stages = container.querySelector('[data-testid="debug-pipeline-stages"]');
    expect(stages).not.toBeNull();
    expect(container.querySelector('[data-testid="debug-stage-asr"]')?.textContent).toContain(
      "こんにちは",
    );
    expect(container.querySelector('[data-testid="debug-stage-asr"]')?.textContent).toMatch(
      /120\s*ms/,
    );
    expect(container.querySelector('[data-testid="debug-stage-asr-start"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="debug-stage-asr-end"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="debug-stage-normalize"]')?.textContent).toMatch(
      /3\s*ms/,
    );
    expect(container.querySelector('[data-testid="debug-stage-translate"]')?.textContent).toContain(
      "Hello",
    );
    // Recent utterances list a row per stage (name, elapsed ms, output text).
    const utterance = container.querySelector('[data-testid="debug-utterance-row"]');
    expect(utterance?.getAttribute("data-utterance-id")).toBe("utt-1");
    expect(container.querySelector('[data-testid="debug-stage-row-asr"]')?.textContent).toMatch(
      /120\s*ms/,
    );
    expect(container.querySelector('[data-testid="debug-stage-row-asr"]')?.textContent).toContain(
      "t+0 ms",
    );
    expect(container.querySelector('[data-testid="debug-stage-row-asr"]')?.textContent).toContain(
      "こんにちは",
    );
    expect(
      container.querySelector('[data-testid="debug-stage-row-translate"]')?.textContent,
    ).toContain("Hello");
    expect(
      container.querySelector('[data-testid="debug-stage-row-translate"]')?.textContent,
    ).toMatch(/t\+123\s*ms/);
    expect(container.querySelector('[data-testid="debug-stage-feed"]')?.textContent).toContain(
      "parapper-ja",
    );
    expect(container.querySelector('[data-testid="debug-chunk-timing"]')).not.toBeNull();
    const drops = container.querySelector('[data-testid="debug-pipeline-drops"]');
    expect(drops).not.toBeNull();
    expect(
      drops?.querySelector('[data-testid="debug-pipeline-drop-total"]')?.textContent,
    ).toContain("6");
    for (const source of ["audio", "chunk-queue", "parapper-output-queue", "translation"]) {
      expect(
        drops?.querySelector(`[data-testid="debug-pipeline-drop-source-${source}"]`),
      ).not.toBeNull();
    }
    expect(
      drops?.querySelector('[data-testid="debug-translation-retired"]')?.textContent,
    ).toContain("4");
    expect(
      drops?.querySelector('[data-testid="debug-pipeline-drop-reasons"]')?.textContent,
    ).toContain("silence-gate");
    expect(container.textContent).toContain("詳細ログ");
    expect(container.textContent).toContain("発話ごとの段階行");
    expect(container.querySelector('[data-testid="debug-enable-hint"]')?.textContent).toContain(
      "デバッグ情報",
    );
    expect(container.querySelector(".debug-verbose-toggle input")).not.toBeNull();
  });

  it("updates stage cards continuously when new pipeline events arrive while open", async () => {
    // Seed one stage so the pipeline section mounts as soon as the panel opens
    // (combined diagnostics require at least one non-empty feed before fetchInfo).
    pushPipelineStageEvent({
      stage: "normalize",
      utteranceId: "utt-seed",
      modelId: "azookey-rust",
      inputSnippet: "seed",
      outputText: "シード",
      durationMs: 1,
      ok: true,
      at: Date.now() - 1_000,
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    await openPanel();

    expect(container.querySelector('[data-testid="debug-stage-asr"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="debug-stage-asr"]')?.textContent).toContain(
      "まだこの段階の出力はありません",
    );

    await act(async () => {
      pushPipelineStageEvent({
        stage: "asr",
        utteranceId: "utt-live",
        modelId: "parapper-ja",
        inputSnippet: "wavBytes=99",
        outputText: "ライブ更新",
        durationMs: 55,
        ok: true,
        at: Date.now(),
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="debug-stage-asr"]')?.textContent).toContain(
      "ライブ更新",
    );
    expect(container.querySelector('[data-testid="debug-stage-asr"]')?.textContent).toMatch(
      /55\s*ms/,
    );
    expect(container.querySelector('[data-testid="debug-utterance-row"]')?.textContent).toContain(
      "utt-live",
    );
  });

  it("reflects verbose pipeline logging and persists kotoba-beacon.debug.verbosePipeline", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    await openPanel();

    const toggle = container.querySelector(
      ".debug-verbose-toggle input",
    ) as HTMLInputElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.checked).toBe(false);
    expect(localStorage.getItem("kotoba-beacon.debug.verbosePipeline")).toBeNull();
    // Open state is persisted so debug mode can remain on across reloads.
    expect(localStorage.getItem("kotoba-beacon.debug.panelOpen")).toBe("1");

    // Panel subscribes to pipeline stage store while open; enabling verbose updates the checkbox.
    await act(async () => {
      setVerbosePipelineLogging(true);
      await Promise.resolve();
    });

    expect(localStorage.getItem("kotoba-beacon.debug.verbosePipeline")).toBe("1");
    expect(isVerbosePipelineLogging()).toBe(true);
    expect(
      (container.querySelector(".debug-verbose-toggle input") as HTMLInputElement | null)?.checked,
    ).toBe(true);
  });

  it("restores previously open debug panel without requiring a re-toggle", async () => {
    localStorage.setItem("kotoba-beacon.debug.panelOpen", "1");
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "utt-restore",
      modelId: "parapper-ja",
      inputSnippet: "wav",
      outputText: "復元",
      durationMs: 10,
      ok: true,
      startedAt: Date.now() - 10,
      at: Date.now(),
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const details = container.querySelector("details");
    expect(details?.open).toBe(true);
    expect(container.querySelector('[data-testid="debug-stage-asr"]')?.textContent).toContain(
      "復元",
    );
  });

  it("shows structured log rows and log-level control", async () => {
    appendStructuredLog({
      level: "info",
      source: "frontend",
      message: "capture started",
      chunkId: "chunk-1",
      durationMs: 12,
      inputBytes: 4096,
    });
    appendStructuredLog({
      level: "error",
      source: "backend",
      stage: "asr",
      message: "stage asr failed",
      chunkId: "chunk-2",
      error: "HTTP 422",
      durationMs: 33,
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    await openPanel();

    expect(container.querySelector('[data-testid="debug-log-level"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="debug-structured-logs"]')).not.toBeNull();
    const rows = container.querySelectorAll('[data-testid="debug-structured-log-row"]');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("capture started");
    expect(container.textContent).toContain("HTTP 422");
    expect(container.querySelector('[data-testid="debug-export-jsonl"]')).not.toBeNull();
  });

  it("filters structured log rows when the log level select changes", async () => {
    appendStructuredLog({
      level: "error",
      source: "backend",
      stage: "asr",
      message: "only-error-row",
      error: "boom",
      durationMs: 9,
    });
    appendStructuredLog({
      level: "info",
      source: "frontend",
      message: "only-info-row",
      durationMs: 4,
    });
    appendStructuredLog({
      level: "debug",
      source: "frontend",
      stage: "normalize",
      message: "only-debug-row",
      durationMs: 2,
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    await openPanel();

    // Default threshold is info → error + info, not debug.
    expect(container.textContent).toContain("only-error-row");
    expect(container.textContent).toContain("only-info-row");
    expect(container.textContent).not.toContain("only-debug-row");

    const select = container.querySelector(
      '[data-testid="debug-log-level"]',
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    if (!select) {
      throw new Error("log level select missing");
    }

    await act(async () => {
      select.value = "error";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(getLogLevel()).toBe("error");
    expect(container.textContent).toContain("only-error-row");
    expect(container.textContent).not.toContain("only-info-row");
    expect(container.textContent).not.toContain("only-debug-row");
    const errorRows = container.querySelectorAll(
      '[data-testid="debug-structured-log-row"][data-log-level="error"]',
    );
    expect(errorRows.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      select.value = "debug";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(getLogLevel()).toBe("debug");
    expect(container.textContent).toContain("only-error-row");
    expect(container.textContent).toContain("only-info-row");
    expect(container.textContent).toContain("only-debug-row");
  });

  it("exports parseable JSON and JSONL from the current structured log buffer", async () => {
    appendStructuredLog({
      level: "info",
      source: "frontend",
      message: "export-json-row",
      chunkId: "c-export",
      durationMs: 11,
      inputBytes: 128,
      epochMs: 1_700_000_000_000,
    });
    appendStructuredLog({
      level: "warn",
      source: "backend",
      stage: "translate",
      message: "export-jsonl-row",
      error: "slow",
      durationMs: 220,
      epochMs: 1_700_000_000_200,
    });

    const json = formatLogsAsJson(getStructuredLogs());
    const parsed = JSON.parse(json) as Array<{ message: string; durationMs: number | null }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((row) => row.message === "export-json-row")).toBe(true);
    expect(parsed.some((row) => row.message === "export-jsonl-row" && row.durationMs === 220)).toBe(
      true,
    );

    const jsonl = formatLogsAsJsonl(getStructuredLogs());
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const row = JSON.parse(line) as { message: string };
      expect(typeof row.message).toBe("string");
    }
    // JSONL is chronological (oldest first).
    expect(JSON.parse(lines[0] ?? "{}").message).toBe("export-json-row");
    expect(JSON.parse(lines[lines.length - 1] ?? "{}").message).toBe("export-jsonl-row");

    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    await openPanel();

    expect(container.querySelector('[data-testid="debug-export-json"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="debug-export-jsonl"]')).not.toBeNull();
    expect(
      (container.querySelector('[data-testid="debug-export-jsonl"]') as HTMLButtonElement | null)
        ?.disabled,
    ).toBe(false);
  });

  it("renders per-stage start/end/error fields with elapsed ms for latency diagnosis", async () => {
    const base = 1_700_000_111_000;
    pushPipelineStageEvent({
      stage: "asr",
      utteranceId: "utt-latency",
      modelId: "parapper-ja",
      inputSnippet: "wavBytes=8192",
      outputText: "レイテンシ検証",
      durationMs: 180,
      ok: true,
      startedAt: base,
      at: base + 180,
    });
    pushPipelineStageEvent({
      stage: "normalize",
      utteranceId: "utt-latency",
      modelId: "azookey-rust",
      inputSnippet: "レイテンシ検証",
      outputText: "レイテンシ検証",
      durationMs: 4,
      ok: true,
      startedAt: base + 180,
      at: base + 184,
    });
    pushPipelineStageEvent({
      stage: "translate",
      utteranceId: "utt-latency",
      modelId: "hy-mt2-1.8b-gguf",
      inputSnippet: "レイテンシ検証",
      outputText: "",
      durationMs: 450,
      ok: false,
      error: "gateway timeout",
      startedAt: base + 184,
      at: base + 634,
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    await openPanel();

    expect(container.querySelector('[data-testid="debug-stage-asr-ms"]')?.textContent).toMatch(
      /180\s*ms/,
    );
    expect(
      container.querySelector('[data-testid="debug-stage-normalize-ms"]')?.textContent,
    ).toMatch(/4\s*ms/);
    expect(
      container.querySelector('[data-testid="debug-stage-translate-ms"]')?.textContent,
    ).toMatch(/450\s*ms/);
    expect(container.querySelector('[data-testid="debug-stage-asr-start"]')?.textContent).not.toBe(
      "—",
    );
    expect(container.querySelector('[data-testid="debug-stage-asr-end"]')?.textContent).not.toBe(
      "—",
    );
    expect(container.querySelector('[data-testid="debug-stage-translate"]')?.textContent).toContain(
      "gateway timeout",
    );
    expect(container.querySelector('[data-testid="debug-stage-translate"]')?.className).toContain(
      "is-error",
    );
    expect(
      container.querySelector('[data-testid="debug-stage-row-translate"]')?.textContent,
    ).toContain("gateway timeout");
  });

  it("shows normalized-source and translation display delay in the timing panel", async () => {
    setVerbosePipelineLogging(true);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(2_000).mockReturnValueOnce(2_350).mockReturnValue(2_350);
    markCaptionDisplay({
      id: "utt-display",
      sourceText: "正規化結果",
      translationText: "",
      sourceLanguage: "ja",
      targetLanguage: "en",
      startedAt: 1_400,
      receivedAt: 1_900,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    markCaptionDisplay({
      id: "utt-display",
      sourceText: "正規化結果",
      translationText: "Normalized result",
      sourceLanguage: "ja",
      targetLanguage: "en",
      startedAt: 1_400,
      receivedAt: 2_300,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    await openPanel();

    const timing = container.querySelector('[data-testid="debug-chunk-timing"]');
    expect(timing?.textContent).toContain("正規化結果→表示");
    expect(timing?.textContent).toContain("600 ms");
    expect(timing?.textContent).toContain("翻訳イベント→表示");
    expect(timing?.textContent).toContain("50 ms");
    expect(timing?.textContent).toContain("原文表示→翻訳表示");
    expect(timing?.textContent).toContain("350 ms");
  });
});
