// Runs with Bun in the Cloudflare Workers runtime.
import handler from "@tanstack/react-start/server-entry";
import {
  handleLanguageContainerRequest,
  NvidiaAmbernetBasicContainer,
  NvidiaAmbernetStandardContainer,
  SpeechbrainEcapaBasicContainer,
  SpeechbrainEcapaStandardContainer,
} from "./container-backend";
import { fetchContainerUsage } from "./container-usage";
import { handleVoiceTestRequest } from "./voice-test-backend";
import { handleWorkersAiLanguageRequest } from "./workers-ai-language";

export {
  NvidiaAmbernetBasicContainer,
  NvidiaAmbernetStandardContainer,
  SpeechbrainEcapaBasicContainer,
  SpeechbrainEcapaStandardContainer,
};

const USAGE_PATH: string = "/api/container-usage";

const handleUsageRequest = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const usage = await fetchContainerUsage(env, new Date());
  return Response.json(usage, { headers: { "cache-control": "public, max-age=60" } });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname: string = new URL(request.url).pathname;
    if (pathname === USAGE_PATH) return handleUsageRequest(request, env);
    const containerResponse: Response | undefined = await handleLanguageContainerRequest(
      request,
      env,
    );
    if (containerResponse !== undefined) return containerResponse;
    const workersAiResponse: Response | undefined = await handleWorkersAiLanguageRequest(
      request,
      env,
    );
    if (workersAiResponse !== undefined) return workersAiResponse;
    const voiceTestResponse: Response | undefined = await handleVoiceTestRequest(request, env);
    return voiceTestResponse ?? handler.fetch(request);
  },
};
