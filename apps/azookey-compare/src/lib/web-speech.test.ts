import { afterEach, describe, expect, it, vi } from "vitest";
import { getSpeechRecognitionConstructor, WebSpeechController } from "./web-speech";

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
  abortFailure: Error | string | null = null;
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
    if (this.abortFailure) {
      throw this.abortFailure;
    }
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

const callbacks = () => ({
  onStateChange: vi.fn(),
  onTranscript: vi.fn(),
  onFinalText: vi.fn(),
  onUtteranceFinal: vi.fn(),
  onRecognitionEnded: vi.fn(),
  onError: vi.fn(),
});

afterEach(() => {
  FakeSpeechRecognition.instances = [];
  Reflect.deleteProperty(globalThis, "window");
  vi.useRealTimers();
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

  it("falls back to WebKit when the standard constructor is stale", () => {
    class BrokenStandard extends FakeSpeechRecognition {
      constructor() {
        super();
        throw new Error("standard service disabled");
      }
    }
    class WorkingWebKit extends FakeSpeechRecognition {}
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        SpeechRecognition: BrokenStandard,
        webkitSpeechRecognition: WorkingWebKit,
      },
    });
    const controller = new WebSpeechController("ja-JP");
    expect(FakeSpeechRecognition.instances.at(-1)).toBeInstanceOf(WorkingWebKit);
    controller.dispose();
  });

  it("surfaces constructor failure only when every browser implementation fails", () => {
    class BrokenStandard extends FakeSpeechRecognition {
      constructor() {
        super();
        throw new Error("standard failed");
      }
    }
    class BrokenWebKit extends FakeSpeechRecognition {
      constructor() {
        super();
        throw new Error("webkit failed");
      }
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { SpeechRecognition: BrokenStandard, webkitSpeechRecognition: BrokenWebKit },
    });
    expect(() => new WebSpeechController("ja-JP")).toThrow("webkit failed");
  });
});

