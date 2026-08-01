import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSpeechRecognitionConstructor,
  type SpeechRecognitionCallbacks,
  WebSpeechController,
} from "./web-speech";

type TestAlternative = { transcript: string; confidence: number };
type TestResult = {
  isFinal: boolean;
  length: number;
  0?: TestAlternative;
};
type TestResultList = {
  readonly length: number;
  readonly [index: number]: TestResult | undefined;
};
type TestResultEvent = {
  resultIndex: number;
  results: TestResultList;
};

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];

  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onresult: ((event: TestResultEvent) => void) | null = null;
  onerror: ((event: { error: string; message?: string }) => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;
  startFailure: Error | string | null = null;
  stopFailure: Error | string | null = null;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  start(): void {
    this.startCalls += 1;
    if (this.startFailure) {
      throw this.startFailure;
    }
  }

  stop(): void {
    this.stopCalls += 1;
    if (this.stopFailure) {
      throw this.stopFailure;
    }
  }

  abort(): void {
    this.abortCalls += 1;
  }
}

const result = (isFinal: boolean, transcript: string): TestResult => ({
  isFinal,
  length: transcript ? 1 : 0,
  ...(transcript ? { 0: { transcript, confidence: 0.9 } } : {}),
});

const results = (...items: Array<TestResult | undefined>): TestResultList =>
  items as unknown as TestResultList;

const installSpeech = (webkit = false): void => {
  const value = webkit
    ? { webkitSpeechRecognition: FakeSpeechRecognition }
    : { SpeechRecognition: FakeSpeechRecognition };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value,
  });
};

const callbacks = (): Required<SpeechRecognitionCallbacks> => ({
  onStateChange: vi.fn(),
  onTranscript: vi.fn(),
  onFinalText: vi.fn(),
  onError: vi.fn(),
});

afterEach(() => {
  FakeSpeechRecognition.instances = [];
  Reflect.deleteProperty(globalThis, "window");
});

describe("Web Speech feature detection", () => {
  it("is SSR-safe and leaves an unsupported controller inert", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(getSpeechRecognitionConstructor()).toBeNull();
    const stateChange = vi.fn();
    const controller = new WebSpeechController("ja-JP", { onStateChange: stateChange });
    expect(controller.supported).toBe(false);
    controller.start();
    controller.stop();
    controller.dispose();
    expect(stateChange).toHaveBeenCalledWith("idle");
  });

  it("prefers the standard constructor and falls back to webkit", () => {
    installSpeech();
    expect(getSpeechRecognitionConstructor()).toBe(FakeSpeechRecognition);
    installSpeech(true);
    expect(getSpeechRecognitionConstructor()).toBe(FakeSpeechRecognition);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {},
    });
    expect(getSpeechRecognitionConstructor()).toBeNull();
  });
});

