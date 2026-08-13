#!/usr/bin/env node
/**
 * Keep Cursor MCP free of Cloudflare Code Mode entries. Code Mode
 * (`https://mcp.cloudflare.com/mcp`) errors in this environment; use the
 * Cursor Cloudflare plugin (bindings / builds / observability / docs) instead.
 *
 * Usage:
 *   node scripts/setup-cursor-cloudflare-mcp.mjs
 *   node scripts/setup-cursor-cloudflare-mcp.mjs --check
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN_KEYS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_DEBUG_TOKEN"];
const BLOCKED_CODE_MODE_URL = "https://mcp.cloudflare.com/mcp";

const present = (value) => typeof value === "string" && value.trim().length > 0;

export const parseDotEnv = (contents) => {
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      values[key] = value;
    }
  }
  return values;
};

export const resolveCloudflareApiToken = ({ env = process.env, envFileContents } = {}) => {
  for (const key of TOKEN_KEYS) {
    const fromEnv = env[key];
    if (present(fromEnv)) {
      return { token: fromEnv.trim(), source: `env:${key}` };
    }
  }
  if (typeof envFileContents === "string") {
    const parsed = parseDotEnv(envFileContents);
    for (const key of TOKEN_KEYS) {
      if (present(parsed[key])) {
        return { token: parsed[key].trim(), source: `dotenv:${key}` };
      }
    }
  }
  return { token: undefined, source: undefined };
};

export const buildCursorMcpConfig = () => ({ mcpServers: {} });

export const cursorMcpConfigPath = (home = homedir()) => join(home, ".cursor", "mcp.json");

export const writeCursorMcpConfig = ({ home = homedir() } = {}) => {
  const configPath = cursorMcpConfigPath(home);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(buildCursorMcpConfig(), null, 2)}\n`, {
    encoding: "utf8",
  });
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // Windows and some shared FS mounts do not support POSIX modes.
  }
  return configPath;
};

export const hasCloudflareCodeMode = (config) => {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== "object") {
    return false;
  }
  return Object.values(servers).some(
    (server) => server && typeof server === "object" && server.url === BLOCKED_CODE_MODE_URL,
  );
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const loadEnvFileContents = (root = repositoryRoot) => {
  const envPath = join(root, ".env");
  return existsSync(envPath) ? readFileSync(envPath, "utf8") : undefined;
};

const run = () => {
  const checkOnly = process.argv.includes("--check");
  const homeConfigPath = cursorMcpConfigPath();
  const projectConfigPath = join(repositoryRoot, ".cursor", "mcp.json");
  const homeConfig = existsSync(homeConfigPath)
    ? JSON.parse(readFileSync(homeConfigPath, "utf8"))
    : { mcpServers: {} };
  const projectConfig = existsSync(projectConfigPath)
    ? JSON.parse(readFileSync(projectConfigPath, "utf8"))
    : { mcpServers: {} };
  if (hasCloudflareCodeMode(projectConfig) || hasCloudflareCodeMode(homeConfig)) {
    console.error(
      "FAIL: Code Mode MCP is still configured. Use the Cursor Cloudflare plugin instead.",
    );
    return 2;
  }
  if (checkOnly) {
    const resolved = resolveCloudflareApiToken({
      env: process.env,
      envFileContents: loadEnvFileContents(),
    });
    console.log(
      resolved.token
        ? `OK: MCP uses the Cloudflare plugin (Wrangler token available via ${resolved.source}).`
        : "OK: MCP uses the Cloudflare plugin. Authenticate plugin-cloudflare-* in Cursor.",
    );
    return 0;
  }
  writeCursorMcpConfig();
  writeFileSync(projectConfigPath, `${JSON.stringify(buildCursorMcpConfig(), null, 2)}\n`, {
    encoding: "utf8",
  });
  console.log("Cleared Code Mode MCP entries. Use the Cursor Cloudflare plugin.");
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
