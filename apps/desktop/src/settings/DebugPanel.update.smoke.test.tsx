// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { DebugPanel } from "./DebugPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("../core/bridge", () => ({
  bridge: {
    isDesktop: () => true,
    getConfig: async () => ({
      schemaVersion: 2,
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
      audio: {
        chunkMs: 900,
        silenceGateDb: -50,
        sampleRate: 16000,
        inputDeviceId: "default",
        noiseSuppression: true,
        autoGainControl: true,
        adaptiveNoiseFloor: true,
      },
      overlay: {
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        order: "source-first",
        captionXPercent: 50,
        captionYPercent: 86,
        gapPx: 8,
        safeAreaPx: 42,
      },
      debug: { verboseLogging: false, logLevel: "info" },
    }),
    saveConfig: async () => undefined,
    getDebugInfo: async () => ({
      platform: "macos",
      version: "0.1.1",
      env: { pkgVersion: "0.1.1", platform: "macos", arch: "aarch64" },
      config: { debug: { verboseLogging: false, logLevel: "info" } },
      runtimeStatus: { status: "idle", nativeOutput: "syphon", backendReachable: true },
      update: {
        status: "failed",
        currentVersion: "0.1.1",
        availableVersion: "0.1.2",
        checkedAt: "2026-08-01T00:00:00.000Z",
        error: "update failed token=secret",
        source: "https://updates.example.test/latest.json?token=secret",
        channel: "stable",
      },
      sidecars: [
        {
          id: "kotoba-inference-gateway",
          kind: "gateway",
          version: "0.1.0",
          versionSource: "build metadata",
          health: "healthy",
          healthUrl: "http://127.0.0.1:8765/health?token=secret",
          port: 8765,
          active: true,
          lastError: null,
          startedAt: null,
          switchResult: "relaunch-requested",
        },
      ],
    }),
    getUpdateStatus: async () => ({
      status: "failed",
      currentVersion: "0.1.1",
      availableVersion: "0.1.2",
      checkedAt: "2026-08-01T00:00:00.000Z",
      downloadedBytes: null,
      totalBytes: null,
      error: "update failed token=secret",
      source: "https://updates.example.test/latest.json?token=secret",
      channel: "stable",
    }),
    listModelStatus: async () => [],
  },
}));

vi.mock("../core/audio", () => ({
  enumerateAudioInputDevices: async () => [],
  getLastAudioCaptureDiagnostics: () => null,
}));

describe("DebugPanel updater/runtime diagnostics", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("caption-bridge.ui-locale.v1", "en");
    window.history.replaceState({}, "", "/debug?access_token=secret#fragment");
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
    window.history.replaceState({}, "", "/");
    localStorage.clear();
  });

  it("renders updater failure and sidecar health/version without query secrets", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    await act(async () => {
      if (!details) throw new Error("details missing");
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="debug-update-status"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="debug-update-state"]')?.textContent).toBe(
      "failed",
    );
    expect(container.querySelector('[data-testid="debug-sidecars"]')).not.toBeNull();
    expect(container.textContent).toContain("0.1.0");
    expect(container.textContent).toContain("relaunch-requested");
    expect(container.textContent).not.toContain("token=secret");
    expect(container.textContent).not.toContain("access_token=secret");
  });
});
