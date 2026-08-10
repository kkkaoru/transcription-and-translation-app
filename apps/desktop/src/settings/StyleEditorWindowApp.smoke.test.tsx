// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import type { AppConfig } from "../core/types";
import { I18nProvider } from "../i18n/I18nProvider";
import { StyleEditorWindowApp } from "./StyleEditorWindowApp";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type ConfigListener = (config: AppConfig) => void;

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn<() => Promise<AppConfig>>(),
  saveConfig: vi.fn<(config: AppConfig) => Promise<void>>(),
  listenConfig: vi.fn<(callback: ConfigListener) => Promise<() => void>>(),
  listSystemFonts: vi.fn(async () => [] as string[]),
}));

vi.mock("../core/bridge", () => ({
  bridge: {
    isDesktop: () => false,
    getConfig: () => mocks.getConfig(),
    saveConfig: (config: AppConfig) => mocks.saveConfig(config),
    listenConfig: (callback: ConfigListener) => mocks.listenConfig(callback),
    listSystemFonts: () => mocks.listSystemFonts(),
  },
}));

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  });
  await act(async () => {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
  });
};

const setInputValue = (element: HTMLInputElement, value: string): void => {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(element, value);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

const withFontSize = (config: AppConfig, fontSizePx: number): AppConfig => ({
  ...config,
  overlay: {
    ...config.overlay,
    source: { ...config.overlay.source, fontSizePx },
  },
});

const withRecognitionMode = (
  config: AppConfig,
  recognitionMode: AppConfig["recognitionMode"],
): AppConfig => ({
  ...config,
  recognitionMode,
});

const renderStyleEditor = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(
      <I18nProvider>
        <StyleEditorWindowApp />
      </I18nProvider>,
    );
    await Promise.resolve();
  });
  await flush();
};

