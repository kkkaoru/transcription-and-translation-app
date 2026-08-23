// This file runs with bun.

export const COMPARE_WORKERS_AI_ASR_PATH = "/v1/speech/workers-ai/azookey";
export const COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH = COMPARE_WORKERS_AI_ASR_PATH;
export const COMPARE_WORKER_ORIGIN = "https://azookey-compare.kaoru.workers.dev";

export interface InferenceProxyEnv {
  AZOOKEY_API_TOKEN?: string;
}

export const shouldProxyToInference = (pathname: string): boolean =>
  pathname === COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH;

export const inferenceProxyRequest = (request: Request, env: InferenceProxyEnv = {}): Request => {
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  const token = env.AZOOKEY_API_TOKEN?.trim();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new Request(request, { headers });
};
