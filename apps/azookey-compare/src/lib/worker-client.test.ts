import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AzooKeyConvertRequest,
  AzooKeyWorkerClient,
  AzooKeyWorkerError,
  type WorkerConnectionState,
  workerErrorReachedConverter,
  workerErrorStage,
} from "./worker-client";

type MessageHandler = ((event: { data: unknown }) => void) | null;
type ErrorHandler = (() => void) | null;
type CloseHandler = ((event: { code: number; reason: string }) => void) | null;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static constructionFailure: Error | string | null = null;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: MessageHandler = null;
  onerror: ErrorHandler = null;
  onclose: CloseHandler = null;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  sendFailure: Error | string | null = null;
  closeFailure: Error | string | null = null;

  constructor(readonly endpoint: string) {
    if (FakeWebSocket.constructionFailure) {
      throw FakeWebSocket.constructionFailure;
    }
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void {
    if (this.sendFailure) {
      throw this.sendFailure;
    }
    this.sent.push(value);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.closeFailure) {
      throw this.closeFailure;
    }
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  error(): void {
    this.onerror?.();
  }

  closeFromPeer(code: number, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const request = (): Omit<AzooKeyConvertRequest, "type" | "requestId"> => ({
  source: "web-speech",
  language: "ja",
  sourceText: "きょうのてんき",
  vibratoInput: "きょうのてんき",
  mode: "worker-vibrato",
});

const openClient = (
  options: Partial<ConstructorParameters<typeof AzooKeyWorkerClient>[0]> = {},
) => {
  const client = new AzooKeyWorkerClient({ endpoint: "wss://worker.example/ws", ...options });
  const connecting = client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error("fake socket was not constructed");
  }
  socket.open();
  if (client.connectionState !== "open") {
    throw new Error(`fake socket did not open (${client.connectionState})`);
  }
  void connecting;
  return { client, socket };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  FakeWebSocket.constructionFailure = null;
});

