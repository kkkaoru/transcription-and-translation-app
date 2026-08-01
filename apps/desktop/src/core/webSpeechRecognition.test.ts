import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebSpeechRecognitionStream,
  DEFAULT_WEB_SPEECH_LANGUAGE,
  DEFAULT_WEB_SPEECH_RESTART_DELAY_MS,
  getWebSpeechRecognitionConstructor,
  isWebSpeechRecognitionSupported,
  type WebSpeechRecognitionError,
  type WebSpeechRecognitionEventLike,
  type WebSpeechRecognitionLike,
  type WebSpeechRecognitionResultLike,
  WebSpeechRecognitionStream,
  type WebSpeechRecognitionStreamEvent,
} from "./webSpeechRecognition";

class FakeRecognition implements WebSpeechRecognitionLike {
  public continuous = false;
  public interimResults = false;
  public lang = "";
  public maxAlternatives = 0;
  public startCalls = 0;
  public stopCalls = 0;
  public abortCalls = 0;
  public throwOnStart: unknown = null;
  public throwOnStop: unknown = null;
  public throwOnAbort: unknown = null;
  public onstart: ((event: Event) => void) | null = null;
  public onresult: ((event: WebSpeechRecognitionEventLike) => void) | null = null;
  public onerror: ((event: { error?: string; message?: string }) => void) | null = null;
  public onend: ((event: Event) => void) | null = null;

  public start(): void {
    this.startCalls += 1;
    if (this.throwOnStart !== null) {
      throw this.throwOnStart;
    }
  }

  public stop(): void {
    this.stopCalls += 1;
    if (this.throwOnStop !== null) {
      throw this.throwOnStop;
    }
  }

  public abort(): void {
    this.abortCalls += 1;
    if (this.throwOnAbort !== null) {
      throw this.throwOnAbort;
    }
  }

  public emitStart(): void {
    this.onstart?.(new Event("start"));
  }

  public emitEnd(): void {
    this.onend?.(new Event("end"));
  }

  public emitError(error: string, message?: string): void {
    this.onerror?.({ error, message });
  }

  public emitResult(event: WebSpeechRecognitionEventLike): void {
    this.onresult?.(event);
  }
}

const result = (
  transcript: string,
  isFinal: boolean,
  confidence?: number,
): WebSpeechRecognitionResultLike => {
  const alternative = { transcript, confidence };
  return Object.assign([alternative], {
    isFinal,
    length: 1,
  }) as unknown as WebSpeechRecognitionResultLike;
};

const resultEvent = (
  entries: Array<{ transcript: string; isFinal: boolean; confidence?: number }>,
  resultIndex = 0,
): WebSpeechRecognitionEventLike => {
  const results = entries.map((entry) => result(entry.transcript, entry.isFinal, entry.confidence));
  return { resultIndex, results: Object.assign(results, { length: results.length }) };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Web Speech feature detection", () => {
  it("prefers the standard constructor and falls back to webkit", () => {
    class Standard extends FakeRecognition {}
    class WebKit extends FakeRecognition {}

    expect(
      getWebSpeechRecognitionConstructor({
        SpeechRecognition: Standard,
        webkitSpeechRecognition: WebKit,
      }),
    ).toBe(Standard);
    expect(getWebSpeechRecognitionConstructor({ webkitSpeechRecognition: WebKit })).toBe(WebKit);
    expect(getWebSpeechRecognitionConstructor({ SpeechRecognition: {} })).toBeNull();
    expect(isWebSpeechRecognitionSupported({ SpeechRecognition: Standard })).toBe(true);
    expect(isWebSpeechRecognitionSupported({})).toBe(false);
  });

  it("uses the standard Japanese defaults without touching a DOM", () => {
    expect(DEFAULT_WEB_SPEECH_LANGUAGE).toBe("ja-JP");
    expect(DEFAULT_WEB_SPEECH_RESTART_DELAY_MS).toBeGreaterThan(0);
    expect(() => new WebSpeechRecognitionStream({})).toThrow(/unavailable/i);
  });

  it("constructs through an injected constructor in a DOM-less runtime", () => {
    class Constructed extends FakeRecognition {}
    const stream = new WebSpeechRecognitionStream({
      recognitionConstructor: Constructed,
      language: "fr-FR",
    });
    expect(stream.recognizer).toBeInstanceOf(Constructed);
    expect(stream.language).toBe("fr-FR");
    expect(stream.lang).toBe("fr-FR");
    stream.setLanguage("de-DE");
    expect(stream.language).toBe("de-DE");
    expect(
      new WebSpeechRecognitionStream({
        recognitionFactory: () => new FakeRecognition(),
      }).recognizer,
    ).toBeInstanceOf(FakeRecognition);
    expect(createWebSpeechRecognitionStream({ recognition: new FakeRecognition() })).toBeInstanceOf(
      WebSpeechRecognitionStream,
    );
  });
});

