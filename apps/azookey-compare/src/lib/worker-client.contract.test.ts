// This file runs with bun.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runComparisonConversion, zenzWorkerLeftContextField } from "./conversion-pipeline";
import { AzooKeyWorkerClient } from "./worker-client";

type MessageHandler = ((event: { data: unknown }) => void) | null;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: MessageHandler = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];

  constructor(readonly endpoint: string) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

const parseSentFrame = (raw: string | undefined): Record<string, unknown> => {
  if (typeof raw !== "string") {
    throw new Error("UI path did not send a WebSocket frame");
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("sent frame is not a JSON object");
  }
  return parsed as Record<string, unknown>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("compare UI outbound convert-frame contract", () => {
  it("puts a leftContext key on the Zenz worker frame even when previous captions are empty", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new AzooKeyWorkerClient({
      endpoint: "wss://worker.example/ws",
      requestTimeoutMs: 20,
    });
    const connecting = client.connect();
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) {
      throw new Error("fake socket was not constructed");
    }
    socket.open();
    await connecting;

    const previousCaptions: Array<string | undefined> = [];
    const conversion = runComparisonConversion(
      {
        sourceText: "かんじ",
        mode: "worker-vibrato",
        converterModel: "zenz-v3.2-small-gguf",
        language: "ja",
        auth: { scheme: "none" },
        ...zenzWorkerLeftContextField("zenz-v3.2-small-gguf", previousCaptions),
      },
      {
        runBrowserVibrato: vi.fn(() => Promise.resolve({ text: "かんじ", elapsedMs: 1 })),
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(async () => {
          await client.connect();
        }),
        convertWithWorker: (request) => client.convert(request),
      },
    );
    const started = Date.now();
    while (socket.sent.length === 0 && Date.now() - started < 200) {
      await Promise.resolve();
    }
    const frame = parseSentFrame(socket.sent[0]);
    expect(Object.hasOwn(frame, "leftContext")).toBe(true);
    expect(typeof frame["leftContext"]).toBe("string");
    const requestId = frame["requestId"];
    if (typeof requestId === "string" && socket.onmessage) {
      socket.onmessage({
        data: JSON.stringify({
          requestId,
          sourceText: "かんじ",
          convertedText: "漢字",
        }),
      });
    }
    await conversion;
  });

  it("omits the leftContext key on dictionary worker frames", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new AzooKeyWorkerClient({
      endpoint: "wss://worker.example/ws",
      requestTimeoutMs: 20,
    });
    const connecting = client.connect();
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) {
      throw new Error("fake socket was not constructed");
    }
    socket.open();
    await connecting;

    const conversion = runComparisonConversion(
      {
        sourceText: "かんじ",
        mode: "worker-vibrato",
        converterModel: "azookey-rust-wasm",
        language: "ja",
        auth: { scheme: "none" },
        ...zenzWorkerLeftContextField("azookey-rust-wasm", ["子供がお菓子を食べています。"]),
      },
      {
        runBrowserVibrato: vi.fn(() => Promise.resolve({ text: "かんじ", elapsedMs: 1 })),
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(async () => {
          await client.connect();
        }),
        convertWithWorker: (request) => client.convert(request),
      },
    );
    const started = Date.now();
    while (socket.sent.length === 0 && Date.now() - started < 200) {
      await Promise.resolve();
    }
    const frame = parseSentFrame(socket.sent[0]);
    expect(Object.hasOwn(frame, "leftContext")).toBe(false);
    const requestId = frame["requestId"];
    if (typeof requestId === "string" && socket.onmessage) {
      socket.onmessage({
        data: JSON.stringify({
          requestId,
          sourceText: "かんじ",
          convertedText: "漢字",
        }),
      });
    }
    await conversion;
  });

  it("reuses one session WebSocket across two worker-vibrato conversions", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new AzooKeyWorkerClient({
      endpoint: "wss://worker.example/ws",
      requestTimeoutMs: 20,
    });
    const warming = client.warmup({
      fetchImpl: vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
    });
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) {
      throw new Error("fake socket was not constructed");
    }
    socket.open();
    await warming;

    const first = runComparisonConversion(
      {
        sourceText: "かんじ",
        mode: "worker-vibrato",
        converterModel: "azookey-rust-wasm",
        language: "ja",
        auth: { scheme: "none" },
      },
      {
        runBrowserVibrato: vi.fn(() => Promise.resolve({ text: "かんじ", elapsedMs: 1 })),
        runBrowserAzookey: vi.fn(),
        connectWorker: () => client.connect(),
        convertWithWorker: (request) => client.convert(request),
      },
    );
    const firstStarted = Date.now();
    while (socket.sent.length === 0 && Date.now() - firstStarted < 200) {
      await Promise.resolve();
    }
    const firstFrame = parseSentFrame(socket.sent[0]);
    const firstRequestId = firstFrame["requestId"];
    if (typeof firstRequestId !== "string") {
      throw new Error("first convert requestId is missing");
    }
    if (socket.onmessage) {
      socket.onmessage({
        data: JSON.stringify({
          requestId: firstRequestId,
          sourceText: "かんじ",
          convertedText: "漢字",
        }),
      });
    }
    await first;

    const second = runComparisonConversion(
      {
        sourceText: "てんき",
        mode: "worker-vibrato",
        converterModel: "azookey-rust-wasm",
        language: "ja",
        auth: { scheme: "none" },
      },
      {
        runBrowserVibrato: vi.fn(() => Promise.resolve({ text: "てんき", elapsedMs: 1 })),
        runBrowserAzookey: vi.fn(),
        connectWorker: () => client.connect(),
        convertWithWorker: (request) => client.convert(request),
      },
    );
    const secondStarted = Date.now();
    while (socket.sent.length < 2 && Date.now() - secondStarted < 200) {
      await Promise.resolve();
    }
    const secondFrame = parseSentFrame(socket.sent[1]);
    const secondRequestId = secondFrame["requestId"];
    if (typeof secondRequestId !== "string") {
      throw new Error("second convert requestId is missing");
    }
    if (socket.onmessage) {
      socket.onmessage({
        data: JSON.stringify({
          requestId: secondRequestId,
          sourceText: "てんき",
          convertedText: "天気",
        }),
      });
    }
    await second;
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.sent).toHaveLength(2);
  });
});
