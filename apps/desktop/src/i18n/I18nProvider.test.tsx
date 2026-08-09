// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import { I18nProvider, useI18n } from "./I18nProvider";

const STORAGE_KEY = "caption-bridge.ui-locale.v1";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TranslatedTitle = () => {
  const { t } = useI18n();
  return <h1>{t("settings.title")}</h1>;
};

describe("I18nProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it("switches the UI and persists the selected locale", () => {
    localStorage.setItem(STORAGE_KEY, "ja");
    act(() => {
      root.render(
        <I18nProvider>
          <LocaleSwitcher />
          <TranslatedTitle />
        </I18nProvider>,
      );
    });

    expect(container.querySelector("h1")?.textContent).toBe("アプリ設定");
    const select = container.querySelector("select");
    expect(select).not.toBeNull();

    act(() => {
      if (select) {
        select.value = "en";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    expect(container.querySelector("h1")?.textContent).toBe("App settings");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("en");
  });

  it("rejects use outside the provider", () => {
    const renderOutsideProvider = () => {
      act(() => root.render(<TranslatedTitle />));
    };

    expect(renderOutsideProvider).toThrow("useI18n must be used within I18nProvider");
  });
});
