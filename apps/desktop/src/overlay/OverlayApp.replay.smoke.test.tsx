// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import type { CaptionPayload, RuntimeStatus, UnlistenFn } from "../core/types";
import { isOverlayCaption, OverlayApp } from "./OverlayApp";

const noopUnlisten: UnlistenFn = () => undefined;

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getLatestCaption: vi.fn(),
  isDesktop: vi.fn(),
  listenCaptions: vi.fn(),
  listenConfig: vi.fn(),
  listenRuntime: vi.fn(),
  publishOverlayFrame: vi.fn(),
}));

vi.mock("../core/bridge", () => ({
  bridge: mocks,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sourceCaption = (): CaptionPayload => ({
  id: "normalized-1",
  sourceText: "正規化された字幕",
  translationText: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 10,
  receivedAt: 20,
  stage: "source",
  sequence: 0,
  isFinal: false,
});

const translationCaption = (): CaptionPayload => ({
  ...sourceCaption(),
  translationText: "Normalized caption",
  receivedAt: 30,
  stage: "translation",
  sequence: 1,
  isFinal: true,
});

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
  });
};

describe("OverlayApp caption replay", () => {
  let container: HTMLDivElement;
  let root: Root;
  let captionListener: ((caption: CaptionPayload) => void) | null;
  let runtimeListener: ((status: RuntimeStatus) => void) | null;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(false);
    mocks.getConfig.mockReset().mockResolvedValue(createDefaultConfig());
    mocks.getLatestCaption.mockReset().mockResolvedValue(sourceCaption());
    mocks.listenConfig.mockReset().mockResolvedValue(noopUnlisten);
    captionListener = null;
    runtimeListener = null;
    mocks.listenCaptions
      .mockReset()
      .mockImplementation((callback: (caption: CaptionPayload) => void) => {
        captionListener = callback;
        return Promise.resolve(noopUnlisten);
      });
    mocks.listenRuntime
      .mockReset()
      .mockImplementation((callback: (status: RuntimeStatus) => void) => {
        runtimeListener = callback;
        return Promise.resolve(noopUnlisten);
      });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("replays a normalized source emitted before the listener Promise settles", async () => {
    let resolveListen!: (dispose: UnlistenFn) => void;
    mocks.listenCaptions.mockImplementation((callback: (caption: CaptionPayload) => void) => {
      captionListener = callback;
      return new Promise<UnlistenFn>((resolve) => {
        resolveListen = resolve;
      });
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(mocks.getLatestCaption).toHaveBeenCalled();
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      captionListener?.(translationCaption());
      resolveListen(noopUnlisten);
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector(".caption-line-translation")?.textContent).toBe(
      "Normalized caption",
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("keeps the overlay responsive when listener registration rejects", async () => {
    mocks.listenCaptions.mockRejectedValue(new Error("webview disconnected"));

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");
    expect(mocks.getLatestCaption).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("does not paint raw ASR stage payloads on the OBS route", async () => {
    mocks.getLatestCaption.mockResolvedValue({
      ...sourceCaption(),
      id: "asr-1",
      sourceText: "raw ASR text",
      stage: "asr" as CaptionPayload["stage"],
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector(".caption-line-source")?.textContent).toBe(
      "これはプレビュー用の字幕です。",
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("coalesces same-id source and translation updates into one overlay", async () => {
    const source = {
      ...sourceCaption(),
      id: "overlay-utterance",
      sourceText: "あしたは",
      startedAt: 1_000,
      receivedAt: 1_100,
      provisional: true,
    };
    mocks.getLatestCaption.mockResolvedValue(source);

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    await act(async () => {
      captionListener?.({
        ...source,
        sourceText: "明日は",
        provisional: undefined,
        receivedAt: 1_200,
      });
      captionListener?.({
        ...source,
        sourceText: "明日は",
        provisional: undefined,
        translationText: "Tomorrow",
        receivedAt: 1_300,
        stage: "translation",
        sequence: 1,
        isFinal: true,
      });
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelectorAll(".caption-line-source")).toHaveLength(1);
    expect(container.querySelectorAll(".caption-line-translation")).toHaveLength(1);
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("明日は");
    expect(container.querySelector(".caption-line-translation")?.textContent).toBe("Tomorrow");

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("renders a raw source-mode caption directly on the standard source line", async () => {
    mocks.getLatestCaption.mockResolvedValue({
      ...sourceCaption(),
      id: "raw-utterance",
      sourceText: "漢字とひらがな",
      translationText: "",
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelectorAll(".caption-line-source")).toHaveLength(1);
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("漢字とひらがな");
    expect(container.querySelector(".caption-line-translation")).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("starts the native-renderer route with preview text for OBS layout", async () => {
    history.pushState({}, "", "/?overlay=1&native=1");
    mocks.getLatestCaption.mockResolvedValue(null);

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector(".caption-line-source")?.textContent).toBe(
      "これはプレビュー用の字幕です。",
    );
    expect(container.querySelector(".caption-line-translation")?.textContent).toBe(
      "This is a preview caption.",
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    history.replaceState({}, "", "/");
    container.remove();
  });

  it("replaces native preview text with the first live caption", async () => {
    history.pushState({}, "", "/?native=1");
    mocks.getLatestCaption.mockResolvedValue(null);

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector(".caption-line-source")?.textContent).toBe(
      "これはプレビュー用の字幕です。",
    );

    await act(async () => {
      captionListener?.(sourceCaption());
      await Promise.resolve();
    });
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      runtimeListener?.({
        status: "idle",
        platform: "macos",
        backendReachable: true,
        nativeOutput: "syphon",
        lastError: null,
      });
      await Promise.resolve();
    });
    expect(container.querySelector(".caption-line-source")?.textContent).toBe(
      "これはプレビュー用の字幕です。",
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    history.replaceState({}, "", "/");
    container.remove();
  });

  it("clears on successful idle and ignores caption events that arrive afterward", async () => {
    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      runtimeListener?.({
        status: "error",
        platform: "unknown",
        backendReachable: false,
        nativeOutput: "unsupported",
        lastError: "capture failed",
      });
      await Promise.resolve();
    });
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      runtimeListener?.({
        status: "idle",
        platform: "unknown",
        backendReachable: false,
        nativeOutput: "unsupported",
        lastError: "capture failed",
      });
      await Promise.resolve();
    });
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      runtimeListener?.({
        status: "idle",
        platform: "unknown",
        backendReachable: false,
        nativeOutput: "unsupported",
        lastError: null,
      });
      captionListener?.(translationCaption());
      await Promise.resolve();
    });

    expect(container.querySelector(".caption-line-source")).toBeNull();
    expect(container.querySelector(".caption-line-translation")).toBeNull();

    await act(async () => {
      runtimeListener?.({
        status: "capturing",
        platform: "unknown",
        backendReachable: true,
        nativeOutput: "unsupported",
        lastError: null,
      });
      captionListener?.({
        ...sourceCaption(),
        id: "normalized-after-restart",
        startedAt: Date.now() + 1,
        receivedAt: Date.now() + 2,
      });
      await Promise.resolve();
    });
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });
});

describe("isOverlayCaption", () => {
  it("rejects non-display stages even when text is present", () => {
    expect(isOverlayCaption({ ...sourceCaption(), stage: "asr" as CaptionPayload["stage"] })).toBe(
      false,
    );
    expect(
      isOverlayCaption({ ...sourceCaption(), stage: "translate" as CaptionPayload["stage"] }),
    ).toBe(false);
  });

  it("accepts a caption with only a trimmed source line", () => {
    expect(isOverlayCaption({ ...sourceCaption(), translationText: "" })).toBe(true);
  });

  it("accepts a caption whose translation is non-empty even when source is blank", () => {
    expect(
      isOverlayCaption({ ...sourceCaption(), sourceText: "   ", translationText: "訳文" }),
    ).toBe(true);
  });

  it("rejects a caption with only whitespace on both lines", () => {
    expect(isOverlayCaption({ ...sourceCaption(), sourceText: " \t", translationText: "  " })).toBe(
      false,
    );
  });
});
describe("OverlayApp listener cleanup robustness", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(false);
    mocks.getConfig.mockReset().mockResolvedValue(createDefaultConfig());
    mocks.getLatestCaption.mockReset().mockResolvedValue(null);
    mocks.listenConfig.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenCaptions.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenRuntime.mockReset().mockImplementation(() => Promise.resolve(noopUnlisten));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("tolerates a promise-like unlisten and a throwing unlisten on unmount", async () => {
    const promiseLike = (): PromiseLike<unknown> => Promise.resolve().then(() => undefined);
    mocks.listenConfig.mockResolvedValue(promiseLike as unknown as UnlistenFn);
    mocks.listenCaptions.mockResolvedValue(() => {
      throw new Error("webview gone");
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("keeps the previous caption when runtime reports an error status", async () => {
    mocks.getLatestCaption.mockResolvedValue(sourceCaption());
    let runtimeListener: ((status: RuntimeStatus) => void) | null = null;
    mocks.listenRuntime.mockImplementation((callback: (status: RuntimeStatus) => void) => {
      runtimeListener = callback;
      return Promise.resolve(noopUnlisten);
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      runtimeListener?.({
        status: "error",
        platform: "unknown",
        backendReachable: false,
        nativeOutput: "unsupported",
        lastError: "boom",
      });
      await Promise.resolve();
    });
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });
});
describe("OverlayApp synchronous bridge throws", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(false);
    mocks.getConfig.mockReset().mockResolvedValue(createDefaultConfig());
    mocks.getLatestCaption.mockReset().mockResolvedValue(null);
    mocks.listenConfig.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenCaptions.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenRuntime.mockReset().mockImplementation(() => Promise.resolve(noopUnlisten));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("survives a bridge.getLatestCaption() that throws synchronously", async () => {
    mocks.getLatestCaption.mockImplementation(() => {
      throw new Error("ipc unavailable");
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();
    // The overlay still mounts and subscribes even when history replay throws.
    expect(mocks.listenCaptions).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("falls back cleanly when bridge.listenCaptions throws synchronously", async () => {
    mocks.listenCaptions.mockImplementation(() => {
      throw new Error("listen unavailable");
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();
    // No crash; the reject path still runs a best-effort history read.
    expect(mocks.getLatestCaption).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });
});
describe("OverlayApp resolves listeners after unmount", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(false);
    mocks.getConfig.mockReset().mockResolvedValue(createDefaultConfig());
    mocks.getLatestCaption.mockReset().mockResolvedValue(null);
    mocks.listenConfig.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenCaptions.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenRuntime.mockReset().mockImplementation(() => Promise.resolve(noopUnlisten));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("disposes a late-resolving config listener after unmount", async () => {
    let resolveConfig!: (dispose: UnlistenFn) => void;
    mocks.listenConfig.mockImplementation(
      () =>
        new Promise<UnlistenFn>((resolve) => {
          resolveConfig = resolve;
        }),
    );

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });

    // Resolve the config listener only after unmount: the else-dispose path runs.
    await act(async () => {
      resolveConfig(() => {
        throw new Error("late dispose");
      });
      await Promise.resolve();
    });
    container.remove();
  });

  it("disposes a late-resolving runtime listener after unmount", async () => {
    let resolveRuntime!: (dispose: UnlistenFn) => void;
    mocks.listenRuntime.mockImplementation(
      () =>
        new Promise<UnlistenFn>((resolve) => {
          resolveRuntime = resolve;
        }),
    );

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });

    await act(async () => {
      resolveRuntime(() => undefined);
      await Promise.resolve();
    });
    container.remove();
  });
});

describe("OverlayApp caption listener late dispose", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(false);
    mocks.getConfig.mockReset().mockResolvedValue(createDefaultConfig());
    mocks.getLatestCaption.mockReset().mockResolvedValue(null);
    mocks.listenConfig.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenCaptions.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenRuntime.mockReset().mockImplementation(() => Promise.resolve(noopUnlisten));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("disposes a caption listener that resolves after unmount", async () => {
    let resolved = false;
    mocks.listenCaptions.mockImplementation(
      () =>
        new Promise<UnlistenFn>((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve(() => undefined);
          }, 0);
        }),
    );

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(resolved).toBe(true);
    container.remove();
  });
});
