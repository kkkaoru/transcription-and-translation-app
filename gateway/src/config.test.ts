import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGatewayConfig, validateGatewayConfig } from "./config.js";

const config = {
  listen: { host: "127.0.0.1", port: 8765 },
  parapper: { url: "ws://127.0.0.1:18082/ws/recognition/", timeoutMs: 18000 },
  models: {
    "hy-mt2-1.8b-gguf": { baseUrl: "http://127.0.0.1:8082/", servedModel: "hy" },
  },
};

describe("gateway configuration", () => {
  it("validates local routes and strips harmless trailing slashes", () => {
    expect(validateGatewayConfig(config)).toEqual({
      listen: { host: "127.0.0.1", port: 8765 },
      parapper: { url: "ws://127.0.0.1:18082/ws/recognition", timeoutMs: 18000 },
      models: { "hy-mt2-1.8b-gguf": { baseUrl: "http://127.0.0.1:8082", servedModel: "hy" } },
    });
  });

  it("accepts omitted optional model and credential fields", () => {
    const result = validateGatewayConfig({
      ...config,
      parapper: { url: "wss://gateway.example/asr", timeoutMs: 1, apiKeyEnv: "PARAPPER_KEY" },
      models: { zenz: { baseUrl: "https://model.example" } },
    });
    expect(result.parapper.apiKeyEnv).toBe("PARAPPER_KEY");
    expect(result.models["zenz"]).toEqual({ baseUrl: "https://model.example" });
  });

  it("rejects invalid structures, values, and protocols", () => {
    expect(() => validateGatewayConfig(null)).toThrow("object");
    expect(() => validateGatewayConfig({ ...config, listen: { host: "", port: 1 } })).toThrow(
      "host",
    );
    expect(() => validateGatewayConfig({ ...config, listen: { host: "x", port: 0 } })).toThrow(
      "port",
    );
    expect(() =>
      validateGatewayConfig({ ...config, parapper: { url: "file:///tmp/asr", timeoutMs: 1 } }),
    ).toThrow("URL");
    expect(() => validateGatewayConfig({ ...config, models: { x: { baseUrl: 3 } } })).toThrow(
      "baseUrl",
    );
    expect(() =>
      validateGatewayConfig({ ...config, models: { x: { baseUrl: "http://x", servedModel: 3 } } }),
    ).toThrow("servedModel");
    expect(() =>
      validateGatewayConfig({ ...config, parapper: { ...config.parapper, apiKeyEnv: 4 } }),
    ).toThrow("apiKeyEnv");
  });

  it("loads the same validated configuration from a JSON file", () => {
    const directory = mkdtempSync(join(tmpdir(), "caption-bridge-gateway-"));
    const path = join(directory, "gateway.json");
    try {
      writeFileSync(path, JSON.stringify(config));
      expect(loadGatewayConfig(path).listen.port).toBe(8765);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
