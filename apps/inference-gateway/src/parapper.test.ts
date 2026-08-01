import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { formatParapperConnectionError, SerialGate, transcribeWithParapper } from "./parapper.js";

const startParapper = async (
  onConnection: (socket: WebSocket, request: IncomingMessage) => void,
): Promise<{ close: () => Promise<void>; url: string }> => {
  const server = createServer();
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", onConnection);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server has no TCP address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/ws/recognition`,
    close: async () => {
      for (const client of websocket.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      websocket.close();
    },
  };
};

describe("Parapper WebSocket adapter", () => {
  it("formats connection failures from Error and unknown values", () => {
    expect(formatParapperConnectionError(new Error("socket unavailable"))).toBe(
      "socket unavailable",
    );
    expect(formatParapperConnectionError("socket unavailable")).toBe(
      "could not open Parapper connection",
    );
  });

  it("rejects an already-cancelled capture before opening a socket", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      transcribeWithParapper(new Uint8Array(2), {
        url: "ws://127.0.0.1:1/ws/recognition",
        timeoutMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "parapper_cancelled", status: 499 });
  });

  it("turns a synchronous invalid WebSocket URL into a connection error", async () => {
    await expect(
      transcribeWithParapper(new Uint8Array(2), {
        url: "not-a-websocket-url",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "parapper_connection_failed", status: 502 });
  });

  it("keeps the session result when a diagnostic logger throws", async () => {
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) return;
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.done", session_id: message.session_id }),
          );
        }
      });
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), {
          url: fixture.url,
          timeoutMs: 1_000,
          log: () => {
            throw new Error("logger unavailable");
          },
        }),
      ).resolves.toBe("");
    } finally {
      await fixture.close();
    }
  });

  it("cancels before the socket opens without wedging the capture loop", async () => {
    const fixture = await startParapper(() => undefined);
    const controller = new AbortController();
    try {
      const pending = transcribeWithParapper(new Uint8Array(2), {
        url: fixture.url,
        timeoutMs: 1_000,
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "parapper_cancelled", status: 499 });
    } finally {
      await fixture.close();
    }
  });

  it("handles an abort that races listener registration", async () => {
    const fixture = await startParapper(() => undefined);
    const controller = new AbortController();
    let signalReads = 0;
    const options = {
      url: fixture.url,
      timeoutMs: 1_000,
    } as Parameters<typeof transcribeWithParapper>[1];
    Object.defineProperty(options, "signal", {
      configurable: true,
      get: () => {
        signalReads += 1;
        if (signalReads === 2) {
          controller.abort();
        }
        return controller.signal;
      },
    });
    try {
      await expect(transcribeWithParapper(new Uint8Array(2), options)).rejects.toMatchObject({
        code: "parapper_cancelled",
        status: 499,
      });
      expect(signalReads).toBeGreaterThanOrEqual(2);
    } finally {
      await fixture.close();
    }
  });

  it("survives a cancellation send failure", async () => {
    let ready = false;
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) return;
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          ready = true;
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        }
      });
    });
    const controller = new AbortController();
    const originalSend = WebSocket.prototype.send;
    const send = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket["send"]>
    ) {
      const [data] = args;
      if (typeof data === "string" && data.includes("session.cancel")) {
        throw new Error("cancel send race");
      }
      return originalSend.apply(this, args);
    });
    try {
      const pending = transcribeWithParapper(new Uint8Array(2), {
        url: fixture.url,
        timeoutMs: 1_000,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(ready).toBe(true));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "parapper_cancelled", status: 499 });
    } finally {
      send.mockRestore();
      await fixture.close();
    }
  });

  it("reports a close without a reason and preserves a partial in error diagnostics", async () => {
    const closed = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) return;
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.close(1001);
        }
      });
    });
    const partialThenError = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.partial",
              session_id: "partial-error",
              text: "partial text",
            }),
          );
          socket.send(
            JSON.stringify({
              version: 1,
              type: "error",
              session_id: "partial-error",
              code: "invalid_audio",
            }),
          );
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        }
      });
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), { url: closed.url, timeoutMs: 1_000 }),
      ).rejects.toMatchObject({
        code: "parapper_connection_closed",
        message: "Parapper sidecar closed the session (1001)",
      });
      await expect(
        transcribeWithParapper(new Uint8Array(2), {
          url: partialThenError.url,
          timeoutMs: 1_000,
          sessionId: () => "partial-error",
        }),
      ).rejects.toMatchObject({ code: "invalid_audio", status: 502 });
    } finally {
      await Promise.all([closed.close(), partialThenError.close()]);
    }
  });

  it("settles a session-start send failure", async () => {
    const fixture = await startParapper(() => undefined);
    const originalSend = WebSocket.prototype.send;
    const send = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket["send"]>
    ) {
      const [data] = args;
      if (typeof data === "string" && data.includes('"session.start"')) {
        throw new Error("start send race");
      }
      return originalSend.apply(this, args);
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), { url: fixture.url, timeoutMs: 1_000 }),
      ).rejects.toMatchObject({ code: "parapper_send_failed", status: 502 });
    } finally {
      send.mockRestore();
      await fixture.close();
    }
  });

  it("settles a session-stop send failure", async () => {
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) return;
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        }
      });
    });
    const originalSend = WebSocket.prototype.send;
    const send = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket["send"]>
    ) {
      const [data] = args;
      if (typeof data === "string" && data.includes('"session.stop"')) {
        throw new Error("stop send race");
      }
      return originalSend.apply(this, args);
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), { url: fixture.url, timeoutMs: 1_000 }),
      ).rejects.toMatchObject({ code: "parapper_send_failed", status: 502 });
    } finally {
      send.mockRestore();
      await fixture.close();
    }
  });

  it("ignores a duplicate ready and soft-skips whitespace partials/finals", async () => {
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) return;
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          const ready = JSON.stringify({
            version: 1,
            type: "session.ready",
            session_id: message.session_id,
          });
          socket.send(ready);
          setTimeout(() => socket.send(ready), 10);
        } else if (message.type === "session.stop") {
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.partial",
              session_id: message.session_id,
              text: "   ",
            }),
          );
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.final",
              session_id: message.session_id,
              text: "   ",
            }),
          );
          socket.send(
            JSON.stringify({ version: 1, type: "session.done", session_id: message.session_id }),
          );
        }
      });
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(6_402), { url: fixture.url, timeoutMs: 1_000 }),
      ).resolves.toBe("");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await fixture.close();
    }
  });

  it("uses the v1 start/ready/frame/stop/final/done protocol", async () => {
    const received: {
      authorization: string | undefined;
      binaryFrames: number[];
      frameSentAt: number[];
      start?: unknown;
      stop?: unknown;
    } = {
      authorization: undefined,
      binaryFrames: [],
      frameSentAt: [],
    };
    const fixture = await startParapper((socket, request) => {
      received.authorization = request.headers.authorization;
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          received.binaryFrames.push(Buffer.isBuffer(data) ? data.length : 0);
          received.frameSentAt.push(Date.now());
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          received.start = message;
          socket.send(Buffer.from([1]));
          socket.send("this is not JSON");
          socket.send(
            JSON.stringify({ version: 2, type: "session.ready", session_id: message.session_id }),
          );
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: "different-session" }),
          );
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        } else if (message.type === "session.stop") {
          received.stop = message;
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.final",
              session_id: message.session_id,
              text: " こんにちは。 ",
            }),
          );
          socket.send(
            JSON.stringify({ version: 1, type: "session.done", session_id: message.session_id }),
          );
          socket.send(
            JSON.stringify({ version: 1, type: "session.done", session_id: message.session_id }),
          );
        }
      });
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(6402), {
          url: fixture.url,
          timeoutMs: 1000,
          apiKey: "local-key",
          sessionId: () => "caption-1",
        }),
      ).resolves.toBe("こんにちは。");
      expect(received.authorization).toBe("Bearer local-key");
      expect(received.start).toMatchObject({ type: "session.start", session_id: "caption-1" });
      expect(received.stop).toMatchObject({ type: "session.stop", session_id: "caption-1" });
      expect(received.binaryFrames).toEqual([3200, 3200, 2]);
      const [firstFrame, secondFrame, thirdFrame] = received.frameSentAt;
      if (firstFrame === undefined || secondFrame === undefined || thirdFrame === undefined) {
        throw new Error("expected timestamps for all PCM frames");
      }
      expect(secondFrame - firstFrame).toBeGreaterThanOrEqual(75);
      expect(thirdFrame - secondFrame).toBeGreaterThanOrEqual(75);
    } finally {
      await fixture.close();
    }
  });

  it("turns Parapper errors and timeouts into useful gateway errors", async () => {
    const failing = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "error", session_id: message.session_id }),
          );
        }
      });
    });
    const timeout = await startParapper(() => undefined);
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), { url: failing.url, timeoutMs: 1000 }),
      ).rejects.toMatchObject({
        code: "parapper_protocol_error",
        status: 502,
      });
      await expect(
        transcribeWithParapper(new Uint8Array(2), { url: timeout.url, timeoutMs: 20 }),
      ).rejects.toMatchObject({
        code: "parapper_timeout",
        status: 504,
      });
      await expect(
        transcribeWithParapper(new Uint8Array(2), {
          url: "ws://127.0.0.1:1/ws/recognition",
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({
        code: "parapper_connection_failed",
        status: 502,
      });
    } finally {
      await Promise.all([failing.close(), timeout.close()]);
    }
  });

  it("fails promptly when the sidecar closes before session.done", async () => {
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.close(1001, "sidecar restarting");
        }
      });
    });
    try {
      const startedAt = Date.now();
      await expect(
        transcribeWithParapper(new Uint8Array(2), { url: fixture.url, timeoutMs: 1_000 }),
      ).rejects.toMatchObject({
        code: "parapper_connection_closed",
        status: 502,
      });
      // A close is a terminal session result; do not make the next chunk wait
      // for the full ASR timeout window.
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      await fixture.close();
    }
  });

  it("cancels an in-flight session and removes its abort listener", async () => {
    let ready = false;
    let cancelReceived = false;
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          ready = true;
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        } else if (message.type === "session.cancel") {
          cancelReceived = true;
        }
      });
    });
    const controller = new AbortController();
    try {
      const pending = transcribeWithParapper(new Uint8Array(2), {
        url: fixture.url,
        timeoutMs: 1_000,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(ready).toBe(true));
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: "parapper_cancelled",
        status: 499,
      });
      await vi.waitFor(() => expect(cancelReceived).toBe(true));
      // Repeated aborts must not produce an additional rejection or sidecar
      // callback after the session has already settled.
      controller.abort();
    } finally {
      await fixture.close();
    }
  });

  it("preserves protocol error code and message when Parapper supplies both", async () => {
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({
              version: 1,
              type: "error",
              session_id: message.session_id,
              code: "invalid_audio",
              message: "PCM stream rejected",
            }),
          );
        }
      });
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), { url: fixture.url, timeoutMs: 1_000 }),
      ).rejects.toMatchObject({
        code: "invalid_audio",
        status: 502,
        message: "PCM stream rejected",
      });
    } finally {
      await fixture.close();
    }
  });

  it("uses the latest non-empty partial when Parapper finishes without a usable final", async () => {
    const noFinal = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        } else if (message.type === "session.stop") {
          // A whitespace partial is ignored; a non-empty partial is retained as
          // the source text when the short window has no usable final.
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.partial",
              session_id: message.session_id,
              text: "  ",
            }),
          );
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.partial",
              session_id: message.session_id,
              text: "  途中  ",
            }),
          );
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.partial",
              session_id: message.session_id,
              text: "  最新の途中  ",
            }),
          );
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.final",
              session_id: message.session_id,
              text: " ",
            }),
          );
          socket.send(
            JSON.stringify({ version: 1, type: "session.done", session_id: message.session_id }),
          );
        }
      });
    });
    const missingFinal = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        } else if (message.type === "session.stop") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.done", session_id: message.session_id }),
          );
        }
      });
    });
    const logged: string[] = [];
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), {
          url: noFinal.url,
          timeoutMs: 1000,
          log: (message) => {
            logged.push(message);
          },
        }),
      ).resolves.toBe("最新の途中");
      // The final-missing reason must reach the debug layer, not just vanish.
      expect(logged).toContain("session done using latest partial transcript (final missing)");
      await expect(
        transcribeWithParapper(new Uint8Array(2), {
          url: missingFinal.url,
          timeoutMs: 1000,
          log: () => undefined,
        }),
      ).resolves.toBe("");
    } finally {
      await Promise.all([noFinal.close(), missingFinal.close()]);
    }
  });

  it("soft-returns empty text for legacy transcript_missing error frames", async () => {
    const legacy = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        } else if (message.type === "session.stop") {
          // Older sidecars emitted this instead of session.done when VAD found
          // no speech; it is still a successful empty window.
          socket.send(
            JSON.stringify({
              version: 1,
              type: "error",
              session_id: message.session_id,
              code: "transcript_missing",
              message: "Parapper completed without a final transcript",
            }),
          );
        }
      });
    });
    const logged: Array<{ message: string; fields: Record<string, unknown> | undefined }> = [];
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), {
          url: legacy.url,
          timeoutMs: 1_000,
          log: (message, fields) => logged.push({ message, fields }),
        }),
      ).resolves.toBe("");
      expect(logged.map((entry) => entry.message)).toContain(
        "Parapper reported no speech (soft empty)",
      );
    } finally {
      await legacy.close();
    }
  });

  it("soft-returns empty text for common no-speech error variants", async () => {
    const variants: Array<{
      code?: string;
      message?: string;
      text?: string;
    }> = [
      { code: "no_speech", message: "no speech detected" },
      { code: "empty_transcript", message: "empty transcript" },
      // Some sidecars omit both fields and only include a text explanation.
      { text: "no speech" },
      { message: "Parapper completed without a final transcript" },
    ];

    for (const variant of variants) {
      const fixture = await startParapper((socket) => {
        socket.on("message", (data: RawData, binary: boolean) => {
          if (binary) {
            return;
          }
          const message = JSON.parse(data.toString()) as { session_id: string; type: string };
          if (message.type === "session.start") {
            socket.send(
              JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
            );
          } else if (message.type === "session.stop") {
            socket.send(
              JSON.stringify({
                version: 1,
                type: "error",
                session_id: message.session_id,
                ...variant,
              }),
            );
          }
        });
      });
      try {
        await expect(
          transcribeWithParapper(new Uint8Array(2), { url: fixture.url, timeoutMs: 1_000 }),
        ).resolves.toBe("");
      } finally {
        await fixture.close();
      }
    }
  });

  it("uses a usable partial when a no-speech error arrives without a final", async () => {
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        } else if (message.type === "session.stop") {
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.partial",
              session_id: message.session_id,
              turn_session_id: 1,
              turn_id: 1,
              segment_id: 1,
              revision: 1,
              text: "短い発話",
            }),
          );
          socket.send(
            JSON.stringify({
              version: 1,
              type: "error",
              session_id: message.session_id,
              code: "transcript_missing",
              message: "Parapper completed without a final transcript",
            }),
          );
        }
      });
    });
    const logged: string[] = [];
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), {
          url: fixture.url,
          timeoutMs: 1_000,
          log: (message) => logged.push(message),
        }),
      ).resolves.toBe("短い発話");
      expect(logged).toContain("Parapper reported no speech; using latest partial transcript");
    } finally {
      await fixture.close();
    }
  });

  it("does not let an out-of-order partial replace the latest short-chunk result", async () => {
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        } else if (message.type === "session.stop") {
          // A delayed ASR callback can deliver an older revision after the
          // latest partial. The adapter must keep the newest protocol cursor.
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.partial",
              session_id: message.session_id,
              turn_session_id: 1,
              turn_id: 2,
              segment_id: 4,
              revision: 3,
              text: "新しい結果",
            }),
          );
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.partial",
              session_id: message.session_id,
              turn_session_id: 1,
              turn_id: 2,
              segment_id: 4,
              revision: 2,
              text: "古い結果",
            }),
          );
          socket.send(
            JSON.stringify({ version: 1, type: "session.done", session_id: message.session_id }),
          );
        }
      });
    });
    const logged: string[] = [];
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), {
          url: fixture.url,
          timeoutMs: 1_000,
          log: (message) => logged.push(message),
        }),
      ).resolves.toBe("新しい結果");
      expect(logged).toContain("stale partial transcript ignored");
    } finally {
      await fixture.close();
    }
  });

  it("keeps standard surface text separate from a sidecar AzooKey reading", async () => {
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        } else if (message.type === "session.stop") {
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.partial",
              session_id: message.session_id,
              turn_session_id: 2,
              turn_id: 4,
              revision: 0,
              output_sequence: 1,
              segment_id: 7,
              text: "きょうは",
              source_text: "今日は",
            }),
          );
          socket.send(
            JSON.stringify({
              version: 1,
              type: "turn.final",
              session_id: message.session_id,
              turn_session_id: 2,
              turn_id: 4,
              revision: 0,
              output_sequence: 2,
              segment_id: 7,
              text: "きょうは晴れです。",
              source_text: "今日は晴れです。",
            }),
          );
          socket.send(
            JSON.stringify({ version: 1, type: "session.done", session_id: message.session_id }),
          );
        }
      });
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), { url: fixture.url, timeoutMs: 1_000 }),
      ).resolves.toBe("今日は晴れです。");
    } finally {
      await fixture.close();
    }
  });

  it("soft-returns an unsolicited session.done without sending audio", async () => {
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          throw new Error("audio must not be sent before ready");
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({
              version: 1,
              type: "session.done",
              session_id: message.session_id,
            }),
          );
        }
      });
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), { url: fixture.url, timeoutMs: 1_000 }),
      ).resolves.toBe("");
    } finally {
      await fixture.close();
    }
  });

  it("settles safely when a close race emits an error and close itself throws", async () => {
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.done", session_id: message.session_id }),
          );
        }
      });
    });
    const close = vi.spyOn(WebSocket.prototype, "close").mockImplementation(function (
      this: WebSocket,
    ) {
      this.emit("error", new Error("late socket error"));
      throw new Error("close race");
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), { url: fixture.url, timeoutMs: 1_000 }),
      ).resolves.toBe("");
    } finally {
      close.mockRestore();
      await fixture.close();
    }
  });

  it("normalizes non-Error send failures to a stable gateway error", async () => {
    const fixture = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        }
      });
    });
    const originalSend = WebSocket.prototype.send;
    const send = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket["send"]>
    ) {
      const [data] = args;
      if (typeof data !== "string") {
        throw "socket send failed";
      }
      return originalSend.apply(this, args);
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), { url: fixture.url, timeoutMs: 1_000 }),
      ).rejects.toMatchObject({
        code: "parapper_send_failed",
        status: 502,
        message: "could not send PCM audio",
      });
    } finally {
      send.mockRestore();
      await fixture.close();
    }
  });

  it("paces audio and stops queued frames when Parapper rejects a session", async () => {
    const receivedFrames: number[] = [];
    const rejecting = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          receivedFrames.push(Buffer.isBuffer(data) ? data.length : 0);
          socket.send(JSON.stringify({ version: 1, type: "error", session_id: "paced-session" }));
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        }
      });
    });
    const malformed = await startParapper((socket) => {
      socket.on("message", (data: RawData, binary: boolean) => {
        if (binary) {
          return;
        }
        const message = JSON.parse(data.toString()) as { session_id: string; type: string };
        if (message.type === "session.start") {
          socket.send(
            JSON.stringify({ version: 1, type: "session.ready", session_id: message.session_id }),
          );
        }
      });
    });
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(6402), {
          url: rejecting.url,
          timeoutMs: 1_000,
          sessionId: () => "paced-session",
        }),
      ).rejects.toMatchObject({ code: "parapper_protocol_error", status: 502 });
      await new Promise((resolve) => setTimeout(resolve, 125));
      expect(receivedFrames).toEqual([3200]);
      await expect(
        transcribeWithParapper(new Uint8Array(3), { url: malformed.url, timeoutMs: 1_000 }),
      ).rejects.toMatchObject({ code: "parapper_send_failed", status: 502 });
    } finally {
      await Promise.all([rejecting.close(), malformed.close()]);
    }
  });

  it("serializes ASR work after a failure", async () => {
    const gate = new SerialGate();
    const sequence: string[] = [];
    const first = gate.run(() =>
      Promise.resolve().then(() => {
        sequence.push("first");
        throw new Error("expected");
      }),
    );
    const second = gate.run(() =>
      Promise.resolve().then(() => {
        sequence.push("second");
        return 2;
      }),
    );
    await expect(first).rejects.toThrow("expected");
    await expect(second).resolves.toBe(2);
    expect(sequence).toEqual(["first", "second"]);
  });
});
