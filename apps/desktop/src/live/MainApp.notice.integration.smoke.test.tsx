// @vitest-environment jsdom

import { act } from "react";
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
    vi.spyOn(bridge, "listenPipelineDrops").mockImplementation((callback) => {
      pipelineDropListener = callback;
      return Promise.resolve(() => undefined);
    });
    vi.spyOn(bridge, "listenRuntime").mockImplementation((callback) => {
      runtimeListener = callback;
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
    expect(getDiagnosticEvents().some((event) => event.message === "Pipeline drop surfaced")).toBe(
      true,
    );
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
});
