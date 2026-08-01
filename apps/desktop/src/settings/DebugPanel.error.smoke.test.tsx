// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushDiagnosticEvent } from "../core/diagnostics";
import { I18nProvider } from "../i18n/I18nProvider";
import { DebugPanel } from "./DebugPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const bridgeMocks = vi.hoisted(() => ({
  getDebugInfo: vi.fn(),
}));

vi.mock("../core/bridge", () => ({
  bridge: {
    isDesktop: () => true,
    getDebugInfo: bridgeMocks.getDebugInfo,
    listModelStatus: async () => [],
    getUpdateStatus: async () => null,
    getConfig: async () => ({ debug: { verboseLogging: false, logLevel: "info" } }),
    saveConfig: async () => undefined,
    exportDebugLogs: async () => "browser-download-only.jsonl",
  },
  formatBridgeError: (error: unknown) =>
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined,
}));

vi.mock("../core/audio", () => ({
  enumerateAudioInputDevices: async () => [],
  getLastAudioCaptureDiagnostics: () => null,
}));

describe("DebugPanel refresh failures", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("caption-bridge.ui-locale.v1", "en");
    localStorage.setItem("kotoba-beacon.debug.panelOpen", "1");
    bridgeMocks.getDebugInfo.mockReset();
    bridgeMocks.getDebugInfo.mockRejectedValue(new Error("native gateway offline"));
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
    localStorage.clear();
  });

  it("leaves the panel usable after a native refresh failure without retrying forever", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <DebugPanel />
        </I18nProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(bridgeMocks.getDebugInfo).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="debug-panel"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "native gateway offline",
    );
    expect(container.textContent).toContain("debug refresh failed");
    expect(container.textContent).not.toContain("Loading…");

    await act(async () => {
      pushDiagnosticEvent("error", "late runtime error", "listener remained live");
      await Promise.resolve();
    });
    expect(container.textContent).toContain("late runtime error");
  });
});
