#!/usr/bin/env node

/**
 * Prove hosted azookey-compare serves the latest deploy, including cache headers.
 * Uses wrangler + curl + local out/ hashes. Access ST is used only when already
 * present in env/.env. Secrets are never printed or invented.
 *
 * Usage:
 *   node scripts/verify-azookey-compare-deploy.mjs
 *   node scripts/verify-azookey-compare-deploy.mjs --expect-version <uuid>
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPARE_PUBLIC_HOST } from "./setup-cloudflare-access.mjs";
import { parseDotEnv } from "./setup-cursor-cloudflare-mcp.mjs";
import {
  accessServiceTokenHeaders,
  BROWSER_LIKE_USER_AGENT,
  isUnauthenticatedAccessStatus,
  resolveAccessServiceToken,
} from "./verify-cloudflare-hosted.mjs";

export const COMPARE_ORIGIN = `https://${COMPARE_PUBLIC_HOST}`;
export const COMPARE_WORKER_NAME = "azookey-compare";
export const DIAGRAM_MARKERS = [
  "/v1/speech/workers-ai/azookey",
  "D3.js visualization",
  "Nova-3",
  "Whisper Large V3 Turbo",
  "Vibrato",
  "AzooKey",
  "Zenz v3.2 XSmall GGUF",
  "Zenz v3.2 Small GGUF",
  "カスタム辞書",
  "PROFILE CONTAINER",
  "Input N5 LM",
  "指定なし（自動検出・日本語後処理なし）",
  "なし（jaでもAzooKeyを実行しない）",
];
export const DECIMAL_USD_FRACTION_PATTERN = /minimumFractionDigits:\s*8/;
export const TO_EXPONENTIAL_CALL_PATTERN = /\.toExponential\s*\(/;
export const HTML_NO_STORE_PATTERN = /\bno-store\b/i;
export const HASHED_STATIC_IMMUTABLE_PATTERN = /\bimmutable\b/i;
export const HASHED_STATIC_MAX_AGE_PATTERN = /max-age=31536000/i;

const INTERESTING_HEADERS = [
  "cache-control",
  "cf-cache-status",
  "etag",
  "age",
  "content-type",
  "location",
];

const present = (value) => typeof value === "string" && value.trim().length > 0;

export const extractNextStaticRefs = (html) => {
  const matches = String(html).match(/\/_next\/static\/[^"'\\\s>]+/g) ?? [];
  return [...new Set(matches.map((ref) => ref.replace(/\\+$/u, "")))];
};

export const hasDecimalUsdFormatter = (source) =>
  source.includes("Intl.NumberFormat") &&
  DECIMAL_USD_FRACTION_PATTERN.test(source) &&
  !TO_EXPONENTIAL_CALL_PATTERN.test(source);

export const missingDiagramMarkers = (source) =>
  DIAGRAM_MARKERS.filter((marker) => !source.includes(marker));

export const isHtmlNoStoreCacheControl = (value) => HTML_NO_STORE_PATTERN.test(value ?? "");

export const isHashedStaticImmutableCacheControl = (value) => {
  const header = value ?? "";
  return HASHED_STATIC_IMMUTABLE_PATTERN.test(header) && HASHED_STATIC_MAX_AGE_PATTERN.test(header);
};

export const isHtmlEdgeHitWithoutNoStore = ({ cacheControl, cfCacheStatus }) => {
  const status = (cfCacheStatus ?? "").toUpperCase();
  if (status !== "HIT" && status !== "EXPIRED" && status !== "STALE") {
    return false;
  }
  return !isHtmlNoStoreCacheControl(cacheControl);
};

export const activeVersionId = (statusJson) => {
  const versions = Array.isArray(statusJson?.versions) ? statusJson.versions : [];
  const primary =
    versions.find((version) => Number(version?.percentage) === 100) ?? versions[0] ?? {};
  return present(primary.version_id) ? primary.version_id : undefined;
};

export const pickHeader = (headers, name) => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
};

export const summarizeHeaders = (headers) => {
  /** @type {Record<string, string | undefined>} */
  const summary = {};
  for (const name of INTERESTING_HEADERS) {
    summary[name] = pickHeader(headers, name);
  }
  return summary;
};

