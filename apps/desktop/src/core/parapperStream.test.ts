import { describe, expect, it, vi } from "vitest";
import {
  PARAPPER_MAX_AUDIO_FRAME_BYTES,
  ParapperRecognitionStream,
  type ParapperStreamEvent,
} from "./parapperStream";

class FakeSocket {
  public static instances: FakeSocket[] = [];
  public readonly url: string;
  public readonly sent: Array<string | Uint8Array> = [];
  public readyState = 0;
  public throwOnSend = false;
  public sendError: unknown = new Error("fake socket send failed");
  public throwOnClose = false;
  public closeReason = "";
  public binaryType = "blob";
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;

  public constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  public send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.throwOnSend) {
      throw this.sendError;
    }
    if (typeof data === "string") {
      this.sent.push(data);
      return;
    }
    this.sent.push(
      data instanceof ArrayBuffer
        ? new Uint8Array(data.slice(0))
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(),
    );
  }

  public close(): void {
    if (this.throwOnClose) {
      throw new Error("fake socket close failed");
    }
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: this.closeReason, wasClean: true } as CloseEvent);
  }

  public open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  public message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }

  public fail(): void {
    this.onerror?.(new Event("error"));
  }
}

const jsonMessages = (socket: FakeSocket): Array<Record<string, unknown>> =>
  socket.sent
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);

