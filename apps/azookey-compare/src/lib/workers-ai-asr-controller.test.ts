import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blobToPcm16Mono } from "./pcm-wav";
import { transcribeWorkersAiAsr } from "./workers-ai-asr-client";
import { WorkersAiAsrController } from "./workers-ai-asr-controller";
import { SILERO_FALLBACK_NOTICE_JA } from "./workers-ai-asr-silero-paths";
import { type VadEngine, type VadResult, WORKERS_AI_ASR_VAD_DEFAULTS } from "./workers-ai-asr-vad";

vi.mock("./workers-ai-asr-client", () => ({
  transcribeWorkersAiAsr: vi.fn(async () => ({ text: "こんにちは" })),
}));

vi.mock("./pcm-wav", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pcm-wav")>();
  return {
    ...actual,
    blobToPcm16Mono: vi.fn(async () => new Int16Array(16_000)),
  };
});

const LOUD_DB = -20;
const SILENT_DB = -80;
const START_MS = WORKERS_AI_ASR_VAD_DEFAULTS.segmentStartSpeechMs;
const END_MS = WORKERS_AI_ASR_VAD_DEFAULTS.checkSilenceMs;

type FakeTrack = { stop: ReturnType<typeof vi.fn> };

class FakeMediaStreamSource {
  connections: unknown[] = [];
  connect(node: unknown): void {
    this.connections.push(node);
  }
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

class FakeAnalyser {
  fftSize = 2048;
  connections: unknown[] = [];
  connect(node: unknown): void {
    this.connections.push(node);
  }
  disconnect(): void {}
  getFloatTimeDomainData(buffer: Float32Array): void {
    buffer.fill(0);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: AudioContextState = "running";
  sampleRate = 16_000;
  closeCalls = 0;
  resumeCalls = 0;
  destination = { kind: "destination" as const };
  createdGains: FakeGainNode[] = [];
  createdProcessors: FakeScriptProcessor[] = [];
  createdAnalysers: FakeAnalyser[] = [];
  createdSources: FakeMediaStreamSource[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource(_stream: MediaStream): FakeMediaStreamSource {
    const source = new FakeMediaStreamSource();
    this.createdSources.push(source);
    return source;
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

  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.createdAnalysers.push(analyser);
    return analyser;
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.state = "closed";
    return Promise.resolve();
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];

  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: { error?: { message?: string } }) => void) | null = null;
  onstop: (() => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  stream: MediaStream;

  constructor(stream: MediaStream) {
    this.stream = stream;
    FakeMediaRecorder.instances.push(this);
  }

  start(_timesliceMs?: number): void {
    this.startCalls += 1;
    this.state = "recording";
  }

  stop(): void {
    this.stopCalls += 1;
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }),
    });
    this.onstop?.();
  }
}

const fakeTrack = (): FakeTrack => ({ stop: vi.fn() });

const installBrowser = (
  track = fakeTrack(),
  AudioContextImpl: typeof FakeAudioContext = FakeAudioContext,
): MediaStream => {
  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
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
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    writable: true,
    value: FakeMediaRecorder,
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
  return stream;
};

const callbacks = () => ({
  onStateChange: vi.fn(),
  onTranscript: vi.fn(),
  onVadNotice: vi.fn(),
  onFinalText: vi.fn(),
  onUtteranceFinal: vi.fn(),
  onError: vi.fn(),
});

const startController = async (vadEngine?: VadEngine) => {
  const events = callbacks();
  const controller = new WorkersAiAsrController("ja-JP", {
    language: "ja-JP",
    endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
    disableSilero: !vadEngine,
    vadEngine,
    ...events,
  });
  await controller.start();
  return { controller, events };
};

const mockSileroEngine = (isSpeech = true): VadEngine => ({
  process: vi.fn(
    (_samples: Float32Array): Promise<VadResult> =>
      Promise.resolve({
        probability: isSpeech ? 0.92 : 0.01,
        isSpeech,
      }),
  ),
  dispose: vi.fn(),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(transcribeWorkersAiAsr).mockReset();
  vi.mocked(transcribeWorkersAiAsr).mockResolvedValue({ text: "こんにちは" });
  vi.mocked(blobToPcm16Mono).mockReset();
  vi.mocked(blobToPcm16Mono).mockResolvedValue(new Int16Array(16_000));
});

afterEach(() => {
  vi.useRealTimers();
  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "AudioContext");
  Reflect.deleteProperty(globalThis, "MediaRecorder");
  Reflect.deleteProperty(globalThis, "navigator");
});