export const evaluateCompareDeployProof = ({
  activeVersion,
  expectVersion,
  unauthenticatedHomeStatus,
  htmlCacheControl,
  htmlCfCacheStatus,
  hashedCacheControl,
  liveSource,
  localSource,
  liveChunkRefs,
  localChunkRefs,
  requireLive = false,
}) => {
  /** @type {string[]} */
  const failures = [];
  if (!present(activeVersion)) {
    failures.push("wrangler active Version ID missing");
  } else if (present(expectVersion) && activeVersion !== expectVersion) {
    failures.push(`active Version ID ${activeVersion} != expected ${expectVersion}`);
  }
  if (!isUnauthenticatedAccessStatus(unauthenticatedHomeStatus)) {
    failures.push(`unauth / expected 401/302, got ${unauthenticatedHomeStatus}`);
  }

  const source = liveSource || localSource || "";
  if (!present(source)) {
    failures.push(requireLive ? "live HTML/JS missing" : "local out/ HTML/JS missing");
  } else {
    const missing = missingDiagramMarkers(source);
    if (missing.length > 0) {
      failures.push(`diagram markers missing: ${missing.join(", ")}`);
    }
    if (!hasDecimalUsdFormatter(source)) {
      failures.push("fixed 8-decimal USD formatter (Intl.NumberFormat, no toExponential) missing");
    }
  }

  if (requireLive || present(liveSource)) {
    if (!isHtmlNoStoreCacheControl(htmlCacheControl)) {
      failures.push(`HTML Cache-Control expected no-store, got ${htmlCacheControl ?? "<none>"}`);
    }
    if (
      isHtmlEdgeHitWithoutNoStore({
        cacheControl: htmlCacheControl,
        cfCacheStatus: htmlCfCacheStatus,
      })
    ) {
      failures.push(`HTML still edge-cached (${htmlCfCacheStatus}) without no-store`);
    }
    if (present(hashedCacheControl) && !isHashedStaticImmutableCacheControl(hashedCacheControl)) {
      failures.push(
        `hashed /_next/static Cache-Control expected immutable max-age=31536000, got ${hashedCacheControl}`,
      );
    }
  }

  if (
    Array.isArray(liveChunkRefs) &&
    Array.isArray(localChunkRefs) &&
    liveChunkRefs.length > 0 &&
    localChunkRefs.length > 0
  ) {
    const missingLive = localChunkRefs.filter((ref) => !liveChunkRefs.includes(ref));
    if (missingLive.length > 0) {
      failures.push(`live index missing local chunk refs: ${missingLive.slice(0, 5).join(", ")}`);
    }
  }

  return { ok: failures.length === 0, failures };
};

const loadDotEnv = (root) => {
  const envPath = join(root, ".env");
  return existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};
};

const readDirFiles = (dir, suffix) => {
  if (!existsSync(dir)) {
    return [];
  }
  /** @type {string[]} */
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (!suffix || entry.name.endsWith(suffix)) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
};

const readLocalExport = (compareRoot) => {
  const indexPath = join(compareRoot, "out", "index.html");
  if (!existsSync(indexPath)) {
    return undefined;
  }
  const html = readFileSync(indexPath, "utf8");
  const jsFiles = readDirFiles(join(compareRoot, "out", "_next", "static"), ".js");
  const js = jsFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  return {
    html,
    source: `${html}\n${js}`,
    chunkRefs: extractNextStaticRefs(html),
  };
};

const wranglerJson = (compareRoot, args) => {
  const result = spawnSync("npx", ["wrangler", ...args, "--json"], {
    cwd: compareRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `wrangler ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").slice(0, 400)}`,
    );
  }
  const stdout = result.stdout.trim();
  const jsonStart =
    stdout.indexOf("{") >= 0 &&
    (stdout.indexOf("[") === -1 || stdout.indexOf("{") < stdout.indexOf("["))
      ? stdout.indexOf("{")
      : stdout.indexOf("[");
  return JSON.parse(stdout.slice(jsonStart >= 0 ? jsonStart : 0));
};

const fetchResponse = async (url, init = {}) => {
  const response = await fetch(url, { ...init, redirect: "manual" });
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [key, value] of response.headers.entries()) {
    headers[key] = value;
  }
  return {
    status: response.status,
    headers,
    body: init.method === "HEAD" ? "" : await response.text(),
  };
};

