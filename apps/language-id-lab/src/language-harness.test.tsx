// Runs with Bun during test.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageHarness } from "./language-harness";

const stableLanguageCode = (container: HTMLElement): string | undefined =>
  container.querySelector(".stable-language .language-code")?.textContent ?? undefined;

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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not advance synthetic language state until the user starts a scenario", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(<LanguageHarness />));
    expect(stableLanguageCode(container)).toBe("unknown");
    expect(container.querySelector(".secondary-button")?.textContent).toContain("Run scenario");

    act(() => vi.advanceTimersByTime(8_000));
    expect(stableLanguageCode(container)).toBe("unknown");

    const localeButtons = container.querySelectorAll(".language-switcher button");
    act(() => localeButtons.item(0).dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector(".stable-header > span")?.textContent).toBe("現在の安定言語");
    expect(window.localStorage.getItem("kotoba-language-id-lab-locale")).toBe("ja");
    act(() => localeButtons.item(1).dispatchEvent(new MouseEvent("click", { bubbles: true })));

    act(() => {
      container
        .querySelector(".secondary-button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(1_600));
    expect(stableLanguageCode(container)).toBe("ja");

    act(() => vi.advanceTimersByTime(8_000));
    expect(stableLanguageCode(container)).toBe("ja");
    expect(container.querySelector(".secondary-button")?.textContent).toContain("Run again");

    act(() => root.unmount());
    container.remove();
  });
});
