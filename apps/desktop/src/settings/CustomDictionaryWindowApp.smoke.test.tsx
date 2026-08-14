// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge } from "../core/bridge";
import type { CustomDictionaryEntry } from "../core/types";
import { I18nProvider } from "../i18n/I18nProvider";
import { CustomDictionaryView, CustomDictionaryWindowApp } from "./CustomDictionaryWindowApp";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const setInput = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("CustomDictionaryWindowApp", () => {
  let container: HTMLDivElement;
  let root: Root;
  const initial: CustomDictionaryEntry[] = [
    { id: "tokyo", reading: "とうきょう", word: "東京" },
    { id: "kyoto", reading: "きょうと", word: "京都" },
  ];

  beforeEach(() => {
    localStorage.setItem("caption-bridge.ui-locale.v1", "ja");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(bridge, "getCustomDictionary").mockResolvedValue(initial);
    vi.spyOn(bridge, "saveCustomDictionary").mockImplementation(async (entries) => entries);
    vi.spyOn(bridge, "reloadCustomDictionary").mockResolvedValue();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const renderApp = async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <CustomDictionaryWindowApp />
        </I18nProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("warns when saved entries cannot be used by the selected normalizer", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <CustomDictionaryView normalizer="zenz-v3.2-small-gguf" />
        </I18nProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector("[data-testid='custom-dictionary-normalizer-warning']"),
    ).not.toBeNull();
    expect(container.textContent).toContain("AzooKey を選択しているときだけ有効");

    act(() => {
      root.render(
        <I18nProvider>
          <CustomDictionaryView normalizer="azookey-rust" />
        </I18nProvider>,
      );
    });
    expect(
      container.querySelector("[data-testid='custom-dictionary-normalizer-warning']"),
    ).toBeNull();
  });

  it("loads entries and filters readings and words independently", async () => {
    await renderApp();
    expect(container.textContent).toContain("東京");
    expect(container.textContent).toContain("京都");

    const readingSearch = container.querySelector<HTMLInputElement>(
      '[data-testid="custom-dictionary-search-reading"]',
    );
    if (!readingSearch) throw new Error("reading search missing");
    await act(async () => setInput(readingSearch, "トウ"));
    expect(container.textContent).toContain("東京");
    expect(container.textContent).not.toContain("京都");

    await act(async () => setInput(readingSearch, ""));
    const wordSearch = container.querySelector<HTMLInputElement>(
      '[data-testid="custom-dictionary-search-word"]',
    );
    if (!wordSearch) throw new Error("word search missing");
    await act(async () => setInput(wordSearch, "京都"));
    expect(container.textContent).not.toContain("東京");
    expect(container.textContent).toContain("京都");
  });

  it("appends imported CSV rows and exports the current dictionary", async () => {
    await renderApp();
    const fileInput = container.querySelector<HTMLInputElement>(
      '[data-testid="custom-dictionary-import-input"]',
    );
    if (!fileInput) throw new Error("CSV input missing");
    const csvFile = { text: vi.fn(async () => "よみ,単語\nぶいあーるちゃっと,VRC\n") };
    Object.defineProperty(fileInput, "files", { configurable: true, value: [csvFile] });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("ぶいあーるちゃっと");
    expect(container.textContent).toContain("VRC");
    expect(container.textContent).toContain("1件を追記");

    const createObjectURL = vi.fn(() => "blob:dictionary");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const exportButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("CSVをエクスポート"),
    );
    await act(async () => exportButton?.click());
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:dictionary");
    expect(container.textContent).toContain("3件をCSVへエクスポート");
  });

  it("adds, edits, deletes, warns without blocking, and saves entries", async () => {
    await renderApp();
    const readingInput = container.querySelector<HTMLInputElement>(
      '[data-testid="custom-dictionary-reading"]',
    );
    const wordInput = container.querySelector<HTMLInputElement>(
      '[data-testid="custom-dictionary-word"]',
    );
    const form = readingInput?.closest("form");
    if (!readingInput || !wordInput || !form) throw new Error("dictionary form missing");

    act(() => {
      setInput(readingInput, "東京");
      setInput(wordInput, "Tokyo");
    });
    expect(container.textContent).toContain("保存はできます");

    await act(async () => setInput(readingInput, "ことばびーこん"));
    await act(async () => {
      form.requestSubmit();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("ことばびーこん");
    expect(container.textContent).toContain("Tokyo");

    const addedRow = Array.from(container.querySelectorAll("tbody tr")).find((row) =>
      row.textContent?.includes("ことばびーこん"),
    );
    const editButton = Array.from(addedRow?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("編集"),
    );
    await act(async () => editButton?.click());
    expect(readingInput.value).toBe("ことばびーこん");
    await act(async () => setInput(wordInput, "Kotoba Beacon"));
    await act(async () => form.requestSubmit());
    expect(container.textContent).toContain("Kotoba Beacon");

    const kyotoRow = Array.from(container.querySelectorAll("tbody tr")).find((row) =>
      row.textContent?.includes("京都"),
    );
    const deleteButton = Array.from(kyotoRow?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("削除"),
    );
    await act(async () => deleteButton?.click());
    expect(container.textContent).not.toContain("きょうと");

    const saveButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="save-custom-dictionary"]',
    );
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bridge.saveCustomDictionary).toHaveBeenCalledTimes(1);
    expect(bridge.reloadCustomDictionary).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(bridge.saveCustomDictionary).mock.calls[0]?.[0] ?? [];
    expect(saved.some((entry) => entry.word === "Kotoba Beacon")).toBe(true);
    expect(saved.some((entry) => entry.id === "kyoto")).toBe(false);
    expect(container.textContent).toContain("カスタム辞書を保存しました");
  });
});