describe("WorkersAiAsrController VAD session", () => {
  it("is inert without MediaRecorder / getUserMedia", () => {
    const events = callbacks();
    const controller = new WorkersAiAsrController("ja-JP", { language: "ja-JP", ...events });
    expect(controller.supported).toBe(false);
    void controller.start();
    controller.stop();
    controller.dispose();
    expect(events.onStateChange).toHaveBeenCalledWith("idle");
  });

  it("transcribes on VAD utterance-end, clears 録音中…, and records the next utterance without stop", async () => {
    installBrowser();
    const { controller, events } = await startController();
    expect(controller.currentState).toBe("listening");
    expect(FakeMediaRecorder.instances).toHaveLength(0);

    await controller.ingestVadFrame(LOUD_DB, START_MS);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(events.onTranscript).toHaveBeenCalledWith({ interimText: "録音中…" });

    await controller.ingestVadFrame(SILENT_DB, END_MS);
    expect(transcribeWorkersAiAsr).toHaveBeenCalledTimes(1);
    const [wav, options] = vi.mocked(transcribeWorkersAiAsr).mock.calls[0] ?? [];
    expect(wav).toBeInstanceOf(File);
    expect((wav as File).name).toBe("utterance.wav");
    expect((wav as File).type).toBe("audio/wav");
    expect(options).toMatchObject({
      endpointUrl: "https://compare.example/v1/asr/workers-ai/transcriptions",
      language: "ja-JP",
    });
    expect(events.onUtteranceFinal).toHaveBeenCalledWith({ text: "こんにちは", audioSeconds: 1 });
    expect(events.onUtteranceFinal.mock.calls[0]?.[0].audioSeconds).not.toBe(16_000);
    expect(events.onFinalText).toHaveBeenCalledWith("こんにちは");
    expect(events.onTranscript).toHaveBeenCalledWith({ interimText: "認識中…" });
    expect(events.onTranscript).toHaveBeenLastCalledWith({ interimText: "" });
    expect(controller.currentState).toBe("listening");

    vi.mocked(transcribeWorkersAiAsr).mockResolvedValueOnce({ text: "きょうははれ" });
    await controller.ingestVadFrame(LOUD_DB, START_MS);
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    await controller.ingestVadFrame(SILENT_DB, END_MS);
    expect(transcribeWorkersAiAsr).toHaveBeenCalledTimes(2);
    expect(events.onUtteranceFinal).toHaveBeenLastCalledWith({
      text: "きょうははれ",
      audioSeconds: 1,
    });
    expect(controller.currentState).toBe("listening");
    controller.dispose();
  });

  it("reports audioSeconds from PCM length / 16 kHz, not sample count", async () => {
    installBrowser();
    vi.mocked(blobToPcm16Mono).mockResolvedValueOnce(new Int16Array(48_000));
    const { controller, events } = await startController();
    await controller.ingestVadFrame(LOUD_DB, START_MS);
    await controller.ingestVadFrame(SILENT_DB, END_MS);
    expect(events.onUtteranceFinal).toHaveBeenCalledWith({ text: "こんにちは", audioSeconds: 3 });
    expect(events.onUtteranceFinal.mock.calls[0]?.[0].audioSeconds).not.toBe(48_000);
    controller.dispose();
  });

  it("transcribes when a mock Silero engine marks speech then silence", async () => {
    installBrowser();
    const engine = mockSileroEngine(true);
    const { controller, events } = await startController(engine);
    const speech = Float32Array.from({ length: 512 }, () => 0.4);
    const silenceEngine: VadEngine = {
      process: vi.fn(() => Promise.resolve({ probability: 0.02, isSpeech: false })),
      dispose: vi.fn(),
    };
    await controller.ingestSamples(speech);
    await controller.ingestSamples(speech);
    await controller.ingestSamples(speech);
    expect(events.onTranscript).toHaveBeenCalledWith({ interimText: "録音中…" });
    controller.dispose();

    const second = await startController(silenceEngine);
    second.controller.dispose();
    expect(engine.dispose).toHaveBeenCalled();
  });

  it("flushes in-progress speech once on user stop and goes idle", async () => {
    installBrowser();
    const { controller, events } = await startController();
    await controller.ingestVadFrame(LOUD_DB, START_MS);
    expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");

    await controller.stop();

    expect(transcribeWorkersAiAsr).toHaveBeenCalledTimes(1);
    expect(events.onUtteranceFinal).toHaveBeenCalledTimes(1);
    expect(controller.currentState).toBe("idle");
    expect(FakeMediaRecorder.instances[0]?.stopCalls).toBe(1);

    await controller.ingestVadFrame(LOUD_DB, START_MS);
    await controller.ingestVadFrame(SILENT_DB, END_MS);
    expect(transcribeWorkersAiAsr).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("does not transcribe a silence-only session on user stop", async () => {
    const track = fakeTrack();
    installBrowser(track);
    const { controller, events } = await startController();
    await controller.ingestVadFrame(SILENT_DB, 5_000);
    expect(FakeMediaRecorder.instances).toHaveLength(0);

    await controller.stop();

    expect(transcribeWorkersAiAsr).not.toHaveBeenCalled();
    expect(events.onUtteranceFinal).not.toHaveBeenCalled();
    expect(controller.currentState).toBe("idle");
    expect(track.stop).toHaveBeenCalled();
    controller.dispose();
  });

  it("discards a noise blip without transcribing", async () => {
    installBrowser();
    const { controller, events } = await startController();
    await controller.ingestVadFrame(LOUD_DB, 64);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(events.onTranscript).not.toHaveBeenCalledWith({ interimText: "録音中…" });
    await controller.ingestVadFrame(SILENT_DB, 32);
    expect(events.onTranscript).toHaveBeenCalledWith({ interimText: "" });
    expect(transcribeWorkersAiAsr).not.toHaveBeenCalled();
    expect(controller.currentState).toBe("listening");
    controller.dispose();
  });

  it("updates language on the existing controller", async () => {
    installBrowser();
    const { controller } = await startController();
    controller.setLanguage("en-US");
    await controller.ingestVadFrame(LOUD_DB, START_MS);
    await controller.ingestVadFrame(SILENT_DB, END_MS);
    expect(vi.mocked(transcribeWorkersAiAsr).mock.calls[0]?.[1]).toMatchObject({
      language: "en-US",
    });
    controller.dispose();
  });

  it("does not error when disposed while start() awaits getUserMedia", async () => {
    installBrowser();
    let releaseMedia: ((stream: MediaStream) => void) | undefined;
    const stream = { getTracks: () => [fakeTrack()] } as unknown as MediaStream;
    (
      navigator as Navigator & { mediaDevices: { getUserMedia: ReturnType<typeof vi.fn> } }
    ).mediaDevices.getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          releaseMedia = resolve;
        }),
    );
    const events = callbacks();
    const controller = new WorkersAiAsrController("ja-JP", {
      language: "ja-JP",
      disableSilero: true,
      ...events,
    });
    const starting = controller.start();
    expect(controller.currentState).toBe("starting");
    controller.dispose();
    releaseMedia?.(stream);
    await starting;
    expect(events.onError).not.toHaveBeenCalled();
    expect(controller.currentState).toBe("idle");
    expect(events.onStateChange.mock.calls.map((call) => call[0])).not.toContain("listening");
    expect(events.onStateChange.mock.calls.map((call) => call[0])).not.toContain("error");
  });

  it("does not fail after dispose when getUserMedia rejects", async () => {
    installBrowser();
    let rejectMedia: ((error: Error) => void) | undefined;
    (
      navigator as Navigator & { mediaDevices: { getUserMedia: ReturnType<typeof vi.fn> } }
    ).mediaDevices.getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((_, reject) => {
          rejectMedia = reject;
        }),
    );
    const events = callbacks();
    const controller = new WorkersAiAsrController("ja-JP", {
      language: "ja-JP",
      disableSilero: true,
      ...events,
    });
    const starting = controller.start();
    controller.dispose();
    rejectMedia?.(new Error("permission denied"));
    await starting;
    expect(events.onError).not.toHaveBeenCalled();
    expect(controller.currentState).toBe("idle");
  });

  it("listens with energy first then swaps in Silero", async () => {
    installBrowser();
    let releaseSilero: ((engine: VadEngine) => void) | undefined;
    const engine = mockSileroEngine(true);
    const events = callbacks();
    const controller = new WorkersAiAsrController("ja-JP", {
      language: "ja-JP",
      sileroLoader: () =>
        new Promise<VadEngine>((resolve) => {
          releaseSilero = resolve;
        }),
      ...events,
    });
    await controller.start();
    expect(controller.currentState).toBe("listening");
    expect(controller.vadBackend).toBe("energy");
    expect(events.onError).not.toHaveBeenCalled();
    for (let tick = 0; tick < 10 && !releaseSilero; tick += 1) {
      await Promise.resolve();
    }
    releaseSilero?.(engine);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.vadBackend).toBe("silero");
    expect(controller.currentState).toBe("listening");
    controller.dispose();
    expect(engine.dispose).toHaveBeenCalled();
  });

  it("does not swap Silero onto a disposed controller", async () => {
    installBrowser();
    let releaseSilero: ((engine: VadEngine) => void) | undefined;
    const engine = mockSileroEngine(true);
    const events = callbacks();
    const controller = new WorkersAiAsrController("ja-JP", {
      language: "ja-JP",
      sileroLoader: () =>
        new Promise<VadEngine>((resolve) => {
          releaseSilero = resolve;
        }),
      ...events,
    });
    await controller.start();
    expect(controller.vadBackend).toBe("energy");
    for (let tick = 0; tick < 10 && !releaseSilero; tick += 1) {
      await Promise.resolve();
    }
    controller.dispose();
    releaseSilero?.(engine);
    await Promise.resolve();
    await Promise.resolve();
    expect(events.onError).not.toHaveBeenCalled();
    expect(controller.currentState).toBe("idle");
    expect(engine.dispose).toHaveBeenCalled();
    expect(controller.vadBackend).toBe("energy");
  });

  it("falls back to energy VAD when Silero process throws and stays listening", async () => {
    installBrowser();
    const engine: VadEngine = {
      process: vi.fn(() => Promise.reject(new Error("ORT tensor"))),
      dispose: vi.fn(),
    };
    const { controller, events } = await startController(engine);
    expect(controller.vadBackend).toBe("silero");
    await controller.ingestSamples(Float32Array.from({ length: 512 }, () => 0.4));
    expect(events.onVadNotice).toHaveBeenCalledWith(SILERO_FALLBACK_NOTICE_JA);
    expect(controller.vadBackend).toBe("energy");
    expect(controller.currentState).toBe("listening");
    expect(events.onError).not.toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalled();
    controller.dispose();
  });

  it("mutes the PCM tap instead of routing ScriptProcessor to speakers", async () => {
    installBrowser();
    const { controller, events } = await startController();
    const context = FakeAudioContext.instances[0];
    const tap = context?.createdProcessors[0];
    const gain = context?.createdGains[0];
    expect(tap).toBeDefined();
    expect(gain).toBeDefined();
    expect(gain?.gain.value).toBe(0);
    expect(tap?.connections).toContain(gain);
    expect(tap?.connections).not.toContain(context?.destination);
    expect(gain?.connections).toContain(context?.destination);
    expect(events.onError).not.toHaveBeenCalled();
    expect(controller.currentState).toBe("listening");
    controller.dispose();
  });

  it("falls back to Analyser PCM when ScriptProcessor is missing", async () => {
    class AnalyserOnlyContext extends FakeAudioContext {
      createScriptProcessor = undefined as unknown as FakeAudioContext["createScriptProcessor"];
    }
    installBrowser(fakeTrack(), AnalyserOnlyContext);
    const { controller, events } = await startController();
    const context = FakeAudioContext.instances[0];
    expect(context?.createdAnalysers).toHaveLength(1);
    expect(context?.createdProcessors).toHaveLength(0);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(controller.currentState).toBe("listening");
    expect(events.onError).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("still listens when the audio graph throws", async () => {
    class ThrowingAudioContext extends FakeAudioContext {
      createMediaStreamSource(): never {
        throw new Error("graph exploded");
      }
    }
    installBrowser(fakeTrack(), ThrowingAudioContext);
    const { controller, events } = await startController();
    expect(controller.currentState).toBe("listening");
    expect(events.onError).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances.length).toBeGreaterThan(0);
    controller.dispose();
  });

  it("surfaces getUserMedia failure", async () => {
    installBrowser();
    (
      navigator as Navigator & { mediaDevices: { getUserMedia: ReturnType<typeof vi.fn> } }
    ).mediaDevices.getUserMedia = vi.fn(() => Promise.reject(new Error("permission denied")));
    const events = callbacks();
    const controller = new WorkersAiAsrController("ja-JP", {
      language: "ja-JP",
      disableSilero: true,
      ...events,
    });
    await controller.start();
    expect(controller.currentState).toBe("error");
    expect(events.onError).toHaveBeenCalledWith("permission denied");
    controller.dispose();
  });

  it("disposes the Silero engine when leaving Workers AI ASR", async () => {
    installBrowser();
    const engine = mockSileroEngine(true);
    const { controller } = await startController(engine);
    expect(controller.vadBackend).toBe("silero");
    controller.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(controller.vadBackend).toBe("energy");
    expect(controller.currentState).toBe("idle");
  });

  it("notifies Japanese fallback when Silero WASM fails to load", async () => {
    installBrowser();
    const events = callbacks();
    const controller = new WorkersAiAsrController("ja-JP", {
      language: "ja-JP",
      sileroLoader: () => Promise.reject(new Error("ort missing")),
      ...events,
    });
    await controller.start();
    expect(controller.currentState).toBe("listening");
    expect(controller.vadBackend).toBe("energy");
    await Promise.resolve();
    await Promise.resolve();
    expect(events.onVadNotice).toHaveBeenCalledWith(SILERO_FALLBACK_NOTICE_JA);
    expect(controller.vadBackend).toBe("energy");
    expect(events.onError).not.toHaveBeenCalled();
    controller.dispose();
  });
});
