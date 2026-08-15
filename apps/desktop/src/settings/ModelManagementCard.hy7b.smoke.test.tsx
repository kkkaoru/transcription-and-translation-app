// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { ModelManagementCard } from "./ModelManagementCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const listModelStatusMock = vi.fn();

vi.mock("../core/bridge", () => ({
  bridge: {
    isDesktop: () => true,
    downloadModel: vi.fn(),
    downloadInputLmModel: vi.fn(),
    cancelModelDownload: vi.fn(),
    listModelStatus: (...args: unknown[]) => listModelStatusMock(...args),
    listenDownloadProgress: vi.fn(async () => () => undefined),
  },
  formatBridgeError: (): undefined => undefined,
}));

vi.mock("../core/diagnostics", () => ({
  pushDiagnosticEvent: vi.fn(),
}));

describe("ModelManagementCard Hy-MT2 7B cost", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("caption-bridge.ui-locale.v1", "en");
    listModelStatusMock.mockReset();
    listModelStatusMock.mockResolvedValue([
      {
        modelId: "hy-mt2-7b-gguf",
        status: "missing",
        installedBytes: null,
        expectedBytes: 4_624_648_896,
        lastError: null,
      },
    ]);
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

  it("shows RSS and download cost on the 7B row before install", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ModelManagementCard />
        </I18nProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const cost = container.querySelector("[data-testid='hy-mt2-7b-cost']");
    expect(cost?.textContent).toContain("4.93GiB");
    expect(cost?.textContent).toContain("424ms");
    expect(cost?.textContent).toContain("53 tok/s");
    expect(cost?.textContent).toContain("4.6GB");
    expect(cost?.textContent).toContain("374s");
  });
});
