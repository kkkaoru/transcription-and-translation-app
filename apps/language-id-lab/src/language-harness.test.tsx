// Runs with Bun during test.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureStart: vi.fn(() => Promise.resolve()),
  captureStop: vi.fn(() => Promise.resolve()),
  warm: vi.fn(() => Promise.resolve()),
  release: vi.fn(() => Promise.resolve()),
  usage: vi.fn(() =>
    Promise.resolve({
      available: false,
      source: "containersUsageAdaptiveGroups",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      updatedAt: "2026-08-31T00:00:00.000Z",
      cpuSeconds: 0,
      memoryGibHours: 0,
      diskGbHours: 0,
      transmittedGb: 0,
      grossResourceUsd: 0,
      estimatedOverageUsd: 0,
      includedUsageApplied: false,
      prices: [
        {
          tier: "basic",
          vcpu: 0.25,
          memoryGib: 1,
          diskGb: 4,
          provisionedHourlyUsd: 0.010008,
          maximumHourlyUsd: 0.028008,
        },
        {
          tier: "standard",
          vcpu: 0.5,
          memoryGib: 4,
          diskGb: 8,
          provisionedHourlyUsd: 0.038016,
          maximumHourlyUsd: 0.074016,
        },
      ],
      detail: "Analytics token unavailable",
    }),
  ),
}));

vi.mock("./microphone-capture", () => ({
  MicrophoneCapture: class {
    public start = mocks.captureStart;
    public stop = mocks.captureStop;
  },
}));

vi.mock("./language-api", () => ({
  inferLanguage: vi.fn(),
  warmLanguageContainer: mocks.warm,
  releaseLanguageContainer: mocks.release,
}));

vi.mock("./usage-api", () => ({
  fetchContainerUsage: mocks.usage,
}));

import { LanguageHarness } from "./language-harness";

describe("LanguageHarness", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()].at(index) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value),
    };
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: () => Promise.resolve([]) },
    });
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows microphone meters and real inference controls without synthetic fixtures", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<LanguageHarness />));
    expect(container.querySelector(".hero-copy h1")?.textContent).toBe(
      "Speak. See the evidence change.",
    );
    expect(container.querySelectorAll("meter").length).toBe(2);
    expect(container.querySelectorAll(".posterior-card").length).toBe(2);
    expect(container.querySelectorAll(".diagnostic-card").length).toBe(3);
    expect(container.querySelector(".method-control select")?.children).toHaveLength(5);
    expect(container.querySelector(".microphone-control")).not.toBeNull();
    expect(container.querySelector(".timeline-chart")).not.toBeNull();
    const capturePanel = container.querySelector(".capture-panel");
    expect(capturePanel?.nextElementSibling?.classList.contains("voice-test-section")).toBe(true);
    expect(container.querySelector(".edge-status")).toBeNull();
    expect(container.querySelector(".hero-description")).toBeNull();
    expect(container.querySelector(".scenario-section")).toBeNull();
    expect(container.querySelector("footer")).toBeNull();

    const localeButtons = container.querySelectorAll(".language-switcher button");
    act(() => localeButtons.item(0).dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector(".hero-copy h1")?.textContent).toBe("話す。推論の変化を見る。");
    expect(window.localStorage.getItem("kotoba-language-id-lab-locale")).toBe("ja");

    act(() => root.unmount());
    container.remove();
  });

  it("warms the selected Container only after explicit microphone start", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<LanguageHarness />));
    expect(mocks.captureStart).not.toHaveBeenCalled();
    expect(mocks.warm).not.toHaveBeenCalled();

    const startButton = container.querySelector(".primary-button");
    await act(async () => startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(mocks.captureStart).toHaveBeenCalledTimes(1);
    expect(mocks.warm).toHaveBeenCalledTimes(1);
    expect(startButton?.textContent?.trim()).toBe("Stop and release");

    await act(async () => root.unmount());
    container.remove();
  });
});
