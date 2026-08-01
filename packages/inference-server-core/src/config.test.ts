import { describe, expect, it } from "vitest";
import { validateGatewayConfig } from "./config.js";

const config = {
  listen: { host: " 127.0.0.1 ", port: 8_765 },
  parapper: { url: "ws://127.0.0.1:18082/ws/recognition/", timeoutMs: 18_000 },
  models: {
    "hy-mt2-1.8b-gguf": { baseUrl: "http://127.0.0.1:8082/", servedModel: " hy " },
  },
};

describe("gateway configuration", () => {
  it("validates routes and normalizes harmless whitespace and trailing slashes", () => {
    expect(validateGatewayConfig(config)).toEqual({
      listen: { host: "127.0.0.1", port: 8_765 },
      parapper: { url: "ws://127.0.0.1:18082/ws/recognition", timeoutMs: 18_000 },
      models: { "hy-mt2-1.8b-gguf": { baseUrl: "http://127.0.0.1:8082", servedModel: "hy" } },
    });
  });

  it("accepts optional fields and empty model maps", () => {
    const result = validateGatewayConfig({
      ...config,
      parapper: { url: "https://gateway.example/asr", timeoutMs: 1, apiKeyEnv: " PARAPPER_KEY " },
      models: { zenz: { baseUrl: "https://model.example/", servedModel: "   " } },
    });
    expect(result.parapper.apiKeyEnv).toBe("PARAPPER_KEY");
    expect(result.models["zenz"]).toEqual({ baseUrl: "https://model.example" });
    expect(validateGatewayConfig({ ...config, models: {} }).models).toEqual({});
  });

  it("rejects invalid structures, values, and protocols", () => {
    expect(() => validateGatewayConfig(null)).toThrow("object");
    expect(() => validateGatewayConfig({ ...config, listen: { host: "", port: 1 } })).toThrow(
      "host",
    );
    expect(() => validateGatewayConfig({ ...config, listen: { host: "x", port: 0 } })).toThrow(
      "port",
    );
    expect(() => validateGatewayConfig({ ...config, listen: { host: "x", port: 1.5 } })).toThrow(
      "port",
    );
    expect(() => validateGatewayConfig({ ...config, listen: [] })).toThrow("listen");
    expect(() => validateGatewayConfig({ ...config, parapper: [] })).toThrow("parapper");
    expect(() => validateGatewayConfig({ ...config, models: [] })).toThrow("models");
    expect(() =>
      validateGatewayConfig({ ...config, parapper: { url: "file:///tmp/asr", timeoutMs: 1 } }),
    ).toThrow("URL");
    expect(() =>
      validateGatewayConfig({ ...config, parapper: { url: "bad", timeoutMs: 1 } }),
    ).toThrow("URL");
    expect(() =>
      validateGatewayConfig({ ...config, parapper: { url: "https://x", timeoutMs: 0 } }),
    ).toThrow("timeoutMs");
    expect(() => validateGatewayConfig({ ...config, models: { x: { baseUrl: 3 } } })).toThrow(
      "baseUrl",
    );
    expect(() =>
      validateGatewayConfig({ ...config, models: { x: { baseUrl: "http://x", servedModel: 3 } } }),
    ).toThrow("servedModel");
    expect(() =>
      validateGatewayConfig({ ...config, parapper: { ...config.parapper, apiKeyEnv: 4 } }),
    ).toThrow("apiKeyEnv");
    expect(() =>
      validateGatewayConfig({ ...config, models: { "": { baseUrl: "http://x" } } }),
    ).toThrow("model ID");
  });
});
