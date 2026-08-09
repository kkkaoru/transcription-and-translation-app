import { inferenceProxyRequest, shouldProxyToInference } from "./lib/inference-proxy";

export interface CompareWorkerAssets {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface CompareWorkerEnv {
  ASSETS: CompareWorkerAssets;
  INFERENCE: CompareWorkerAssets;
}

export default {
  fetch(request: Request, env: CompareWorkerEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (shouldProxyToInference(pathname)) {
      return env.INFERENCE.fetch(inferenceProxyRequest(request));
    }
    return env.ASSETS.fetch(request);
  },
};
