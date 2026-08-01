// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import type { CaptionPayload, RuntimeStatus, UnlistenFn } from "../core/types";

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

import { OverlayApp } from "./OverlayApp";

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
