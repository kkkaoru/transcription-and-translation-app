// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPipelineStageEvents,
  isVerbosePipelineLogging,
  pushPipelineStageEvent,
  setVerbosePipelineLogging,
} from "../core/pipelineStages";
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
      debug: { verboseLogging: false },
    }),
    saveConfig: async () => undefined,
    getDebugInfo: async () => ({
      platform: "browser",
      version: "test",
      logDir: "/tmp/kotoba-logs",
      env: { pkgVersion: "0.0.0", platform: "browser", arch: "test" },
      runtimeStatus: { status: "idle", nativeOutput: "unsupported", backendReachable: false },
      modelSummary: { ready: 0, total: 0 },
      debug: { verboseLogging: false, logDir: "/tmp/kotoba-logs" },
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
        debug: { verboseLogging: false },
      },
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
    setVerbosePipelineLogging(false);
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
    setVerbosePipelineLogging(false);
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
});
