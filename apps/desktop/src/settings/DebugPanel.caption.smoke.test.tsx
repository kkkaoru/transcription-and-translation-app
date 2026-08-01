// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetStructuredLogForTests } from "../core/structuredLog";
import { I18nProvider } from "../i18n/I18nProvider";
import { DebugPanel } from "./DebugPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const bridgeMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getDebugInfo: vi.fn(),
  publishSourceCaption: vi.fn(),
}));

vi.mock("../core/bridge", () => ({
  bridge: {
    isDesktop: () => false,
    getConfig: bridgeMocks.getConfig,
    getDebugInfo: bridgeMocks.getDebugInfo,
    listModelStatus: async () => [],
    getUpdateStatus: async () => null,
    publishSourceCaption: bridgeMocks.publishSourceCaption,
    exportDebugLogs: async () => "browser-download-only.jsonl",
  },
  formatBridgeError: (error: unknown) =>
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined,
}));

vi.mock("../core/audio", () => ({
  enumerateAudioInputDevices: async () => [],
  getLastAudioCaptureDiagnostics: () => null,
}));

describe("DebugPanel recognition mode and test captions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("caption-bridge.ui-locale.v1", "en");
    localStorage.setItem("kotoba-beacon.debug.panelOpen", "1");
    bridgeMocks.getConfig.mockReset();
    bridgeMocks.getDebugInfo.mockReset();
    bridgeMocks.publishSourceCaption.mockReset();
    bridgeMocks.getConfig.mockResolvedValue({ recognitionMode: "web-speech" });
    bridgeMocks.getDebugInfo.mockResolvedValue({
      platform: "browser",
      config: { recognitionMode: "web-speech" },
    });
    bridgeMocks.publishSourceCaption.mockResolvedValue(undefined);
    __resetStructuredLogForTests();
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
    __resetStructuredLogForTests();
    localStorage.clear();
  });

  const renderAndFlush = async (): Promise<void> => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("shows the active recognition mode and reports a successful test caption", async () => {
    let resolvePublish: (() => void) | undefined;
    bridgeMocks.publishSourceCaption.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePublish = resolve;
        }),
    );
    await renderAndFlush();

    expect(container.querySelector('[data-testid="debug-recognition-mode"]')?.textContent).toBe(
      "web-speech",
    );
    const button = container.querySelector(
      '[data-testid="debug-test-caption-publish"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(button?.disabled).toBe(true);
    const runningState = container.querySelector('[data-testid="debug-test-caption-state"]');
    expect(runningState?.textContent).toBe("Publishing…");
    expect(runningState?.getAttribute("data-status")).toBe("running");
    resolvePublish?.();
    await act(async () => {
      await Promise.resolve();
    });

    expect(bridgeMocks.publishSourceCaption).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceText: "これはデバッグ用のテスト字幕です。",
        stage: "source",
        isFinal: true,
      }),
    );
    expect(container.querySelector('[data-testid="debug-test-caption-notice"]')?.textContent).toBe(
      "Test caption published.",
    );
    expect(
      container
        .querySelector('[data-testid="debug-test-caption-state"]')
        ?.getAttribute("data-status"),
    ).toBe("success");
    expect(container.querySelector('[data-testid="debug-test-caption-error"]')).toBeNull();
  });

  it("shows an error when publishing the test caption fails", async () => {
    bridgeMocks.publishSourceCaption.mockRejectedValueOnce(new Error("caption path unavailable"));
    await renderAndFlush();

    await act(async () => {
      const button = container.querySelector(
        '[data-testid="debug-test-caption-publish"]',
      ) as HTMLButtonElement | null;
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="debug-test-caption-error"]')?.textContent,
    ).toContain("caption path unavailable");
    expect(
      container
        .querySelector('[data-testid="debug-test-caption-state"]')
        ?.getAttribute("data-status"),
    ).toBe("error");
    expect(container.querySelector('[data-testid="debug-test-caption-notice"]')).toBeNull();
  });
});
