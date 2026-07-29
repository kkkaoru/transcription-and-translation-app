import { readFileSync } from "node:fs";
import { validateGatewayConfig } from "@caption-bridge/inference-server-core";
import type { GatewayConfig } from "@caption-bridge/inference-server-core";

export { validateGatewayConfig };
export type { GatewayConfig, TextModelRoute } from "@caption-bridge/inference-server-core";

export const loadGatewayConfig = (path: string): GatewayConfig =>
  validateGatewayConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
