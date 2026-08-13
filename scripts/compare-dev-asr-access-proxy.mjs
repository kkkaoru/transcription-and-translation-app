/**
 * Local next.dev ASR proxy: Access ST → hosted compare → INFERENCE Nova-3.
 * Secrets are never printed or invented.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "./setup-cursor-cloudflare-mcp.mjs";
import {
  accessServiceTokenHeaders,
  BROWSER_LIKE_USER_AGENT,
  COMPARE_ASR_PATH,
  COMPARE_HEALTH_PATH,
  COMPARE_ORIGIN,
  resolveAccessServiceToken,
} from "./verify-cloudflare-hosted.mjs";

export const COMPARE_ASR_DEV_PROXY_PORT = 8790;
export const COMPARE_ASR_DEV_PROXY_ORIGIN_DEFAULT = `http://127.0.0.1:${COMPARE_ASR_DEV_PROXY_PORT}`;
export const LOCAL_WORKERS_AI_ASR_UNAVAILABLE_JA =
  "ローカルの Cloudflare Workers AI ASR には .env の Access サービス トークンか、bun run worker:dev の AI binding が必要です";

const jsonResponse = (status, body) =>
  Response.json(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export const loadRepoDotEnv = (root) => {
  const envPath = join(root, ".env");
  return existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};
};

const accessHeaders = (token) => ({
  ...accessServiceTokenHeaders(token),
  "User-Agent": BROWSER_LIKE_USER_AGENT,
});

export const handleCompareDevAsrAccessProxyRequest = async (
  request,
  { env = process.env, dotenv = {}, fetchImpl = fetch, compareOrigin = COMPARE_ORIGIN } = {},
) => {
  const pathname = new URL(request.url).pathname;
  if (pathname !== COMPARE_ASR_PATH) {
    return jsonResponse(404, {
      error: { code: "not_found", message: LOCAL_WORKERS_AI_ASR_UNAVAILABLE_JA },
    });
  }
  const token = resolveAccessServiceToken({ env, dotenv });
  if (!token) {
    return jsonResponse(503, {
      error: { code: "asr_workers_ai_unavailable", message: LOCAL_WORKERS_AI_ASR_UNAVAILABLE_JA },
    });
  }
  const headers = accessHeaders(token);
  if (request.method === "GET" || request.method === "HEAD") {
    const health = await fetchImpl(`${compareOrigin}${COMPARE_HEALTH_PATH}`, { headers });
    if (!health.ok) {
      return jsonResponse(503, {
        error: { code: "asr_workers_ai_unavailable", message: LOCAL_WORKERS_AI_ASR_UNAVAILABLE_JA },
      });
    }
    if (request.method === "HEAD") {
      return new Response(null, { status: 200 });
    }
    return jsonResponse(200, { ok: true, proxy: "access-compare" });
  }
  if (request.method !== "POST") {
    return jsonResponse(405, {
      error: { code: "method_not_allowed", message: "POST or GET is required" },
    });
  }
  const contentType = request.headers.get("content-type");
  const upstream = await fetchImpl(`${compareOrigin}${COMPARE_ASR_PATH}`, {
    method: "POST",
    headers: {
      ...headers,
      ...(contentType ? { "content-type": contentType } : {}),
    },
    body: request.body,
    duplex: "half",
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  const upstreamType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": upstreamType },
  });
};

export const startCompareDevAsrAccessProxy = ({
  hostname = "127.0.0.1",
  port = COMPARE_ASR_DEV_PROXY_PORT,
  root = join(dirname(fileURLToPath(import.meta.url)), ".."),
  env = process.env,
  dotenv,
  fetchImpl = fetch,
  compareOrigin = COMPARE_ORIGIN,
} = {}) => {
  const loadedDotenv = dotenv ?? loadRepoDotEnv(root);
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${hostname}:${port}`);
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        const method = req.method ?? "GET";
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") {
            headers.set(key, value);
          } else if (Array.isArray(value)) {
            headers.set(key, value.join(", "));
          }
        }
        const request = new Request(url, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : body,
        });
        const response = await handleCompareDevAsrAccessProxyRequest(request, {
          env,
          dotenv: loadedDotenv,
          fetchImpl,
          compareOrigin,
        });
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        res.writeHead(response.status, responseHeaders);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: {
              code: "asr_workers_ai_failed",
              message: "Cloudflare Workers AI ASR の Access proxy に失敗しました",
            },
          }),
        );
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
};
