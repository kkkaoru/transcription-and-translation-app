/**
 * This file runs with bun.
 *
 * Explicit Workers AI Nova-3 ASR adapter. Post-processing matches Tauri after
 * Parapper: Japanese token-gap space stripping and the Vibrato reading gate.
 */
import { normalizeAsrSourceText, readingForAzookey } from "@caption-bridge/azookey-reading";
import {
  GatewayError,
  MAX_AUDIO_BYTES,
  pcm16FromWav,
  pcm16ToWav,
} from "@caption-bridge/inference-server-core";
import { segmentPcm16Utterances } from "./asr-vad.js";
import { byteLimitTransform, collectStream } from "./azookey.js";

const passthroughReading = (input: string): string => input;

/**
 * Same post-ASR text stage as Tauri after Parapper: strip Japanese token-gap
 * spaces, then apply the Vibrato reading gate. Without an IPADIC tokenizer
 * the gate is identity for kanji and passthrough for kana.
 */
export const postprocessWorkersAiAsrTranscript = (
  transcript: string,
): { text: string; reading: string } => {
  const text = normalizeAsrSourceText(transcript);
  return { text, reading: readingForAzookey(text, passthroughReading) };
};

/** Supported batch ASR models. Nova-3 stays on its lower-cost HTTP path. */
export const WORKERS_AI_ASR_MODEL = "@cf/deepgram/nova-3";
export const WORKERS_AI_ASR_WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
export type WorkersAiAsrModel = typeof WORKERS_AI_ASR_MODEL | typeof WORKERS_AI_ASR_WHISPER_MODEL;
export const WORKERS_AI_ASR_LANGUAGE = "ja";
export const WORKERS_AI_ASR_UNEXPECTED_SCRIPT_FALLBACK = "nova-3-unexpected-language-script";
const JAPANESE_LANGUAGE = /^ja(?:-|$)/iu;
const UNICODE_LETTER = /\p{Letter}/u;
const JAPANESE_COMPATIBLE_LETTER =
  /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]$/u;
/** Browser Silero has already produced one complete utterance. */
export const WORKERS_AI_ASR_CLIENT_SEGMENTATION = "client-silero-v1" as const;

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

interface WorkersAiAsrAudioInput {
  body: ReadableStream<Uint8Array>;
  contentType: "audio/wav";
}

interface WorkersAiAsrInput {
  audio: WorkersAiAsrAudioInput;
  language?: string;
  task?: "transcribe";
  vad_filter?: boolean;
  beam_size?: number;
}

