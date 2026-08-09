#!/usr/bin/env node
/**
 * Hosted compare / inference checks with an Access Service Token.
 * No OTP wait loop. Secrets are never printed.
 *
 * Usage:
 *   node scripts/verify-cloudflare-hosted.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CF_ACCESS_CLIENT_ID_KEY,
  CF_ACCESS_CLIENT_SECRET_KEY,
  COMPARE_PUBLIC_HOST,
  INFERENCE_PUBLIC_HOST,
} from "./setup-cloudflare-access.mjs";
import { parseDotEnv } from "./setup-cursor-cloudflare-mcp.mjs";

export const COMPARE_ORIGIN = `https://${COMPARE_PUBLIC_HOST}`;
export const INFERENCE_ORIGIN = `https://${INFERENCE_PUBLIC_HOST}`;
export const COMPARE_HEALTH_PATH = "/v1/azookey";
export const COMPARE_WS_PATH = "/ws/azookey";

const present = (value) => typeof value === "string" && value.trim().length > 0;

export const isUnauthenticatedAccessStatus = (status) => status === 401 || status === 302;

export const accessServiceTokenHeaders = ({ clientId, clientSecret }) => ({
  "CF-Access-Client-Id": clientId,
  "CF-Access-Client-Secret": clientSecret,
});

export const resolveAccessServiceToken = ({ env = process.env, dotenv = {} } = {}) => {
  const clientId = (env[CF_ACCESS_CLIENT_ID_KEY] || dotenv[CF_ACCESS_CLIENT_ID_KEY] || "").trim();
  const clientSecret = (
    env[CF_ACCESS_CLIENT_SECRET_KEY] ||
    dotenv[CF_ACCESS_CLIENT_SECRET_KEY] ||
    ""
  ).trim();
  if (!present(clientId) || !present(clientSecret)) {
    return undefined;
  }
  return { clientId, clientSecret };
};

export const evaluateHostedChecks = ({
  unauthenticatedHome,
  unauthenticatedHealth,
  authenticatedHealth,
  inferenceDirect,
  websocket,
  requireAuthenticatedHealth = true,
}) => {
  /** @type {string[]} */
  const failures = [];
  if (!isUnauthenticatedAccessStatus(unauthenticatedHome)) {
    failures.push(`unauth / expected 401/302, got ${unauthenticatedHome}`);
  }
  if (!isUnauthenticatedAccessStatus(unauthenticatedHealth)) {
    failures.push(`unauth ${COMPARE_HEALTH_PATH} expected 401/302, got ${unauthenticatedHealth}`);
  }
  if (requireAuthenticatedHealth) {
    if (authenticatedHealth === undefined) {
      failures.push(`auth ${COMPARE_HEALTH_PATH} skipped`);
    } else if (authenticatedHealth !== 200) {
      failures.push(`auth ${COMPARE_HEALTH_PATH} expected 200, got ${authenticatedHealth}`);
    }
  }
  if (inferenceDirect !== 404) {
    failures.push(`inference direct expected 404, got ${inferenceDirect}`);
  }
  return {
    ok: failures.length === 0,
    failures,
    websocket: websocket ?? "skipped",
  };
};

const loadDotEnv = (root) => {
  const envPath = join(root, ".env");
  return existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};
};

const fetchStatus = async (url, init = {}) => {
  const response = await fetch(url, { ...init, redirect: "manual" });
  return {
    status: response.status,
    wwwAuthenticate: response.headers.get("www-authenticate"),
    location: response.headers.get("location"),
    okJson: await readOkFlag(response),
  };
};

const readOkFlag = async (response) => {
  if (response.status !== 200) {
    return undefined;
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    return undefined;
  }
  try {
    const body = await response.json();
    return body?.ok === true;
  } catch {
    return undefined;
  }
};

const smokeWebSocketUpgrade = async ({ origin, headers }) => {
  const response = await fetch(`${origin}${COMPARE_WS_PATH}`, {
    method: "GET",
    redirect: "manual",
    headers: {
      ...headers,
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
    },
  });
  return response.status;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const run = async () => {
  const dotenv = loadDotEnv(repositoryRoot);
  const serviceToken = resolveAccessServiceToken({ env: process.env, dotenv });
  const unauthHome = await fetchStatus(`${COMPARE_ORIGIN}/`);
  const unauthHealth = await fetchStatus(`${COMPARE_ORIGIN}${COMPARE_HEALTH_PATH}`);
  const inferenceDirect = await fetchStatus(`${INFERENCE_ORIGIN}${COMPARE_HEALTH_PATH}`);

  let authenticatedHealth;
  let websocketStatus;
  if (!serviceToken) {
    console.warn(
      "Access Service Token missing in env/.env. Skipping authenticated compare checks (no OTP wait).",
    );
  } else {
    const headers = accessServiceTokenHeaders(serviceToken);
    authenticatedHealth = await fetchStatus(`${COMPARE_ORIGIN}${COMPARE_HEALTH_PATH}`, {
      headers,
    });
    try {
      websocketStatus = await smokeWebSocketUpgrade({ origin: COMPARE_ORIGIN, headers });
    } catch (error) {
      console.warn(
        `WS upgrade smoke skipped: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  const summary = evaluateHostedChecks({
    unauthenticatedHome: unauthHome.status,
    unauthenticatedHealth: unauthHealth.status,
    authenticatedHealth: authenticatedHealth?.status,
    inferenceDirect: inferenceDirect.status,
    websocket: websocketStatus,
    requireAuthenticatedHealth: Boolean(serviceToken),
  });

  console.log(
    JSON.stringify(
      {
        unauthHome: unauthHome.status,
        unauthHealth: unauthHealth.status,
        authHealth: authenticatedHealth?.status ?? "skipped",
        authHealthOk: authenticatedHealth?.okJson,
        inferenceDirect: inferenceDirect.status,
        websocket: websocketStatus ?? "skipped",
        ok: summary.ok,
        failures: summary.failures,
      },
      null,
      2,
    ),
  );

  if (!serviceToken) {
    return summary.ok ? 2 : 1;
  }
  return summary.ok ? 0 : 1;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
