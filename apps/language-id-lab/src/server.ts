// Runs with Bun in the Cloudflare Workers runtime.
import handler from "@tanstack/react-start/server-entry";
import {
  handleLanguageContainerRequest,
  LanguageIdBasicContainer,
  LanguageIdStandardContainer,
} from "./container-backend";
import { fetchContainerUsage } from "./container-usage";

export { LanguageIdBasicContainer, LanguageIdStandardContainer };

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
    return containerResponse ?? handler.fetch(request);
  },
};
