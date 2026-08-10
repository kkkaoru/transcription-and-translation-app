export const COMPARE_INFERENCE_WEBSOCKET_PATH = "/ws/azookey";
export const COMPARE_INFERENCE_HEALTH_PATH = "/v1/azookey";
/** Explicit compare → inference Workers AI ASR route (Nova-3 via env.AI.run). */
export const COMPARE_WORKERS_AI_ASR_PATH = "/v1/asr/workers-ai/transcriptions";

export const COMPARE_INFERENCE_PROXY_PATHS = [
  COMPARE_INFERENCE_WEBSOCKET_PATH,
  COMPARE_INFERENCE_HEALTH_PATH,
  COMPARE_WORKERS_AI_ASR_PATH,
] as const;

export const COMPARE_WORKER_ORIGIN = "https://azookey-compare.kaoru.workers.dev";
export const COMPARE_WORKER_WEBSOCKET_URL = `wss://azookey-compare.kaoru.workers.dev${COMPARE_INFERENCE_WEBSOCKET_PATH}`;
export const COMPARE_WORKER_ASR_URL = `${COMPARE_WORKER_ORIGIN}${COMPARE_WORKERS_AI_ASR_PATH}`;

/** Local `next dev` rewrite target. Production compare Worker uses the INFERENCE binding instead. */
export const COMPARE_INFERENCE_DEV_ORIGIN_DEFAULT = "http://127.0.0.1:8787";
/** Local ASR Access proxy started by `azookey-compare:dev`. */
export const COMPARE_ASR_DEV_PROXY_ORIGIN_DEFAULT = "http://127.0.0.1:8790";

export type InferenceDevOriginEnv = {
  COMPARE_INFERENCE_ORIGIN?: string;
  COMPARE_ASR_ORIGIN?: string;
};

export const compareInferenceDevOrigin = (env: InferenceDevOriginEnv = process.env): string =>
  (env.COMPARE_INFERENCE_ORIGIN?.trim() || COMPARE_INFERENCE_DEV_ORIGIN_DEFAULT).replace(
    /\/+$/,
    "",
  );

export const compareAsrDevOrigin = (env: InferenceDevOriginEnv = process.env): string =>
  (env.COMPARE_ASR_ORIGIN?.trim() || COMPARE_ASR_DEV_PROXY_ORIGIN_DEFAULT).replace(/\/+$/, "");

export type InferenceDevRewrite = {
  source: string;
  destination: string;
};

export const compareInferenceDevRewrites = (
  inferenceOrigin = compareInferenceDevOrigin(),
  asrOrigin = compareAsrDevOrigin(),
): readonly InferenceDevRewrite[] => [
  {
    source: COMPARE_INFERENCE_WEBSOCKET_PATH,
    destination: `${inferenceOrigin}${COMPARE_INFERENCE_WEBSOCKET_PATH}`,
  },
  {
    source: COMPARE_INFERENCE_HEALTH_PATH,
    destination: `${inferenceOrigin}${COMPARE_INFERENCE_HEALTH_PATH}`,
  },
  {
    source: COMPARE_WORKERS_AI_ASR_PATH,
    destination: `${asrOrigin}${COMPARE_WORKERS_AI_ASR_PATH}`,
  },
];

export const buildWorkersAiAsrUrl = (origin: string): string =>
  `${origin.replace(/\/+$/, "")}${COMPARE_WORKERS_AI_ASR_PATH}`;

export type InferenceProxyEnv = {
  AZOOKEY_API_TOKEN?: string;
};

export const shouldProxyToInference = (pathname: string): boolean =>
  (COMPARE_INFERENCE_PROXY_PATHS as readonly string[]).includes(pathname);

/**
 * Forward to the inference Worker without trusting the browser Authorization.
 * WebSocket upgrade headers stay on the cloned Request so service-binding
 * upgrades keep working. `AZOOKEY_API_TOKEN` is injected only when configured.
 */
export const inferenceProxyRequest = (request: Request, env: InferenceProxyEnv = {}): Request => {
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  const token = env.AZOOKEY_API_TOKEN?.trim();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new Request(request, { headers });
};
