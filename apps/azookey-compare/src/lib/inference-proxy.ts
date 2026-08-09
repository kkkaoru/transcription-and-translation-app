export const COMPARE_INFERENCE_WEBSOCKET_PATH = "/ws/azookey";
export const COMPARE_INFERENCE_HEALTH_PATH = "/v1/azookey";

export const COMPARE_INFERENCE_PROXY_PATHS = [
  COMPARE_INFERENCE_WEBSOCKET_PATH,
  COMPARE_INFERENCE_HEALTH_PATH,
] as const;

export const COMPARE_WORKER_ORIGIN = "https://azookey-compare.kaoru.workers.dev";
export const COMPARE_WORKER_WEBSOCKET_URL = `wss://azookey-compare.kaoru.workers.dev${COMPARE_INFERENCE_WEBSOCKET_PATH}`;

export const shouldProxyToInference = (pathname: string): boolean =>
  (COMPARE_INFERENCE_PROXY_PATHS as readonly string[]).includes(pathname);

/**
 * Forward the inbound request unchanged so WebSocket upgrades keep their
 * headers and the inference Worker sees the original path.
 */
export const inferenceProxyRequest = (request: Request): Request => request;
