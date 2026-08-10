import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_VIBRATO_WARMUP_FAILURE_NOTICE_PREFIX,
  beginRecognitionListening,
} from "./recognition-listen";
import type { WorkersAiAsrController } from "./workers-ai-asr-controller";
import {
  ensureWorkersAiAsrController,
  gateWorkersAiAsrStart,
  startCloudflareWorkersAiAsrAfterSelect,
} from "./workers-ai-asr-session";
import {
  isWorkersAiAsrCaptureSupported,
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
  static instances: ThrowingDestinationAudioContext[] = [];

  state: AudioContextState = "running";
  sampleRate = 16_000;
  destination = { kind: "destination" as const };
  createdGains: FakeGainNode[] = [];
  createdProcessors: FakeScriptProcessor[] = [];
  destinationCreateCalls = 0;

  constructor() {
    ThrowingDestinationAudioContext.instances.push(this);
  }

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
    const tap = new FakeScriptProcessor();
    this.createdProcessors.push(tap);
    return tap;
  }

  createMediaStreamDestination(): never {
    this.destinationCreateCalls += 1;
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

/** Old PCM tap: connect ScriptProcessor → MediaStreamDestination. */
const legacyConnectTapToDestination = (audioContext: ThrowingDestinationAudioContext): void => {
  const source = audioContext.createMediaStreamSource({} as MediaStream);
  const tap = audioContext.createScriptProcessor(4096, 1, 1);
  source.connect(tap);
  tap.connect(audioContext.createMediaStreamDestination());
};

const installCapture = (AudioContextImpl = ThrowingDestinationAudioContext): MediaStream => {
  ThrowingDestinationAudioContext.instances = [];
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

/** Compare-page toggleListening after web-speech → workers-ai-asr select. */
const pageToggleStartAfterSelect = async (options: {
  existing: WorkersAiAsrController | null;
  onError: (message: string) => void;
  warmBrowserVibrato?: () => Promise<void>;
  onWarmupNotice?: (message: string) => void;
  requireVibratoWarmup?: boolean;
}) =>
  startCloudflareWorkersAiAsrAfterSelect({
    language: "ja-JP",
    endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
    auth: { scheme: "none" },
    existing: options.existing,
    callbacks: {
      disableSilero: true,
      onError: options.onError,
    },
    onError: options.onError,
    warmBrowserVibrato: options.warmBrowserVibrato,
    onWarmupNotice: options.onWarmupNotice,
    requireVibratoWarmup: options.requireVibratoWarmup,
  });

afterEach(() => {
  ThrowingDestinationAudioContext.instances = [];
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

describe("legacy select→start bugs (reproduction harness)", () => {
  it("asrRef null + gate without ensure setErrors 準備中 and never starts", () => {
    installCapture();
    const asrRef: { current: WorkersAiAsrController | null } = { current: null };
    const onError = vi.fn();
    const started = vi.fn();
    // web-speech → workers-ai-asr select, effect has not mounted asrRef yet
    const gate = gateWorkersAiAsrStart({
      controller: asrRef.current,
      captureSupported: true,
    });
    if (!gate.ok) {
      onError(gate.message);
    } else {
      started();
      void gate.controller.start();
    }
    expect(onError).toHaveBeenCalledWith(WORKERS_AI_ASR_PREPARING_JA);
    expect(started).not.toHaveBeenCalled();
  });

  it("snapshotted supported=false setErrors unsupported after mock mic appears", () => {
    expect(isWorkersAiAsrCaptureSupported()).toBe(false);
    const snapshotted = fakeController({
      supported: false,
      start: vi.fn(async () => undefined),
    });
    installCapture();
    expect(isWorkersAiAsrCaptureSupported()).toBe(true);
    const onError = vi.fn();
    const gate = gateWorkersAiAsrStart({
      controller: snapshotted,
      captureSupported: true,
    });
    if (!gate.ok) {
      onError(gate.message);
    } else {
      void snapshotted.start();
    }
    expect(onError).toHaveBeenCalledWith(WORKERS_AI_ASR_UNSUPPORTED_JA);
    expect(snapshotted.start).not.toHaveBeenCalled();
  });

  it("tap→destination throws InvalidStateError and cannot start without MediaRecorder", () => {
    installCapture();
    const audioContext = new ThrowingDestinationAudioContext();
    expect(() => legacyConnectTapToDestination(audioContext)).toThrow(/InvalidStateError/);
    expect(audioContext.destinationCreateCalls).toBe(1);
  });
});

describe("startCloudflareWorkersAiAsrAfterSelect", () => {
  it("web-speech → workers-ai-asr select → 認識を開始: mock mic, no setError, start() runs", async () => {
    installCapture();
    const asrRef: { current: WorkersAiAsrController | null } = { current: null };
    const onError = vi.fn();
    const warmBrowserVibrato = vi.fn(() => Promise.reject(new Error("IPADIC missing")));
    const onWarmupNotice = vi.fn();

    const result = await pageToggleStartAfterSelect({
      existing: asrRef.current,
      onError,
      warmBrowserVibrato,
      onWarmupNotice,
      requireVibratoWarmup: true,
    });
    asrRef.current = result.controller;
    await Promise.resolve();
    await Promise.resolve();

    expect(warmBrowserVibrato, "toggleListening must fire Vibrato warmup").toHaveBeenCalled();
    expect(onError, "select→認識を開始 must not setError").not.toHaveBeenCalled();
    expect(onWarmupNotice).toHaveBeenCalledWith(
      `${BROWSER_VIBRATO_WARMUP_FAILURE_NOTICE_PREFIX}IPADIC missing`,
    );
    expect(result.ok, "select→認識を開始 must succeed").toBe(true);
    if (!result.ok) {
      expect(result.message).not.toContain("準備");
      expect(result.message).not.toContain("非対応");
      expect(result.message).not.toBe(WORKERS_AI_ASR_PREPARING_JA);
      expect(result.message).not.toBe(WORKERS_AI_ASR_UNSUPPORTED_JA);
      expect(result.message).not.toBe(WORKERS_AI_ASR_GRAPH_UNAVAILABLE_JA);
    }
    expect(result.controller?.currentState).toBe("listening");
    expect(ThrowingDestinationAudioContext.instances[0]?.destinationCreateCalls ?? 0).toBe(0);
    const tap = ThrowingDestinationAudioContext.instances[0]?.createdProcessors[0];
    const destination = ThrowingDestinationAudioContext.instances[0]?.destination;
    expect(tap?.connections ?? []).not.toContain(destination);
    result.controller?.dispose();
  });

  it("refreshes live supported after construct-time false (no snapshot)", async () => {
    const stale = ensureWorkersAiAsrController({
      language: "ja-JP",
      existing: null,
      callbacks: { disableSilero: true },
    });
    expect(stale.supported).toBe(false);
    installCapture();
    const onError = vi.fn();
    const result = await pageToggleStartAfterSelect({
      existing: stale,
      onError,
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.controller?.currentState).toBe("listening");
    expect(result.controller?.supported).toBe(true);
    result.controller?.dispose();
  });

  it("still starts when composed with beginRecognitionListening like the compare page", async () => {
    installCapture();
    const asrRef: { current: WorkersAiAsrController | null } = { current: null };
    const onError = vi.fn();
    let startResult: Awaited<ReturnType<typeof startCloudflareWorkersAiAsrAfterSelect>> | undefined;
    beginRecognitionListening({
      provider: "workers-ai-asr",
      start: async () => {
        startResult = await pageToggleStartAfterSelect({
          existing: asrRef.current,
          onError,
        });
        asrRef.current = startResult.controller;
      },
      warmBrowserVibrato: async () => undefined,
      onWarmupError: onError,
      requireVibratoWarmup: true,
    });
    for (let tick = 0; tick < 10 && !startResult; tick += 1) {
      await Promise.resolve();
    }
    expect(onError).not.toHaveBeenCalled();
    expect(startResult?.ok).toBe(true);
    expect(startResult?.controller?.currentState).toBe("listening");
    startResult?.controller?.dispose();
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
      start: vi.fn(() => Promise.reject(denied)),
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
      start: vi.fn(() => {
        (created as { currentState: string }).currentState = "error";
        return Promise.resolve();
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
      start: vi.fn(() => {
        (created as { currentState: string }).currentState = "starting";
        return Promise.resolve();
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
