// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./app";
import { BUILD_INFO } from "./core/buildInfo";
import { clearDiagnosticEvents, getDiagnosticEvents } from "./core/diagnostics";

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
    expect(container.querySelector(".sidebar")).toBeNull();
    expect(container.querySelector(".sidebar-intro")).toBeNull();
    expect(container.querySelector(".privacy-note")).toBeNull();
    expect(container.querySelector(".platform-label")).toBeNull();
    expect(container.querySelector(".topbar .nav-tabs")).not.toBeNull();
    expect(container.querySelector(".live-stage")).not.toBeNull();
    expect(container.querySelector(".live-toolbar")).not.toBeNull();
    expect(container.querySelector('[data-testid="open-transparent-capture"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hide-transparent-capture"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="open-style-editor"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="open-style-editor"]')?.textContent).toBe(
      "文字の装飾を開く ↗",
    );
    expect(container.querySelector('.topbar [data-testid="build-info"]')).toBeNull();

    // In-app preview must render live caption payload without OBS / without forced placeholders.
    expect(container.querySelector('[data-testid="live-preview-stage"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="preview-scale-host"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="input-level-meter"]')).not.toBeNull();
    expect(container.querySelector(".debug-panel")).toBeNull();
    expect(container.textContent).toContain("これはプレビュー用の字幕です。");
    expect(container.textContent).toContain("This is a preview caption.");
    expect(container.textContent).not.toContain("日本語の音声認識結果がここに表示されます");
    // Live stage shows the live caption payload, not static design placeholders.
    const stage = container.querySelector(".preview-stage");
    expect(stage?.textContent).toContain("これはプレビュー用の字幕です。");
    expect(stage?.textContent).toContain("This is a preview caption.");
    expect(stage?.textContent).not.toContain("English translation will appear here");
    expect(stage?.querySelector(".overlay-preview .caption-line-source")?.textContent).toBe(
      "これはプレビュー用の字幕です。",
    );
    expect(stage?.querySelector(".overlay-preview .caption-line-translation")?.textContent).toBe(
      "This is a preview caption.",
    );
    // placeholder must stay false so recognition updates appear in-app without OBS.
    expect(container.querySelector(".overlay-preview")?.classList.contains("overlay-preview")).toBe(
      true,
    );
    const styleButton = container.querySelector('[data-testid="nav-style"]');
    expect(styleButton?.textContent).toBe("文字の装飾設定");
    act(() => styleButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector(".content-heading h2")?.textContent).toBe("文字の装飾設定");
    expect(container.querySelector('[data-testid="caption-style-editors"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="caption-style-layout"]')).not.toBeNull();
    expect(container.textContent).toContain("日本語（認識結果）");
    expect(container.textContent).toContain("English（翻訳結果）");

    const settingsButton = container.querySelector('[data-testid="nav-settings"]');
    expect(settingsButton?.textContent).toBe("アプリ設定");
    act(() => settingsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.querySelector(".content-heading h2")?.textContent).toBe("アプリ設定");
    expect(container.querySelector(".content-heading .settings-pane-tabs")).not.toBeNull();
    const buildInfo = container.querySelector('[data-testid="build-info"]');
    expect(buildInfo).not.toBeNull();
    expect(container.querySelector('.content-heading [data-testid="build-info"]')).not.toBeNull();
    const buildVersion = container.querySelector('[data-testid="build-version"]');
    expect(buildVersion?.textContent).toBe(`v${BUILD_INFO.appVersion}`);
    expect(BUILD_INFO.appVersion.trim()).not.toBe("");
    const buildId = container.querySelector('[data-testid="build-id"]');
    expect(buildId?.textContent).toBe(`build ${BUILD_INFO.buildId}`);
    expect(BUILD_INFO.buildId.trim()).not.toBe("");
    expect(buildInfo?.textContent).toMatch(/v\S+\s*·\s*build\s+\S+/);
    expect(container.querySelector('[data-testid="settings-everyday-tab"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-advanced-tab"]')).not.toBeNull();
    const everydayPane = container.querySelector<HTMLElement>(
      '[data-testid="settings-pane-everyday"]',
    );
    const advancedPane = container.querySelector<HTMLElement>(
      '[data-testid="settings-pane-advanced"]',
    );
    expect(everydayPane?.hidden).toBe(false);
    expect(advancedPane?.hidden).toBe(true);
    expect(container.textContent).toContain("普段の設定");
    expect(container.textContent).toContain("詳細設定");
    expect(container.textContent).toContain("音声と認識");
    expect(container.textContent).toContain("字幕の出し方");

    const advancedTab = container.querySelector('[data-testid="settings-advanced-tab"]');
    act(() => advancedTab?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(everydayPane?.hidden).toBe(true);
    expect(advancedPane?.hidden).toBe(false);
    expect(container.textContent).toContain("推論先");
    expect(container.textContent).toContain("モデル管理");
    expect(container.textContent).toContain("最小モデルを一括DL");
    expect(container.textContent).toContain("AzooKey ユーザー辞書（任意）");
    expect(container.textContent).toContain("AzooKey 学習メモリ（任意）");
    expect(container.querySelector(".debug-panel")).not.toBeNull();
    // Structured log level selector is part of the always-present debug panel markup.
    expect(container.querySelector('[data-testid="debug-log-level"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="debug-structured-logs"]')).not.toBeNull();

    clearDiagnosticEvents();
    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("設定を保存"),
    );
    expect(saveButton).not.toBeUndefined();
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      getDiagnosticEvents().filter((event) => event.message === "Settings saved"),
    ).toHaveLength(1);
  });

  it("renders the transparent capture route without the main workspace chrome", async () => {
    window.history.replaceState({}, "", "/?transparent=1");
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
    expect(document.body.classList.contains("overlay-document--window")).toBe(false);
    // Live capture starts empty; preview copy is reserved for non-capture surfaces.
    expect(container.querySelector(".caption-lines")).not.toBeNull();
  });

  it("renders the style-editor window route with CaptionStyleView and shared save chrome", async () => {
    localStorage.setItem("caption-bridge.ui-locale.v1", "ja");
    window.history.replaceState({}, "", "/?style-editor=1");
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="style-editor-window"]')).not.toBeNull();
    expect(container.querySelector(".nav-tabs")).toBeNull();
    expect(container.querySelector(".live-stage")).toBeNull();
    expect(container.querySelector(".overlay-root")).not.toBeNull();
    expect(container.querySelector('[data-testid="caption-style-preview"]')).not.toBeNull();
    expect(container.textContent).toContain("これはプレビュー用の字幕です。");
    expect(container.textContent).toContain("This is a preview caption.");
    expect(container.querySelector(".content-heading h2")?.textContent).toBe("文字の装飾設定");
    expect(container.querySelector('[data-testid="caption-style-editors"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="caption-style-layout"]')).not.toBeNull();
  });
});
