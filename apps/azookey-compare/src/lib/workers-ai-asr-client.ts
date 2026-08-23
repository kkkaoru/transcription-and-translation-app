import { COMPARE_WORKERS_AI_ASR_PATH } from "./inference-proxy";

export interface ComparisonAuth {
  scheme: "none" | "bearer";
  token?: string;
}

export const WORKERS_AI_ASR_CLIENT_SEGMENTATION = "client-silero-v1";
export type BrowserAsrModel = "@cf/deepgram/nova-3" | "@cf/openai/whisper-large-v3-turbo";
export type BrowserConversionModel = "zenz-v3.2-xsmall-gguf" | "zenz-v3.2-small-gguf";

export interface WorkersAiPipelineLog {
  stage: "asr" | "vibrato" | "azookey";
  engine: string;
  input: string;
  output: string;
  elapsedMs: number;
}

export interface WorkersAiAsrTranscriptionResult {
  text: string;
  reading?: string;
  language?: string;
  model?: string;
  transport?: string;
  segmentation?: string;
  convertedText?: string;
  pipeline?: string;
  vibratoText?: string;
  logs?: WorkersAiPipelineLog[];
  conversionModel?: BrowserConversionModel;
  usedCompletion?: boolean;
  modelFallback?: string;
}

export interface WorkersAiAsrClientOptions {
  endpointUrl?: string;
  language?: string;
  model?: BrowserAsrModel;
  conversionModel?: BrowserConversionModel;
  leftContext?: string;
  auth?: ComparisonAuth;
  fetchImpl?: typeof fetch;
}

export const WORKERS_AI_ASR_ROUTE_MISSING_JA =
  "Cloudflare Workers AI ASR の経路が見つかりません（404）。ローカルなら bun run worker:dev を起動し、Next.js が inference（既定 http://127.0.0.1:8787）へ proxy しているか確認してください";

export const WORKERS_AI_ASR_UNREACHABLE_JA =
  "Cloudflare Workers AI ASR に接続できません。ローカルなら bun run azookey-compare:dev と bun run worker:dev を起動してください";

export const WORKERS_AI_ASR_LOCAL_UNAVAILABLE_JA =
  "ローカルの Cloudflare Workers AI ASR には .env の Access サービス トークンか、bun run worker:dev の AI binding が必要です";

const defaultEndpoint = (): string => {
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}${COMPARE_WORKERS_AI_ASR_PATH}`;
  }
  return COMPARE_WORKERS_AI_ASR_PATH;
};

export const isLoopbackWorkersAiAsrEndpoint = (endpointUrl?: string): boolean => {
  if (!endpointUrl?.trim()) {
    return false;
  }
  try {
    const hostname = new URL(endpointUrl, "http://127.0.0.1").hostname;
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
};

const readAsrErrorMessage = (payload: unknown, status: number): string => {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  if (status === 503) {
    return WORKERS_AI_ASR_LOCAL_UNAVAILABLE_JA;
  }
  return `Cloudflare Workers AI ASR に失敗しました（${status}）`;
};

export const warmWorkersAiConversion = async (
  options: WorkersAiAsrClientOptions = {},
): Promise<void> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpointUrl?.trim() || defaultEndpoint();
  const url = new URL(
    endpoint,
    typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin,
  );
  url.searchParams.set("conversionModel", options.conversionModel ?? "zenz-v3.2-xsmall-gguf");
  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: authHeaders(options.auth),
  });
  if (!response.ok) {
    throw new Error(`Zenz Container warm-up failed (${String(response.status)})`);
  }
};

export const probeWorkersAiAsrRoute = async (
  endpointUrl: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<void> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpointUrl, { method: "GET" });
  } catch {
    throw new Error(WORKERS_AI_ASR_UNREACHABLE_JA);
  }
  if (response.ok) {
    return;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (response.status === 404) {
      throw new Error(WORKERS_AI_ASR_ROUTE_MISSING_JA);
    }
    throw new Error(WORKERS_AI_ASR_UNREACHABLE_JA);
  }
  throw new Error(readAsrErrorMessage(payload, response.status));
};

const authHeaders = (auth: ComparisonAuth | undefined): HeadersInit => {
  if (auth?.scheme === "bearer" && auth.token?.trim()) {
    return { authorization: `Bearer ${auth.token.trim()}` };
  }
  return {};
};

export const transcribeWorkersAiAsr = async (
  wavFile: File | Blob,
  options: WorkersAiAsrClientOptions = {},
): Promise<WorkersAiAsrTranscriptionResult> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpointUrl?.trim() || defaultEndpoint();
  const form = new FormData();
  form.set(
    "file",
    wavFile instanceof File ? wavFile : new File([wavFile], "utterance.wav", { type: "audio/wav" }),
  );
  if (options.language?.trim()) {
    form.set("language", options.language.trim());
  }
  form.set("model", options.model ?? "@cf/deepgram/nova-3");
  form.set("conversionModel", options.conversionModel ?? "zenz-v3.2-xsmall-gguf");
  if (options.leftContext?.trim()) {
    form.set("leftContext", options.leftContext.trim());
  }
  // The controller sends one complete utterance already cut by browser Silero.
  // Tell the Worker not to run its lower-fidelity RMS fallback over it again.
  form.set("segmentation", WORKERS_AI_ASR_CLIENT_SEGMENTATION);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      body: form,
      headers: authHeaders(options.auth),
    });
  } catch {
    throw new Error(WORKERS_AI_ASR_UNREACHABLE_JA);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (response.status === 404) {
      throw new Error(WORKERS_AI_ASR_ROUTE_MISSING_JA);
    }
    if (response.status === 500) {
      throw new Error(WORKERS_AI_ASR_UNREACHABLE_JA);
    }
    throw new Error(`Cloudflare Workers AI ASR が JSON 以外を返しました（${response.status}）`);
  }
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : `Cloudflare Workers AI ASR に失敗しました（${response.status}）`;
    throw new Error(message);
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { text?: unknown }).text !== "string"
  ) {
    throw new Error("Cloudflare Workers AI ASR の応答に text がありません");
  }
  const body = payload as WorkersAiAsrTranscriptionResult;
  return {
    text: body.text,
    ...(body.reading ? { reading: body.reading } : {}),
    ...(body.language ? { language: body.language } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.transport ? { transport: body.transport } : {}),
    ...(body.segmentation ? { segmentation: body.segmentation } : {}),
    ...(body.convertedText ? { convertedText: body.convertedText } : {}),
    ...(body.pipeline ? { pipeline: body.pipeline } : {}),
    ...(body.vibratoText ? { vibratoText: body.vibratoText } : {}),
    ...(Array.isArray(body.logs) ? { logs: body.logs } : {}),
    ...(body.conversionModel ? { conversionModel: body.conversionModel } : {}),
    ...(typeof body.usedCompletion === "boolean" ? { usedCompletion: body.usedCompletion } : {}),
    ...(body.modelFallback ? { modelFallback: body.modelFallback } : {}),
  };
};
