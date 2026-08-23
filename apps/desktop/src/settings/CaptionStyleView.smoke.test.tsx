// @vitest-environment jsdom
// This file runs with bun.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import type { AppConfig } from "../core/types";
import { I18nProvider } from "../i18n/I18nProvider";
import { CaptionStyleView } from "./CaptionStyleView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PreviewHarness = ({ initialConfig }: { initialConfig: AppConfig }) => {
  const [config, setConfig] = useState(initialConfig);
  return (
    <CaptionStyleView config={config} saving={false} onConfigChange={setConfig} onSave={() => {}} />
  );
};

describe("CaptionStyleView live preview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("caption-bridge.ui-locale.v1", "ja");
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

  it("renders the Japanese and English sample captions", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <PreviewHarness initialConfig={createDefaultConfig()} />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const preview = container.querySelector('[data-testid="caption-style-preview"]');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain("これはプレビュー用の字幕です。");
    expect(preview?.textContent).toContain("This is a preview caption.");
    expect(preview?.querySelector(".caption-line-source")?.textContent).toBe(
      "これはプレビュー用の字幕です。",
    );
    expect(preview?.querySelector(".caption-line-translation")?.textContent).toBe(
      "This is a preview caption.",
    );
    expect(preview?.querySelector('[data-testid="caption-style-preview-host"]')).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="caption-style-preview-source"]')
        ?.value,
    ).toBe("これはプレビュー用の字幕です。");
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="caption-style-preview-translation"]')
        ?.value,
    ).toBe("This is a preview caption.");
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="caption-style-preview-background"]')
        ?.value,
    ).toBe("#1a2830");
  });

  it("edits preview captions and background without saving configuration", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <PreviewHarness initialConfig={createDefaultConfig()} />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const sourceInput = container.querySelector<HTMLInputElement>(
      '[data-testid="caption-style-preview-source"]',
    );
    const backgroundInput = container.querySelector<HTMLInputElement>(
      '[data-testid="caption-style-preview-background"]',
    );
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setNativeValue?.call(sourceInput, "変更した認識結果");
      sourceInput?.dispatchEvent(new Event("input", { bubbles: true }));
      setNativeValue?.call(backgroundInput, "#123456");
      backgroundInput?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="caption-style-preview"] .caption-line-source',
      )?.textContent,
    ).toBe("変更した認識結果");
    expect(
      container.querySelector<HTMLElement>('[data-testid="caption-style-preview-stage"]')?.style
        .backgroundColor,
    ).toBe("rgb(18, 52, 86)");
  });

  it("updates rendered caption styles immediately without saving", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <PreviewHarness initialConfig={createDefaultConfig()} />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const sourceLine = () =>
      container.querySelector<HTMLElement>(
        '[data-testid="caption-style-preview"] .caption-line-source',
      );
    const fontSize = container.querySelector<HTMLInputElement>(
      '[data-testid="style-source-fontSizePx"]',
    );
    expect(fontSize).not.toBeNull();
    expect(sourceLine()?.style.fontSize).toBe("36px");

    await act(async () => {
      const setNativeValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setNativeValue?.call(fontSize, "72");
      fontSize?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    expect(sourceLine()?.style.fontSize).toBe("72px");
    expect(fontSize?.value).toBe("72");
  });
});
