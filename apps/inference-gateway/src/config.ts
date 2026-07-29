import { readFileSync } from "node:fs";

export interface TextModelRoute {
  baseUrl: string;
  servedModel?: string;
}

export interface GatewayConfig {
  listen: {
    host: string;
    port: number;
  };
  parapper: {
    apiKeyEnv?: string;
    timeoutMs: number;
    url: string;
  };
  models: Record<string, TextModelRoute>;
}

const nonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
};

const url = (value: unknown, label: string): string => {
  const candidate = nonEmptyString(value, label);
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:" &&
      parsed.protocol !== "ws:" &&
      parsed.protocol !== "wss:"
    ) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`${label} must be an HTTP(S) or WebSocket URL`);
  }
  return candidate.replace(/\/$/, "");
};

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
};

export const validateGatewayConfig = (value: unknown): GatewayConfig => {
  const root = record(value, "gateway config");
  const listen = record(root["listen"], "listen");
  const parapper = record(root["parapper"], "parapper");
  const modelInput = record(root["models"], "models");
  const models = Object.fromEntries(
    Object.entries(modelInput).map(([id, routeValue]) => {
      const route = record(routeValue, `models.${id}`);
      const servedModel = route["servedModel"];
      if (servedModel !== undefined && typeof servedModel !== "string") {
        throw new Error(`models.${id}.servedModel must be a string when supplied`);
      }
      return [
        nonEmptyString(id, "model ID"),
        {
          baseUrl: url(route["baseUrl"], `models.${id}.baseUrl`),
          ...(servedModel?.trim() ? { servedModel: servedModel.trim() } : {}),
        },
      ];
    }),
  );
  const apiKeyEnv = parapper["apiKeyEnv"];
  if (apiKeyEnv !== undefined && typeof apiKeyEnv !== "string") {
    throw new Error("parapper.apiKeyEnv must be a string when supplied");
  }
  return {
    listen: {
      host: nonEmptyString(listen["host"], "listen.host"),
      port: positiveInteger(listen["port"], "listen.port"),
    },
    parapper: {
      url: url(parapper["url"], "parapper.url"),
      timeoutMs: positiveInteger(parapper["timeoutMs"], "parapper.timeoutMs"),
      ...(apiKeyEnv?.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
    },
    models,
  };
};

export const loadGatewayConfig = (path: string): GatewayConfig =>
  validateGatewayConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
