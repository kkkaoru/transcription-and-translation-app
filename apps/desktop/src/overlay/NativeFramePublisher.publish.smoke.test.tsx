// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import { __resetStructuredLogForTests, getStructuredLogs } from "../core/structuredLog";
import type { AppConfig, CaptionPayload } from "../core/types";
import { createPreviewCaption } from "./captions";

const mocks = vi.hoisted(() => ({
  isDesktop: vi.fn(),
  publishOverlayFrame: vi.fn(),
}));

const audioMocks = vi.hoisted(() => ({
  bytesToBase64: vi.fn(),
  realBytesToBase64: null as ((bytes: Uint8Array) => string) | null,
}));

vi.mock("../core/bridge", () => ({
  bridge: mocks,
  formatBridgeError: (error: unknown): string | undefined => {
    if (error instanceof Error) {
      return error.message;
    }
    return typeof error === "string" ? error : undefined;
  },
}));

vi.mock("../core/audio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/audio")>();
  audioMocks.realBytesToBase64 = actual.bytesToBase64;
  return { ...actual, bytesToBase64: audioMocks.bytesToBase64 };
});

import { NativeFramePublisher } from "./NativeFramePublisher";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const smallConfig = (): AppConfig => {
  const config = createDefaultConfig();
  config.overlay.width = 64;
  config.overlay.height = 36;
  return config;
};

const captionWith = (sourceText: string): CaptionPayload => ({
  ...createPreviewCaption(),
  sourceText,
  translationText: "",
});

// jsdom ships no 2D canvas implementation. The publisher only needs the
// measurement / pixel-readback surface to produce a frame; the pixel contents
// are irrelevant to the publish-lifecycle assertions below.
let encodeThrows = false;
let getContextUnavailable = false;

const installCanvasStub = (): void => {
  const context = {
    beginPath: () => undefined,
    clearRect: () => undefined,
    closePath: () => undefined,
    fill: () => undefined,
    fillText: () => undefined,
    getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4) }) as ImageData,
    lineTo: () => undefined,
    measureText: (text: string): TextMetrics =>
      ({ width: Array.from(text).length * 8 }) as TextMetrics,
    moveTo: () => undefined,
    quadraticCurveTo: () => undefined,
    restore: () => undefined,
    save: () => undefined,
    strokeText: () => undefined,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() =>
    getContextUnavailable ? null : (context as unknown as CanvasRenderingContext2D),
  );
};

const flush = async (ms: number): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

describe("NativeFramePublisher publish failures", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(true);
    mocks.publishOverlayFrame.mockReset().mockResolvedValue(undefined);
    encodeThrows = false;
    getContextUnavailable = false;
    audioMocks.bytesToBase64.mockReset();
    audioMocks.bytesToBase64.mockImplementation((bytes: Uint8Array): string => {
      if (encodeThrows) {
        throw new Error("base64 encoding is unavailable in this runtime");
      }
      return audioMocks.realBytesToBase64?.(bytes) ?? "";
    });
    __resetStructuredLogForTests();
    installCanvasStub();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("republishes the next caption after a rejected invoke instead of suppressing it", async () => {
    mocks.publishOverlayFrame.mockRejectedValueOnce(new Error("native output worker stopped"));

    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("first")} />);
    });
    await flush(60);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(1);

    const attemptsBefore = mocks.publishOverlayFrame.mock.calls.length;
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("second")} />);
    });
    await flush(60);

    // A rejected invoke must not advance the painted key: the next caption
    // gets its own attempt instead of being silently skipped forever.
    expect(mocks.publishOverlayFrame.mock.calls.length).toBeGreaterThan(attemptsBefore);

    // The failure is surfaced as a diagnostic rather than swallowed.
    const nativeLogs = getStructuredLogs().filter((entry) => entry.stage === "native-output");
    expect(nativeLogs.length).toBeGreaterThan(0);
    expect(nativeLogs[0]?.error).toContain("native output worker stopped");
  });

  it("retries the latest frame after a transient failure without a caption change", async () => {
    mocks.publishOverlayFrame.mockRejectedValueOnce(new Error("ipc disconnected"));

    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("only")} />);
    });
    await flush(60);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(1);

    // The publisher backs off ~200ms and republishes the same (latest) frame,
    // so a transient IPC hiccup cannot freeze OBS on the previous caption.
    await flush(400);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(2);
  });

  it("stops retrying a permanently failing key and logs an error", async () => {
    mocks.publishOverlayFrame.mockRejectedValue(new Error("spout device lost"));

    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("stuck")} />);
    });
    // Three attempts at roughly 0/200/400ms, then the key is exhausted.
    await flush(900);

    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(3);
    const nativeLogs = getStructuredLogs().filter((entry) => entry.stage === "native-output");
    expect(nativeLogs.some((entry) => entry.level === "error")).toBe(true);

    // No further attempts fire once retries are exhausted: the retry loop is
    // bounded even though the native worker stays dead.
    await flush(400);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(3);
  });

  it("releases the in-flight gate after a synchronous encode throw so the next caption publishes", async () => {
    encodeThrows = true;

    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("first")} />);
    });
    await flush(60);

    // The throw happens after the in-flight claim, so without the guard every
    // later caption would hit the defer branch and native output would freeze.
    expect(mocks.publishOverlayFrame).not.toHaveBeenCalled();
    const nativeLogs = getStructuredLogs().filter((entry) => entry.stage === "native-output");
    expect(
      nativeLogs.some((entry) => entry.error?.includes("base64 encoding is unavailable")),
    ).toBe(true);

    encodeThrows = false;
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("second")} />);
    });
    await flush(60);

    // The catch path released the gate, so the second caption publishes again.
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(1);
  });

  it("publishes the wire frame contract as rgba base64 of width×height×4 bytes", async () => {
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("wire")} />);
    });
    await flush(60);

    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(1);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledWith(expect.any(String), 64, 36);
    const [rgbaBase64] = mocks.publishOverlayFrame.mock.calls[0] ?? [];
    expect(atob(rgbaBase64).length).toBe(64 * 36 * 4);
  });

  it("retries when the canvas context is unavailable instead of dropping the frame", async () => {
    getContextUnavailable = true;

    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("first")} />);
    });
    await flush(40);
    expect(mocks.publishOverlayFrame).not.toHaveBeenCalled();

    getContextUnavailable = false;
    await flush(60);

    // The retry scheduled by the null-context branch publishes the pending
    // frame once a context is available, without requiring a new caption.
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(1);
  });
});