describe("AzooKey Worker client connection lifecycle", () => {
  it("reports unsupported browsers and empty endpoints", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const unsupported = new AzooKeyWorkerClient({ endpoint: "wss://worker.example/ws" });
    await expect(unsupported.connect()).rejects.toThrow("WebSocket");
    await expect(unsupported.convert(request())).rejects.toThrow("WebSocket");
    expect(unsupported.connectionState).toBe("error");

    vi.stubGlobal("WebSocket", FakeWebSocket);
    const states: WorkerConnectionState[] = [];
    const empty = new AzooKeyWorkerClient({
      endpoint: " ",
      onStateChange: (state) => states.push(state),
    });
    await expect(empty.connect()).rejects.toThrow("URL");
    expect(states).toEqual(["error"]);
  });

  it("connects once, shares concurrent connects, and converts a correlated response", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const states: WorkerConnectionState[] = [];
    const client = new AzooKeyWorkerClient({
      endpoint: " wss://worker.example/ws ",
      onStateChange: (state) => states.push(state),
    });
    const first = client.connect();
    const second = client.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("fake socket was not constructed");
    }
    socket.open();
    await Promise.all([first, second]);
    expect(client.connectionState).toBe("open");
    await client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const pending = client.convert(request());
    await Promise.resolve();
    const sent = JSON.parse(socket.sent[0] ?? "{}") as { requestId: string; type: string };
    expect(sent).toMatchObject({ type: "azookey.convert" });
    socket.message(
      JSON.stringify({
        requestId: sent.requestId,
        sourceText: "きょうのてんき",
        convertedText: "今日の天気",
        mode: "worker-vibrato",
        elapsedMs: 12,
      }),
    );
    await expect(pending).resolves.toMatchObject({
      requestId: sent.requestId,
      sourceText: "きょうのてんき",
      convertedText: "今日の天気",
      elapsedMs: 12,
      mode: "worker-vibrato",
    });
    expect(states).toEqual(["connecting", "open"]);
  });

  it("surfaces Zenzai fallback metadata from the Worker result", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient();
    const pending = client.convert({ ...request(), model: "zenz-v3.2-xsmall-gguf" });
    await Promise.resolve();
    const sent = JSON.parse(socket.sent[0] ?? "{}") as { requestId: string; model?: string };
    expect(sent.model).toBe("zenz-v3.2-xsmall-gguf");
    socket.message(
      JSON.stringify({
        requestId: sent.requestId,
        convertedText: "今日の天気",
        model: "azookey-rust-wasm",
        requestedModel: "zenz-v3.2-xsmall-gguf",
        modelFallback: "unconfigured-route",
      }),
    );
    await expect(pending).resolves.toMatchObject({
      convertedText: "今日の天気",
      model: "azookey-rust-wasm",
      requestedModel: "zenz-v3.2-xsmall-gguf",
      modelFallback: "unconfigured-route",
    });

    const upstream = client.convert({ ...request(), model: "zenz-v3.2-xsmall-gguf" });
    await Promise.resolve();
    const upstreamSent = JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string };
    socket.message(
      JSON.stringify({
        requestId: upstreamSent.requestId,
        convertedText: "WASMフォールバック",
        model: "azookey-rust-wasm",
        requestedModel: "zenz-v3.2-xsmall-gguf",
        modelFallback: "upstream-failed",
      }),
    );
    await expect(upstream).resolves.toMatchObject({
      convertedText: "WASMフォールバック",
      modelFallback: "upstream-failed",
    });
  });

  it("opens on demand when convert is called before connect", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new AzooKeyWorkerClient({ endpoint: "wss://worker.example/ws" });
    const pending = client.convert(request());
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("fake socket was not constructed");
    }
    socket.open();
    await Promise.resolve();
    const sent = JSON.parse(socket.sent[0] ?? "{}") as { requestId: string };
    socket.message(JSON.stringify({ requestId: sent.requestId, text: "オンデマンド" }));
    await expect(pending).resolves.toMatchObject({
      convertedText: "オンデマンド",
      sourceText: "",
    });
  });

  it("accepts nested response aliases and binary message payloads", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient();
    const first = client.convert(request());
    await Promise.resolve();
    const firstId = (JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string }).requestId;
    socket.message(
      JSON.stringify({
        result: {
          id: firstId,
          input: "かな",
          text: "漢字",
          mode: "browser-vibrato",
          durationMs: 4,
        },
      }),
    );
    await expect(first).resolves.toMatchObject({
      requestId: firstId,
      sourceText: "かな",
      convertedText: "漢字",
      mode: "browser-vibrato",
      elapsedMs: 4,
    });

    const snake = client.convert(request());
    await Promise.resolve();
    const snakeId = (JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string }).requestId;
    socket.message(
      JSON.stringify({
        requestId: snakeId,
        convertedText: "今日はいい天気",
        elapsed_ms: 18,
      }),
    );
    await expect(snake).resolves.toMatchObject({
      convertedText: "今日はいい天気",
      elapsedMs: 18,
    });

    const zeroCamel = client.convert(request());
    await Promise.resolve();
    const zeroCamelId = (JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string }).requestId;
    socket.message(
      JSON.stringify({
        requestId: zeroCamelId,
        convertedText: "今日はいい天気",
        elapsedMs: 0,
      }),
    );
    await expect(zeroCamel).resolves.toMatchObject({
      convertedText: "今日はいい天気",
      elapsedMs: 0,
    });

    const nestedSnake = client.convert(request());
    await Promise.resolve();
    const nestedSnakeId = (JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string })
      .requestId;
    socket.message(
      JSON.stringify({
        result: {
          requestId: nestedSnakeId,
          convertedText: "ゼロミリ秒",
          elapsed_ms: 0,
        },
      }),
    );
    await expect(nestedSnake).resolves.toMatchObject({
      convertedText: "ゼロミリ秒",
      elapsedMs: 0,
    });

    const blob = client.convert(request());
    await Promise.resolve();
    const blobId = (JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string }).requestId;
    socket.message(
      new Blob([JSON.stringify({ requestId: blobId, output: "結果", originalText: "入力" })]),
    );
    await expect(blob).resolves.toMatchObject({ convertedText: "結果", sourceText: "入力" });

    const binary = client.convert(request());
    await Promise.resolve();
    const binaryId = (JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string }).requestId;
    socket.message(
      new TextEncoder().encode(JSON.stringify({ requestId: binaryId, text: "二" })).buffer,
    );
    await expect(binary).resolves.toMatchObject({ convertedText: "二" });
  });

  it("normalizes browser comparison mode to the Worker wire mode", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = openClient();
    const pending = client.convert({
      ...request(),
      mode: "browser-vibrato",
      vibratoExecution: "browser-wasm",
    });
    const sent = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      requestId: string;
      mode: string;
      comparisonMode?: string;
      vibratoExecution?: string;
    };
    expect(sent).toMatchObject({
      mode: "worker-vibrato",
      comparisonMode: "browser-vibrato",
      vibratoExecution: "browser-wasm",
    });
    socket.message(JSON.stringify({ requestId: sent.requestId, text: "変換結果" }));
    await expect(pending).resolves.toMatchObject({ convertedText: "変換結果" });
  });

  it("handles malformed messages, protocol errors, and missing response text", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient();
    class ThrowingBlob extends Blob {
      override text(): Promise<string> {
        return Promise.reject(new Error("cannot read Blob"));
      }
    }
    socket.message(new ThrowingBlob());
    socket.message(JSON.stringify({ type: "result" }));
    socket.message(JSON.stringify({ text: "orphan" }));
    await Promise.resolve();
    const pending = client.convert(request());
    await Promise.resolve();
    socket.message(new Uint8Array([1, 2, 3]));
    socket.message("not-json");
    socket.message({ unsupported: true });
    socket.message(JSON.stringify({ requestId: "unknown", text: "ignored" }));
    const id = (JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string }).requestId;
    socket.message(JSON.stringify({ requestId: id, type: "error", error: { message: "拒否" } }));
    await expect(pending).rejects.toThrow("拒否");

    const missing = client.convert(request());
    await Promise.resolve();
    const missingId = (JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string }).requestId;
    socket.message(JSON.stringify({ requestId: missingId }));
    await expect(missing).rejects.toThrow("convertedText");

    const noId = client.convert(request());
    await Promise.resolve();
    socket.message(JSON.stringify({ text: "ID省略" }));
    let noIdSettled = false;
    void noId.then(
      () => {
        noIdSettled = true;
      },
      () => {
        noIdSettled = true;
      },
    );
    await Promise.resolve();
    expect(noIdSettled).toBe(false);
    const noIdRequestId = (JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string })
      .requestId;
    socket.message(JSON.stringify({ requestId: noIdRequestId, text: "相関ID付き" }));
    await expect(noId).resolves.toMatchObject({ convertedText: "相関ID付き" });

    const noMessage = client.convert(request());
    await Promise.resolve();
    const noMessageId = (JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string }).requestId;
    socket.message(JSON.stringify({ requestId: noMessageId, type: "error" }));
    await expect(noMessage).rejects.toThrow("AzooKey Cloudflare Worker が変換を拒否しました");
  });

  it("maps construction, send, timeout, and connection-close failures", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.constructionFailure = new Error("constructor failed");
    const constructorError = new AzooKeyWorkerClient({ endpoint: "wss://worker.example/ws" });
    await expect(constructorError.connect()).rejects.toThrow("constructor failed");
    FakeWebSocket.constructionFailure = "constructor failed";
    const constructorFallback = new AzooKeyWorkerClient({ endpoint: "wss://worker.example/ws" });
    await expect(constructorFallback.connect()).rejects.toThrow("constructor failed");
    FakeWebSocket.constructionFailure = null;

    const constructorRetry = constructorError.connect();
    const constructorRetrySocket = FakeWebSocket.instances.at(-1);
    if (!constructorRetrySocket) {
      throw new Error("fake socket was not constructed");
    }
    constructorRetrySocket.open();
    await constructorRetry;
    expect(constructorError.connectionState).toBe("open");

    const { client, socket } = await openClient({ requestTimeoutMs: 1_000 });
    socket.sendFailure = new Error("send failed");
    await expect(client.convert(request())).rejects.toThrow("send failed");
    socket.sendFailure = "send failed";
    await expect(client.convert(request())).rejects.toThrow("send failed");
    socket.sendFailure = {} as unknown as string;
    await expect(client.convert(request())).rejects.toThrow("送信できません");

    socket.sendFailure = null;
    vi.useFakeTimers();
    const timed = client.convert(request());
    const timedRejection = expect(timed).rejects.toThrow("タイムアウト");
    await vi.advanceTimersByTimeAsync(1_001);
    await timedRejection;

    const pending = client.convert(request());
    await Promise.resolve();
    socket.closeFromPeer(1006);
    await expect(pending).rejects.toThrow("1006");
    expect(client.connectionState).toBe("closed");

    const withReason = new AzooKeyWorkerClient({ endpoint: "wss://worker.example/ws" });
    const withReasonConnect = withReason.connect();
    const withReasonSocket = FakeWebSocket.instances.at(-1);
    if (!withReasonSocket) {
      throw new Error("fake socket was not constructed");
    }
    withReasonSocket.open();
    await withReasonConnect;
    withReasonSocket.closeFromPeer(1000, "server restart");
    expect(withReason.connectionState).toBe("closed");
  });

  it("rejects pending conversion on socket errors and close()", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient();
    const pending = client.convert(request());
    client.close();
    await expect(pending).rejects.toThrow("閉じました");
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "comparison page closed" }]);
    client.close();

    const reconnect = new AzooKeyWorkerClient({ endpoint: "wss://worker.example/ws" });
    const connecting = reconnect.connect();
    const reconnectSocket = FakeWebSocket.instances.at(-1);
    if (!reconnectSocket) {
      throw new Error("fake socket was not constructed");
    }
    reconnectSocket.error();
    await expect(connecting).rejects.toThrow("接続エラー");
    expect(reconnect.connectionState).toBe("error");
  });

  it("rejects a pending connect when close() is called", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new AzooKeyWorkerClient({ endpoint: "wss://worker.example/ws" });
    const pending = client.connect();
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) {
      throw new Error("fake socket was not constructed");
    }

    client.close();

    await expect(pending).rejects.toThrow("閉じました");
    expect(client.connectionState).toBe("closed");
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "comparison page closed" }]);
  });

  it("settles a handshake when the peer closes before opening", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new AzooKeyWorkerClient({ endpoint: "wss://worker.example/ws" });
    const pending = client.connect();
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) {
      throw new Error("fake socket was not constructed");
    }
    socket.closeFromPeer(1006);
    await expect(pending).rejects.toThrow("1006");
    expect(client.connectionState).toBe("closed");
  });

  it("does not enqueue a conversion after a handshake loses its open socket", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new AzooKeyWorkerClient({ endpoint: "wss://worker.example/ws" });
    const pending = client.convert(request());
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) {
      throw new Error("fake socket was not constructed");
    }
    socket.open();
    socket.readyState = FakeWebSocket.CLOSED;
    await expect(pending).rejects.toThrow("接続されていません");
  });

  it("rejects pending conversions and reconnects after an open socket error", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient();
    const pending = client.convert(request());
    await Promise.resolve();

    socket.closeFailure = "already closed";
    socket.error();

    await expect(pending).rejects.toThrow("接続エラー");
    expect(client.connectionState).toBe("error");

    const retry = client.connect();
    const replacement = FakeWebSocket.instances.at(-1);
    if (!replacement) {
      throw new Error("fake socket was not constructed");
    }
    expect(replacement).not.toBe(socket);
    replacement.open();
    await retry;
    expect(client.connectionState).toBe("open");
  });

  it("reconnects queued conversions after the active socket drops", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient();
    const first = client.convert({ ...request(), sourceText: "一つ目", vibratoInput: "一つ目" });
    const second = client.convert({ ...request(), sourceText: "二つ目", vibratoInput: "二つ目" });
    expect(socket.sent).toHaveLength(1);

    socket.closeFromPeer(1006);
    await expect(first).rejects.toThrow("1006");

    const replacement = FakeWebSocket.instances.at(-1);
    if (!replacement) {
      throw new Error("queued conversion did not request a replacement socket");
    }
    expect(replacement).not.toBe(socket);
    replacement.open();
    await Promise.resolve();
    const payload = JSON.parse(replacement.sent[0] ?? "{}") as { requestId: string };
    replacement.message(JSON.stringify({ requestId: payload.requestId, text: "二つ目の結果" }));
    await expect(second).resolves.toMatchObject({ convertedText: "二つ目の結果" });
  });

  it("rejects a queued conversion when reconnecting never reaches OPEN", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient();
    const first = client.convert({ ...request(), sourceText: "一つ目", vibratoInput: "一つ目" });
    const second = client.convert({ ...request(), sourceText: "二つ目", vibratoInput: "二つ目" });

    socket.closeFromPeer(1006);
    await expect(first).rejects.toThrow("1006");
    const replacement = FakeWebSocket.instances.at(-1);
    if (!replacement) {
      throw new Error("queued conversion did not request a replacement socket");
    }
    replacement.open();
    replacement.readyState = FakeWebSocket.CLOSED;
    await expect(second).rejects.toThrow("接続されていません");
  });

  it("reconnects the FIFO tail after socket error without orphaning a handshake", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient();
    const first = client.convert({ ...request(), sourceText: "一つ目", vibratoInput: "一つ目" });
    const second = client.convert({ ...request(), sourceText: "二つ目", vibratoInput: "二つ目" });

    socket.error();
    await expect(first).rejects.toThrow("接続エラー");
    const firstConnect = client.connect();
    const secondConnect = client.connect();
    expect(secondConnect).toBe(firstConnect);
    const replacement = FakeWebSocket.instances.at(-1);
    if (!replacement) {
      throw new Error("queued conversion did not request a replacement socket");
    }
    expect(replacement).not.toBe(socket);
    replacement.open();
    await expect(firstConnect).resolves.toBeUndefined();
    await expect(secondConnect).resolves.toBeUndefined();
    await Promise.resolve();
    const payload = JSON.parse(replacement.sent[0] ?? "{}") as { requestId: string };
    replacement.message(JSON.stringify({ requestId: payload.requestId, text: "二つ目の結果" }));
    await expect(second).resolves.toMatchObject({ convertedText: "二つ目の結果" });
  });

  it("serializes rapid conversions and retries a transient busy refusal", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
    const { client, socket } = await openClient({
      maxBusyRetries: 2,
      busyRetryDelayMs: 10,
    });
    const first = client.convert({ ...request(), sourceText: "一つ目", vibratoInput: "一つ目" });
    const second = client.convert({ ...request(), sourceText: "二つ目", vibratoInput: "二つ目" });
    expect(socket.sent).toHaveLength(1);
    const firstPayload = JSON.parse(socket.sent[0] ?? "{}") as {
      requestId: string;
      sourceText: string;
    };
    expect(firstPayload.sourceText).toBe("一つ目");

    socket.message(
      JSON.stringify({
        type: "azookey.error",
        requestId: firstPayload.requestId,
        error: { code: "busy", message: "another conversion is in progress" },
      }),
    );
    await vi.advanceTimersByTimeAsync(9);
    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent).toHaveLength(2);
    const retryPayload = JSON.parse(socket.sent[1] ?? "{}") as { requestId: string };
    expect(retryPayload.requestId).toBe(firstPayload.requestId);

    socket.message(JSON.stringify({ requestId: retryPayload.requestId, text: "一つ目の結果" }));
    await expect(first).resolves.toMatchObject({ convertedText: "一つ目の結果" });
    await Promise.resolve();
    expect(socket.sent).toHaveLength(3);
    const secondPayload = JSON.parse(socket.sent[2] ?? "{}") as {
      requestId: string;
      sourceText: string;
    };
    expect(secondPayload.sourceText).toBe("二つ目");
    socket.message(JSON.stringify({ requestId: secondPayload.requestId, text: "二つ目の結果" }));
    await expect(second).resolves.toMatchObject({ convertedText: "二つ目の結果" });
  });

  it("does not attribute a delayed requestId-less response to the next FIFO item", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
    const { client, socket } = await openClient({ requestTimeoutMs: 1_000 });

    const first = client.convert({ ...request(), sourceText: "一つ目", vibratoInput: "一つ目" });
    const firstRejection = expect(first).rejects.toThrow("タイムアウト");
    await vi.advanceTimersByTimeAsync(1_001);
    await firstRejection;

    const second = client.convert({ ...request(), sourceText: "二つ目", vibratoInput: "二つ目" });
    await Promise.resolve();
    const secondPayload = JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string };

    // This frame is a late response to the timed-out first request. It has no
    // correlation id, so the client must leave the second conversion pending.
    socket.message(JSON.stringify({ text: "一つ目の遅延結果" }));
    let settled = false;
    void second.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.message(JSON.stringify({ requestId: secondPayload.requestId, text: "二つ目の結果" }));
    await expect(second).resolves.toMatchObject({ convertedText: "二つ目の結果" });
  });

  it("ignores a duplicate requestId-less frame after a correlated response", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient();

    const first = client.convert({ ...request(), sourceText: "一つ目", vibratoInput: "一つ目" });
    await Promise.resolve();
    const firstPayload = JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string };
    socket.message(JSON.stringify({ requestId: firstPayload.requestId, text: "一つ目の結果" }));
    await expect(first).resolves.toMatchObject({ convertedText: "一つ目の結果" });

    const second = client.convert({ ...request(), sourceText: "二つ目", vibratoInput: "二つ目" });
    await Promise.resolve();
    const secondPayload = JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string };

    // Some legacy servers emit a duplicate frame without requestId after the
    // correlated response. It must not claim the next FIFO conversion.
    socket.message(JSON.stringify({ text: "一つ目の重複" }));
    let settled = false;
    void second.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(socket.closeCalls).toHaveLength(0);

    socket.message(JSON.stringify({ requestId: secondPayload.requestId, text: "二つ目の結果" }));
    await expect(second).resolves.toMatchObject({ convertedText: "二つ目の結果" });
  });

  it("rejects queued work and clears a busy retry when closed", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient({ maxBusyRetries: 2, busyRetryDelayMs: 100 });
    const first = client.convert({ ...request(), sourceText: "一つ目", vibratoInput: "一つ目" });
    const second = client.convert({ ...request(), sourceText: "二つ目", vibratoInput: "二つ目" });
    await Promise.resolve();
    const payload = JSON.parse(socket.sent[0] ?? "{}") as { requestId: string };
    socket.message(
      JSON.stringify({
        type: "azookey.error",
        requestId: payload.requestId,
        error: { code: "busy", message: "busy" },
      }),
    );
    client.close();
    await expect(first).rejects.toThrow("閉じました");
    await expect(second).rejects.toThrow("閉じました");
  });

  it("handles a close failure during explicit shutdown", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient();
    socket.closeFailure = "close failed";
    expect(() => client.close()).not.toThrow();
    expect(client.connectionState).toBe("closed");
  });

  it("recovers from a connection error that is never followed by close", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new AzooKeyWorkerClient({ endpoint: "wss://worker.example/ws" });
    const first = client.connect();
    const firstSocket = FakeWebSocket.instances.at(-1);
    if (!firstSocket) {
      throw new Error("fake socket was not constructed");
    }
    firstSocket.error();
    await expect(first).rejects.toThrow("接続エラー");

    const retry = client.connect();
    const secondSocket = FakeWebSocket.instances.at(-1);
    if (!secondSocket) {
      throw new Error("fake socket was not constructed");
    }
    expect(secondSocket).not.toBe(firstSocket);
    let retried = false;
    void retry.then(() => {
      retried = true;
    });
    firstSocket.open();
    await Promise.resolve();
    expect(retried).toBe(false);
    expect(client.connectionState).toBe("connecting");
    secondSocket.open();
    await retry;
    expect(client.connectionState).toBe("open");

    firstSocket.message(JSON.stringify({ requestId: "stale", text: "無視" }));
    firstSocket.error();
    firstSocket.closeFromPeer(1006);
    expect(client.connectionState).toBe("open");

    const pending = client.convert(request());
    await Promise.resolve();
    const sent = JSON.parse(secondSocket.sent.at(-1) ?? "{}") as { requestId: string };
    secondSocket.message(JSON.stringify({ requestId: sent.requestId, text: "復帰" }));
    await expect(pending).resolves.toMatchObject({ convertedText: "復帰" });
  });

  it("uses a deterministic fallback request ID when crypto is unavailable", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { client, socket } = await openClient();
    const pending = client.convert(request());
    await Promise.resolve();
    const sent = JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string };
    expect(sent.requestId).toMatch(/^azookey-/);
    socket.message(JSON.stringify({ requestId: sent.requestId, text: "結果" }));
    await expect(pending).resolves.toMatchObject({ convertedText: "結果" });
  });

  it("keeps the Worker's error code so a refusal is not read as a conversion", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = await openClient({ maxBusyRetries: 0 });
    const pending = client.convert(request());
    await Promise.resolve();
    const sent = JSON.parse(socket.sent.at(-1) ?? "{}") as { requestId: string };
    socket.message(
      JSON.stringify({
        type: "azookey.error",
        requestId: sent.requestId,
        error: { code: "busy", message: "another conversion is in progress" },
      }),
    );

    const rejection = await pending.catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(AzooKeyWorkerError);
    expect((rejection as AzooKeyWorkerError).code).toBe("busy");
    // The Worker answers busy before it ever invokes the converter.
    expect(workerErrorReachedConverter(rejection)).toBe(false);
  });

  it("separates conversion, refusal, and uncertain Worker failures", () => {
    expect(workerErrorReachedConverter(new AzooKeyWorkerError("failed", "conversion_failed"))).toBe(
      true,
    );
    expect(
      workerErrorReachedConverter(new AzooKeyWorkerError("timeout", "conversion_timeout")),
    ).toBe(true);
    expect(workerErrorStage(new AzooKeyWorkerError("failed", "conversion_failed"))).toBe("worker");
    expect(workerErrorStage(new AzooKeyWorkerError("timeout", "conversion_timeout"))).toBe(
      "worker",
    );
    expect(workerErrorReachedConverter(new AzooKeyWorkerError("nope", "unauthorized"))).toBe(false);
    expect(workerErrorReachedConverter(new AzooKeyWorkerError("nope", "invalid_contract"))).toBe(
      false,
    );
    expect(workerErrorStage(new AzooKeyWorkerError("nope", "unauthorized"))).toBe("worker-request");
    expect(workerErrorStage(new AzooKeyWorkerError("nope", "invalid_contract"))).toBe(
      "worker-request",
    );
    expect(workerErrorReachedConverter(new AzooKeyWorkerError("no code"))).toBe(false);
    expect(workerErrorReachedConverter(new Error("socket died"))).toBe(false);
    expect(workerErrorStage(new AzooKeyWorkerError("no code"))).toBe("worker-transport");
    expect(workerErrorStage(new Error("socket died"))).toBe("worker-transport");
    // An unknown code is not enough evidence to claim either conversion or refusal.
    expect(workerErrorStage(new AzooKeyWorkerError("future", "some_future_code"))).toBe(
      "worker-transport",
    );
  });

  it("classifies Vibrato pre-pass refusals as before-converter rejections", () => {
    // The Worker emits these codes when the Vibrato pre-pass failed before the
    // AzooKey converter was invoked. They are definite refusals, not ambiguous
    // transport outcomes, and must never claim that conversion ran.
    for (const code of ["vibrato_unavailable", "vibrato_timeout", "vibrato_failed"]) {
      const rejection = new AzooKeyWorkerError("pre-pass failed", code);
      expect(workerErrorReachedConverter(rejection)).toBe(false);
      expect(workerErrorStage(rejection)).toBe("worker-request");
    }
  });
});