const parseArgs = (argv) => {
  const expectIndex = argv.indexOf("--expect-version");
  return {
    expectVersion: expectIndex >= 0 ? argv[expectIndex + 1] : undefined,
  };
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compareRoot = join(repositoryRoot, "apps", "azookey-compare");

const run = async () => {
  const { expectVersion } = parseArgs(process.argv.slice(2));
  const dotenv = loadDotEnv(repositoryRoot);
  const serviceToken = resolveAccessServiceToken({ env: process.env, dotenv });
  const statusJson = wranglerJson(compareRoot, ["deployments", "status"]);
  const activeVersion = activeVersionId(statusJson);
  const unauth = await fetchResponse(`${COMPARE_ORIGIN}/`, { method: "HEAD" });
  const local = readLocalExport(compareRoot);

  /** @type {string | undefined} */
  let liveHtml;
  /** @type {string | undefined} */
  let liveSource;
  /** @type {string[] | undefined} */
  let liveChunkRefs;
  /** @type {string | undefined} */
  let htmlCacheControl;
  /** @type {string | undefined} */
  let htmlCfCacheStatus;
  /** @type {string | undefined} */
  let hashedCacheControl;
  /** @type {Record<string, string | undefined> | undefined} */
  let liveHtmlHeaders;
  /** @type {Record<string, string | undefined> | undefined} */
  let liveHashedHeaders;
  let liveStatus;

  if (serviceToken) {
    const authHeaders = {
      ...accessServiceTokenHeaders(serviceToken),
      "User-Agent": BROWSER_LIKE_USER_AGENT,
    };
    const htmlResponse = await fetchResponse(`${COMPARE_ORIGIN}/`, { headers: authHeaders });
    liveStatus = htmlResponse.status;
    liveHtml = htmlResponse.body;
    liveHtmlHeaders = summarizeHeaders(htmlResponse.headers);
    htmlCacheControl = liveHtmlHeaders["cache-control"];
    htmlCfCacheStatus = liveHtmlHeaders["cf-cache-status"];
    liveChunkRefs = extractNextStaticRefs(liveHtml ?? "");
    const jsRefs = (liveChunkRefs ?? []).filter((ref) => ref.endsWith(".js"));
    const jsBodies = [];
    for (const ref of jsRefs) {
      const jsResponse = await fetchResponse(`${COMPARE_ORIGIN}${ref}`, { headers: authHeaders });
      if (!liveHashedHeaders) {
        liveHashedHeaders = summarizeHeaders(jsResponse.headers);
        hashedCacheControl = liveHashedHeaders["cache-control"];
      }
      jsBodies.push(jsResponse.body);
    }
    liveSource = `${liveHtml ?? ""}\n${jsBodies.join("\n")}`;
  }

  const proof = evaluateCompareDeployProof({
    activeVersion,
    expectVersion,
    unauthenticatedHomeStatus: unauth.status,
    htmlCacheControl,
    htmlCfCacheStatus,
    hashedCacheControl,
    liveSource,
    localSource: local?.source,
    liveChunkRefs,
    localChunkRefs: local?.chunkRefs,
    requireLive: Boolean(serviceToken),
  });

  console.log(
    JSON.stringify(
      {
        origin: COMPARE_ORIGIN,
        worker: COMPARE_WORKER_NAME,
        activeVersion,
        expectVersion: expectVersion ?? null,
        unauth: { status: unauth.status, headers: summarizeHeaders(unauth.headers) },
        live: serviceToken
          ? {
              status: liveStatus,
              htmlHeaders: liveHtmlHeaders,
              hashedHeaders: liveHashedHeaders,
              chunkRefs: liveChunkRefs,
              markersMissing: missingDiagramMarkers(liveSource ?? ""),
              decimalUsd: hasDecimalUsdFormatter(liveSource ?? ""),
            }
          : { skipped: "no Access ST in env/.env" },
        localOut: local
          ? {
              chunkRefs: local.chunkRefs,
              markersMissing: missingDiagramMarkers(local.source),
              decimalUsd: hasDecimalUsdFormatter(local.source),
            }
          : { skipped: "apps/azookey-compare/out missing" },
        ok: proof.ok,
        failures: proof.failures,
      },
      null,
      2,
    ),
  );

  if (!proof.ok) {
    process.exitCode = 1;
  }
};

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
