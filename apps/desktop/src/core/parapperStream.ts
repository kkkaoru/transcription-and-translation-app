/**
 * Browser-side client for Parapper's native streaming recognition protocol.
 *
 * The desktop capture must keep one WebSocket session alive for the whole
 * microphone session.  Opening a new socket for every UI chunk resets
 * Parapper's VAD, Segment and Turn state and makes its interim/final contract
 * mostly ineffective.  This client deliberately contains only transport and
 * protocol ordering; text normalization remains a native Tauri concern.
 */

export const PARAPPER_STREAM_PROTOCOL_VERSION = 1;
export const PARAPPER_MAX_AUDIO_FRAME_BYTES = 3_200;
export const DEFAULT_PARAPPER_STREAM_TIMEOUT_MS = 8_000;
export const DEFAULT_PARAPPER_STREAM_URL = "ws://127.0.0.1:18082/ws/recognition";
export const PARAPPER_STREAM_SAMPLE_RATE = 16_000;
export const PARAPPER_STREAM_CHANNELS = 1;

export type ParapperTurnEventType = "turn.partial" | "turn.final";

export type ParapperTurnEvent = {
  type: ParapperTurnEventType;
  version: number;
  sessionId: string;
  turnSessionId: number;
  turnId: number;
  revision: number;
  outputSequence: number;
  segmentId: number;
  previousSegmentId: number | null;
  text: string;
  sourceText: string | null;
  azookeyInputText: string | null;
  sourceAsrModel: string;
  sourceLanguage: string;
  detectedLanguage: string | null;
  elapsedMs: number;
  audioDurationMs: number | null;
};

export type ParapperStreamEvent =
  | { type: "speech.started"; version: number; sessionId: string }
  | ParapperTurnEvent;

/**
 * Choose the surface text for a raw Parapper caption.
 *
 * The bundled sidecar defaults its streaming `text` field to Hiragana.
 * `source_text` retains the recognizer's surface output, while
 * `azookey_input_text` is the explicit phonetic input for the native
 * normalizer. A sidecar configured with the standard Surface format may omit
 * both optional fields, so raw captions use `text` as a compatibility fallback.
 */
export const selectParapperSurfaceText = (output: {
  text: string;
  sourceText?: string | null;
}): string => {
  const raw = output.sourceText?.trim() || output.text.trim();
  // Parapper continuing turns append `...`; never paint that on captions.
  return raw.replace(/(?:\.{3}|…|⋯)+$/u, "").trimEnd();
};

type ServerMessage = {
  type?: unknown;
  version?: unknown;
  session_id?: unknown;
  turn_session_id?: unknown;
  turn_id?: unknown;
  revision?: unknown;
  output_sequence?: unknown;
  segment_id?: unknown;
  previous_segment_id?: unknown;
  text?: unknown;
  source_text?: unknown;
  azookey_input_text?: unknown;
  source_asr_model?: unknown;
  source_language?: unknown;
  detected_language?: unknown;
  elapsed_ms?: unknown;
  audio_duration_ms?: unknown;
  code?: unknown;
  message?: unknown;
  fatal?: unknown;
};

type WebSocketLike = {
  readonly readyState: number;
  binaryType: string;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
};

type WebSocketConstructor = new (url: string) => WebSocketLike;

export type ParapperStreamOptions = {
  url: string;
  timeoutMs?: number;
  sessionId?: string;
  onEvent?: (event: ParapperStreamEvent) => void;
  /** Called once when an already-ready session loses its transport. */
  onError?: (error: Error) => void;
  /** Dependency injection keeps protocol tests independent of a browser DOM. */
  webSocketConstructor?: WebSocketConstructor;
};

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const DEFAULT_TIMEOUT = DEFAULT_PARAPPER_STREAM_TIMEOUT_MS;
const MIN_STREAM_TIMEOUT_MS = 500;
const DEFAULT_NUMERIC_FALLBACK = 0;
const UNKNOWN_PROTOCOL_VERSION = -1;
const PCM16_BYTES_PER_SAMPLE = 2;

