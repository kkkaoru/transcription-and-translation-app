// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge } from "../core/bridge";
import { DEFAULT_RUNTIME_STATUS } from "../core/defaults";
import { clearDiagnosticEvents, getDiagnosticEvents } from "../core/diagnostics";
import type { PipelineDropSignal } from "../core/dropDiagnostics";
import { clearPipelineDrops, snapshotPipelineDrops } from "../core/dropDiagnostics";
import type { RuntimeStatus } from "../core/types";
import { I18nProvider } from "../i18n/I18nProvider";
import { MainApp } from "./MainApp";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("MainApp pipeline-drop notice wiring", () => {
  let container: HTMLDivElement;
  let root: Root;
  let pipelineDropListener: ((drop: PipelineDropSignal) => void) | undefined;
  let runtimeListener: ((status: RuntimeStatus) => void) | undefined;
  let runtimeListeners: Array<(status: RuntimeStatus) => void> = [];

  const noticeText = (): string =>
    Array.from(container.querySelectorAll<HTMLElement>('.notice[role="status"]'))
      .map((element) => element.textContent ?? "")
      .find((text) => text.trim().length > 0) ?? "";

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("caption-bridge.ui-locale.v1", "ja");
    localStorage.setItem("kotoba-beacon.debug.panelOpen", "0");
    clearPipelineDrops();
    clearDiagnosticEvents();
    pipelineDropListener = undefined;
    runtimeListener = undefined;
    runtimeListeners = [];
    vi.spyOn(bridge, "listenPipelineDrops").mockImplementation((callback) => {
      pipelineDropListener = callback;
      return Promise.resolve(() => undefined);
    });
    vi.spyOn(bridge, "listenRuntime").mockImplementation((callback) => {
      runtimeListener = callback;
      runtimeListeners.push(callback);
      return Promise.resolve(() => undefined);
    });
    vi.spyOn(bridge, "getStatus").mockResolvedValue({ ...DEFAULT_RUNTIME_STATUS });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    vi.restoreAllMocks();
    clearPipelineDrops();
    clearDiagnosticEvents();
    localStorage.clear();
    container.remove();
  });

  it("keeps a fatal runtime error visible and does not consume the drop gate", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MainApp />
        </I18nProvider>,
      );
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });
    expect(runtimeListener).toBeTypeOf("function");
    expect(pipelineDropListener).toBeTypeOf("function");

    const fatalStatus: RuntimeStatus = {
      ...DEFAULT_RUNTIME_STATUS,
      status: "error",
      lastError: "persistent ASR failure",
    };
    await act(async () => {
      runtimeListener?.(fatalStatus);
      await Promise.resolve();
    });
    expect(noticeText()).toContain("persistent ASR failure");

    await act(async () => {
      pipelineDropListener?.({ source: "translation", reason: "retired", count: 1 });
      await Promise.resolve();
    });
    expect(noticeText()).toContain("persistent ASR failure");
    expect(noticeText()).not.toContain("source=translation");
    expect(snapshotPipelineDrops().bySource["translation"]).toBe(1);

    const healthyStatus: RuntimeStatus = {
      ...DEFAULT_RUNTIME_STATUS,
      status: "capturing",
      lastError: null,
    };
    await act(async () => {
      runtimeListener?.(healthyStatus);
      await Promise.resolve();
      pipelineDropListener?.({ source: "translation", reason: "retired", count: 1 });
      await Promise.resolve();
    });
    expect(noticeText()).toContain("source=translation");

    await act(async () => {
      pipelineDropListener?.({ source: "audio", reason: "silence-gate", count: 1 });
      await Promise.resolve();
    });
    expect(noticeText()).not.toContain("source=audio");
    expect(
      getDiagnosticEvents().filter((event) => event.message === "Pipeline drop signal"),
    ).toHaveLength(3);
  });

  it("clears the drop aggregate when a new capture session starts", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MainApp />
        </I18nProvider>,
      );
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });
    expect(pipelineDropListener).toBeTypeOf("function");

    await act(async () => {
      pipelineDropListener?.({ source: "translation", reason: "retired", count: 2 });
      await Promise.resolve();
    });
    expect(snapshotPipelineDrops().bySource["translation"]).toBe(2);

    const startButton = container.querySelector<HTMLButtonElement>(".primary-button");
    expect(startButton).not.toBeNull();
    await act(async () => {
      startButton?.click();
      await Promise.resolve();
    });

    expect(snapshotPipelineDrops()).toEqual({
      total: 0,
      bySource: {},
      byReason: {},
      signals: [],
    });
  });

  it("keeps the notice/drop bridge wired through a StrictMode mount", async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <I18nProvider>
            <MainApp />
          </I18nProvider>
        </StrictMode>,
      );
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    expect(container.querySelector(".app-shell")).not.toBeNull();
    expect(runtimeListener).toBeTypeOf("function");
    expect(pipelineDropListener).toBeTypeOf("function");

    const healthyStatus: RuntimeStatus = {
      ...DEFAULT_RUNTIME_STATUS,
      status: "capturing",
      lastError: null,
    };
    await act(async () => {
      runtimeListener?.(healthyStatus);
      pipelineDropListener?.({ source: "translation", reason: "retired", count: 1 });
      await Promise.resolve();
    });

    expect(noticeText()).toContain("source=translation");
    expect(snapshotPipelineDrops().bySource).toEqual({ translation: 1 });
  });

  it("ignores a delayed runtime event after the MainApp DOM is unmounted", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MainApp />
        </I18nProvider>,
      );
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });
    const staleRuntimeListener = runtimeListeners[0];
    expect(staleRuntimeListener).toBeTypeOf("function");

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    clearDiagnosticEvents();

    staleRuntimeListener?.({
      ...DEFAULT_RUNTIME_STATUS,
      status: "error",
      lastError: "late runtime event",
    });
    expect(getDiagnosticEvents().some((event) => event.message === "Runtime → error")).toBe(false);
  });

  it("hides in-app captions when native output is active", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MainApp />
        </I18nProvider>,
      );
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    expect(container.querySelector(".caption-line-source")).not.toBeNull();

    await act(async () => {
      runtimeListener?.({
        ...DEFAULT_RUNTIME_STATUS,
        nativeOutput: "syphon",
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="live-output-status"]')?.textContent).toContain(
      "Syphon に出力中",
    );
    expect(container.querySelector(".caption-line-source")).toBeNull();
    expect(container.querySelector(".native-output-canvas")).not.toBeNull();
  });

  it("hides in-app captions while transparent capture is open", async () => {
    vi.spyOn(bridge, "openTransparentCapture").mockResolvedValue(undefined);
    vi.spyOn(bridge, "closeTransparentCapture").mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <I18nProvider>
          <MainApp />
        </I18nProvider>,
      );
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-transparent-capture"]')
        ?.click();
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    expect(container.querySelector('[data-testid="live-output-status"]')?.textContent).toContain(
      "透過取り込みに出力中",
    );
    expect(container.querySelector(".caption-line-source")).toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="hide-transparent-capture"]')
        ?.click();
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    expect(container.querySelector('[data-testid="live-output-status"]')).toBeNull();
    expect(container.querySelector(".caption-line-source")).not.toBeNull();
  });
});
