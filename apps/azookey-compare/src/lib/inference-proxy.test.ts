import { describe, expect, it } from "vitest";
import {
  COMPARE_INFERENCE_HEALTH_PATH,
  COMPARE_INFERENCE_PROXY_PATHS,
  COMPARE_INFERENCE_WEBSOCKET_PATH,
  COMPARE_WORKER_ORIGIN,
  COMPARE_WORKER_WEBSOCKET_URL,
  inferenceProxyRequest,
  shouldProxyToInference,
} from "./inference-proxy";

describe("compare Worker inference proxy", () => {
  it("proxies AzooKey health, WebSocket, and explicit Workers AI ASR paths", () => {
    expect(COMPARE_INFERENCE_PROXY_PATHS).toEqual([
      "/ws/azookey",
      "/v1/azookey",
      "/v1/asr/workers-ai/transcriptions",
    ]);
    expect(shouldProxyToInference(COMPARE_INFERENCE_WEBSOCKET_PATH)).toBe(true);
    expect(shouldProxyToInference(COMPARE_INFERENCE_HEALTH_PATH)).toBe(true);
    expect(shouldProxyToInference("/v1/asr/workers-ai/transcriptions")).toBe(true);
    expect(shouldProxyToInference("/")).toBe(false);
    expect(shouldProxyToInference("/vibrato/vibrato_wasm.js")).toBe(false);
    expect(shouldProxyToInference("/ws/azookey/extra")).toBe(false);
  });

  it("pins the hosted compare origin and same-origin WebSocket URL", () => {
    expect(COMPARE_WORKER_ORIGIN).toBe("https://azookey-compare.kaoru.workers.dev");
    expect(COMPARE_WORKER_WEBSOCKET_URL).toBe("wss://azookey-compare.kaoru.workers.dev/ws/azookey");
  });

  it("keeps WebSocket upgrade headers after stripping client Authorization", () => {
    const request = new Request("https://azookey-compare.kaoru.workers.dev/ws/azookey", {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        "sec-websocket-protocol": "azookey.text.v1",
        authorization: "Bearer client-token",
        "cf-access-jwt-assertion": "access-jwt",
      },
    });
    const proxied = inferenceProxyRequest(request, {});
    expect(proxied).not.toBe(request);
    expect(proxied.method).toBe("GET");
    expect(new URL(proxied.url).pathname).toBe("/ws/azookey");
    expect(proxied.headers.get("upgrade")).toBe("websocket");
    expect(proxied.headers.get("connection")).toBe("Upgrade");
    expect(proxied.headers.get("sec-websocket-key")).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(proxied.headers.get("sec-websocket-version")).toBe("13");
    expect(proxied.headers.get("sec-websocket-protocol")).toBe("azookey.text.v1");
    expect(proxied.headers.get("cf-access-jwt-assertion")).toBe("access-jwt");
    expect(proxied.headers.get("authorization")).toBeNull();
    expect(request.headers.get("authorization")).toBe("Bearer client-token");
  });

  it("injects AZOOKEY bearer after dropping the client Authorization", () => {
    const request = new Request("https://azookey-compare.kaoru.workers.dev/v1/azookey", {
      headers: {
        authorization: "Bearer client-token",
      },
    });
    const proxied = inferenceProxyRequest(request, { AZOOKEY_API_TOKEN: " worker-secret " });
    expect(proxied.headers.get("authorization")).toBe("Bearer worker-secret");
    expect(request.headers.get("authorization")).toBe("Bearer client-token");
  });

  it("does not invent a bearer when AZOOKEY_API_TOKEN is unset", () => {
    const request = new Request("https://azookey-compare.kaoru.workers.dev/v1/azookey");
    expect(inferenceProxyRequest(request).headers.get("authorization")).toBeNull();
    expect(
      inferenceProxyRequest(request, { AZOOKEY_API_TOKEN: "   " }).headers.get("authorization"),
    ).toBeNull();
  });
});
