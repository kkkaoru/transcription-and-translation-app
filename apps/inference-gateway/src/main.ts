import { resolve } from "node:path";
import { loadGatewayConfig } from "./config.js";
import { createGatewayServer } from "./server.js";

const configArgument = process.argv.indexOf("--config");
if (configArgument >= 0 && !process.argv[configArgument + 1]) {
  throw new Error("--config requires an absolute or relative JSON file path");
}
const explicitConfig = configArgument >= 0 ? process.argv[configArgument + 1] : undefined;
const configPath =
  explicitConfig ??
  process.env["CAPTION_BRIDGE_GATEWAY_CONFIG"] ??
  resolve(process.cwd(), "gateway.config.json");
const config = loadGatewayConfig(configPath);
const server = createGatewayServer(config);

server.listen(config.listen.port, config.listen.host, () => {
  process.stdout.write(
    `Kotoba Beacon gateway listening on http://${config.listen.host}:${config.listen.port}\n`,
  );
});

const stop = (signal: string): void => {
  server.close((error) => {
    if (error) {
      process.stderr.write(`Gateway shutdown after ${signal} failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
