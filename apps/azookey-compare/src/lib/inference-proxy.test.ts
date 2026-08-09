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
  it("proxies only the AzooKey health and WebSocket paths", () => {
    expect(COMPARE_INFERENCE_PROXY_PATHS).toEqual(["/ws/azookey", "/v1/azookey"]);
    expect(shouldProxyToInference(COMPARE_INFERENCE_WEBSOCKET_PATH)).toBe(true);
    expect(shouldProxyToInference(COMPARE_INFERENCE_HEALTH_PATH)).toBe(true);
    expect(shouldProxyToInference("/")).toBe(false);
    expect(shouldProxyToInference("/vibrato/vibrato_wasm.js")).toBe(false);
    expect(shouldProxyToInference("/ws/azookey/extra")).toBe(false);
  });

  it("pins the hosted compare origin and same-origin WebSocket URL", () => {
    expect(COMPARE_WORKER_ORIGIN).toBe("https://azookey-compare.kaoru.workers.dev");
    expect(COMPARE_WORKER_WEBSOCKET_URL).toBe("wss://azookey-compare.kaoru.workers.dev/ws/azookey");
  });

  it("returns the inbound request so upgrade headers stay intact", () => {
    const request = new Request("https://azookey-compare.kaoru.workers.dev/ws/azookey", {
      headers: {
        upgrade: "websocket",
        "cf-access-jwt-assertion": "test-jwt",
      },
    });
    expect(inferenceProxyRequest(request)).toBe(request);
    expect(inferenceProxyRequest(request).headers.get("upgrade")).toBe("websocket");
  });
});
