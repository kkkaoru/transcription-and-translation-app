import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { splitParapperFrames } from "./audio.js";

export class GatewayError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface ParapperOptions {
  apiKey?: string;
  sessionId?: () => string;
  timeoutMs: number;
  url: string;
}

interface ParapperMessage {
  code?: string;
  message?: string;
  session_id?: string;
  text?: string;
  type?: string;
  version?: number;
}

const parseMessage = (data: WebSocket.RawData): ParapperMessage | null => {
  if (typeof data !== "string" && !Buffer.isBuffer(data)) {
    return null;
  }
  try {
    return JSON.parse(data.toString()) as ParapperMessage;
  } catch {
    return null;
  }
};

const protocolError = (message: ParapperMessage): GatewayError =>
  new GatewayError(
    502,
    message.code ?? "parapper_protocol_error",
    message.message ?? "Parapper rejected the recognition session",
  );

export const transcribeWithParapper = (
  pcm: Uint8Array,
  options: ParapperOptions,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const sessionId = (options.sessionId ?? randomUUID)();
    const socket = new WebSocket(options.url, {
      ...(options.apiKey ? { headers: { Authorization: `Bearer ${options.apiKey}` } } : {}),
    });
    let finished = false;
    let finalText: string | null = null;
    const settle = (result: { error: Error } | { text: string }) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      socket.close();
      if ("error" in result) {
        reject(result.error);
      } else {
        resolve(result.text);
      }
    };
    const timer = setTimeout(() => {
      settle({
        error: new GatewayError(504, "parapper_timeout", "Parapper did not finish in time"),
      });
    }, options.timeoutMs);

    socket.once("error", (error) => {
      settle({ error: new GatewayError(502, "parapper_connection_failed", error.message) });
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary || finished) {
        return;
      }
      const message = parseMessage(data);
      if (message?.version !== 1 || message.session_id !== sessionId) {
        return;
      }
      if (message.type === "error") {
        settle({ error: protocolError(message) });
      } else if (message.type === "session.ready") {
        for (const frame of splitParapperFrames(pcm)) {
          socket.send(frame);
        }
        socket.send(JSON.stringify({ version: 1, type: "session.stop", session_id: sessionId }));
      } else if (message.type === "turn.final") {
        finalText = message.text?.trim() || null;
      } else if (message.type === "session.done") {
        settle(
          finalText
            ? { text: finalText }
            : {
                error: new GatewayError(
                  422,
                  "transcript_missing",
                  "Parapper completed without a final transcript",
                ),
              },
        );
      }
    });
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          version: 1,
          type: "session.start",
          session_id: sessionId,
          audio: { encoding: "pcm_s16le", sample_rate: 16000, channels: 1 },
        }),
      );
    });
  });

export class SerialGate {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
