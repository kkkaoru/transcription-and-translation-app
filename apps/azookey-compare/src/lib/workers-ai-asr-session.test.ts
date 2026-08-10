import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkersAiAsrController } from "./workers-ai-asr-controller";
import {
  ensureWorkersAiAsrController,
  gateWorkersAiAsrStart,
  startCloudflareWorkersAiAsrAfterSelect,
} from "./workers-ai-asr-session";
import {
  WORKERS_AI_ASR_GRAPH_UNAVAILABLE_JA,
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

class FakeMediaStreamSource {
  connect(_node: unknown): void {}
  disconnect(): void {}
}

class FakeGainNode {
  gain = { value: 1 };
  connections: unknown[] = [];
  connect(node: unknown): void {
    this.connections.push(node);
  }
  disconnect(): void {}
}

class FakeScriptProcessor {
  onaudioprocess:
    | ((event: { inputBuffer: { getChannelData: (i: number) => Float32Array } }) => void)
    | null = null;
  connections: unknown[] = [];
  connect(node: unknown): void {
    this.connections.push(node);
  }
  disconnect(): void {}
}

/** Mimics browsers where MediaStreamDestination throws during ASR start. */
class ThrowingDestinationAudioContext {
  state: AudioContextState = "running";
  sampleRate = 16_000;
  destination = { kind: "destination" as const };
  createdGains: FakeGainNode[] = [];

  createMediaStreamSource(_stream: MediaStream): FakeMediaStreamSource {
    return new FakeMediaStreamSource();
  }

  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    this.createdGains.push(gain);
    return gain;
  }

  createScriptProcessor(
    _bufferSize?: number,
    _inputChannels?: number,
    _outputChannels?: number,
  ): FakeScriptProcessor {
    return new FakeScriptProcessor();
  }

  createMediaStreamDestination(): never {
    throw new Error("InvalidStateError");
  }

  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }
}

const installCapture = (AudioContextImpl = ThrowingDestinationAudioContext): MediaStream => {
  const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { AudioContext: AudioContextImpl },
  });
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    writable: true,
    value: AudioContextImpl,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      mediaDevices: {
        getUserMedia: vi.fn(async () => stream),
      },
    },
  });
  Reflect.deleteProperty(globalThis, "MediaRecorder");
  return stream;
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "AudioContext");
  Reflect.deleteProperty(globalThis, "MediaRecorder");
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
  it("rejects start when capture is unavailable, even without a controller", () => {
    expect(gateWorkersAiAsrStart({ controller: null, captureSupported: false })).toEqual({
      ok: false,
      reason: "unsupported",
      message: WORKERS_AI_ASR_UNSUPPORTED_JA,
    });
  });

  it("does not treat a missing controller as a successful start", () => {
    const gate = gateWorkersAiAsrStart({ controller: null, captureSupported: true });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.reason).toBe("preparing");
      expect(gate.message).toBe(WORKERS_AI_ASR_PREPARING_JA);
    }
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

  it("rejects when captureSupported is explicitly false even if the controller is supported", () => {
    const controller = fakeController({ supported: true });
    expect(gateWorkersAiAsrStart({ controller, captureSupported: false })).toEqual({
      ok: false,
      reason: "unsupported",
      message: WORKERS_AI_ASR_UNSUPPORTED_JA,
    });
  });

  it("is ok after ensureWorkersAiAsrController({ existing: null }) when capture is available", () => {
    installCapture();
    const controller = ensureWorkersAiAsrController({
      language: "ja-JP",
      existing: null,
    });
    const gate = gateWorkersAiAsrStart({ controller });
    expect(gate).toEqual({ ok: true, controller });
    expect(gate.ok).toBe(true);
    if (!gate.ok) {
      expect(gate.reason).not.toBe("preparing");
      expect(gate.reason).not.toBe("unsupported");
    }
    controller.dispose();
  });
});

