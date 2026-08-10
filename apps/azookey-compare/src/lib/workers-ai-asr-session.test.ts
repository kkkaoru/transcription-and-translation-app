import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkersAiAsrController } from "./workers-ai-asr-controller";
import { ensureWorkersAiAsrController, gateWorkersAiAsrStart } from "./workers-ai-asr-session";
import {
  WORKERS_AI_ASR_PREPARING_JA,
  WORKERS_AI_ASR_UNSUPPORTED_JA,
} from "./workers-ai-asr-support";

const fakeController = (
  overrides: Partial<WorkersAiAsrController> & {
    start?: ReturnType<typeof vi.fn>;
    dispose?: ReturnType<typeof vi.fn>;
    setLanguage?: ReturnType<typeof vi.fn>;
    matchesTransport?: ReturnType<typeof vi.fn>;
  } = {},
): WorkersAiAsrController =>
  ({
    supported: true,
    isDisposed: false,
    currentState: "idle",
    matchesTransport: vi.fn(() => true),
    setLanguage: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    dispose: vi.fn(),
    ...overrides,
  }) as unknown as WorkersAiAsrController;

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "AudioContext");
  Reflect.deleteProperty(globalThis, "navigator");
});

describe("ensureWorkersAiAsrController", () => {
  it("creates a real controller when no factory is supplied", () => {
    const controller = ensureWorkersAiAsrController({
      language: "ja-JP",
      existing: null,
    });
    expect(controller.isDisposed).toBe(false);
    expect(controller.supported).toBe(false);
    controller.dispose();
    expect(controller.isDisposed).toBe(true);
  });

  it("starts immediately after selecting workers-ai-asr without waiting a tick", async () => {
    const created = fakeController();
    const createController = vi.fn(() => created);
    const controller = ensureWorkersAiAsrController({
      language: "ja-JP",
      endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
      auth: { scheme: "none" },
      existing: null,
      createController,
    });
    expect(createController).toHaveBeenCalledTimes(1);
    expect(controller).toBe(created);
    await controller.start();
    expect(created.start).toHaveBeenCalledTimes(1);
  });

  it("reuses a live controller with the same transport instead of recreating", () => {
    const existing = fakeController({
      matchesTransport: vi.fn(() => true),
      setLanguage: vi.fn(),
    });
    const createController = vi.fn(() => fakeController());
    const controller = ensureWorkersAiAsrController({
      language: "en-US",
      endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
      auth: { scheme: "bearer", token: "t" },
      existing,
      createController,
    });
    expect(controller).toBe(existing);
    expect(existing.setLanguage).toHaveBeenCalledWith("en-US");
    expect(existing.dispose).not.toHaveBeenCalled();
    expect(createController).not.toHaveBeenCalled();
  });

  it("disposes a mismatched or disposed controller before creating a replacement", () => {
    const stale = fakeController({
      isDisposed: false,
      matchesTransport: vi.fn(() => false),
      dispose: vi.fn(),
    });
    const next = fakeController();
    const createController = vi.fn(() => next);
    expect(
      ensureWorkersAiAsrController({
        language: "ja-JP",
        existing: stale,
        createController,
      }),
    ).toBe(next);
    expect(stale.dispose).toHaveBeenCalledTimes(1);
    expect(createController).toHaveBeenCalledTimes(1);

    const disposed = fakeController({ isDisposed: true, dispose: vi.fn() });
    const replacement = fakeController();
    expect(
      ensureWorkersAiAsrController({
        language: "ja-JP",
        existing: disposed,
        createController: () => replacement,
      }),
    ).toBe(replacement);
    expect(disposed.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("gateWorkersAiAsrStart", () => {
  it("does not treat a missing controller as unsupported", () => {
    expect(gateWorkersAiAsrStart({ controller: null, captureSupported: true })).toEqual({
      ok: false,
      reason: "preparing",
      message: WORKERS_AI_ASR_PREPARING_JA,
    });
    expect(gateWorkersAiAsrStart({ controller: null, captureSupported: false })).toEqual({
      ok: false,
      reason: "unsupported",
      message: WORKERS_AI_ASR_UNSUPPORTED_JA,
    });
  });

  it("allows start when the controller is supported", () => {
    const controller = fakeController({ supported: true });
    expect(gateWorkersAiAsrStart({ controller, captureSupported: true })).toEqual({
      ok: true,
      controller,
    });
  });

  it("rejects an unsupported controller even if one is mounted", () => {
    const controller = fakeController({ supported: false });
    expect(gateWorkersAiAsrStart({ controller, captureSupported: true })).toEqual({
      ok: false,
      reason: "unsupported",
      message: WORKERS_AI_ASR_UNSUPPORTED_JA,
    });
  });

  it("uses the live capture probe when captureSupported is omitted", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { AudioContext: class FakeAudioContext {} },
    });
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: class FakeAudioContext {},
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => ({}) } },
    });
    const controller = fakeController({ supported: true });
    expect(gateWorkersAiAsrStart({ controller }).ok).toBe(true);
    const preparing = gateWorkersAiAsrStart({ controller: null });
    expect(preparing.ok).toBe(false);
    if (!preparing.ok) {
      expect(preparing.reason).toBe("preparing");
    }
  });
});
