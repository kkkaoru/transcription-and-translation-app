import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { SerialGate, transcribeWithParapper } from "./parapper.js";

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

  it("soft-returns empty text when Parapper finishes without a usable final", async () => {
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
          // Partials only (or whitespace final) + session.done — typical silent window.
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
    try {
      await expect(
        transcribeWithParapper(new Uint8Array(2), {
          url: noFinal.url,
          timeoutMs: 1000,
          log: () => undefined,
        }),
      ).resolves.toBe("");
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
