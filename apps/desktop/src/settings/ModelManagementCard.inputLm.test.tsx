// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { ModelManagementCard } from "./ModelManagementCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const downloadModelMock = vi.fn();
const downloadInputLmModelMock = vi.fn();
const cancelModelDownloadMock = vi.fn();
const listModelStatusMock = vi.fn();
const listenDownloadProgressMock = vi.fn();

vi.mock("../core/bridge", () => ({
  bridge: {
    isDesktop: () => true,
    downloadModel: downloadModelMock,
    downloadInputLmModel: downloadInputLmModelMock,
    cancelModelDownload: cancelModelDownloadMock,
    listModelStatus: listModelStatusMock,
    listenDownloadProgress: listenDownloadProgressMock,
  },
  formatBridgeError: (error: unknown): string | undefined => {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    return undefined;
  },
}));

vi.mock("../core/diagnostics", () => ({
  pushDiagnosticEvent: vi.fn(),
}));

describe("ModelManagementCard input-LM download routing", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("caption-bridge.ui-locale.v1", "en");
    downloadModelMock.mockClear();
    downloadInputLmModelMock.mockClear();
    cancelModelDownloadMock.mockClear();
    listModelStatusMock.mockClear();
    listenDownloadProgressMock.mockClear();
    downloadModelMock.mockResolvedValue("input-n5-lm-v1");
    downloadInputLmModelMock.mockResolvedValue("/cache/input_n5_lm_v1");
    listModelStatusMock.mockResolvedValue([
      {
        modelId: "input-n5-lm-v1",
        status: "missing",
        installedBytes: null,
        expectedBytes: 120_372_659,
        lastError: null,
      },
    ]);
    listenDownloadProgressMock.mockResolvedValue(() => undefined);
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

  const renderCard = async (): Promise<void> => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ModelManagementCard />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    // Drain the initial listModelStatus + listenDownloadProgress promises.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("routes input-n5-lm-v1 to downloadInputLmModel, not downloadModel", async () => {
    await renderCard();

    // Find the download button for the input-n5-lm-v1 row.
    const rows = container.querySelectorAll<HTMLElement>(".download-row");
    const inputLmRow = Array.from(rows).find((row) =>
      row.querySelector(".download-row-meta")?.textContent?.includes("input-n5-lm-v1"),
    );
    expect(inputLmRow).toBeDefined();

    const downloadButton = inputLmRow?.querySelector<HTMLButtonElement>(
      "button.download-one-button",
    );
    expect(downloadButton).not.toBeNull();
    expect(downloadButton?.disabled).toBe(false);

    await act(async () => {
      downloadButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(downloadInputLmModelMock).toHaveBeenCalledTimes(1);
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("routes GGUF models to downloadModel, not downloadInputLmModel", async () => {
    listModelStatusMock.mockResolvedValue([
      {
        modelId: "zenz-v3.2-xsmall-gguf",
        status: "missing",
        installedBytes: null,
        expectedBytes: 20_970_304,
        lastError: null,
      },
    ]);

    await renderCard();

    const rows = container.querySelectorAll<HTMLElement>(".download-row");
    const ggufRow = Array.from(rows).find((row) =>
      row.querySelector(".download-row-meta")?.textContent?.includes("zenz-v3.2-xsmall-gguf"),
    );
    expect(ggufRow).toBeDefined();

    const downloadButton = ggufRow?.querySelector<HTMLButtonElement>("button.download-one-button");
    expect(downloadButton).not.toBeNull();

    await act(async () => {
      downloadButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(downloadModelMock).toHaveBeenCalledTimes(1);
    expect(downloadInputLmModelMock).not.toHaveBeenCalled();
  });

  it("shows the input-LM note when the input-LM model is listed", async () => {
    await renderCard();

    const note = container.querySelector(".download-section-note");
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("Input N5 LM");
  });

  it("does not show the input-LM note when the input-LM model is absent", async () => {
    listModelStatusMock.mockResolvedValue([
      {
        modelId: "zenz-v3.2-xsmall-gguf",
        status: "ready",
        installedBytes: 20_970_304,
        expectedBytes: 20_970_304,
        lastError: null,
      },
    ]);

    await renderCard();

    const note = container.querySelector(".download-section-note");
    expect(note).toBeNull();
  });
});
