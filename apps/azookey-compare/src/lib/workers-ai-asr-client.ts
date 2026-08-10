import type { ComparisonAuth } from "./contract";
import { COMPARE_WORKERS_AI_ASR_PATH } from "./inference-proxy";

export interface WorkersAiAsrTranscriptionResult {
  text: string;
  language?: string;
  model?: string;
  transport?: string;
}

export interface WorkersAiAsrClientOptions {
  endpointUrl?: string;
  language?: string;
  auth?: ComparisonAuth;
  fetchImpl?: typeof fetch;
}

export const WORKERS_AI_ASR_ROUTE_MISSING_JA =
  "Cloudflare Workers AI ASR の経路が見つかりません（404）。ローカルなら bun run worker:dev を起動し、Next.js が inference（既定 http://127.0.0.1:8787）へ proxy しているか確認してください";

export const WORKERS_AI_ASR_UNREACHABLE_JA =
  "Cloudflare Workers AI ASR に接続できません。ローカルなら bun run worker:dev が 8787 で起動しているか確認してください";

const defaultEndpoint = (): string => {
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}${COMPARE_WORKERS_AI_ASR_PATH}`;
  }
  return COMPARE_WORKERS_AI_ASR_PATH;
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
    ...(body.language ? { language: body.language } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.transport ? { transport: body.transport } : {}),
  };
};
