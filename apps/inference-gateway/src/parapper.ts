import { randomUUID } from "node:crypto";
import { GatewayError, SerialGate } from "@caption-bridge/inference-server-core";
import WebSocket from "ws";
import { PARAPPER_SAMPLE_RATE, splitParapperFrames } from "./audio.js";

const PCM16_BYTES_PER_MILLISECOND = (PARAPPER_SAMPLE_RATE * 2) / 1_000;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export { GatewayError, SerialGate } from "@caption-bridge/inference-server-core";

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
    function settle(result: { error: Error } | { text: string }): void {
      finished = true;
      clearTimeout(timer);
      socket.close();
      if ("error" in result) {
        reject(result.error);
      } else {
        resolve(result.text);
      }
    }
    const sendPacedFrames = async (): Promise<void> => {
      const frames = splitParapperFrames(pcm);
      for (const [index, frame] of frames.entries()) {
        if (finished) {
          return;
        }
        socket.send(frame);
        if (index + 1 < frames.length) {
          await wait(Math.ceil(frame.length / PCM16_BYTES_PER_MILLISECOND));
        }
      }
      if (!finished) {
        socket.send(JSON.stringify({ version: 1, type: "session.stop", session_id: sessionId }));
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
        void sendPacedFrames().catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : "could not send PCM audio";
          settle({ error: new GatewayError(502, "parapper_send_failed", detail) });
        });
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
