import { randomUUID } from "node:crypto";
import { GatewayError } from "@caption-bridge/inference-server-core";
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
  /** Optional logger for fine-grained ASR session diagnostics. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
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

const defaultLog = (message: string, fields?: Record<string, unknown>): void => {
  if (fields && Object.keys(fields).length > 0) {
    console.info(`[parapper] ${message}`, fields);
  } else {
    console.info(`[parapper] ${message}`);
  }
};

/**
 * Stream mono 16 kHz PCM16LE to Parapper and return the final transcript text.
 *
 * Live caption windows often contain only ambient noise. When Parapper finishes
 * without a non-empty `turn.final` (VAD found no speech), this resolves to `""`
 * rather than HTTP 422 so continuous capture can soft-skip without hard failure.
 */
export const transcribeWithParapper = (
  pcm: Uint8Array,
  options: ParapperOptions,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const sessionId = (options.sessionId ?? randomUUID)();
    const log = options.log ?? defaultLog;
    const startedAt = Date.now();
    const socket = new WebSocket(options.url, {
      ...(options.apiKey ? { headers: { Authorization: `Bearer ${options.apiKey}` } } : {}),
    });
    let finished = false;
    let finalText: string | null = null;
    let lastPartialText: string | null = null;
    let partialCount = 0;
    let framesSent = 0;
    let bytesSent = 0;
    let readyAt: number | null = null;
    let stopAt: number | null = null;
    let finalAt: number | null = null;

    function settle(result: { error: Error } | { text: string }): void {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore close races
      }
      const elapsedMs = Date.now() - startedAt;
      if ("error" in result) {
        log("session failed", {
          sessionId,
          elapsedMs,
          pcmBytes: pcm.byteLength,
          framesSent,
          bytesSent,
          partialCount,
          lastPartialChars: lastPartialText?.length ?? 0,
          hasFinal: finalText !== null,
          error: result.error.message,
        });
        reject(result.error);
      } else {
        log("session completed", {
          sessionId,
          elapsedMs,
          pcmBytes: pcm.byteLength,
          framesSent,
          bytesSent,
          partialCount,
          lastPartialChars: lastPartialText?.length ?? 0,
          hasFinal: Boolean(result.text),
          textChars: result.text.length,
          readyLatencyMs: readyAt == null ? null : readyAt - startedAt,
          stopLatencyMs: stopAt == null ? null : stopAt - startedAt,
          finalLatencyMs: finalAt == null ? null : finalAt - startedAt,
        });
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
        framesSent += 1;
        bytesSent += frame.byteLength;
        if (index + 1 < frames.length) {
          await wait(Math.ceil(frame.length / PCM16_BYTES_PER_MILLISECOND));
        }
      }
      if (!finished) {
        stopAt = Date.now();
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
        readyAt = Date.now();
        void sendPacedFrames().catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : "could not send PCM audio";
          settle({ error: new GatewayError(502, "parapper_send_failed", detail) });
        });
      } else if (message.type === "turn.partial") {
        partialCount += 1;
        const partial = message.text?.trim() || null;
        if (partial) {
          lastPartialText = partial;
        }
      } else if (message.type === "turn.final") {
        finalAt = Date.now();
        // Empty/whitespace finals are not usable speech — keep null so session.done
        // can soft-return "" (same as no turn.final at all).
        finalText = message.text?.trim() || null;
      } else if (message.type === "session.done") {
        // No-speech / VAD-silent windows complete without a usable final. Return
        // empty text so OpenAI-shaped clients soft-skip instead of treating 422
        // as a hard audio processing failure during continuous capture.
        if (finalText) {
          settle({ text: finalText });
        } else {
          log("session done without final transcript (soft empty)", {
            sessionId,
            pcmBytes: pcm.byteLength,
            framesSent,
            partialCount,
            lastPartialChars: lastPartialText?.length ?? 0,
          });
          settle({ text: "" });
        }
      }
    });
    socket.once("open", () => {
      log("session start", {
        sessionId,
        pcmBytes: pcm.byteLength,
        sampleRate: PARAPPER_SAMPLE_RATE,
      });
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
