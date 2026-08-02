import { randomUUID } from "node:crypto";
import { GatewayError } from "@caption-bridge/inference-server-core";
import WebSocket from "ws";
import { PARAPPER_SAMPLE_RATE, splitParapperFrames } from "./audio.js";

const PCM16_BYTES_PER_MILLISECOND = (PARAPPER_SAMPLE_RATE * 2) / 1_000;
const PARAPPER_PROTOCOL_VERSION = 1;
const MONO_CHANNEL_COUNT = 1;
const HTTP_CLIENT_CLOSED_REQUEST = 499;
const HTTP_BAD_GATEWAY = 502;
const HTTP_GATEWAY_TIMEOUT = 504;
const ORDER_BEFORE = -1;
const ORDER_EQUAL = 0;
const ORDER_AFTER = 1;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export { GatewayError, SerialGate } from "@caption-bridge/inference-server-core";

export interface ParapperOptions {
  apiKey?: string;
  /** Abort an in-flight sidecar session when the owning capture is cancelled. */
  signal?: AbortSignal;
  sessionId?: () => string;
  timeoutMs: number;
  url: string;
  /** Optional logger for fine-grained ASR session diagnostics. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

interface ParapperMessage {
  code?: string;
  message?: string;
  revision?: number;
  output_sequence?: number;
  segment_id?: number;
  session_id?: string;
  source_text?: string;
  text?: string;
  turn_id?: number;
  turn_session_id?: number;
  type?: string;
  version?: number;
}

/**
 * A short HTTP capture window can be stopped before Parapper emits
 * `turn.final`. Keep the latest usable interim result together with its
 * protocol cursor so an out-of-order/late partial cannot overwrite it.
 */
interface PartialTranscript {
  revision: number | null;
  outputSequence: number | null;
  segmentId: number | null;
  text: string;
  turnId: number | null;
  turnSessionId: number | null;
}

const numericCursor = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Return a protocol ordering for two partials. The sidecar's segment/turn
 * cursors are monotonic, while tests and older sidecars may omit them; in the
 * latter case the caller's arrival order remains authoritative.
 */
const comparePartialCursor = (candidate: PartialTranscript, current: PartialTranscript): number => {
  const fields: Array<keyof PartialTranscript> = [
    "turnSessionId",
    "turnId",
    "revision",
    "outputSequence",
    "segmentId",
  ];
  for (const field of fields) {
    const next = candidate[field];
    const previous = current[field];
    if (typeof next !== "number" || typeof previous !== "number" || next === previous) {
      continue;
    }
    return next > previous ? ORDER_AFTER : ORDER_BEFORE;
  }
  return ORDER_EQUAL;
};

/**
 * The sidecar's optional reading transform is not the HTTP gateway's public
 * transcript format. Prefer its retained ASR surface for standard Parapper
 * callers, while accepting older/Surface producers that only send `text`.
 */
const standardParapperText = (message: ParapperMessage): string | null => {
  const source = typeof message.source_text === "string" ? message.source_text.trim() : "";
  if (source) {
    return source;
  }
  const text = typeof message.text === "string" ? message.text.trim() : "";
  return text || null;
};

/**
 * Parapper versions in the wild report a VAD no-speech result in two ways:
 * either a normal `session.done` with no final, or an `error` frame carrying
 * `transcript_missing`. Both outcomes are expected for continuous capture and
 * must resolve to an empty transcript rather than poisoning the capture loop.
 */
const NO_SPEECH_MESSAGE =
  /(transcript[\s_-]*missing|without[\s_-]*a[\s_-]*final[\s_-]*transcript|no[\s_-]*final[\s_-]*transcript|no[\s_-]*transcript|empty[\s_-]*transcript|no[\s_-]*speech)/i;

const isNoSpeechMessage = (message: ParapperMessage): boolean => {
  // Only the protocol's error code/message fields describe the error. Other
  // fields (for example a `text` or diagnostic payload) may legitimately
  // contain words such as "no speech" while the actual failure is fatal. Do
  // not turn those unrelated fields into a successful empty transcript.
  const detail = [message.code, message.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return NO_SPEECH_MESSAGE.test(detail);
};

const parseMessage = (data: WebSocket.RawData): ParapperMessage | null => {
  try {
    return JSON.parse(data.toString()) as ParapperMessage;
  } catch {
    return null;
  }
};

const protocolError = (message: ParapperMessage): GatewayError => {
  const code =
    typeof message.code === "string" && message.code.trim()
      ? message.code.trim()
      : "parapper_protocol_error";
  const detail =
    typeof message.message === "string" && message.message.trim()
      ? message.message
      : "Parapper rejected the recognition session";
  return new GatewayError(HTTP_BAD_GATEWAY, code, detail);
};

const sendFailure = (error: unknown, fallback: string): GatewayError =>
  new GatewayError(
    HTTP_BAD_GATEWAY,
    "parapper_send_failed",
    error instanceof Error && error.message.trim() ? error.message : fallback,
  );

export const formatParapperConnectionError = (error: unknown): string =>
  error instanceof Error && error.message.trim()
    ? error.message
    : "could not open Parapper connection";

const defaultLog = (message: string, fields?: Record<string, unknown>): void => {
  // biome-ignore lint/suspicious/noConsole: gateway log helper invoked by callers
  console.info(`[parapper] ${message}`, fields);
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
    if (options.signal?.aborted) {
      reject(
        new GatewayError(
          HTTP_CLIENT_CLOSED_REQUEST,
          "parapper_cancelled",
          "Parapper recognition was cancelled",
        ),
      );
      return;
    }
    const sessionId = (options.sessionId ?? randomUUID)();
    const log = options.log ?? defaultLog;
    const startedAt = Date.now();
    let socket: WebSocket;
    try {
      socket = new WebSocket(options.url, {
        ...(options.apiKey ? { headers: { Authorization: `Bearer ${options.apiKey}` } } : {}),
      });
    } catch (error) {
      reject(
        new GatewayError(
          HTTP_BAD_GATEWAY,
          "parapper_connection_failed",
          formatParapperConnectionError(error),
        ),
      );
      return;
    }
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sendStarted = false;
    let finalTranscript: PartialTranscript | null = null;
    let lastPartial: PartialTranscript | null = null;
    let partialCount = 0;
    let framesSent = 0;
    let bytesSent = 0;
    let readyAt: number | null = null;
    let stopAt: number | null = null;
    let finalAt: number | null = null;

    /**
     * `session.done` can close a short HTTP window after a turn finalized and
     * a later turn only produced an interim. Select by the sidecar cursor, not
     * by result kind: otherwise the older final discards the user's newest
     * speech. When cursor metadata is absent, preserve the historical final
     * preference because arrival order is then unknowable.
     */
    const latestUsableTranscript = (): PartialTranscript | null => {
      if (!finalTranscript) {
        return lastPartial;
      }
      if (!lastPartial || comparePartialCursor(finalTranscript, lastPartial) >= ORDER_EQUAL) {
        return finalTranscript;
      }
      return lastPartial;
    };

    const emitLog = (message: string, fields?: Record<string, unknown>): void => {
      // A diagnostic logger must never be able to strand the capture Promise.
      try {
        log(message, fields);
      } catch {
        // Ignore logger failures; the session result remains authoritative.
      }
    };

    const clearSessionTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const onAbort = (): void => {
      settle({
        error: new GatewayError(
          HTTP_CLIENT_CLOSED_REQUEST,
          "parapper_cancelled",
          "Parapper recognition was cancelled",
        ),
      });
    };

    const sendCancelControl = (): void => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        // The protocol distinguishes an explicit cancellation from an
        // unexpected transport close. Do not wait for the acknowledgement:
        // the caller is already leaving this chunk/session.
        socket.send(
          JSON.stringify({
            version: PARAPPER_PROTOCOL_VERSION,
            type: "session.cancel",
            session_id: sessionId,
          }),
        );
      } catch {
        // Cancellation is best effort. The close below still guarantees that
        // the Promise settles and that the next chunk is not blocked.
      }
    };