export type WorkersAiAsrRun = (
  model: WorkersAiAsrModel,
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

export interface WorkersAiAsrModelFallback {
  requestedModel: WorkersAiAsrModel;
  model: WorkersAiAsrModel;
  reason: typeof WORKERS_AI_ASR_UNEXPECTED_SCRIPT_FALLBACK;
}

export interface WorkersAiAsrTranscribeOptions {
  presegmented?: boolean;
  language?: string;
  autoDetectLanguage?: boolean;
  model?: WorkersAiAsrModel;
  onModelFallback?: (fallback: WorkersAiAsrModelFallback) => void;
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

/** Detect a provider result that cannot be Japanese despite an explicit ja hint. */
export const hasUnexpectedJapaneseTranscriptScript = (transcript: string): boolean =>
  [...transcript].some(
    (character) => UNICODE_LETTER.test(character) && !JAPANESE_COMPATIBLE_LETTER.test(character),
  );

const transcriptFromResult = (value: unknown, model: WorkersAiAsrModel): string => {
  if (!isRecord(value)) {
    throw malformedResponse();
  }
  if (model === WORKERS_AI_ASR_WHISPER_MODEL) {
    if (typeof value["text"] !== "string") {
      throw malformedResponse();
    }
    return value["text"];
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

interface UtteranceTranscript {
  text: string;
  model: WorkersAiAsrModel;
  fallback?: WorkersAiAsrModelFallback;
}

interface RunTranscriptionOptions {
  runner: WorkersAiAsrRun;
  pcm: Uint8Array;
  timeoutMs: number;
  model: WorkersAiAsrModel;
  language?: string;
}

const runTranscriptionModel = async (options: RunTranscriptionOptions): Promise<string> => {
  const result = await withTimeout(
    (signal) =>
      options.runner(
        options.model,
        {
          audio: {
            body: wavBodyStream(pcm16ToWav(options.pcm)),
            contentType: "audio/wav",
          },
          ...(options.language ? { language: options.language } : {}),
          ...(options.model === WORKERS_AI_ASR_WHISPER_MODEL
            ? { task: "transcribe", vad_filter: false, beam_size: 1 }
            : {}),
        },
        { signal },
      ),
    options.timeoutMs,
  );
  return transcriptFromResult(
    result instanceof Response ? await resultFromRawResponse(result) : result,
    options.model,
  );
};

const transcribeUtterance = async (
  options: RunTranscriptionOptions,
): Promise<UtteranceTranscript> => {
  try {
    const text = await runTranscriptionModel(options);
    if (
      options.model === WORKERS_AI_ASR_MODEL &&
      options.language !== undefined &&
      JAPANESE_LANGUAGE.test(options.language) &&
      hasUnexpectedJapaneseTranscriptScript(text)
    ) {
      const fallback: WorkersAiAsrModelFallback = {
        requestedModel: options.model,
        model: WORKERS_AI_ASR_WHISPER_MODEL,
        reason: WORKERS_AI_ASR_UNEXPECTED_SCRIPT_FALLBACK,
      };
      return {
        text: await runTranscriptionModel({ ...options, model: fallback.model }),
        model: fallback.model,
        fallback,
      };
    }
    return { text, model: options.model };
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
): ((
  pcm: Uint8Array,
  signal?: AbortSignal,
  request?: Request,
  options?: WorkersAiAsrTranscribeOptions,
) => Promise<string>) => {
  const runner = run ?? env.AI?.run.bind(env.AI);
  const timeoutMs = workersAiAsrTimeoutMs(env);
  return async (
    pcm: Uint8Array,
    _signal?: AbortSignal,
    _request?: Request,
    options: WorkersAiAsrTranscribeOptions = {},
  ): Promise<string> => {
    validatePcm(pcm);
    if (!runner) {
      throw new GatewayError(
        HTTP_SERVICE_UNAVAILABLE,
        "asr_workers_ai_unavailable",
        "Workers AI ASR binding is not configured",
      );
    }
    const model = options.model ?? WORKERS_AI_ASR_MODEL;
    const language = options.autoDetectLanguage
      ? undefined
      : options.language?.trim() || WORKERS_AI_ASR_LANGUAGE;
    const utterances = options.presegmented
      ? [{ pcm, reason: "flush" as const }]
      : segmentPcm16Utterances(pcm);
    if (utterances.length === 0) {
      return postprocessWorkersAiAsrTranscript("").text;
    }
    const transcripts = await utterances.reduce<Promise<UtteranceTranscript[]>>(
      async (previous, utterance) => {
        const collected = await previous;
        const transcript = await transcribeUtterance({
          runner,
          pcm: utterance.pcm,
          timeoutMs,
          model,
          ...(language ? { language } : {}),
        });
        if (transcript.fallback) {
          options.onModelFallback?.(transcript.fallback);
        }
        return [...collected, transcript];
      },
      Promise.resolve([]),
    );
    return postprocessWorkersAiAsrTranscript(
      transcripts.map((transcript) => transcript.text).join(""),
    ).text;
  };
};

/** Dedicated inference route; compare proxies here to opt into Nova-3 explicitly. */
export const WORKERS_AI_ASR_HTTP_PATH = "/v1/asr/workers-ai/transcriptions" as const;

const jsonResponse = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export interface WorkersAiAsrRequestOptions {
  run?: WorkersAiAsrRun;
  preparedForm?: FormData;
}

export type WorkersAiAsrRequestArgument = WorkersAiAsrRun | WorkersAiAsrRequestOptions;

interface WorkersAiAsrMultipart {
  wav: Uint8Array;
  language?: string;
  model: WorkersAiAsrModel;
  presegmented: boolean;
}

const readMultipartForm = async (request: Request): Promise<FormData> => {
  try {
    return await request.formData();
  } catch {
    throw new GatewayError(HTTP_BAD_REQUEST, "invalid_multipart", "Expected multipart form data");
  }
};

const requestRun = (options?: WorkersAiAsrRequestArgument): WorkersAiAsrRun | undefined =>
  typeof options === "function" ? options : options?.run;

const requestPreparedForm = (options?: WorkersAiAsrRequestArgument): FormData | undefined =>
  typeof options === "function" ? undefined : options?.preparedForm;

const readWavFromMultipart = async (
  request: Request,
  preparedForm?: FormData,
): Promise<WorkersAiAsrMultipart> => {
  const form = preparedForm ?? (await readMultipartForm(request));
  const fileValue = form.get("file");
  if (!(fileValue instanceof File)) {
    throw new GatewayError(HTTP_BAD_REQUEST, "invalid_audio", "file field is required");
  }
  const languageValue = form.get("language");
  const language =
    typeof languageValue === "string" && languageValue.trim() ? languageValue.trim() : undefined;
  const modelValue = form.get("model");
  const model =
    modelValue === null || modelValue === WORKERS_AI_ASR_MODEL
      ? WORKERS_AI_ASR_MODEL
      : modelValue === WORKERS_AI_ASR_WHISPER_MODEL
        ? WORKERS_AI_ASR_WHISPER_MODEL
        : undefined;
  if (!model) {
    throw new GatewayError(
      HTTP_BAD_REQUEST,
      "invalid_asr_model",
      "model must be @cf/deepgram/nova-3 or @cf/openai/whisper-large-v3-turbo",
    );
  }
  const segmentationValue = form.get("segmentation");
  if (segmentationValue !== null && segmentationValue !== WORKERS_AI_ASR_CLIENT_SEGMENTATION) {
    throw new GatewayError(
      HTTP_BAD_REQUEST,
      "invalid_segmentation",
      "segmentation must be client-silero-v1 when provided",
    );
  }
  return {
    wav: new Uint8Array(await fileValue.arrayBuffer()),
    ...(language ? { language } : {}),
    model,
    presegmented: segmentationValue === WORKERS_AI_ASR_CLIENT_SEGMENTATION,
  };
};

/**
 * Handle the explicit Workers AI ASR route. This path always uses Nova-3 and
 * does not depend on the global `ASR_PROVIDER` flag used by `/v1/audio/transcriptions`.
 */
export const handleWorkersAiAsrTranscription = async (
  request: Request,
  env: WorkersAiAsrEnvironment & { AI?: WorkersAiAsrBinding },
  options?: WorkersAiAsrRequestArgument,
): Promise<Response> => {
  if (request.method !== "POST") {
    return jsonResponse(405, {
      error: { code: "method_not_allowed", message: "POST is required" },
    });
  }
  let wav: Uint8Array;
  let language: string | undefined;
  let model: WorkersAiAsrModel = WORKERS_AI_ASR_MODEL;
  let presegmented = false;
  try {
    ({ wav, language, model, presegmented } = await readWavFromMultipart(
      request,
      requestPreparedForm(options),
    ));
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
  const transcribe = createWorkersAiAsrTranscriber(env, requestRun(options));
  const modelFallbacks: WorkersAiAsrModelFallback[] = [];
  try {
    const processed = postprocessWorkersAiAsrTranscript(
      await transcribe(pcm, undefined, undefined, {
        presegmented,
        autoDetectLanguage: !language,
        ...(language ? { language } : {}),
        model,
        onModelFallback: (fallback) => modelFallbacks.push(fallback),
      }),
    );
    const fallback = modelFallbacks.at(-1);
    return jsonResponse(200, {
      text: processed.text,
      reading: processed.reading,
      language: language ?? "und",
      model: fallback?.model ?? model,
      ...(fallback
        ? { requestedModel: fallback.requestedModel, asrModelFallback: fallback.reason }
        : {}),
      transport: "http",
      segmentation: presegmented ? WORKERS_AI_ASR_CLIENT_SEGMENTATION : "worker-energy-v1",
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