const finiteNumber = (value: unknown, fallback = DEFAULT_NUMERIC_FALLBACK): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const optionalFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const createSessionId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // Restricted WebViews can expose crypto without allowing randomUUID.
    }
  }
  return `parapper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const streamError = (message: string, code?: string): Error => {
  const error = new Error(code ? `${code}: ${message}` : message);
  error.name = "ParapperStreamError";
  return error;
};

const parseMessage = (data: unknown): ServerMessage | null => {
  if (typeof data !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === "object" ? (parsed as ServerMessage) : null;
  } catch {
    return null;
  }
};

const toEvent = (message: ServerMessage, sessionId: string): ParapperStreamEvent | null => {
  if (message.type === "speech.started") {
    return { type: "speech.started", version: PARAPPER_STREAM_PROTOCOL_VERSION, sessionId };
  }
  if (message.type !== "turn.partial" && message.type !== "turn.final") {
    return null;
  }
  const text = nonEmptyString(message.text);
  if (text === null) {
    return null;
  }
  return {
    type: message.type,
    version: PARAPPER_STREAM_PROTOCOL_VERSION,
    sessionId,
    turnSessionId: finiteNumber(message.turn_session_id),
    turnId: finiteNumber(message.turn_id),
    revision: finiteNumber(message.revision),
    outputSequence: finiteNumber(message.output_sequence),
    segmentId: finiteNumber(message.segment_id),
    previousSegmentId: optionalFiniteNumber(message.previous_segment_id),
    text,
    sourceText: nonEmptyString(message.source_text),
    azookeyInputText: nonEmptyString(message.azookey_input_text),
    sourceAsrModel: nonEmptyString(message.source_asr_model) ?? "unknown",
    sourceLanguage: nonEmptyString(message.source_language) ?? "ja",
    detectedLanguage: nonEmptyString(message.detected_language),
    elapsedMs: finiteNumber(message.elapsed_ms),
    audioDurationMs: optionalFiniteNumber(message.audio_duration_ms),
  };
};

/**
 * One long-lived Parapper recognition session.
 *
 * `sendPcm16` is synchronous by design: a 16 kHz mono stream is only 32 KB/s,
 * so the browser WebSocket can send each small frame without an application
 * queue.  If the socket is not ready, throwing is preferable to silently
 * losing a VAD frame and corrupting the native turn state.
 */
export class ParapperRecognitionStream {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly sessionId: string;
  private readonly onEvent: (event: ParapperStreamEvent) => void;
  private readonly onError: (error: Error) => void;
  private readonly webSocketConstructor: WebSocketConstructor;
  private socket: WebSocketLike | null = null;
  private started = false;
  private startPromise: Promise<void> | null = null;
  /** Settles a startup that is still awaiting session.ready. */
  private failPendingStart: ((error: Error) => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  private settled = false;
  private activeErrorReported = false;

  public constructor(options: ParapperStreamOptions) {
    if (!options.url.trim()) {
      throw new Error("Parapper WebSocket URL is required");
    }
    this.url = options.url;
    this.timeoutMs = Math.max(MIN_STREAM_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_TIMEOUT);
    this.sessionId = options.sessionId?.trim() || createSessionId();
    this.onEvent = options.onEvent ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    const webSocketCtor =
      options.webSocketConstructor ??
      (typeof globalThis.WebSocket === "function"
        ? (globalThis.WebSocket as unknown as WebSocketConstructor)
        : null);
    if (!webSocketCtor) {
      throw new Error("WebSocket is unavailable in this runtime");
    }
    this.webSocketConstructor = webSocketCtor;
  }

  public get id(): string {
    return this.sessionId;
  }

  public start(): Promise<void> {
    if (this.settled) {
      return Promise.reject(
        streamError("Parapper recognition session has already ended", "settled"),
      );
    }
    if (this.started) {
      return this.startPromise ?? Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let resolved = false;
      const clearTimer = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const succeed = (): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        this.failPendingStart = null;
        clearTimer();
        this.started = true;
        resolve();
      };
      const fail = (error: Error): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        this.failPendingStart = null;
        clearTimer();
        this.closeSocket();
        reject(error);
      };
      this.failPendingStart = fail;
      let socket: WebSocketLike;
      try {
        socket = new this.webSocketConstructor(this.url);
      } catch (error) {
        fail(error instanceof Error ? error : streamError("could not open Parapper socket"));
        return;
      }
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        try {
          socket.send(
            JSON.stringify({
              version: PARAPPER_STREAM_PROTOCOL_VERSION,
              type: "session.start",
              session_id: this.sessionId,
              audio: {
                encoding: "pcm_s16le",
                sample_rate: PARAPPER_STREAM_SAMPLE_RATE,
                channels: PARAPPER_STREAM_CHANNELS,
              },
            }),
          );
        } catch (error) {
          fail(error instanceof Error ? error : streamError("could not send session.start"));
        }
      };
      socket.onmessage = (event) => {
        const message = parseMessage(event.data);
        if (
          !message ||
          finiteNumber(message.version, UNKNOWN_PROTOCOL_VERSION) !==
            PARAPPER_STREAM_PROTOCOL_VERSION
        ) {
          return;
        }
        if (message.type === "session.ready") {
          if (message.session_id === this.sessionId) {
            succeed();
          }
          return;
        }
        // Session-scoped protocol failures must not tear down a replacement
        // capture when a stale sidecar frame arrives after reconnect. Keep this
        // check ahead of error handling because errors do not flow through
        // `toEvent` and therefore would otherwise bypass the session fence.
        if (message.session_id !== this.sessionId) {
          return;
        }
        if (message.type === "error") {
          const code = nonEmptyString(message.code) ?? "parapper_protocol_error";
          const detail = nonEmptyString(message.message) ?? "Parapper rejected the session";
          const error = streamError(detail, code);
          if (resolved && this.started && !this.settled) {
            // The startup promise is already resolved, so `fail()` would be a
            // no-op here. Surface a protocol failure from an active session
            // through the same one-shot owner callback as transport errors.
            this.reportActiveError(error);
          } else {
            fail(error);
          }
          return;
        }
        const output = toEvent(message, this.sessionId);
        if (output) {
          try {
            this.onEvent(output);
          } catch {
            // UI callbacks must not break transport or strand the native session.
          }
        }
      };
      socket.onerror = () => {
        const error = streamError("Parapper WebSocket connection failed", "connection_failed");
        if (resolved && this.started && !this.settled) {
          this.reportActiveError(error);
        } else {
          fail(error);
        }
      };
      socket.onclose = (event) => {
        if (!resolved) {
          fail(
            streamError(
              event.reason || `Parapper socket closed (${event.code})`,
              "connection_closed",
            ),
          );
        } else if (this.started && !this.settled) {
          this.reportActiveError(
            streamError(
              event.reason || `Parapper socket closed (${event.code})`,
              "connection_closed",
            ),
          );
        }
      };
      timer = setTimeout(
        () => fail(streamError("Parapper did not send session.ready in time", "timeout")),
        this.timeoutMs,
      );
    });
    return this.startPromise;
  }

  public sendPcm16(frame: Uint8Array): void {
    if (frame.byteLength === 0) {
      return;
    }
    if (frame.byteLength % PCM16_BYTES_PER_SAMPLE !== 0) {
      throw new Error("Parapper PCM16 frame must contain an even number of bytes");
    }
    const socket = this.socket;
    if (!this.started || !socket || socket.readyState !== SOCKET_OPEN || this.settled) {
      throw new Error("Parapper recognition session is not ready");
    }
    for (let offset = 0; offset < frame.byteLength; offset += PARAPPER_MAX_AUDIO_FRAME_BYTES) {
      const end = Math.min(offset + PARAPPER_MAX_AUDIO_FRAME_BYTES, frame.byteLength);
      // Copy each slice so callers may immediately reuse their AudioWorklet buffer.
      socket.send(frame.slice(offset, end));
    }
  }

  public stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const socket = this.socket;
    if (!this.started) {
      // `stop()` is also used while start_capture is still awaiting
      // session.ready. Detaching the socket handlers alone used to leave that
      // start Promise pending until its timeout (or forever in fake hosts).
      this.settled = true;
      this.failPendingStart?.(
        streamError("Parapper recognition start was cancelled before session.ready", "cancelled"),
      );
      this.closeSocket();
      return Promise.resolve();
    }
    if (!socket || socket.readyState !== SOCKET_OPEN || this.settled || this.activeErrorReported) {
      this.settled = true;
      this.closeSocket();
      return Promise.resolve();
    }
    this.stopPromise = new Promise<void>((resolve, reject) => {
      // Mark the stream terminal before installing the stop handlers. This
      // prevents the original error/close handlers from reporting a second
      // active-session failure while the graceful stop is draining.
      this.settled = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = (error?: Error): void => {
        if (finished) {
          return;
        }
        finished = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        this.settled = true;
        this.closeSocket();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const previousMessage = socket.onmessage;
      socket.onmessage = (event) => {
        // Keep dispatching turn.partial/final through the normal handler, then
        // consume only the terminal session.done control frame here.
        const message = parseMessage(event.data);
        const isCurrentProtocolMessage =
          finiteNumber(message?.version, UNKNOWN_PROTOCOL_VERSION) ===
            PARAPPER_STREAM_PROTOCOL_VERSION && message?.session_id === this.sessionId;
        if (message?.type === "session.done" && isCurrentProtocolMessage) {
          finish();
          return;
        }
        if (message?.type === "error" && isCurrentProtocolMessage) {
          const code = nonEmptyString(message.code) ?? "parapper_protocol_error";
          const detail = nonEmptyString(message.message) ?? "Parapper rejected session.stop";
          finish(streamError(detail, code));
          return;
        }
        previousMessage?.(event);
      };
      const previousClose = socket.onclose;
      socket.onclose = (event) => {
        previousClose?.(event);
        if (!finished) {
          finish(
            streamError(
              event.reason || `Parapper socket closed before session.done (${event.code})`,
              "connection_closed",
            ),
          );
        }
      };
      try {
        socket.send(
          JSON.stringify({
            version: PARAPPER_STREAM_PROTOCOL_VERSION,
            type: "session.stop",
            session_id: this.sessionId,
          }),
        );
      } catch (error) {
        finish(error instanceof Error ? error : streamError("could not send session.stop"));
        return;
      }
      timer = setTimeout(
        () => finish(streamError("Parapper did not finish the session in time", "timeout")),
        this.timeoutMs,
      );
    });
    return this.stopPromise;
  }

  public cancel(): void {
    const socket = this.socket;
    if (!this.started) {
      // See stop(): cancel must resolve the pending startup first, before the
      // close detaches its event handlers.
      this.settled = true;
      this.failPendingStart?.(
        streamError("Parapper recognition start was cancelled before session.ready", "cancelled"),
      );
      this.closeSocket();
      return;
    }
    if (!socket || socket.readyState !== SOCKET_OPEN || this.settled) {
      this.closeSocket();
      return;
    }
    this.settled = true;
    try {
      socket.send(
        JSON.stringify({
          version: PARAPPER_STREAM_PROTOCOL_VERSION,
          type: "session.cancel",
          session_id: this.sessionId,
        }),
      );
    } catch {
      // The close below is still sufficient to cancel the native worker.
    }
    this.closeSocket();
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      if (socket.readyState === SOCKET_OPEN || socket.readyState === SOCKET_CONNECTING) {
        socket.close();
      }
    } catch {
      // Ignore close races during a failed startup.
    }
  }

  private reportActiveError(error: Error): void {
    if (this.activeErrorReported) {
      return;
    }
    this.activeErrorReported = true;
    try {
      this.onError(error);
    } catch {
      // An error observer must not interfere with socket cleanup.
    }
  }
}