    function settle(result: { error: Error } | { text: string }): void {
      if (finished) {
        return;
      }
      const shouldCancelSidecar =
        "error" in result &&
        result.error instanceof GatewayError &&
        (result.error.code === "parapper_cancelled" || result.error.code === "parapper_timeout");
      finished = true;
      clearSessionTimer();
      options.signal?.removeEventListener("abort", onAbort);
      if (shouldCancelSidecar) {
        sendCancelControl();
      }
      try {
        socket.close();
      } catch {
        // ignore close races
      }
      const elapsedMs = Date.now() - startedAt;
      if ("error" in result) {
        emitLog("session failed", {
          sessionId,
          elapsedMs,
          pcmBytes: pcm.byteLength,
          framesSent,
          bytesSent,
          partialCount,
          lastPartialChars: lastPartial?.text.length ?? 0,
          hasFinal: finalTranscript !== null,
          error: result.error.message,
        });
        reject(result.error);
      } else {
        emitLog("session completed", {
          sessionId,
          elapsedMs,
          pcmBytes: pcm.byteLength,
          framesSent,
          bytesSent,
          partialCount,
          lastPartialChars: lastPartial?.text.length ?? 0,
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
      sendStarted = true;
      const frames = splitParapperFrames(pcm);
      for (const [index, frame] of frames.entries()) {
        if (finished) {
          return;
        }
        try {
          socket.send(frame);
        } catch (error) {
          throw sendFailure(error, "could not send PCM audio");
        }
        framesSent += 1;
        bytesSent += frame.byteLength;
        if (index + 1 < frames.length) {
          await wait(Math.ceil(frame.length / PCM16_BYTES_PER_MILLISECOND));
        }
      }
      if (!finished) {
        stopAt = Date.now();
        try {
          socket.send(
            JSON.stringify({
              version: PARAPPER_PROTOCOL_VERSION,
              type: "session.stop",
              session_id: sessionId,
            }),
          );
        } catch (error) {
          throw sendFailure(error, "could not send session.stop");
        }
      }
    };

    timer = setTimeout(() => {
      const latest = latestUsableTranscript();
      if (latest) {
        // The sidecar may still be doing work after the HTTP window expires.
        // Return the best result already received, then make a best-effort
        // cancellation before closing the transport so it does not keep an
        // orphaned recognition session alive. An explicit abort/protocol
        // error settles through its own handler and never reaches this path.
        sendCancelControl();
        emitLog("session timed out using latest transcript", {
          sessionId,
          pcmBytes: pcm.byteLength,
          framesSent,
          partialCount,
          transcriptChars: latest.text.length,
          transcriptRevision: latest.revision,
          transcriptSegmentId: latest.segmentId,
        });
        settle({ text: latest.text });
        return;
      }
      settle({
        error: new GatewayError(
          HTTP_GATEWAY_TIMEOUT,
          "parapper_timeout",
          "Parapper did not finish in time",
        ),
      });
    }, options.timeoutMs);

    socket.once("error", (error: Error) => {
      settle({
        error: new GatewayError(
          HTTP_BAD_GATEWAY,
          "parapper_connection_failed",
          formatParapperConnectionError(error),
        ),
      });
    });
    socket.once("close", (code: number, reason: Buffer) => {
      if (finished) {
        return;
      }
      const detail = reason?.toString().trim();
      const latest = latestUsableTranscript();
      if (latest) {
        // A sidecar restart or transport close can race the finalization
        // acknowledgement. Match `session.done`'s cursor ladder so a newer
        // partial is not discarded in favour of an older final. Explicit
        // protocol errors and caller aborts settle first and set `finished`,
        // preserving their existing error contract.
        emitLog("session closed using latest transcript", {
          sessionId,
          code,
          reason: detail || null,
          transcriptChars: latest.text.length,
          transcriptRevision: latest.revision,
          transcriptSegmentId: latest.segmentId,
        });
        settle({ text: latest.text });
        return;
      }
      settle({
        error: new GatewayError(
          HTTP_BAD_GATEWAY,
          "parapper_connection_closed",
          detail
            ? `Parapper sidecar closed the session (${code}): ${detail}`
            : `Parapper sidecar closed the session (${code})`,
        ),
      });
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary || finished) {
        return;
      }
      const message = parseMessage(data);
      if (message?.version !== PARAPPER_PROTOCOL_VERSION || message.session_id !== sessionId) {
        return;
      }
      if (message.type === "error") {
        if (isNoSpeechMessage(message)) {
          const latest = latestUsableTranscript();
          if (latest) {
            emitLog("Parapper reported no speech; using latest partial transcript", {
              sessionId,
              code: message.code ?? null,
              message: message.message ?? null,
              pcmBytes: pcm.byteLength,
              framesSent,
              transcriptChars: latest.text.length,
              transcriptRevision: latest.revision,
              transcriptSegmentId: latest.segmentId,
            });
            settle({ text: latest.text });
          } else {
            emitLog("Parapper reported no speech (soft empty)", {
              sessionId,
              code: message.code ?? null,
              message: message.message ?? null,
              pcmBytes: pcm.byteLength,
              framesSent,
            });
            settle({ text: "" });
          }
        } else {
          settle({ error: protocolError(message) });
        }
      } else if (message.type === "session.ready") {
        if (sendStarted) {
          emitLog("duplicate session.ready ignored", { sessionId });
          return;
        }
        readyAt = Date.now();
        void sendPacedFrames().catch((error: unknown) => {
          settle({
            error:
              error instanceof GatewayError
                ? error
                : sendFailure(error, "could not send PCM audio"),
          });
        });
      } else if (message.type === "turn.partial") {
        partialCount += 1;
        const partial = standardParapperText(message);
        if (partial === null) {
          return;
        }
        const candidate: PartialTranscript = {
          revision: numericCursor(message.revision),
          outputSequence: numericCursor(message.output_sequence),
          segmentId: numericCursor(message.segment_id),
          text: partial,
          turnId: numericCursor(message.turn_id),
          turnSessionId: numericCursor(message.turn_session_id),
        };
        if (lastPartial === null || comparePartialCursor(candidate, lastPartial) >= 0) {
          lastPartial = candidate;
        } else {
          emitLog("stale partial transcript ignored", {
            sessionId,
            partialChars: partial.length,
            partialRevision: candidate.revision,
            partialSegmentId: candidate.segmentId,
            latestRevision: lastPartial.revision,
            latestSegmentId: lastPartial.segmentId,
          });
        }
      } else if (message.type === "turn.final") {
        finalAt = Date.now();
        // Empty/whitespace finals are not usable speech — keep null so session.done
        // can soft-return "" (same as no turn.final at all).
        const candidateText = standardParapperText(message);
        if (candidateText === null) {
          return;
        }
        const candidate: PartialTranscript = {
          revision: numericCursor(message.revision),
          outputSequence: numericCursor(message.output_sequence),
          segmentId: numericCursor(message.segment_id),
          text: candidateText,
          turnId: numericCursor(message.turn_id),
          turnSessionId: numericCursor(message.turn_session_id),
        };
        if (lastPartial === null || comparePartialCursor(candidate, lastPartial) >= 0) {
          finalTranscript = candidate;
        } else {
          emitLog("stale final transcript ignored", {
            sessionId,
            finalRevision: candidate.revision,
            latestRevision: lastPartial.revision,
          });
        }
      } else if (message.type === "session.done") {
        // A short window may have a usable interim result but no final because
        // stop raced the sidecar's finalization. Prefer that result over an
        // empty transcript; it is still normalized by the desktop pipeline.
        const latest = latestUsableTranscript();
        if (latest) {
          if (finalTranscript && latest === finalTranscript) {
            settle({ text: finalTranscript.text });
            return;
          }
          emitLog("session done using latest partial transcript (final missing)", {
            sessionId,
            pcmBytes: pcm.byteLength,
            framesSent,
            partialCount,
            partialChars: latest.text.length,
            partialRevision: latest.revision,
            partialSegmentId: latest.segmentId,
          });
          settle({ text: latest.text });
        } else {
          // No-speech / VAD-silent windows complete without a usable partial or
          // final. Return empty text so OpenAI-shaped clients soft-skip instead
          // of treating 422 as a hard audio processing failure.
          emitLog("session done without final transcript (soft empty)", {
            sessionId,
            pcmBytes: pcm.byteLength,
            framesSent,
            partialCount,
            lastPartialChars: 0,
          });
          settle({ text: "" });
        }
      }
    });
    socket.once("open", () => {
      if (finished) {
        return;
      }
      emitLog("session start", {
        sessionId,
        pcmBytes: pcm.byteLength,
        sampleRate: PARAPPER_SAMPLE_RATE,
      });
      try {
        socket.send(
          JSON.stringify({
            version: PARAPPER_PROTOCOL_VERSION,
            type: "session.start",
            session_id: sessionId,
            audio: {
              encoding: "pcm_s16le",
              sample_rate: PARAPPER_SAMPLE_RATE,
              channels: MONO_CHANNEL_COUNT,
            },
          }),
        );
      } catch (error) {
        settle({ error: sendFailure(error, "could not send session.start") });
      }
    });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
