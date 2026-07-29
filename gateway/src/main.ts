import { resolve } from "node:path";
import { loadGatewayConfig } from "./config.js";
import { createGatewayServer } from "./server.js";

const configPath =
  process.env["CAPTION_BRIDGE_GATEWAY_CONFIG"] ?? resolve(process.cwd(), "gateway.config.json");
const config = loadGatewayConfig(configPath);
const server = createGatewayServer(config);

server.listen(config.listen.port, config.listen.host, () => {
  process.stdout.write(
    `Caption Bridge gateway listening on http://${config.listen.host}:${config.listen.port}\n`,
  );
});
