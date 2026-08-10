#!/usr/bin/env node
/**
 * Local compare UI: Access ASR proxy on :8790 + next.dev on :3000.
 * Does not print secrets.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPARE_ASR_DEV_PROXY_ORIGIN_DEFAULT,
  COMPARE_ASR_DEV_PROXY_PORT,
  startCompareDevAsrAccessProxy,
} from "./compare-dev-asr-access-proxy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compareRoot = join(root, "apps/azookey-compare");

const server = await startCompareDevAsrAccessProxy({
  hostname: "127.0.0.1",
  port: COMPARE_ASR_DEV_PROXY_PORT,
  root,
});

console.log(`ASR Access proxy ${COMPARE_ASR_DEV_PROXY_ORIGIN_DEFAULT} → hosted compare`);

const child = spawn("bun", ["x", "next", "dev", "--hostname", "127.0.0.1"], {
  cwd: compareRoot,
  stdio: "inherit",
  env: process.env,
});

const shutdown = () => {
  child.kill("SIGTERM");
  server.close();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => {
  server.close();
  process.exit(code ?? 0);
});
