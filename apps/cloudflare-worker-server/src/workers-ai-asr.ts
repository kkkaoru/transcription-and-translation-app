import {
  GatewayError,
  MAX_AUDIO_BYTES,
  pcm16FromWav,
  pcm16ToWav,
} from "@caption-bridge/inference-server-core";
import { byteLimitTransform, collectStream } from "./azookey.js";

/** The Workers AI partner model used only by the explicit `workers-ai` route. */
export const WORKERS_AI_ASR_MODEL = "@cf/deepgram/nova-3" as const;
export const WORKERS_AI_ASR_LANGUAGE = "ja" as const;

/**
 * The gateway limits uploaded WAV files to MAX_AUDIO_BYTES.  The ASR adapter
 * receives the WAV's PCM payload, so leave room for the 44-byte WAV header it
 * adds before invoking Nova-3.
 */
export const WORKERS_AI_ASR_WAV_HEADER_BYTES = 44;
export const WORKERS_AI_ASR_MAX_AUDIO_BYTES = MAX_AUDIO_BYTES;
export const WORKERS_AI_ASR_MAX_PCM_BYTES = MAX_AUDIO_BYTES - WORKERS_AI_ASR_WAV_HEADER_BYTES;
export const WORKERS_AI_ASR_DEFAULT_TIMEOUT_MS = 15_000;
export const WORKERS_AI_ASR_MIN_TIMEOUT_MS = 100;
export const WORKERS_AI_ASR_MAX_TIMEOUT_MS = 30_000;
/** Upper bound for the Workers AI raw Response body before it is parsed. */
export const WORKERS_AI_ASR_MAX_RESPONSE_BYTES = 65_536;

type WorkersAiAsrInput = {
  audio: {
    /** Nova-3 binding expects a readable stream of audio bytes (see Cloudflare docs). */
    body: ReadableStream<Uint8Array>;
    contentType: "audio/wav";
  };
  language: typeof WORKERS_AI_ASR_LANGUAGE;
};

export type WorkersAiAsrRun = (
  model: typeof WORKERS_AI_ASR_MODEL,
  input: WorkersAiAsrInput,
  options: { signal: AbortSignal },
) => Promise<unknown>;

/** Narrow seam used by tests; the production binding is adapted at the index boundary. */
export interface WorkersAiAsrBinding {
  run: WorkersAiAsrRun;
}

export interface WorkersAiAsrEnvironment {
  AI?: WorkersAiAsrBinding;
  WORKERS_AI_ASR_TIMEOUT_MS?: string;
}

export interface WorkersAiAsrResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: unknown;
      }>;
    }>;
  };
}

const HTTP_BAD_REQUEST = 400;
const HTTP_BAD_GATEWAY = 502;
const HTTP_GATEWAY_TIMEOUT = 504;
const HTTP_SERVICE_UNAVAILABLE = 503;
const finiteInteger = (value: number): number | undefined =>
  Number.isFinite(value) && Number.isInteger(value) ? value : undefined;

/** Parse and clamp the optional timeout without allowing an unbounded AI call. */
export const workersAiAsrTimeoutMs = (env: WorkersAiAsrEnvironment): number => {
  const raw = env.WORKERS_AI_ASR_TIMEOUT_MS?.trim();
  if (!raw) {
    return WORKERS_AI_ASR_DEFAULT_TIMEOUT_MS;
  }
  const parsed = finiteInteger(Number(raw));
  if (parsed === undefined) {
    return WORKERS_AI_ASR_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(parsed, WORKERS_AI_ASR_MIN_TIMEOUT_MS), WORKERS_AI_ASR_MAX_TIMEOUT_MS);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const errorDetail = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;

/** Wrap encoded WAV bytes in the stream shape Nova-3's binding validates. */
const wavBodyStream = (wav: Uint8Array): ReadableStream<Uint8Array> => {
  const body = new Response(wav).body;
  if (!body) {
    throw new GatewayError(
      HTTP_BAD_GATEWAY,
      "asr_workers_ai_failed",
      "Workers AI ASR could not build the audio stream",
    );
  }
  return body;
};

const malformedResponse = (): GatewayError =>
  new GatewayError(
    HTTP_BAD_GATEWAY,
    "asr_workers_ai_invalid_response",
    "Workers AI ASR response has no transcript field",
  );

const transcriptFromResult = (value: unknown): string => {
  if (!isRecord(value)) {
    throw malformedResponse();
  }
  const results = value["results"];
  if (!isRecord(results) || !Array.isArray(results["channels"])) {
    throw malformedResponse();
  }
  const channels = results["channels"];
  const channel = channels[0];
  if (!isRecord(channel) || !Array.isArray(channel["alternatives"])) {
    throw malformedResponse();
  }
  const alternatives = channel["alternatives"];
  const alternative = alternatives[0];
  if (!isRecord(alternative) || typeof alternative["transcript"] !== "string") {
    throw malformedResponse();
  }
  return alternative["transcript"];
};

const resultFromRawResponse = async (response: Response): Promise<unknown> => {
  if (!response.ok) {
    throw new GatewayError(
      HTTP_BAD_GATEWAY,
      "asr_workers_ai_failed",
      `Workers AI returned ${response.status}`,
    );
  }
  if (!response.body) {
    throw new GatewayError(
      HTTP_BAD_GATEWAY,
      "asr_workers_ai_invalid_response",
      "Workers AI ASR response has no body",
    );
  }
  try {
    const bounded = response.body.pipeThrough(
      byteLimitTransform(
        WORKERS_AI_ASR_MAX_RESPONSE_BYTES,
        "Workers AI ASR response exceeds the byte limit",
      ),
    );
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await collectStream(bounded)),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Workers AI ASR response exceeds the byte limit"
    ) {
      throw new GatewayError(HTTP_BAD_GATEWAY, "asr_workers_ai_invalid_response", error.message);
    }
    throw new GatewayError(
      HTTP_BAD_GATEWAY,
      "asr_workers_ai_invalid_response",
      "Workers AI ASR response was not valid JSON",
    );
  }
};

