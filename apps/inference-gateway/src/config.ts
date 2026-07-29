import { readFileSync } from "node:fs";
import type { GatewayConfig } from "@caption-bridge/inference-server-core";
import { validateGatewayConfig } from "@caption-bridge/inference-server-core";

export type { GatewayConfig, TextModelRoute } from "@caption-bridge/inference-server-core";
export { validateGatewayConfig };

export const loadGatewayConfig = (path: string): GatewayConfig =>
  validateGatewayConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