const clickSave = async (container: HTMLElement): Promise<void> => {
  const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
    /設定を保存|Save settings|保存|Save/.test(button.textContent ?? ""),
  );
  expect(saveButton).toBeDefined();
  await act(async () => {
    saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  await flush();
};

describe("StyleEditorWindowApp config sync", () => {
  let container: HTMLDivElement;
  let root: Root;
  let configListener: ConfigListener | null;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("caption-bridge.ui-locale.v1", "ja");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    configListener = null;

    mocks.getConfig.mockReset();
    mocks.saveConfig.mockReset().mockResolvedValue(undefined);
    mocks.listSystemFonts.mockReset().mockResolvedValue([]);
    mocks.listenConfig.mockReset().mockImplementation((callback: ConfigListener) => {
      configListener = callback;
      return Promise.resolve(() => undefined);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    localStorage.clear();
  });

  it("keeps a local unsaved overlay draft when config:update arrives", async () => {
    const baseline = createDefaultConfig();
    mocks.getConfig.mockResolvedValue(baseline);

    await renderStyleEditor(root);

    const fontSize = container.querySelector<HTMLInputElement>(
      '[data-testid="style-source-fontSizePx"]',
    );
    expect(fontSize).not.toBeNull();
    expect(fontSize?.value).toBe(String(baseline.overlay.source.fontSizePx));

    await act(async () => {
      setInputValue(fontSize!, "72");
      await Promise.resolve();
    });
    expect(fontSize?.value).toBe("72");

    const remote = withFontSize(baseline, 18);
    await act(async () => {
      configListener?.(remote);
      await Promise.resolve();
    });

    const afterRemote = container.querySelector<HTMLInputElement>(
      '[data-testid="style-source-fontSizePx"]',
    );
    expect(afterRemote?.value).toBe("72");
  });

  it("adopts remote non-overlay fields while preserving a dirty overlay draft on save", async () => {
    const baseline = createDefaultConfig();
    expect(baseline.recognitionMode).not.toBe("web-speech");
    mocks.getConfig.mockResolvedValue(baseline);

    await renderStyleEditor(root);

    const fontSize = container.querySelector<HTMLInputElement>(
      '[data-testid="style-source-fontSizePx"]',
    );
    expect(fontSize).not.toBeNull();

    await act(async () => {
      setInputValue(fontSize!, "72");
      await Promise.resolve();
    });
    expect(fontSize?.value).toBe("72");

    const remote = withRecognitionMode(withFontSize(baseline, 18), "web-speech");
    await act(async () => {
      configListener?.(remote);
      await Promise.resolve();
    });
    await flush();

    const afterRemote = container.querySelector<HTMLInputElement>(
      '[data-testid="style-source-fontSizePx"]',
    );
    expect(afterRemote?.value).toBe("72");

    // Style-editor save must fetch the latest full config and only merge its
    // owned overlay/fields, so unrelated remote changes (recognitionMode)
    // are not rolled back.
    const latestForSave = withRecognitionMode(baseline, "web-speech");
    mocks.getConfig.mockResolvedValueOnce(latestForSave);

    await clickSave(container);

    expect(mocks.getConfig).toHaveBeenCalledTimes(2);
    expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
    const saved = mocks.saveConfig.mock.calls[0]?.[0];
    expect(saved?.recognitionMode).toBe("web-speech");
    expect(saved?.overlay.source.fontSizePx).toBe(72);
    expect(saved?.overlay.source.fontSizePx).not.toBe(remote.overlay.source.fontSizePx);
  });

  it("applies remote config:update when the draft matches the last saved baseline", async () => {
    const baseline = createDefaultConfig();
    mocks.getConfig.mockResolvedValue(baseline);

    await renderStyleEditor(root);

    const remote = withFontSize(baseline, 44);
    await act(async () => {
      configListener?.(remote);
      await Promise.resolve();
    });
    await flush();

    const fontSize = container.querySelector<HTMLInputElement>(
      '[data-testid="style-source-fontSizePx"]',
    );
    expect(fontSize?.value).toBe("44");
  });

  it("ignores a stale getConfig snapshot that resolves after config:update", async () => {
    const stale = withFontSize(createDefaultConfig(), 20);
    const fresher = withFontSize(createDefaultConfig(), 55);
    let resolveGetConfig: ((config: AppConfig) => void) | null = null;
    mocks.getConfig.mockImplementation(
      () =>
        new Promise<AppConfig>((resolve) => {
          resolveGetConfig = resolve;
        }),
    );

    await act(async () => {
      root.render(
        <I18nProvider>
          <StyleEditorWindowApp />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    // listenConfig must finish registering (and getConfig must be pending) before
    // we inject the fresher remote event that races the snapshot.
    for (let attempt = 0; attempt < 10 && !configListener; attempt += 1) {
      await flush();
    }
    expect(configListener).not.toBeNull();
    expect(resolveGetConfig).not.toBeNull();

    await act(async () => {
      configListener?.(fresher);
      await Promise.resolve();
    });
    await flush();

    const fontSizeBeforeStale = container.querySelector<HTMLInputElement>(
      '[data-testid="style-source-fontSizePx"]',
    );
    expect(fontSizeBeforeStale?.value).toBe("55");

    await act(async () => {
      resolveGetConfig?.(stale);
      await Promise.resolve();
    });
    await flush();

    const fontSizeAfterStale = container.querySelector<HTMLInputElement>(
      '[data-testid="style-source-fontSizePx"]',
    );
    expect(fontSizeAfterStale?.value).toBe("55");
  });

  it("waits for listenConfig registration before fetching the initial config", async () => {
    const callOrder: string[] = [];
    let resolveRegistration: ((dispose: () => void) => void) | null = null;
    mocks.listenConfig.mockImplementation((callback: ConfigListener) => {
      callOrder.push("listenConfig:started");
      configListener = callback;
      return new Promise<() => void>((resolve) => {
        resolveRegistration = (dispose) => {
          callOrder.push("listenConfig:completed");
          resolve(dispose);
        };
      });
    });
    mocks.getConfig.mockImplementation(() => {
      callOrder.push("getConfig");
      return Promise.resolve(createDefaultConfig());
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <StyleEditorWindowApp />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    expect(callOrder).toEqual(["listenConfig:started"]);
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(resolveRegistration).not.toBeNull();

    await act(async () => {
      resolveRegistration?.(() => undefined);
      await Promise.resolve();
    });
    await flush();

    expect(callOrder).toEqual(["listenConfig:started", "listenConfig:completed", "getConfig"]);
  });
});
