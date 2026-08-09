#!/usr/bin/env node
/**
 * Configure Cursor MCP so Cloudflare Bindings / Builds / Observability work
 * without interactive OAuth. Agent environments cannot complete the desktop
 * OAuth card; an API token Bearer header is the supported automation path.
 *
 * Reads CLOUDFLARE_API_TOKEN or CLOUDFLARE_DEBUG_TOKEN from the process
 * environment or a gitignored .env. Writes ~/.cursor/mcp.json (literal
 * Authorization header) and never prints the token.
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
const MCP_SERVERS = [
  ["cloudflare-bindings", "https://bindings.mcp.cloudflare.com/mcp"],
  ["cloudflare-builds", "https://builds.mcp.cloudflare.com/mcp"],
  ["cloudflare-observability", "https://observability.mcp.cloudflare.com/mcp"],
];

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

export const buildCursorMcpConfig = (token) => {
  if (!present(token)) {
    throw new Error("Cloudflare API token is required");
  }
  const authorization = `Bearer ${token.trim()}`;
  return {
    mcpServers: Object.fromEntries(
      MCP_SERVERS.map(([name, url]) => [
        name,
        {
          url,
          headers: { Authorization: authorization },
        },
      ]),
    ),
  };
};

export const cursorMcpConfigPath = (home = homedir()) => join(home, ".cursor", "mcp.json");

export const writeCursorMcpConfig = ({ token, home = homedir() }) => {
  const configPath = cursorMcpConfigPath(home);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(buildCursorMcpConfig(token), null, 2)}\n`, {
    encoding: "utf8",
  });
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // Windows and some shared FS mounts do not support POSIX modes.
  }
  return configPath;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const loadEnvFileContents = (root = repositoryRoot) => {
  const envPath = join(root, ".env");
  return existsSync(envPath) ? readFileSync(envPath, "utf8") : undefined;
};

const run = () => {
  const checkOnly = process.argv.includes("--check");
  const resolved = resolveCloudflareApiToken({
    env: process.env,
    envFileContents: loadEnvFileContents(),
  });
  if (!resolved.token) {
    console.error(
      "FAIL: set CLOUDFLARE_API_TOKEN or CLOUDFLARE_DEBUG_TOKEN (env or gitignored .env).",
    );
    return 2;
  }
  if (checkOnly) {
    console.log(
      `OK: Cloudflare MCP token available (${resolved.source}, len=${resolved.token.length}).`,
    );
    return 0;
  }
  const configPath = writeCursorMcpConfig({ token: resolved.token });
  console.log(
    `Wrote ${configPath} for bindings/builds/observability MCP (${resolved.source}). Reloading Cursor MCP may be required.`,
  );
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
