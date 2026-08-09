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
  AZOOKEY_API_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: CompareWorkerEnv): Promise<Response> {
    const denied = await enforceAccessJwt(request, env);
    if (denied) {
      return denied;
    }
    const pathname = new URL(request.url).pathname;
    if (shouldProxyToInference(pathname)) {
      return env.INFERENCE.fetch(inferenceProxyRequest(request, env));
    }
    return env.ASSETS.fetch(request);
  },
};
