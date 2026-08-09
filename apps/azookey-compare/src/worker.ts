import { enforceAccessJwt } from "./lib/access-jwt";
import { inferenceProxyRequest, shouldProxyToInference } from "./lib/inference-proxy";

export interface CompareWorkerAssets {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface CompareWorkerEnv {
  ASSETS: CompareWorkerAssets;
  INFERENCE: CompareWorkerAssets;
  POLICY_AUD?: string;
  TEAM_DOMAIN?: string;
}

export default {
  async fetch(request: Request, env: CompareWorkerEnv): Promise<Response> {
    const denied = await enforceAccessJwt(request, env);
    if (denied) {
      return denied;
    }
    const pathname = new URL(request.url).pathname;
    if (shouldProxyToInference(pathname)) {
      return env.INFERENCE.fetch(inferenceProxyRequest(request));
    }
    return env.ASSETS.fetch(request);
  },
};