const withTimeout = async <T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Settle the timeout branch before aborting the provider promise so a
        // provider that rejects synchronously from the abort signal cannot
        // turn a timeout into a generic upstream failure.
        reject(
          new GatewayError(
            HTTP_GATEWAY_TIMEOUT,
            "asr_workers_ai_timeout",
            `Workers AI ASR exceeded the ${timeoutMs} ms timeout`,
          ),
        );
        controller.abort("Workers AI ASR timed out");
      }, timeoutMs);
    });
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const validatePcm = (pcm: Uint8Array): void => {
  if (pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new GatewayError(
      HTTP_BAD_REQUEST,
      "asr_workers_ai_invalid_audio",
      "PCM must be non-empty signed 16-bit samples",
    );
  }
  if (pcm.length > WORKERS_AI_ASR_MAX_PCM_BYTES) {
    throw new GatewayError(
      HTTP_BAD_REQUEST,
      "asr_workers_ai_audio_too_large",
      "Audio request exceeds the Workers AI ASR size limit",
    );
  }
};

/**
 * Build an ASR transcriber for the Workers AI binding.  Calling this factory
 * does not invoke AI; the binding is used only when the caller explicitly
 * selects `ASR_PROVIDER=workers-ai`.
 */
export const createWorkersAiAsrTranscriber = (
  env: WorkersAiAsrEnvironment,
  run?: WorkersAiAsrRun,
): ((pcm: Uint8Array) => Promise<string>) => {
  const runner = run ?? env.AI?.run.bind(env.AI);
  const timeoutMs = workersAiAsrTimeoutMs(env);
  return async (pcm: Uint8Array): Promise<string> => {
    validatePcm(pcm);
    if (!runner) {
      throw new GatewayError(
        HTTP_SERVICE_UNAVAILABLE,
        "asr_workers_ai_unavailable",
        "Workers AI ASR binding is not configured",
      );
    }
    let result: unknown;
    try {
      result = await withTimeout(
        (signal) =>
          runner(
            WORKERS_AI_ASR_MODEL,
            {
              audio: {
                body: wavBodyStream(pcm16ToWav(pcm)),
                contentType: "audio/wav",
              },
              language: WORKERS_AI_ASR_LANGUAGE,
            },
            { signal },
          ),
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error;
      }
      throw new GatewayError(
        HTTP_BAD_GATEWAY,
        "asr_workers_ai_failed",
        errorDetail(error, "Workers AI ASR failed"),
      );
    }
    if (result instanceof Response) {
      result = await resultFromRawResponse(result);
    }
    return transcriptFromResult(result);
  };
};

/** Dedicated inference route; compare proxies here to opt into Nova-3 explicitly. */
export const WORKERS_AI_ASR_HTTP_PATH = "/v1/asr/workers-ai/transcriptions" as const;

const jsonResponse = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const readWavFromMultipart = async (
  request: Request,
): Promise<{ wav: Uint8Array; language?: string }> => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new GatewayError(HTTP_BAD_REQUEST, "invalid_multipart", "Expected multipart form data");
  }
  const fileValue = form.get("file");
  if (!(fileValue instanceof File)) {
    throw new GatewayError(HTTP_BAD_REQUEST, "invalid_audio", "file field is required");
  }
  const languageValue = form.get("language");
  const language =
    typeof languageValue === "string" && languageValue.trim() ? languageValue.trim() : undefined;
  return { wav: new Uint8Array(await fileValue.arrayBuffer()), language };
};

/**
 * Handle the explicit Workers AI ASR route. This path always uses Nova-3 and
 * does not depend on the global `ASR_PROVIDER` flag used by `/v1/audio/transcriptions`.
 */
export const handleWorkersAiAsrTranscription = async (
  request: Request,
  env: WorkersAiAsrEnvironment & { AI?: WorkersAiAsrBinding },
  run?: WorkersAiAsrRun,
): Promise<Response> => {
  if (request.method !== "POST") {
    return jsonResponse(405, {
      error: { code: "method_not_allowed", message: "POST is required" },
    });
  }
  let wav: Uint8Array;
  let language: string | undefined;
  try {
    ({ wav, language } = await readWavFromMultipart(request));
  } catch (error) {
    if (error instanceof GatewayError) {
      return jsonResponse(error.status, { error: { code: error.code, message: error.message } });
    }
    throw error;
  }
  let pcm: Uint8Array;
  try {
    pcm = pcm16FromWav(wav);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "WAV validation failed";
    return jsonResponse(HTTP_BAD_REQUEST, { error: { code: "invalid_audio", message: detail } });
  }
  const transcribe = createWorkersAiAsrTranscriber(env, run);
  try {
    const text = await transcribe(pcm);
    return jsonResponse(200, {
      text,
      language: language ?? WORKERS_AI_ASR_LANGUAGE,
      model: WORKERS_AI_ASR_MODEL,
      transport: "http",
    });
  } catch (error) {
    if (error instanceof GatewayError) {
      return jsonResponse(error.status, { error: { code: error.code, message: error.message } });
    }
    return jsonResponse(HTTP_BAD_GATEWAY, {
      error: {
        code: "asr_workers_ai_failed",
        message: errorDetail(error, "Workers AI ASR failed"),
      },
    });
  }
};
