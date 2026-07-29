// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./app";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("App routes", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
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

  it("renders the main workspace and opens the settings section", async () => {
    localStorage.setItem("caption-bridge.ui-locale.v1", "ja");
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });

    expect(container.querySelector(".brand-name")?.textContent).toBe("Kotoba Beacon");
    const settingsButton = Array.from(container.querySelectorAll(".nav-tabs button")).find(
      (button) => button.textContent?.includes("設定"),
    );
    expect(settingsButton).not.toBeUndefined();

    act(() => settingsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.querySelector(".content-heading h2")?.textContent).toBe("設定");
    expect(container.textContent).toContain("言語と推論先");
    expect(container.textContent).toContain("AzooKey ユーザー辞書（任意）");
    expect(container.textContent).toContain("AzooKey 学習メモリ（任意）");
  });

  it("renders only the transparent caption route for overlay windows", async () => {
    window.history.replaceState({}, "", "/?overlay=1");
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });

    expect(container.querySelector(".app-shell")).toBeNull();
    expect(container.querySelector(".overlay-root")).not.toBeNull();
    expect(container.querySelector(".settings-section")).toBeNull();
    expect(container.textContent).not.toContain("設定を保存");
    expect(container.textContent).not.toContain("Save settings");
    expect(document.body.classList.contains("overlay-document")).toBe(true);
    expect(container.textContent).toContain("これはプレビュー用の字幕です。");
    expect(container.textContent).toContain("This is a preview caption.");
  });
});