describe("ParapperRecognitionStream", () => {
  const createReadyStream = async (
    options: Partial<ConstructorParameters<typeof ParapperRecognitionStream>[0]> = {},
  ): Promise<{ stream: ParapperRecognitionStream; socket: FakeSocket }> => {
    FakeSocket.instances = [];
    const stream = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      sessionId: "ready-session",
      webSocketConstructor: FakeSocket as never,
      ...options,
    });
    const startPromise = stream.start();
    expect(stream.start()).toBe(startPromise);
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();
    socket.message({ version: 1, type: "session.ready", session_id: stream.id });
    socket.message({ version: 1, type: "session.ready", session_id: stream.id });
    await startPromise;
    return { stream, socket };
  };

  it("keeps start/audio/stop on one protocol session and preserves turn order", async () => {
    FakeSocket.instances = [];
    const events: ParapperStreamEvent[] = [];
    const stream = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      sessionId: "session-1",
      webSocketConstructor: FakeSocket as never,
      onEvent: (event) => events.push(event),
    });
    const startPromise = stream.start();
    const socket = FakeSocket.instances[0];
    expect(socket?.url).toContain("18082");
    socket?.open();
    const startMessage = jsonMessages(socket as FakeSocket)[0];
    expect(startMessage).toMatchObject({
      version: 1,
      type: "session.start",
      session_id: "session-1",
      audio: { encoding: "pcm_s16le", sample_rate: 16_000, channels: 1 },
    });
    socket?.message({
      version: 1,
      type: "session.ready",
      session_id: "session-1",
      capabilities: { partial: true, speech_started: true, cancel: true },
    });
    await startPromise;

    const pcm = new Uint8Array(PARAPPER_MAX_AUDIO_FRAME_BYTES + 2).fill(7);
    stream.sendPcm16(pcm);
    const binary = (socket?.sent ?? []).filter(
      (entry): entry is Uint8Array => entry instanceof Uint8Array,
    );
    expect(binary.map((entry) => entry.byteLength)).toEqual([3_200, 2]);

    socket?.message({ version: 1, type: "speech.started", session_id: "session-1" });
    socket?.message({
      version: 1,
      type: "turn.partial",
      session_id: "session-1",
      turn_session_id: 4,
      turn_id: 8,
      revision: 0,
      segment_id: 11,
      previous_segment_id: null,
      text: "こんにちは",
      source_text: "今日は",
      source_asr_model: "reazonspeech-k2-v2",
      source_language: "ja",
      elapsed_ms: 18,
      detected_language: null,
      speech_start_at: 1_000,
      asr_dispatch_at: 1_040,
      first_partial_at: 1_080,
    });
    socket?.message({
      version: 1,
      type: "turn.final",
      session_id: "session-1",
      turn_session_id: 4,
      turn_id: 8,
      revision: 1,
      segment_id: 11,
      previous_segment_id: null,
      text: "こんにちは。",
      source_text: "今日は。",
      source_asr_model: "reazonspeech-k2-v2",
      source_language: "ja",
      audio_duration_ms: 640,
      elapsed_ms: 24,
      detected_language: null,
    });
    const stopPromise = stream.stop();
    expect(jsonMessages(socket as FakeSocket).at(-1)).toMatchObject({
      type: "session.stop",
      session_id: "session-1",
    });
    socket?.message({ version: 1, type: "session.done", session_id: "session-1" });
    await stopPromise;

    expect(events.map((event) => event.type)).toEqual([
      "speech.started",
      "turn.partial",
      "turn.final",
    ]);
    expect(events[1]).toMatchObject({
      text: "こんにちは",
      sourceText: "今日は",
      turnSessionId: 4,
      turnId: 8,
      revision: 0,
      asrLatency: {
        speech_start_at: 1_000,
        asr_dispatch_at: 1_040,
        first_partial_at: 1_080,
      },
    });
    expect(events[2]).toMatchObject({
      text: "こんにちは。",
      sourceText: "今日は。",
      audioDurationMs: 640,
    });
  });

  it("rejects startup errors instead of accepting audio without session.ready", async () => {
    FakeSocket.instances = [];
    const stream = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
      timeoutMs: 1_000,
    });
    const startPromise = stream.start();
    const socket = FakeSocket.instances[0];
    socket?.open();
    socket?.message({
      version: 1,
      type: "error",
      session_id: stream.id,
      code: "model_unavailable",
      message: "model missing",
      fatal: true,
    });
    await expect(startPromise).rejects.toThrow(/model_unavailable.*model missing/);

    FakeSocket.instances = [];
    const fallbackError = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    const fallbackPromise = fallbackError.start();
    const fallbackSocket = FakeSocket.instances.at(-1) as FakeSocket;
    fallbackSocket.open();
    fallbackSocket.message({ version: 1, type: "error", session_id: fallbackError.id });
    await expect(fallbackPromise).rejects.toThrow(/parapper_protocol_error.*rejected/);
  });

  it("ignores frames from another session and sends an explicit cancel", async () => {
    FakeSocket.instances = [];
    const events: ParapperStreamEvent[] = [];
    const errors: Error[] = [];
    const stream = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      sessionId: "session-2",
      webSocketConstructor: FakeSocket as never,
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });
    const startPromise = stream.start();
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();
    socket.message({ version: 1, type: "session.ready", session_id: "session-2" });
    await startPromise;
    socket.message({ version: 1, type: "speech.started", session_id: "other" });
    socket.message({
      version: 1,
      type: "error",
      session_id: "other",
      code: "stale_session_failed",
      message: "superseded capture failed",
    });
    expect(events).toEqual([]);
    expect(errors).toEqual([]);
    stream.cancel();
    expect(jsonMessages(socket).at(-1)).toMatchObject({
      type: "session.cancel",
      session_id: "session-2",
    });
  });

  it("validates constructor, startup, and PCM state before sending", async () => {
    expect(
      () =>
        new ParapperRecognitionStream({
          url: "",
          webSocketConstructor: FakeSocket as never,
        }),
    ).toThrow("WebSocket URL");

    vi.stubGlobal("WebSocket", undefined);
    expect(
      () =>
        new ParapperRecognitionStream({
          url: "ws://127.0.0.1:18082/ws/recognition",
        }),
    ).toThrow("WebSocket is unavailable");
    vi.unstubAllGlobals();
    vi.stubGlobal("WebSocket", FakeSocket);
    const browserDefault = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
    });
    expect(browserDefault.id).not.toHaveLength(0);
    vi.unstubAllGlobals();

    const { stream, socket } = await createReadyStream();
    await stream.start();
    expect(() => stream.sendPcm16(new Uint8Array([1]))).toThrow("even number");
    expect(() => stream.sendPcm16(new Uint8Array([1, 2]))).not.toThrow();
    socket.readyState = 3;
    expect(() => stream.sendPcm16(new Uint8Array([1, 2]))).toThrow("not ready");
    stream.cancel();
    expect(() => stream.sendPcm16(new Uint8Array())).not.toThrow();
    await expect(stream.stop()).resolves.toBeUndefined();
  });

  it("normalizes optional protocol fields and creates fallback session ids", async () => {
    const events: ParapperStreamEvent[] = [];
    const { stream, socket } = await createReadyStream({ onEvent: (event) => events.push(event) });
    socket.message({
      version: 1,
      type: "turn.partial",
      session_id: stream.id,
      text: "fallback fields",
    });
    expect(events[0]).toMatchObject({
      type: "turn.partial",
      turnSessionId: 0,
      turnId: 0,
      revision: 0,
      segmentId: 0,
      previousSegmentId: null,
      sourceText: null,
      sourceAsrModel: "unknown",
      sourceLanguage: "ja",
      detectedLanguage: null,
      elapsedMs: 0,
      audioDurationMs: null,
    });

    const originalCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", { randomUUID: () => "generated-session" });
    const generated = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    expect(generated.id).toBe("generated-session");
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new Error("restricted");
      },
    });
    const fallback = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    expect(fallback.id).toMatch(/^parapper-/);
    vi.stubGlobal("crypto", originalCrypto);
  });

  it("handles malformed, stale, and callback-failing server messages", async () => {
    const errors: Error[] = [];
    const events: ParapperStreamEvent[] = [];
    const { stream, socket } = await createReadyStream({
      onEvent: (event) => {
        events.push(event);
        throw new Error("observer failed");
      },
      onError: (error) => errors.push(error),
    });
    socket.onmessage?.({ data: "not json" } as MessageEvent<string>);
    socket.onmessage?.({ data: new Uint8Array([1, 2]) } as unknown as MessageEvent<unknown>);
    socket.onmessage?.({ data: "1" } as MessageEvent<string>);
    socket.onmessage?.({
      data: JSON.stringify({ version: 2, type: "turn.partial" }),
    } as MessageEvent<string>);
    socket.message({ version: 1, type: "turn.partial", session_id: stream.id, text: "" });
    socket.message({ version: 1, type: "unknown", session_id: stream.id, text: "ignored" });
    socket.message({
      version: 1,
      type: "speech.started",
      session_id: stream.id,
    });
    expect(events).toHaveLength(1);

    socket.fail();
    socket.fail();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/connection failed/);

    const closeErrors: Error[] = [];
    const activeClose = await createReadyStream({ onError: (error) => closeErrors.push(error) });
    activeClose.socket.closeReason = "active close";
    activeClose.socket.close();
    expect(closeErrors[0]?.message).toMatch(/active close/);

    const throwingErrorObserver = await createReadyStream({
      onError: () => {
        throw new Error("observer failed");
      },
    });
    throwingErrorObserver.socket.fail();
    expect(() => throwingErrorObserver.socket.fail()).not.toThrow();
  });

  it("reports a same-session protocol error after session.ready", async () => {
    const errors: Error[] = [];
    const { stream, socket } = await createReadyStream({ onError: (error) => errors.push(error) });

    socket.message({
      version: 1,
      type: "error",
      session_id: stream.id,
      code: "recognition_failed",
      message: "model worker stopped",
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/recognition_failed.*model worker stopped/);
  });

  it("reports startup construction, send, close, and timeout failures", async () => {
    class ThrowingSocket extends FakeSocket {
      public constructor(url: string) {
        super(url);
        throw new Error("constructor failed");
      }
    }
    const constructionFailure = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: ThrowingSocket as never,
    });
    await expect(constructionFailure.start()).rejects.toThrow("constructor failed");

    class ThrowingValueSocket extends FakeSocket {
      public constructor(url: string) {
        super(url);
        throw "constructor value failed";
      }
    }
    const valueFailure = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: ThrowingValueSocket as never,
    });
    await expect(valueFailure.start()).rejects.toThrow("could not open Parapper socket");

    const { stream, socket } = await createReadyStream();
    socket.throwOnSend = true;
    await expect(stream.stop()).rejects.toThrow("fake socket send failed");

    const timeoutReady = await createReadyStream({ timeoutMs: 10 });
    timeoutReady.socket.closeReason = "closed before done";
    const stopOnClose = timeoutReady.stream.stop();
    timeoutReady.socket.close();
    await expect(stopOnClose).rejects.toThrow("closed before done");

    const timeoutStream = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
      timeoutMs: 10,
    });
    const timeoutStart = timeoutStream.start();
    const timeoutSocket = FakeSocket.instances.at(-1) as FakeSocket;
    timeoutSocket.open();
    await expect(timeoutStart).rejects.toThrow("session.ready");

    FakeSocket.instances = [];
    const openingFailure = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    const openingPromise = openingFailure.start();
    const openingSocket = FakeSocket.instances.at(-1) as FakeSocket;
    openingSocket.throwOnSend = true;
    openingSocket.sendError = "send value failed";
    openingSocket.open();
    await expect(openingPromise).rejects.toThrow("could not send session.start");

    FakeSocket.instances = [];
    const openingError = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    const openingErrorPromise = openingError.start();
    const openingErrorSocket = FakeSocket.instances.at(-1) as FakeSocket;
    openingErrorSocket.throwOnSend = true;
    openingErrorSocket.open();
    await expect(openingErrorPromise).rejects.toThrow("fake socket send failed");

    FakeSocket.instances = [];
    const startupClose = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    const startupClosePromise = startupClose.start();
    const startupCloseSocket = FakeSocket.instances.at(-1) as FakeSocket;
    startupCloseSocket.closeReason = "startup closed";
    startupCloseSocket.close();
    await expect(startupClosePromise).rejects.toThrow("startup closed");

    FakeSocket.instances = [];
    const startupError = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    const startupErrorPromise = startupError.start();
    const startupErrorSocket = FakeSocket.instances.at(-1) as FakeSocket;
    startupErrorSocket.fail();
    await expect(startupErrorPromise).rejects.toThrow(/connection_failed/);

    FakeSocket.instances = [];
    const startupFallbackClose = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    const startupFallbackPromise = startupFallbackClose.start();
    const startupFallbackSocket = FakeSocket.instances.at(-1) as FakeSocket;
    startupFallbackSocket.close();
    await expect(startupFallbackPromise).rejects.toThrow(/socket closed/);
  });

  it("finishes stop on protocol errors and timeout, and keeps stop idempotent", async () => {
    const first = await createReadyStream();
    const stop = first.stream.stop();
    expect(first.stream.stop()).toBe(stop);
    first.socket.message({
      version: 1,
      type: "error",
      session_id: first.stream.id,
      code: "stop_failed",
      message: "stop rejected",
    });
    await expect(stop).rejects.toThrow(/stop_failed.*stop rejected/);

    const fallbackStop = await createReadyStream();
    const fallbackStopPromise = fallbackStop.stream.stop();
    fallbackStop.socket.message({ version: 1, type: "error", session_id: fallbackStop.stream.id });
    await expect(fallbackStopPromise).rejects.toThrow(
      /parapper_protocol_error.*Parapper rejected session.stop/,
    );

    const valueStop = await createReadyStream();
    valueStop.socket.throwOnSend = true;
    valueStop.socket.sendError = "stop value failed";
    const valueStopPromise = valueStop.stream.stop();
    await expect(valueStopPromise).rejects.toThrow("could not send session.stop");

    const second = await createReadyStream({ timeoutMs: 10 });
    const timedOut = second.stream.stop();
    await expect(timedOut).rejects.toThrow("finish the session");

    const early = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    await expect(early.stop()).resolves.toBeUndefined();

    const cancelFailure = await createReadyStream();
    cancelFailure.socket.throwOnSend = true;
    expect(() => cancelFailure.stream.cancel()).not.toThrow();
    await expect(cancelFailure.stream.stop()).resolves.toBeUndefined();

    const closeFailure = await createReadyStream();
    closeFailure.socket.throwOnClose = true;
    closeFailure.stream.cancel();
  });

  it("does not double-report a transport failure while stopping", async () => {
    const errors: Error[] = [];
    const { stream, socket } = await createReadyStream({
      onError: (error) => errors.push(error),
    });
    const stopping = stream.stop();
    socket.closeReason = "closed while stopping";
    socket.close();
    await expect(stopping).rejects.toThrow("closed while stopping");
    expect(errors).toEqual([]);
  });

  it("resolves a stop for an already-closed socket and blocks PCM during drain", async () => {
    const draining = await createReadyStream();
    const stopping = draining.stream.stop();
    expect(() => draining.stream.sendPcm16(new Uint8Array([1, 2]))).toThrow(
      "recognition session is not ready",
    );
    draining.socket.message({ version: 1, type: "session.done", session_id: draining.stream.id });
    await expect(stopping).resolves.toBeUndefined();

    const closed = await createReadyStream();
    closed.socket.readyState = 3;
    await expect(closed.stream.stop()).resolves.toBeUndefined();
  });

  it("does not restart a terminal stream", async () => {
    const stream = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    await expect(stream.stop()).resolves.toBeUndefined();
    await expect(stream.start()).rejects.toThrow(/settled/);
  });

  it("cancels an unresolved start for both cancel and stop", async () => {
    FakeSocket.instances = [];
    const cancelled = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    const cancelledStart = cancelled.start();
    cancelled.cancel();
    await expect(cancelledStart).rejects.toThrow(/cancelled/i);

    const stopped = new ParapperRecognitionStream({
      url: "ws://127.0.0.1:18082/ws/recognition",
      webSocketConstructor: FakeSocket as never,
    });
    const stoppedStart = stopped.start();
    await expect(stopped.stop()).resolves.toBeUndefined();
    await expect(stoppedStart).rejects.toThrow(/cancelled/i);
  });

  it("only finishes stop for session.done from the active protocol session", async () => {
    const { stream, socket } = await createReadyStream();
    const stopping = stream.stop();
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });

    socket.message({ version: 2, type: "session.done", session_id: stream.id });
    socket.message({ version: 1, type: "session.done", session_id: "another-session" });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.message({ version: 1, type: "session.done", session_id: stream.id });
    await expect(stopping).resolves.toBeUndefined();
  });
});
