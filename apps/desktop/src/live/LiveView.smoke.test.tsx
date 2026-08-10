// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig, DEFAULT_RUNTIME_STATUS } from "../core/defaults";
import { I18nProvider } from "../i18n/I18nProvider";
import { createPreviewCaption } from "../overlay/captions";
import { LiveView, resolveLiveExternalOutput } from "./LiveView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("LiveView in-app preview scaling", () => {
  let container: HTMLDivElement;
  let root: Root;
  let observerCallback: ResizeObserverCallback | null = null;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("caption-bridge.ui-locale.v1", "ja");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    observerCallback = null;

    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe(target: Element) {
        const rect = {
          width: 640,
          height: 360,
          top: 0,
          left: 0,
          bottom: 360,
          right: 640,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
        Object.defineProperty(target, "getBoundingClientRect", {
          configurable: true,
          value: () => rect,
        });
        // Fire asynchronously-like on next microtask so initial fill mode can mount first.
        queueMicrotask(() => {
          observerCallback?.(
            [
              {
                target,
                contentRect: rect as DOMRectReadOnly,
                borderBoxSize: [],
                contentBoxSize: [],
                devicePixelContentBoxSize: [],
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        });
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("scales the full overlay canvas into the preview stage without OBS", async () => {
    const config = createDefaultConfig();
    const caption = createPreviewCaption();

    await act(async () => {
      root.render(
        <I18nProvider>
          <LiveView
            config={config}
            status={DEFAULT_RUNTIME_STATUS}
            caption={caption}
            devices={[]}
            message={null}
            onToggleCapture={() => {}}
            onDeviceChange={() => {}}
            onRefreshDevices={() => {}}
            onCloseMessage={() => {}}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const stage = container.querySelector('[data-testid="live-preview-stage"]');
    expect(stage).not.toBeNull();
    expect(stage?.getAttribute("data-preview-measured")).toBe("true");
    // Default overlay 1280×720 into a 640×360 stage → 50%.
    expect(stage?.getAttribute("data-preview-scale")).toBe("0.5000");

    const host = container.querySelector(
      '[data-testid="preview-scale-host"]',
    ) as HTMLElement | null;
    expect(host).not.toBeNull();
    expect(host?.classList.contains("is-scaled")).toBe(true);
    expect(host?.style.width).toBe("1280px");
    expect(host?.style.height).toBe("720px");
    expect(host?.style.transform).toContain("scale(0.5)");

    // Both JA source and EN translation render in the in-app stage (no OBS).
    expect(stage?.querySelector(".caption-line-source")?.textContent).toBe(
      "これはプレビュー用の字幕です。",
    );
    expect(stage?.querySelector(".caption-line-translation")?.textContent).toBe(
      "This is a preview caption.",
    );
    // Never force static design placeholders on the live stage.
    expect(stage?.textContent).not.toContain("日本語の音声認識結果がここに表示されます");
    expect(stage?.textContent).not.toContain("English translation will appear here");
  });

  it("replaces sample copy with live caption payload text when recognition updates", async () => {
    const config = createDefaultConfig();
    const sample = createPreviewCaption();
    const live = {
      ...sample,
      id: "live-42",
      sourceText: "こんにちは、世界。",
      translationText: "Hello, world.",
      receivedAt: Date.now(),
    };

    await act(async () => {
      root.render(
        <I18nProvider>
          <LiveView
            config={config}
            status={DEFAULT_RUNTIME_STATUS}
            caption={sample}
            devices={[]}
            message={null}
            onToggleCapture={() => {}}
            onDeviceChange={() => {}}
            onRefreshDevices={() => {}}
            onCloseMessage={() => {}}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector(".caption-line-source")?.textContent).toBe(
      "これはプレビュー用の字幕です。",
    );

    // Simulate a live recognition event reaching LiveView (placeholder stays false).
    await act(async () => {
      root.render(
        <I18nProvider>
          <LiveView
            config={config}
            status={{ ...DEFAULT_RUNTIME_STATUS, status: "capturing" }}
            caption={live}
            devices={[]}
            message={null}
            onToggleCapture={() => {}}
            onDeviceChange={() => {}}
            onRefreshDevices={() => {}}
            onCloseMessage={() => {}}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const stage = container.querySelector('[data-testid="live-preview-stage"]');
    expect(stage?.querySelector(".caption-line-source")?.textContent).toBe("こんにちは、世界。");
    expect(stage?.querySelector(".caption-line-translation")?.textContent).toBe("Hello, world.");
    expect(stage?.textContent).not.toContain("これはプレビュー用の字幕です。");
    expect(stage?.textContent).not.toContain("日本語の音声認識結果がここに表示されます");
  });

  it("renders a pipeline-drop notice on the normal Live screen", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <LiveView
            config={createDefaultConfig()}
            status={DEFAULT_RUNTIME_STATUS}
            caption={createPreviewCaption()}
            devices={[]}
            message="音声字幕パイプラインで処理待ちの項目を整理しました。 source=translation · reason=retired · count=1"
            onToggleCapture={() => {}}
            onDeviceChange={() => {}}
            onRefreshDevices={() => {}}
            onCloseMessage={() => {}}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector(".notice")?.textContent).toContain("source=translation");
    expect(container.querySelector('.notice[role="status"]')).not.toBeNull();
  });

  it("exposes a control to open the dedicated style-editor window", async () => {
    const onOpenStyleEditor = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider>
          <LiveView
            config={createDefaultConfig()}
            status={DEFAULT_RUNTIME_STATUS}
            caption={createPreviewCaption()}
            devices={[]}
            message={null}
            onToggleCapture={() => {}}
            onDeviceChange={() => {}}
            onRefreshDevices={() => {}}
            onCloseMessage={() => {}}
            onOpenStyleEditor={onOpenStyleEditor}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const button = container.querySelector<HTMLButtonElement>('[data-testid="open-style-editor"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("文字の装飾を開く ↗");
    act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onOpenStyleEditor).toHaveBeenCalledTimes(1);
  });

  it("disables device controls only while capture is starting", async () => {
    const config = createDefaultConfig();
    const caption = createPreviewCaption();

    await act(async () => {
      root.render(
        <I18nProvider>
          <LiveView
            config={config}
            status={{ ...DEFAULT_RUNTIME_STATUS, status: "starting" }}
            caption={caption}
            devices={[]}
            message={null}
            onToggleCapture={() => {}}
            onDeviceChange={() => {}}
            onRefreshDevices={() => {}}
            onCloseMessage={() => {}}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".text-button")?.disabled).toBe(true);

    await act(async () => {
      root.render(
        <I18nProvider>
          <LiveView
            config={config}
            status={{ ...DEFAULT_RUNTIME_STATUS, status: "capturing" }}
            caption={caption}
            devices={[]}
            message={null}
            onToggleCapture={() => {}}
            onDeviceChange={() => {}}
            onRefreshDevices={() => {}}
            onCloseMessage={() => {}}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLSelectElement>("select")?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>(".text-button")?.disabled).toBe(false);
  });

  it("replaces in-app captions with Syphon output status", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <LiveView
            config={createDefaultConfig()}
            status={{ ...DEFAULT_RUNTIME_STATUS, nativeOutput: "syphon" }}
            caption={createPreviewCaption()}
            devices={[]}
            message={null}
            onToggleCapture={() => {}}
            onDeviceChange={() => {}}
            onRefreshDevices={() => {}}
            onCloseMessage={() => {}}
            onOpenTransparentCapture={() => {}}
            onCloseTransparentCapture={() => {}}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="live-output-status"]')?.textContent).toContain(
      "Syphon に出力中",
    );
    expect(
      container.querySelector('[data-testid="live-output-status"]')?.getAttribute("data-output"),
    ).toBe("syphon");
    expect(container.querySelector('[data-testid="preview-scale-host"]')).toBeNull();
    expect(container.querySelector(".caption-line-source")).toBeNull();
    expect(container.querySelector('[data-testid="open-transparent-capture"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hide-transparent-capture"]')).not.toBeNull();
  });

  it("replaces in-app captions while transparent capture is open", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <LiveView
            config={createDefaultConfig()}
            status={DEFAULT_RUNTIME_STATUS}
            caption={createPreviewCaption()}
            devices={[]}
            message={null}
            transparentCaptureOpen
            onToggleCapture={() => {}}
            onDeviceChange={() => {}}
            onRefreshDevices={() => {}}
            onCloseMessage={() => {}}
            onOpenTransparentCapture={() => {}}
            onCloseTransparentCapture={() => {}}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="live-output-status"]')?.textContent).toContain(
      "透過取り込みに出力中",
    );
    expect(container.querySelector(".caption-line-source")).toBeNull();
  });

  it("prefers Syphon status when transparent capture is also open", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <LiveView
            config={createDefaultConfig()}
            status={{ ...DEFAULT_RUNTIME_STATUS, nativeOutput: "spout2" }}
            caption={createPreviewCaption()}
            devices={[]}
            message={null}
            transparentCaptureOpen
            onToggleCapture={() => {}}
            onDeviceChange={() => {}}
            onRefreshDevices={() => {}}
            onCloseMessage={() => {}}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="live-output-status"]')?.textContent).toContain(
      "Spout2 に出力中",
    );
    expect(container.querySelector(".caption-line-source")).toBeNull();
  });
});

describe("resolveLiveExternalOutput", () => {
  it("prefers native transport over transparent capture", () => {
    expect(resolveLiveExternalOutput("syphon", true)).toBe("syphon");
    expect(resolveLiveExternalOutput("spout2", false)).toBe("spout2");
    expect(resolveLiveExternalOutput("transparent-window", true)).toBe("transparent-window");
    expect(resolveLiveExternalOutput("unsupported", true)).toBe("transparent-window");
    expect(resolveLiveExternalOutput("unsupported", false)).toBeNull();
  });
});
