// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./app";
import { BUILD_INFO } from "./core/buildInfo";

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
    const buildInfo = container.querySelector('[data-testid="build-info"]');
    expect(buildInfo).not.toBeNull();

    const buildVersion = container.querySelector('[data-testid="build-version"]');
    expect(buildVersion?.textContent).toBe(`v${BUILD_INFO.appVersion}`);
    expect(BUILD_INFO.appVersion.trim()).not.toBe("");

    const buildId = container.querySelector('[data-testid="build-id"]');
    expect(buildId?.textContent).toBe(`build ${BUILD_INFO.buildId}`);
    expect(BUILD_INFO.buildId.trim()).not.toBe("");
    expect(buildInfo?.textContent).toMatch(/v\S+\s*·\s*build\s+\S+/);

    // In-app preview must render live caption payload without OBS / without forced placeholders.
    expect(container.querySelector('[data-testid="live-preview-stage"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="preview-scale-host"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="input-level-meter"]')).not.toBeNull();
    // Pipeline timing/debug output is reachable from the live workspace too;
    // users do not need to switch tabs before they can inspect each stage.
    expect(container.querySelector(".debug-panel")).not.toBeNull();
    expect(container.textContent).toContain("これはプレビュー用の字幕です。");
    expect(container.textContent).toContain("This is a preview caption.");
    expect(container.textContent).toMatch(/OBS\s*不要/);
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
    const settingsButton = Array.from(container.querySelectorAll(".nav-tabs button")).find(
      (button) => button.textContent?.includes("設定"),
    );
    expect(settingsButton).not.toBeUndefined();

    act(() => settingsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.querySelector(".content-heading h2")?.textContent).toBe("設定");
    expect(container.textContent).toContain("言語と推論先");
    expect(container.textContent).toContain("モデル管理");
    expect(container.textContent).toContain("最小モデルを一括DL");
    expect(container.textContent).toContain("AzooKey ユーザー辞書（任意）");
    expect(container.textContent).toContain("AzooKey 学習メモリ（任意）");
    expect(container.querySelector(".debug-panel")).not.toBeNull();
    // Structured log level selector is part of the always-present debug panel markup.
    expect(container.querySelector('[data-testid="debug-log-level"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="debug-structured-logs"]')).not.toBeNull();
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
