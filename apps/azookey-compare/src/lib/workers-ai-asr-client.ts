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
  form.set("file", wavFile instanceof File ? wavFile : new File([wavFile], "utterance.wav", { type: "audio/wav" }));
  if (options.language?.trim()) {
    form.set("language", options.language.trim());
  }
  const response = await fetchImpl(endpoint, {
    method: "POST",
    body: form,
    headers: authHeaders(options.auth),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Workers AI ASR returned non-JSON (${response.status})`);
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
        : `Workers AI ASR failed (${response.status})`;
    throw new Error(message);
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { text?: unknown }).text !== "string"
  ) {
    throw new Error("Workers AI ASR response has no text field");
  }
  const body = payload as WorkersAiAsrTranscriptionResult;
  return {
    text: body.text,
    ...(body.language ? { language: body.language } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.transport ? { transport: body.transport } : {}),
  };
};