describe("startCloudflareWorkersAiAsrAfterSelect", () => {
  it("starts after selecting workers-ai-asr with a null controller and mocked mic", async () => {
    installCapture();
    const onError = vi.fn();
    const controllerOnError = vi.fn();
    const result = await startCloudflareWorkersAiAsrAfterSelect({
      language: "ja-JP",
      endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
      auth: { scheme: "none" },
      existing: null,
      callbacks: {
        disableSilero: true,
        onError: controllerOnError,
      },
      onError,
    });

    const errorMessages = [
      ...onError.mock.calls.map((call) => String(call[0])),
      ...controllerOnError.mock.calls.map((call) => String(call[0])),
    ];
    expect(errorMessages, "select→認識を開始 must not setError").toEqual([]);
    expect(result.ok, "select→認識を開始 must succeed").toBe(true);
    if (!result.ok) {
      expect(result.message).not.toContain("準備");
      expect(result.message).not.toContain("非対応");
      expect(result.message).not.toBe(WORKERS_AI_ASR_PREPARING_JA);
      expect(result.message).not.toBe(WORKERS_AI_ASR_UNSUPPORTED_JA);
      expect(result.message).not.toBe(WORKERS_AI_ASR_GRAPH_UNAVAILABLE_JA);
      expect(result.message).not.toMatch(/NotAllowedError/i);
      expect(result.message).not.toMatch(/マイクを開始できません/);
    }
    expect(result.controller).toBeTruthy();
    expect(result.controller?.currentState).toBe("listening");
    result.controller?.dispose();
  });

  it("refreshes capture support when the existing controller was snapshotted unsupported", async () => {
    const stale = ensureWorkersAiAsrController({
      language: "ja-JP",
      existing: null,
      callbacks: { disableSilero: true },
    });
    expect(stale.supported).toBe(false);
    installCapture();
    const onError = vi.fn();
    const result = await startCloudflareWorkersAiAsrAfterSelect({
      language: "ja-JP",
      existing: stale,
      callbacks: { disableSilero: true, onError },
      onError,
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.controller?.currentState).toBe("listening");
    expect(result.controller?.supported).toBe(true);
    result.controller?.dispose();
  });

  it("reports gate failure without calling start", async () => {
    const created = fakeController({ supported: false });
    const onError = vi.fn();
    const result = await startCloudflareWorkersAiAsrAfterSelect({
      language: "ja-JP",
      existing: null,
      createController: () => created,
      onError,
    });
    expect(created.start).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(WORKERS_AI_ASR_UNSUPPORTED_JA);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unsupported");
    }
  });

  it("maps thrown getUserMedia errors to Japanese", async () => {
    const denied = new Error("Permission denied");
    denied.name = "NotAllowedError";
    const created = fakeController({
      start: vi.fn(async () => {
        throw denied;
      }),
    });
    const onError = vi.fn();
    const result = await startCloudflareWorkersAiAsrAfterSelect({
      language: "ja-JP",
      existing: null,
      createController: () => created,
      captureSupported: true,
      onError,
    });
    expect(result.ok).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      "マイク許可が必要です。ブラウザの設定でマイクを許可してください",
    );
    expect(String(onError.mock.calls[0]?.[0])).not.toMatch(/NotAllowedError|Permission denied/i);
  });

  it("treats controller error state after start as failure", async () => {
    const created = fakeController({
      start: vi.fn(async () => {
        (created as { currentState: string }).currentState = "error";
      }),
    });
    const result = await startCloudflareWorkersAiAsrAfterSelect({
      language: "ja-JP",
      existing: null,
      createController: () => created,
      captureSupported: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("start-failed");
    }
  });

  it("treats idle after start as a failed start", async () => {
    const created = fakeController({
      currentState: "idle",
      start: vi.fn(async () => undefined),
    });
    const onError = vi.fn();
    const result = await startCloudflareWorkersAiAsrAfterSelect({
      language: "ja-JP",
      existing: null,
      createController: () => created,
      captureSupported: true,
      onError,
    });
    expect(onError).toHaveBeenCalledWith(WORKERS_AI_ASR_PREPARING_JA);
    expect(result.ok).toBe(false);
  });

  it("accepts starting state immediately after start", async () => {
    const created = fakeController({
      start: vi.fn(async () => {
        (created as { currentState: string }).currentState = "starting";
      }),
    });
    const result = await startCloudflareWorkersAiAsrAfterSelect({
      language: "ja-JP",
      existing: null,
      createController: () => created,
      captureSupported: true,
    });
    expect(result.ok).toBe(true);
    expect(result.controller?.currentState).toBe("starting");
  });
});

