import { readFileSync } from "node:fs";
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
    expect(shouldProxyToInference("/models/silero_vad_v6/silero_vad.onnx")).toBe(false);
    expect(shouldProxyToInference("/ort/ort-wasm-simd-threaded.wasm")).toBe(false);
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

  it("builds local next.dev rewrites to COMPARE_INFERENCE_ORIGIN", async () => {
    const mod = await import("./inference-proxy");
    expect(mod).toHaveProperty("COMPARE_INFERENCE_DEV_ORIGIN_DEFAULT", "http://127.0.0.1:8787");
    expect(mod.compareInferenceDevOrigin({})).toBe("http://127.0.0.1:8787");
    expect(mod.compareInferenceDevOrigin({ COMPARE_INFERENCE_ORIGIN: "  " })).toBe(
      "http://127.0.0.1:8787",
    );
    expect(
      mod.compareInferenceDevOrigin({ COMPARE_INFERENCE_ORIGIN: "http://127.0.0.1:9999/" }),
    ).toBe("http://127.0.0.1:9999");
    expect(mod.compareInferenceDevRewrites()).toEqual([
      { source: "/ws/azookey", destination: "http://127.0.0.1:8787/ws/azookey" },
      { source: "/v1/azookey", destination: "http://127.0.0.1:8787/v1/azookey" },
      {
        source: "/v1/asr/workers-ai/transcriptions",
        destination: "http://127.0.0.1:8787/v1/asr/workers-ai/transcriptions",
      },
    ]);
    expect(mod.compareInferenceDevRewrites("http://127.0.0.1:9999")).toEqual([
      { source: "/ws/azookey", destination: "http://127.0.0.1:9999/ws/azookey" },
      { source: "/v1/azookey", destination: "http://127.0.0.1:9999/v1/azookey" },
      {
        source: "/v1/asr/workers-ai/transcriptions",
        destination: "http://127.0.0.1:9999/v1/asr/workers-ai/transcriptions",
      },
    ]);
  });

  it("keeps next.config.mjs development rewrites aligned with inference proxy paths", () => {
    const nextConfig = readFileSync(new URL("../../next.config.mjs", import.meta.url), "utf8");
    expect(nextConfig).toContain("rewrites");
    expect(nextConfig).toContain("COMPARE_INFERENCE_ORIGIN");
    expect(nextConfig).toContain("http://127.0.0.1:8787");
    expect(nextConfig).toContain('NODE_ENV === "development"');
    for (const pathname of COMPARE_INFERENCE_PROXY_PATHS) {
      expect(nextConfig).toContain(pathname);
    }
  });

  it("requires local worker:dev wrangler.dev.jsonc to expose a Workers AI remote binding", () => {
    const devJsonc = readFileSync(
      new URL("../../../cloudflare-worker-server/wrangler.dev.jsonc", import.meta.url),
      "utf8",
    );
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const devConfig = JSON.parse(devJsonc.replace(/^\s*\/\/.*$/gm, "")) as {
      ai?: { binding?: string; remote?: boolean };
    };
    // Local next.dev rewrites ASR to :8787. Without a remote AI binding there,
    // 認識を開始 succeeds but the first utterance returns JSON 503
    // "Workers AI ASR binding is not configured".
    expect(devConfig.ai).toEqual({ binding: "AI", remote: true });
    expect(readme).toMatch(/wrangler\.dev\.jsonc/);
    expect(readme).toMatch(/remote:\s*true/);
    expect(readme).not.toMatch(/does not enable the\s+Workers AI binding/);
  });
});
