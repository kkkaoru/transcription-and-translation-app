export const COMPARE_INFERENCE_WEBSOCKET_PATH = "/ws/azookey";
export const COMPARE_INFERENCE_HEALTH_PATH = "/v1/azookey";

export const COMPARE_INFERENCE_PROXY_PATHS = [
  COMPARE_INFERENCE_WEBSOCKET_PATH,
  COMPARE_INFERENCE_HEALTH_PATH,
] as const;

export const COMPARE_WORKER_ORIGIN = "https://azookey-compare.kaoru.workers.dev";
export const COMPARE_WORKER_WEBSOCKET_URL = `wss://azookey-compare.kaoru.workers.dev${COMPARE_INFERENCE_WEBSOCKET_PATH}`;

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