describe("WebSpeechController", () => {
  it("updates the active recognition language without recreating the controller", () => {
    installSpeech();
    const controller = new WebSpeechController("ja-JP");
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    controller.start();
    recognition.onstart?.();
    controller.setLanguage("j");
    controller.setLanguage("ja");
    controller.setLanguage("ja-JP");

    expect(FakeSpeechRecognition.instances).toHaveLength(1);
    expect(recognition.lang).toBe("ja-JP");
    controller.dispose();
  });

  it("restarts a continuous session after an unexpected end", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    recognition.onend?.();
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
    vi.advanceTimersByTime(99);
    expect(recognition.startCalls).toBe(1);
    vi.advanceTimersByTime(1);
    expect(recognition.startCalls).toBe(1);
    vi.advanceTimersByTime(49);
    vi.advanceTimersByTime(1);
    expect(recognition.startCalls).toBe(2);
    recognition.onstart?.();
    controller.stop();
    recognition.onend?.();
    expect(events.onStateChange).toHaveBeenLastCalledWith("stopping");
    vi.advanceTimersByTime(100);
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
    expect(events.onRecognitionEnded).toHaveBeenCalledWith({
      reason: "user-stop",
      finalText: "",
      interimText: "",
    });
    vi.runOnlyPendingTimers();
    expect(recognition.startCalls).toBe(2);
    controller.dispose();
  });

  it("keeps a final result queued after end until the bounded flush grace expires", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    recognition.onend?.();

    // WebKit can enqueue this final result after `end`. It must be delivered
    // before the old generation is flushed and a replacement is started.
    recognition.onresult?.({ resultIndex: 0, results: results(result(true, "遅延した確定")) });
    expect(events.onFinalText).toHaveBeenCalledWith("遅延した確定");
    expect(events.onUtteranceFinal).toHaveBeenCalledWith({
      text: "遅延した確定",
      finalText: "遅延した確定",
      cause: "browser-final",
      resultIndex: 0,
    });
    expect(events.onRecognitionEnded).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(recognition.startCalls).toBe(1);
    vi.advanceTimersByTime(1);
    expect(recognition.startCalls).toBe(1);
    vi.advanceTimersByTime(50);
    expect(recognition.startCalls).toBe(2);
    controller.dispose();
  });

  it("cancels a pending end flush restart when stop is requested from idle", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    recognition.onend?.();
    controller.stop();
    vi.advanceTimersByTime(200);
    expect(recognition.startCalls).toBe(1);
    expect(events.onRecognitionEnded).toHaveBeenCalledWith({
      reason: "user-stop",
      finalText: "",
      interimText: "",
    });
    controller.dispose();
  });

  it("keeps a queued final when stop and start overlap the old session", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    controller.stop();
    recognition.onend?.();
    controller.start();
    recognition.onstart?.();

    // The old session's result was already queued across stop/start. It must
    // still reach the final-text lane rather than being lost by a buffer reset.
    recognition.onresult?.({ resultIndex: 0, results: results(result(true, "停止直前の確定")) });
    expect(events.onFinalText).toHaveBeenCalledWith("停止直前の確定");
    expect(events.onUtteranceFinal).toHaveBeenCalledWith({
      text: "停止直前の確定",
      finalText: "停止直前の確定",
      cause: "browser-final",
      resultIndex: 0,
    });
    controller.dispose();
  });

  it("promotes an interim-only utterance after end, then restarts continuously", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    recognition.onresult?.({ resultIndex: 0, results: results(result(false, "途中の発話")) });
    expect(events.onFinalText).not.toHaveBeenCalled();
    recognition.onend?.();
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
    vi.advanceTimersByTime(100);
    expect(events.onFinalText).toHaveBeenCalledWith("途中の発話");
    expect(events.onUtteranceFinal).toHaveBeenCalledWith({
      text: "途中の発話",
      finalText: "途中の発話",
      cause: "end-flush",
      resultIndex: 0,
    });
    expect(events.onTranscript).toHaveBeenLastCalledWith({
      finalText: "途中の発話",
      interimText: "",
    });
    expect(events.onRecognitionEnded).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(recognition.startCalls).toBe(2);
    controller.dispose();
  });

  it("commits leftover interim when stop arrives before any browser final", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    recognition.onresult?.({ resultIndex: 0, results: results(result(false, "  まだ途中  ")) });
    expect(events.onFinalText).not.toHaveBeenCalled();
    controller.stop();
    expect(events.onStateChange).toHaveBeenLastCalledWith("stopping");
    recognition.onend?.();
    expect(events.onStateChange).toHaveBeenLastCalledWith("stopping");
    expect(events.onFinalText).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(events.onFinalText).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(events.onFinalText).toHaveBeenCalledWith("まだ途中");
    expect(events.onUtteranceFinal).toHaveBeenCalledWith({
      text: "まだ途中",
      finalText: "まだ途中",
      cause: "stop-flush",
      resultIndex: 0,
    });
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
    expect(events.onRecognitionEnded).toHaveBeenCalledWith({
      reason: "user-stop",
      finalText: "まだ途中",
      interimText: "",
    });
    vi.advanceTimersByTime(200);
    expect(recognition.startCalls).toBe(1);
    controller.dispose();
  });

  it("emits a browser final then ends without duplicating the utterance", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    recognition.onresult?.({ resultIndex: 0, results: results(result(true, "確定した発話")) });
    expect(events.onFinalText).toHaveBeenCalledTimes(1);
    expect(events.onUtteranceFinal).toHaveBeenCalledWith({
      text: "確定した発話",
      finalText: "確定した発話",
      cause: "browser-final",
      resultIndex: 0,
    });
    controller.stop();
    recognition.onend?.();
    vi.advanceTimersByTime(100);
    expect(events.onFinalText).toHaveBeenCalledTimes(1);
    expect(events.onUtteranceFinal).toHaveBeenCalledTimes(1);
    expect(events.onTranscript).toHaveBeenLastCalledWith({
      finalText: "確定した発話",
      interimText: "",
    });
    expect(events.onRecognitionEnded).toHaveBeenCalledWith({
      reason: "user-stop",
      finalText: "確定した発話",
      interimText: "",
    });
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
    controller.dispose();
  });

  it("keeps a late final after end and does not discard it on continuous restart", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    recognition.onresult?.({ resultIndex: 0, results: results(result(false, "遅延前")) });
    recognition.onend?.();
    recognition.onresult?.({ resultIndex: 0, results: results(result(true, "遅延した確定")) });
    expect(events.onFinalText).toHaveBeenCalledWith("遅延した確定");
    expect(events.onUtteranceFinal).toHaveBeenLastCalledWith({
      text: "遅延した確定",
      finalText: "遅延した確定",
      cause: "browser-final",
      resultIndex: 0,
    });
    vi.advanceTimersByTime(100);
    expect(events.onFinalText).toHaveBeenCalledTimes(1);
    expect(events.onRecognitionEnded).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(recognition.startCalls).toBe(2);
    recognition.onstart?.();
    recognition.onresult?.({ resultIndex: 0, results: results(result(true, "次の発話")) });
    expect(events.onFinalText).toHaveBeenLastCalledWith("次の発話");
    controller.dispose();
  });

  it("leaves stopping when end never arrives after stop", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    recognition.onresult?.({ resultIndex: 0, results: results(result(false, "固着しそう")) });
    controller.stop();
    controller.stop();
    expect(events.onStateChange).toHaveBeenLastCalledWith("stopping");
    vi.advanceTimersByTime(1_999);
    expect(events.onStateChange).toHaveBeenLastCalledWith("stopping");
    expect(events.onFinalText).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recognition.abortCalls).toBe(1);
    expect(events.onFinalText).toHaveBeenCalledWith("固着しそう");
    expect(events.onUtteranceFinal).toHaveBeenCalledWith({
      text: "固着しそう",
      finalText: "固着しそう",
      cause: "stop-flush",
      resultIndex: 0,
    });
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
    expect(events.onRecognitionEnded).toHaveBeenCalledWith({
      reason: "timeout",
      finalText: "固着しそう",
      interimText: "",
    });
    controller.dispose();
  });

  it("ignores the old end queued after the replacement session starts", () => {
    vi.useFakeTimers();
    installSpeech();
    const controller = new WebSpeechController("ja-JP");
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    controller.stop();
    controller.start();

    // Deferred start waits for the stop `end` and grace flush before the
    // replacement service calls `start()` again.
    recognition.onend?.();
    vi.advanceTimersByTime(150);
    expect(recognition.startCalls).toBe(2);
    recognition.onstart?.();

    // The superseded service can deliver `end` after the new start callback.
    recognition.onend?.();
    vi.advanceTimersByTime(200);
    expect(recognition.startCalls).toBe(2);
    controller.dispose();
  });

  it("recovers from a transient recognition error and leaves fatal errors stopped", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    recognition.onerror?.({ error: "network" });
    expect(events.onError).toHaveBeenLastCalledWith("network");
    vi.advanceTimersByTime(50);
    expect(recognition.startCalls).toBe(2);
    recognition.onstart?.();
    recognition.onerror?.({ error: "not-allowed", message: "permission denied" });
    // Browsers dispatch `end` after a permission/policy error. That terminal
    // event must not re-arm the continuous restart loop.
    recognition.onend?.();
    vi.runOnlyPendingTimers();
    expect(recognition.startCalls).toBe(2);
    expect(events.onError).toHaveBeenLastCalledWith("permission denied");
    controller.dispose();
  });

  it("cancels a pending transient retry when a fatal error follows", () => {
    vi.useFakeTimers();
    installSpeech();
    const controller = new WebSpeechController("ja-JP");
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    recognition.onerror?.({ error: "network" });
    // A browser may report the permission/policy refusal before the queued
    // network backoff timer has fired. Neither that timer nor the end event
    // should resurrect a denied session.
    recognition.onerror?.({ error: "not-allowed" });
    recognition.onend?.();
    vi.runOnlyPendingTimers();
    expect(recognition.startCalls).toBe(1);
    controller.dispose();
  });

  it("streams final and interim segments, de-duplicates finals, and stops cleanly", () => {
    vi.useFakeTimers();
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
    expect(events.onFinalText).toHaveBeenCalledTimes(2);
    expect(events.onFinalText).toHaveBeenLastCalledWith("新しい確定");
    expect(events.onUtteranceFinal).toHaveBeenNthCalledWith(1, {
      text: "先に確定",
      finalText: "先に確定 新しい確定",
      cause: "browser-final",
      resultIndex: 0,
    });
    expect(events.onUtteranceFinal).toHaveBeenNthCalledWith(2, {
      text: "新しい確定",
      finalText: "先に確定 新しい確定",
      cause: "browser-final",
      resultIndex: 1,
    });

    recognition?.onresult?.({
      resultIndex: 0,
      results: results(result(true, "先に確定"), result(false, "  続き  "), result(false, "")),
    });
    expect(events.onTranscript).toHaveBeenLastCalledWith({
      finalText: "先に確定 新しい確定",
      interimText: "続き",
    });
    expect(events.onFinalText).toHaveBeenCalledTimes(2);

    recognition?.onresult?.({
      resultIndex: 0,
      results: results(result(true, "更新された確定")),
    });
    expect(events.onFinalText).toHaveBeenLastCalledWith("更新された確定");
    expect(events.onFinalText).toHaveBeenCalledTimes(3);

    // A browser may revise an earlier final while resultIndex points at a
    // later segment. The revision is still a new final and must be forwarded.
    recognition?.onresult?.({
      resultIndex: 2,
      results: results(result(true, "さらに更新された確定")),
    });
    expect(events.onFinalText).toHaveBeenLastCalledWith("さらに更新された確定");
    expect(events.onFinalText).toHaveBeenCalledTimes(4);

    controller.stop();
    expect(events.onStateChange).toHaveBeenLastCalledWith("stopping");
    expect(recognition?.stopCalls).toBe(1);
    recognition?.onerror?.({ error: "aborted", message: "ignored" });
    recognition?.onend?.();
    expect(events.onStateChange).toHaveBeenLastCalledWith("stopping");
    vi.advanceTimersByTime(100);
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
    expect(events.onRecognitionEnded).toHaveBeenCalledWith({
      reason: "user-stop",
      finalText: "さらに更新された確定 新しい確定",
      interimText: "",
    });
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

  it("does not consume a real end event when abort fails during restart", () => {
    vi.useFakeTimers();
    installSpeech();
    const controller = new WebSpeechController("ja-JP");
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    controller.stop();
    recognition.abortFailure = "abort failed";
    controller.start();
    expect(recognition.startCalls).toBe(1);

    // This onend is not ignored: abort did not succeed, so it belongs to the
    // active browser service and must schedule the ordinary restart path.
    recognition.onend?.();
    vi.advanceTimersByTime(150);
    expect(recognition.startCalls).toBe(2);
    controller.dispose();
  });

  it("retries a recoverable synchronous start failure instead of leaving recognition errored", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    // WebKit can synchronously reject start() while it is still releasing a
    // prior service session. The caller still requested continuous capture, so
    // the existing restart policy must make a later attempt.
    recognition.startFailure = new Error("recognition service busy");
    controller.start();
    expect(events.onStateChange).toHaveBeenLastCalledWith("error");
    expect(recognition.startCalls).toBe(1);

    recognition.startFailure = null;
    vi.advanceTimersByTime(50);
    expect(recognition.startCalls).toBe(2);
    recognition.onstart?.();
    expect(events.onStateChange).toHaveBeenLastCalledWith("listening");
  });

  it("surfaces a start that never produces a browser lifecycle event", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    // Some environments expose the constructor but never grant/resolve the
    // microphone service. A watchdog must leave the UI recoverable instead of
    // keeping the button on "starting" forever.
    controller.start();
    expect(events.onStateChange).toHaveBeenLastCalledWith("starting");
    vi.advanceTimersByTime(10_000);
    expect(events.onStateChange).toHaveBeenLastCalledWith("error");
    expect(events.onError).toHaveBeenLastCalledWith(
      "Speech recognition did not start; check microphone permission and site security settings",
    );
    recognition.onstart?.();
    expect(events.onStateChange).toHaveBeenLastCalledWith("error");
    expect(events.onRecognitionEnded).toHaveBeenCalledWith({
      reason: "timeout",
      finalText: "",
      interimText: "",
    });
    recognition.onend?.();
    vi.runOnlyPendingTimers();
    expect(recognition.startCalls).toBe(1);
    expect(events.onStateChange).toHaveBeenLastCalledWith("error");
    controller.dispose();
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

  it("isolates throwing observers and best-effort browser abort failures", () => {
    vi.useFakeTimers();
    installSpeech();
    const controller = new WebSpeechController("ja-JP", {
      onStateChange: () => {
        throw new Error("state observer");
      },
      onTranscript: () => {
        throw new Error("transcript observer");
      },
      onFinalText: () => {
        throw new Error("final observer");
      },
      onUtteranceFinal: () => {
        throw new Error("utterance observer");
      },
      onRecognitionEnded: () => {
        throw new Error("ended observer");
      },
      onError: () => {
        throw new Error("error observer");
      },
    });
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    recognition.startFailure = "start failed";
    controller.start();
    recognition.startFailure = null;
    controller.start();
    recognition.onstart?.();
    recognition.onerror?.({ error: "network" });
    recognition.onresult?.({ resultIndex: 0, results: results(result(true, "確定")) });
    recognition.abortFailure = "abort failed";
    controller.start();
    recognition.onend?.();
    controller.dispose();
    recognition.onend?.();
    recognition.onerror?.({ error: "network" });
    vi.runOnlyPendingTimers();
  });

  it("ignores stale lifecycle events and guards restart timers", () => {
    vi.useFakeTimers();
    installSpeech();
    const controller = new WebSpeechController("ja-JP");
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    controller.start();
    recognition.onstart?.();
    controller.stop();
    // A late onstart from the deliberately stopped service must not revive it.
    recognition.onstart?.();
    expect(recognition.startCalls).toBe(1);

    // Starting while the old service is stopping waits for its `end` before
    // calling `start()` again.
    const staleEnd = recognition.onend;
    controller.start();
    staleEnd?.();
    vi.advanceTimersByTime(150);
    expect(recognition.startCalls).toBe(2);
    recognition.onstart?.();

    // Keep references before dispose: dispose detaches browser handlers, but a
    // browser can still deliver callbacks that were already queued.
    const queuedEnd = recognition.onend;
    const queuedError = recognition.onerror;
    controller.dispose();
    queuedEnd?.();
    queuedError?.({ error: "network" });

    const timerController = new WebSpeechController("ja-JP");
    const timerRecognition = FakeSpeechRecognition.instances[1];
    if (!timerRecognition) {
      throw new Error("fake recognition was not constructed");
    }
    timerController.start();
    timerRecognition.onstart?.();
    timerRecognition.onend?.();
    // A second end while a restart is already queued must not queue another.
    timerRecognition.onend?.();

    // Deliberately keep the timer alive after stop so its callback exercises
    // the requested-stop guard rather than being removed before it runs.
    const clearTimeoutSpy = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => undefined);
    timerController.start();
    timerController.stop();
    vi.advanceTimersByTime(50);
    clearTimeoutSpy.mockRestore();
    timerController.dispose();
  });

  class ChromeLikeSpeechRecognition extends FakeSpeechRecognition {
    active = false;

    start(): void {
      if (this.active) {
        throw new Error("InvalidStateError: recognition has already started");
      }
      super.start();
      this.active = true;
    }

    stop(): void {
      super.stop();
    }

    abort(): void {
      super.abort();
      this.active = false;
    }

    emitStart(): void {
      this.onstart?.();
    }

    emitEnd(): void {
      this.active = false;
      this.onend?.();
    }
  }

  const installChromeSpeech = (): void => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { SpeechRecognition: ChromeLikeSpeechRecognition },
    });
  };

  it("defers start until end after rapid stop then start", () => {
    vi.useFakeTimers();
    installChromeSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0] as ChromeLikeSpeechRecognition;
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    controller.start();
    recognition.emitStart();
    controller.stop();
    controller.start();
    expect(recognition.startCalls).toBe(1);

    recognition.emitEnd();
    vi.advanceTimersByTime(150);
    expect(recognition.startCalls).toBe(2);
    recognition.emitStart();
    expect(events.onStateChange).toHaveBeenLastCalledWith("listening");

    recognition.onresult?.({ resultIndex: 0, results: results(result(true, "再開後")) });
    expect(events.onFinalText).toHaveBeenLastCalledWith("再開後");
    controller.dispose();
  });

  it("cancels start cleanly when stop arrives during starting", () => {
    vi.useFakeTimers();
    installChromeSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0] as ChromeLikeSpeechRecognition;
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    controller.start();
    expect(events.onStateChange).toHaveBeenLastCalledWith("starting");
    controller.stop();
    expect(events.onStateChange).toHaveBeenLastCalledWith("stopping");

    recognition.emitStart();
    expect(events.onStateChange).toHaveBeenLastCalledWith("stopping");

    recognition.emitEnd();
    vi.advanceTimersByTime(100);
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
    expect(events.onRecognitionEnded).toHaveBeenCalledWith({
      reason: "user-stop",
      finalText: "",
      interimText: "",
    });
    expect(recognition.startCalls).toBe(1);
    controller.dispose();
  });

  it("ignores a double start click while already starting", () => {
    installSpeech();
    const controller = new WebSpeechController("ja-JP");
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    controller.start();
    controller.start();
    expect(recognition.startCalls).toBe(1);
    controller.dispose();
  });

  it("restarts after start during stopping once the browser delivers end", () => {
    vi.useFakeTimers();
    installChromeSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0] as ChromeLikeSpeechRecognition;
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    controller.start();
    recognition.emitStart();
    controller.stop();
    controller.start();
    recognition.emitEnd();
    vi.advanceTimersByTime(150);
    recognition.emitStart();

    recognition.onresult?.({ resultIndex: 0, results: results(result(true, "停止中に再開")) });
    expect(events.onFinalText).toHaveBeenLastCalledWith("停止中に再開");
    expect(events.onStateChange).toHaveBeenLastCalledWith("listening");
    controller.dispose();
  });

  it("restarts from a stop flush when start is requested before grace expires", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    controller.start();
    recognition.onstart?.();
    controller.stop();
    recognition.onend?.();
    controller.start();
    vi.advanceTimersByTime(100);
    expect(recognition.startCalls).toBe(2);
    recognition.onstart?.();
    expect(events.onStateChange).toHaveBeenLastCalledWith("listening");
    controller.dispose();
  });

  it("does not restart after stop when the user keeps capture off through flush", () => {
    vi.useFakeTimers();
    installSpeech();
    const controller = new WebSpeechController("ja-JP");
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    controller.start();
    recognition.onstart?.();
    controller.stop();
    recognition.onend?.();
    vi.advanceTimersByTime(150);
    expect(recognition.startCalls).toBe(1);
    controller.dispose();
  });

  it("defers start while a result flush timer is still pending", () => {
    vi.useFakeTimers();
    installSpeech();
    const controller = new WebSpeechController("ja-JP");
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    controller.start();
    recognition.onstart?.();
    recognition.onend?.();
    controller.start();
    expect(recognition.startCalls).toBe(1);
    vi.advanceTimersByTime(150);
    expect(recognition.startCalls).toBe(2);
    controller.dispose();
  });

  it("skips beginRecognitionStart when stop cancels capture before restart fires", () => {
    vi.useFakeTimers();
    installSpeech();
    const controller = new WebSpeechController("ja-JP");
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }

    controller.start();
    recognition.onstart?.();
    recognition.onend?.();
    controller.stop();
    vi.advanceTimersByTime(150);
    expect(recognition.startCalls).toBe(1);
    controller.dispose();
  });

  it("skips a duplicate browser final that repeats a just-flushed interim", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    recognition.onresult?.({ resultIndex: 0, results: results(result(false, "重複")) });
    recognition.onend?.();
    vi.advanceTimersByTime(100);
    expect(events.onFinalText).toHaveBeenCalledWith("重複");
    events.onFinalText.mockClear();
    vi.advanceTimersByTime(50);
    expect(recognition.startCalls).toBe(2);
    recognition.onresult?.({ resultIndex: 0, results: results(result(true, "重複")) });
    expect(events.onFinalText).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("survives throwing onRecognitionEnded observers", () => {
    vi.useFakeTimers();
    installSpeech();
    const events = callbacks();
    events.onRecognitionEnded.mockImplementation(() => {
      throw new Error("observer failed");
    });
    const controller = new WebSpeechController("ja-JP", events);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("fake recognition was not constructed");
    }
    controller.start();
    recognition.onstart?.();
    controller.stop();
    recognition.onend?.();
    vi.advanceTimersByTime(150);
    expect(events.onStateChange).toHaveBeenLastCalledWith("idle");
    controller.dispose();
  });
});
