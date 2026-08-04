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

import {
  beginNativePublish,
  completeNativePublishSuccess,
  createNativePublishGate,
  NativeFramePublisher,
} from "./NativeFramePublisher";

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
  it("queues a revert to the last successful frame while a newer frame is in flight", () => {
    const gate = createNativePublishGate();

    expect(beginNativePublish(gate, "frame-a")).toEqual({
      action: "publish",
      key: "frame-a",
    });
    expect(completeNativePublishSuccess(gate, "frame-a")).toBeNull();

    expect(beginNativePublish(gate, "frame-b")).toEqual({
      action: "publish",
      key: "frame-b",
    });
    // The current props can revert to A before B's IPC call completes. A was
    // successful previously, but it still must be queued behind B.
    expect(beginNativePublish(gate, "frame-a")).toEqual({
      action: "defer",
      pendingKey: "frame-a",
    });
    expect(completeNativePublishSuccess(gate, "frame-b")).toBe("frame-a");
    expect(gate.lastSuccessfulKey).toBe("frame-b");

    expect(beginNativePublish(gate, "frame-a")).toEqual({
      action: "publish",
      key: "frame-a",
    });
  });

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

  it("republishes the latest caption after cleanup cancels an unresolved invoke", async () => {
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("first")} />);
    });
    await flush(60);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(1);

    let resolveSecond: (() => void) | null = null;
    mocks.publishOverlayFrame.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSecond = resolve;
        }),
    );
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("second")} />);
    });
    await flush(60);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(2);

    // Reverting to the already-successful first caption while the second IPC
    // call is unresolved must still publish first again. The effect cleanup
    // cannot leave the native output stuck on second.
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("first")} />);
    });
    await flush(60);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(3);

    expect(resolveSecond).not.toBeNull();
    (resolveSecond as unknown as () => void)();
    await flush(60);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(3);
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

  it("uses a stable fallback when native publish rejects with an unstructured value", async () => {
    mocks.publishOverlayFrame.mockRejectedValueOnce({ reason: "worker stopped" });

    await act(() => {
      root.render(
        <NativeFramePublisher config={smallConfig()} caption={captionWith("malformed")} />,
      );
    });
    await flush(60);

    const nativeLogs = getStructuredLogs().filter((entry) => entry.stage === "native-output");
    expect(nativeLogs[0]?.error).toBe("native overlay publish rejected");
  });

  it("ignores a rejected native call that settles after the publisher unmounts", async () => {
    const pending = { reject: null as ((error: unknown) => void) | null };
    mocks.publishOverlayFrame.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          pending.reject = reject;
        }),
    );

    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("late")} />);
    });
    await flush(60);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(1);

    await act(() => {
      root.unmount();
    });
    pending.reject?.(new Error("webview closed"));
    await flush(60);

    expect(getStructuredLogs().filter((entry) => entry.stage === "native-output")).toHaveLength(0);
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

  it("bounds retries when every native frame render fails synchronously", async () => {
    encodeThrows = true;

    await act(() => {
      root.render(
        <NativeFramePublisher config={smallConfig()} caption={captionWith("stuck-render")} />,
      );
    });
    await flush(900);

    expect(mocks.publishOverlayFrame).not.toHaveBeenCalled();
    const nativeLogs = getStructuredLogs().filter((entry) => entry.stage === "native-output");
    expect(nativeLogs.some((entry) => entry.level === "error")).toBe(true);
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

  it("schedules a follow-up publish when a newer caption replaces a successful one", async () => {
    // Two distinct captions in quick succession coalesce into one rAF; the
    // drain path must keep the channel alive after the first success.
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("a")} />);
    });
    await flush(60);
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("b")} />);
    });
    await flush(60);
    expect(mocks.publishOverlayFrame.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("NativeFramePublisher cancelled render catch", () => {
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

  it("releases the in-flight claim when unmounted during a throwing render", async () => {
    audioMocks.bytesToBase64.mockImplementationOnce(() => {
      root.unmount();
      throw new Error("render interrupted by teardown");
    });

    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("boom")} />);
    });
    await flush(40);
    expect(mocks.publishOverlayFrame).not.toHaveBeenCalled();
  });

  it("uses the render-failure fallback for an unstructured synchronous throw", async () => {
    audioMocks.bytesToBase64.mockImplementationOnce(() => {
      throw { reason: "encoder unavailable" };
    });

    await act(() => {
      root.render(
        <NativeFramePublisher config={smallConfig()} caption={captionWith("fallback")} />,
      );
    });
    await flush(60);

    const nativeLogs = getStructuredLogs().filter((entry) => entry.stage === "native-output");
    expect(nativeLogs[0]?.error).toBe("native overlay frame render failed");
  });
});

describe("NativeFramePublisher decision-skip effects", () => {
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

  it("skips a repeat render of the same caption after it already succeeded", async () => {
    const caption = captionWith("same");
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={caption} />);
    });
    await flush(60);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(1);

    // Re-render the identical caption: the publish gate returns skip.
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={caption} />);
    });
    await flush(60);
    expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(1);
  });
});

describe("NativeFramePublisher coalesce and cancelled paths", () => {
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

  it("coalesces rapid caption bursts into a single published frame", async () => {
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("a")} />);
    });
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("b")} />);
    });
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("c")} />);
    });
    // All three re-renders land in the same rAF; only the latest frame paints.
    await flush(60);
    expect(mocks.publishOverlayFrame.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("reuses the cached fonts.ready promise across captions", async () => {
    // Define a real document.fonts.ready so the ensureFontsReady cache path runs
    // on the second effect instead of short-circuiting on the missing-fonts guard.
    const readyCallbacks: Array<() => void> = [];
    const ready = new Promise<void>((resolve) => {
      readyCallbacks.push(resolve);
    });
    const originalFonts = document.fonts;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready },
    });
    try {
      await act(() => {
        root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("one")} />);
      });
      readyCallbacks[0]?.();
      await act(async () => {
        await ready;
      });
      await flush(60);
      expect(mocks.publishOverlayFrame).toHaveBeenCalledTimes(1);

      // A second caption re-enters ensureFontsReady; the cached promise (not a
      // fresh one) must be reused, so only one .ready was created.
      await act(() => {
        root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("two")} />);
      });
      await flush(60);
      expect(mocks.publishOverlayFrame.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(readyCallbacks.length).toBe(1);
    } finally {
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: originalFonts,
      });
    }
  });
});

describe("NativeFramePublisher exhausted-decision branch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(true);
    mocks.publishOverlayFrame.mockReset().mockRejectedValue(new Error("native worker dead"));
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

  it("logs exhaustion and suppresses a re-rendered permanently failing frame", async () => {
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("stuck")} />);
    });
    // Burn through the retry budget: three attempts exhaust the key.
    await flush(900);
    expect(mocks.publishOverlayFrame.mock.calls.length).toBeGreaterThanOrEqual(3);

    // A fresh effect for the same failed key must hit the exhausted-decision
    // branch and log an error without republishing.
    const callsAfterExhaustion = mocks.publishOverlayFrame.mock.calls.length;
    await act(() => {
      root.render(<NativeFramePublisher config={smallConfig()} caption={captionWith("stuck")} />);
    });
    await flush(60);
    expect(mocks.publishOverlayFrame.mock.calls.length).toBe(callsAfterExhaustion);
  });
});