describe("WebSpeechController", () => {
  it("streams final and interim segments, de-duplicates finals, and stops cleanly", () => {
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition).toBeDefined();
    expect(controller.supported).toBe(true);
    expect(recognition?.lang).toBe("ja-JP");
    expect(recognition?.continuous).toBe(true);
    expect(recognition?.interimResults).toBe(true);
    expect(recognition?.maxAlternatives).toBe(1);

    controller.setLanguage("  en-US  ");
    controller.setLanguage("   ");
    expect(recognition?.lang).toBe("en-US");

    controller.start();
    expect(events.onStateChange).toHaveBeenLastCalledWith("starting");
    recognition?.onstart?.();
    controller.start();
    expect(recognition?.startCalls).toBe(1);
    expect(events.onStateChange).toHaveBeenLastCalledWith("listening");
    recognition?.onend?.();
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
    controller.start();
    recognition?.onstart?.();

    recognition?.onresult?.({
      resultIndex: 1,
      results: results(result(true, "先に確定"), result(true, "新しい確定"), undefined),
    });
    expect(events.onTranscript).toHaveBeenLastCalledWith({
      finalText: "先に確定 新しい確定",
      interimText: "",
    });
    expect(events.onFinalText).toHaveBeenCalledTimes(1);
    expect(events.onFinalText).toHaveBeenLastCalledWith("新しい確定");

    recognition?.onresult?.({
      resultIndex: 0,
      results: results(result(true, "先に確定"), result(false, "  続き  "), result(false, "")),
    });
    expect(events.onTranscript).toHaveBeenLastCalledWith({
      finalText: "先に確定 新しい確定",
      interimText: "続き",
    });
    expect(events.onFinalText).toHaveBeenCalledTimes(1);

    recognition?.onresult?.({
      resultIndex: 0,
      results: results(result(true, "更新された確定")),
    });
    expect(events.onFinalText).toHaveBeenLastCalledWith("更新された確定");
    expect(events.onFinalText).toHaveBeenCalledTimes(2);

    controller.stop();
    expect(events.onStateChange).toHaveBeenLastCalledWith("stopping");
    expect(recognition?.stopCalls).toBe(1);
    recognition?.onerror?.({ error: "aborted", message: "ignored" });
    recognition?.onend?.();
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
    controller.stop();
    expect(recognition?.stopCalls).toBe(1);
    controller.dispose();
    expect(recognition?.abortCalls).toBe(1);
  });

  it("reports start, stop, and recognition errors with useful fallbacks", () => {
    installSpeech();
    const startEvents = callbacks();
    const startController = new WebSpeechController("ja-JP", startEvents);
    const startRecognition = FakeSpeechRecognition.instances[0];
    if (!startRecognition) {
      throw new Error("fake recognition was not constructed");
    }
    startRecognition.startFailure = new Error("start failed");
    startController.start();
    expect(startEvents.onStateChange).toHaveBeenLastCalledWith("error");
    expect(startEvents.onError).toHaveBeenLastCalledWith("start failed");

    const fallbackStartEvents = callbacks();
    const fallbackStartController = new WebSpeechController("ja-JP", fallbackStartEvents);
    const fallbackStartRecognition = FakeSpeechRecognition.instances[1];
    if (!fallbackStartRecognition) {
      throw new Error("fake recognition was not constructed");
    }
    fallbackStartRecognition.startFailure = "start failed";
    fallbackStartController.start();
    expect(fallbackStartEvents.onError).toHaveBeenLastCalledWith(
      "Speech recognition could not start",
    );

    const stopEvents = callbacks();
    const stopController = new WebSpeechController("ja-JP", stopEvents);
    const stopRecognition = FakeSpeechRecognition.instances[2];
    if (!stopRecognition) {
      throw new Error("fake recognition was not constructed");
    }
    stopController.start();
    stopRecognition.stopFailure = "stop failed";
    stopController.stop();
    expect(stopEvents.onStateChange).toHaveBeenLastCalledWith("error");
    expect(stopEvents.onError).toHaveBeenLastCalledWith("Speech recognition could not stop");

    stopRecognition.onerror?.({ error: "network", message: "  network unavailable  " });
    expect(stopEvents.onError).toHaveBeenLastCalledWith("network unavailable");
    stopRecognition.onerror?.({ error: "", message: "" });
    expect(stopEvents.onError).toHaveBeenLastCalledWith("Speech recognition failed");
    stopRecognition.onerror?.({ error: "aborted" });
    expect(stopEvents.onStateChange).toHaveBeenLastCalledWith("error");

    const errorStopEvents = callbacks();
    const errorStopController = new WebSpeechController("ja-JP", errorStopEvents);
    const errorStopRecognition = FakeSpeechRecognition.instances[3];
    if (!errorStopRecognition) {
      throw new Error("fake recognition was not constructed");
    }
    errorStopController.start();
    errorStopRecognition.stopFailure = new Error("stop failed");
    errorStopController.stop();
    expect(errorStopEvents.onError).toHaveBeenLastCalledWith("stop failed");
  });

  it("ignores duplicate lifecycle calls and supports callbacks being omitted", () => {
    installSpeech(true);
    const controller = new WebSpeechController("ja-JP");
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    controller.start();
    expect(recognition.startCalls).toBe(1);
    controller.dispose();
    controller.stop();
    expect(recognition.stopCalls).toBe(0);
    recognition.onresult?.({ resultIndex: 0, results: results(result(false, "表示")) });
    recognition.onend?.();
  });
});