describe("WebSpeechRecognitionStream", () => {
  it("configures continuous interim recognition and emits partial/final text", () => {
    const recognition = new FakeRecognition();
    const results: Array<{ type: string; text: string }> = [];
    const partial: string[] = [];
    const final: string[] = [];
    const events: WebSpeechRecognitionStreamEvent[] = [];
    const stream = new WebSpeechRecognitionStream({
      recognition,
      lang: "en-US",
      onResult: (value) => results.push({ type: value.type, text: value.text }),
      onPartial: (text) => partial.push(text),
      onFinal: (text) => final.push(text),
      onEvent: (event) => events.push(event),
    });

    expect(recognition).toMatchObject({
      continuous: true,
      interimResults: true,
      lang: "en-US",
      maxAlternatives: 1,
    });
    stream.start();
    stream.start();
    expect(recognition.startCalls).toBe(1);
    expect(stream.state).toBe("starting");
    recognition.emitStart();
    expect(stream.state).toBe("running");
    expect(stream.isRunning).toBe(true);

    recognition.emitResult(resultEvent([{ transcript: "こん", isFinal: false, confidence: 0.4 }]));
    // The browser sends all prior final slots again in continuous mode. They
    // must be de-duplicated; only a changed slot reaches the app.
    recognition.emitResult(resultEvent([{ transcript: "こん", isFinal: false, confidence: 0.4 }]));
    recognition.emitResult(
      resultEvent([{ transcript: "こんにちは", isFinal: true, confidence: 0.9 }]),
    );

    expect(results).toEqual([
      { type: "partial", text: "こん" },
      { type: "final", text: "こんにちは" },
    ]);
    expect(partial).toEqual(["こん"]);
    expect(final).toEqual(["こんにちは"]);
    expect(
      events.filter((event) => event.type === "partial" || event.type === "final"),
    ).toHaveLength(2);
  });

  it("uses resultIndex to retain final slots and emits only newly changed slots", () => {
    const recognition = new FakeRecognition();
    const emitted: string[] = [];
    const stream = new WebSpeechRecognitionStream({
      recognition,
      onResult: (value) => emitted.push(`${value.type}:${value.transcript}`),
    });
    stream.start();
    recognition.emitResult(
      resultEvent([
        { transcript: "明日", isFinal: true, confidence: 0.8 },
        { transcript: "は", isFinal: false, confidence: 0.5 },
      ]),
    );
    recognition.emitResult(
      resultEvent(
        [
          { transcript: "明日", isFinal: true, confidence: 0.8 },
          { transcript: "晴れ", isFinal: true, confidence: 0.9 },
        ],
        1,
      ),
    );
    expect(emitted).toEqual(["final:明日", "partial:は", "final:晴れ"]);
  });

  it("skips malformed, empty, and duplicate alternatives", () => {
    const recognition = new FakeRecognition();
    const emitted: string[] = [];
    const stream = new WebSpeechRecognitionStream({
      recognition,
      onResult: (value) => emitted.push(value.transcript),
    });
    stream.start();
    recognition.emitResult({ resultIndex: Number.NaN, results: { length: 0 } });
    recognition.emitResult({
      results: Object.assign(
        [
          Object.assign([], { isFinal: false, length: 1 }),
          Object.assign([{ transcript: 123 }], {
            isFinal: false,
            length: 1,
          }) as unknown as WebSpeechRecognitionResultLike,
        ],
        { length: 2 },
      ),
    });
    recognition.emitResult({
      resultIndex: 0,
      results: Object.assign([undefined, result("   ", false), result("ok", false, Number.NaN)], {
        length: 3,
      }),
    });
    recognition.emitResult({
      resultIndex: Number.NaN,
      results: Object.assign([Object.assign([], { isFinal: false, length: 1 })], { length: 1 }),
    });
    recognition.emitResult({
      resultIndex: 2,
      results: Object.assign([undefined, undefined, result("ok", false, Number.NaN)], {
        length: 3,
      }),
    });
    expect(emitted).toEqual(["ok"]);
  });

  it("bounds cumulative final-result bookkeeping", () => {
    const recognition = new FakeRecognition();
    const stream = new WebSpeechRecognitionStream({ recognition });
    stream.start();
    recognition.emitResult({
      resultIndex: 0,
      results: Object.assign(
        Array.from({ length: 260 }, (_, index) => result(`語${index}`, true)),
        { length: 260 },
      ),
    });
    expect(recognition).toBeDefined();
  });

  it("automatically restarts after onend until stop or cancel is requested", () => {
    vi.useFakeTimers();
    const recognition = new FakeRecognition();
    const events: WebSpeechRecognitionStreamEvent[] = [];
    const stream = new WebSpeechRecognitionStream({
      recognition,
      restartDelayMs: 20,
      onEvent: (event) => events.push(event),
    });
    stream.start();
    recognition.emitEnd();
    recognition.emitEnd();
    expect(recognition.startCalls).toBe(1);
    vi.advanceTimersByTime(19);
    expect(recognition.startCalls).toBe(1);
    vi.advanceTimersByTime(1);
    expect(recognition.startCalls).toBe(2);
    expect(events).toContainEqual({ type: "end", willRestart: true });

    stream.stop();
    expect(recognition.stopCalls).toBe(1);
    recognition.emitEnd();
    vi.runOnlyPendingTimers();
    expect(recognition.startCalls).toBe(2);
    expect(stream.isRunning).toBe(false);

    stream.start();
    stream.cancel();
    expect(recognition.abortCalls).toBe(1);
    recognition.emitEnd();
    vi.runOnlyPendingTimers();
    expect(recognition.startCalls).toBe(3);
  });

  it("reports recoverable and fatal errors without leaking callback exceptions", () => {
    const recognition = new FakeRecognition();
    const errors: WebSpeechRecognitionError[] = [];
    const events: WebSpeechRecognitionStreamEvent[] = [];
    const stream = new WebSpeechRecognitionStream({
      recognition,
      onError: (error) => {
        errors.push(error);
        throw new Error("observer failed");
      },
      onEvent: (event) => events.push(event),
    });
    stream.start();
    expect(() => recognition.emitError("no-speech")).not.toThrow();
    expect(errors[0]).toMatchObject({ code: "no-speech", fatal: false });
    expect(errors[0]).toBeInstanceOf(Error);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "no-speech" } });
    recognition.emitError("not-allowed", "permission denied");
    expect(errors[1]).toMatchObject({
      code: "not-allowed",
      fatal: true,
      message: "permission denied",
    });
    expect(stream.isRunning).toBe(false);
    recognition.emitEnd();
    expect(recognition.startCalls).toBe(1);
  });

  it("backs off asynchronous retries when start keeps throwing", () => {
    vi.useFakeTimers();
    const recognition = new FakeRecognition();
    recognition.throwOnStart = "busy";
    const errors: WebSpeechRecognitionError[] = [];
    const stream = new WebSpeechRecognitionStream({
      recognition,
      restartDelayMs: 1,
      onError: (error) => errors.push(error),
    });
    stream.start();
    expect(recognition.startCalls).toBe(1);
    vi.advanceTimersByTime(1);
    expect(recognition.startCalls).toBe(2);
    // The second failure uses the 50 ms backoff rather than recursing in the
    // same stack frame. Let the next attempt succeed.
    recognition.throwOnStart = null;
    vi.advanceTimersByTime(49);
    expect(recognition.startCalls).toBe(2);
    vi.advanceTimersByTime(1);
    expect(recognition.startCalls).toBe(3);
    expect(errors.map((error) => error.code)).toEqual(["lifecycle-start", "lifecycle-start"]);
  });

  it("normalizes language, maxAlternatives, lifecycle failures, and dispose", () => {
    const recognition = new FakeRecognition();
    recognition.throwOnStart = new Error("busy");
    const errors: WebSpeechRecognitionError[] = [];
    const stream = new WebSpeechRecognitionStream({
      recognition,
      language: "  ",
      continuous: false,
      interimResults: false,
      maxAlternatives: 2.9,
      restartDelayMs: 1,
      onError: (error) => errors.push(error),
    });
    expect(recognition).toMatchObject({
      lang: DEFAULT_WEB_SPEECH_LANGUAGE,
      continuous: false,
      interimResults: false,
      maxAlternatives: 2,
    });
    stream.start();
    expect(errors[0]).toMatchObject({ code: "lifecycle-start", fatal: false });

    recognition.throwOnStop = new Error("stop failed");
    recognition.throwOnStart = null;
    stream.start();
    stream.stop();
    expect(errors.map((error) => error.code)).toEqual(["lifecycle-start", "lifecycle-stop"]);
    recognition.throwOnAbort = new Error("abort failed");
    stream.start();
    stream.cancel();
    expect(errors.map((error) => error.code)).toEqual([
      "lifecycle-start",
      "lifecycle-stop",
      "lifecycle-cancel",
    ]);

    // The stream is idle after the failed start, so cancel is a no-op. Dispose
    // still removes handlers and rejects later starts explicitly.
    stream.dispose();
    expect(recognition.onresult).toBeNull();
    expect(() => stream.start()).toThrow(/disposed/i);
    stream.dispose();
  });

  it("isolates result/event observers and handles unknown browser errors", () => {
    const recognition = new FakeRecognition();
    const errors: WebSpeechRecognitionError[] = [];
    const stream = new WebSpeechRecognitionStream({
      recognition,
      onResult: () => {
        throw new Error("result observer failed");
      },
      onPartial: () => {
        throw new Error("partial observer failed");
      },
      onFinal: () => {
        throw new Error("final observer failed");
      },
      onEvent: () => {
        throw new Error("event observer failed");
      },
      onError: (error) => {
        errors.push(error);
        throw new Error("error observer failed");
      },
    });
    stream.start();
    recognition.emitResult(resultEvent([{ transcript: "x", isFinal: false }]));
    recognition.emitResult(resultEvent([{ transcript: "x", isFinal: true }]));
    recognition.emitError("");
    recognition.emitError("service-not-allowed");
    recognition.emitError(undefined as unknown as string);
    expect(errors.map((error) => error.code)).toEqual([
      "unknown",
      "service-not-allowed",
      "unknown",
    ]);

    const startHandler = recognition.onstart;
    const endHandler = recognition.onend;
    stream.dispose();
    startHandler?.(new Event("start"));
    endHandler?.(new Event("end"));

    const failingRecognition = new FakeRecognition();
    failingRecognition.throwOnStart = "busy";
    const failingStream = new WebSpeechRecognitionStream({
      recognition: failingRecognition,
      onError: () => {
        throw new Error("lifecycle observer failed");
      },
    });
    expect(() => failingStream.start()).not.toThrow();
    failingStream.cancel();
  });
});
