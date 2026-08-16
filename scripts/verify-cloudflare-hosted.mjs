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
export const COMPARE_ASR_PATH = "/v1/asr/workers-ai/transcriptions";
export const COMPARE_WS_SMOKE_INPUT = "きょうはいいてんき";
export const BROWSER_LIKE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const present = (value) => typeof value === "string" && value.trim().length > 0;

export const isRecordedElapsedMs = (value) => typeof value === "number" && Number.isFinite(value);

export const isAcceptableElapsedMs = (value) => isRecordedElapsedMs(value) && value >= 1;

export const recordedElapsedMs = (conversion) => {
  if (!conversion || typeof conversion !== "object") {
    return undefined;
  }
  if (isRecordedElapsedMs(conversion.elapsedMs)) {
    return conversion.elapsedMs;
  }
  if (isRecordedElapsedMs(conversion.elapsed_ms)) {
    return conversion.elapsed_ms;
  }
  return undefined;
};

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
  websocketConversion,
  requireAuthenticatedHealth = true,
  requireWebsocketConversion = requireAuthenticatedHealth,
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
  if (requireWebsocketConversion) {
    if (!websocketConversion || websocketConversion === "skipped") {
      failures.push("auth WS conversion skipped");
    } else if (!websocketConversion.ok) {
      failures.push(`auth WS conversion failed (${websocketConversion.stage ?? "unknown"})`);
    } else if (!present(websocketConversion.convertedText)) {
      failures.push("auth WS conversion missing convertedText");
    } else if (!isRecordedElapsedMs(recordedElapsedMs(websocketConversion))) {
      failures.push("auth WS conversion missing elapsedMs/elapsed_ms");
    } else if (!isAcceptableElapsedMs(recordedElapsedMs(websocketConversion))) {
      failures.push("auth WS conversion elapsedMs/elapsed_ms must be >= 1");
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    websocket: websocket ?? "skipped",
    websocketConversion: websocketConversion ?? "skipped",
  };
};

export const summarizeWebsocketConversion = (conversion) => {
  if (!conversion || conversion === "skipped") {
    return "skipped";
  }
  if (!conversion.ok) {
    return {
      ok: false,
      stage: conversion.stage,
      code: conversion.code,
      message: present(conversion.message) ? String(conversion.message).slice(0, 160) : undefined,
    };
  }
  return {
    ok: true,
    input: conversion.input,
    convertedText: conversion.convertedText,
    elapsedMs: recordedElapsedMs(conversion),
    model: conversion.model,
  };
};

export const GREETING_SPEECH_WAV_RELATIVE_PATH =
  "apps/desktop/src/overlay/fixtures/greeting-kikoemasu.wav";

export const buildWorkersAiAsrSmokeWav = () => {
  const sampleRate = 16_000;
  const sampleCount = Math.floor(sampleRate * 0.25);
  const pcm = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / sampleRate;
    pcm[index] = Math.round(Math.sin(2 * Math.PI * 440 * t) * 12_000);
  }
  const pcmBytes = new Uint8Array(pcm.buffer);
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + pcmBytes.length, true);
  header.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  header.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, pcmBytes.length, true);
  const wav = new Uint8Array(header.length + pcmBytes.length);
  wav.set(header, 0);
  wav.set(pcmBytes, header.length);
  return wav;
};

export const loadGreetingSpeechWav = (root = repositoryRoot) => {
  const wavPath = resolve(root, GREETING_SPEECH_WAV_RELATIVE_PATH);
  if (!existsSync(wavPath)) {
    throw new Error(`greeting speech WAV missing: ${wavPath}`);
  }
  return readFileSync(wavPath);
};

export const smokeWorkersAiAsr = async ({ origin, headers, wavBytes, fileName }) => {
  const form = new FormData();
  const bytes = wavBytes ?? loadGreetingSpeechWav();
  form.set("file", new File([bytes], fileName ?? "greeting-kikoemasu.wav", { type: "audio/wav" }));
  form.set("language", "ja");
  const response = await fetch(`${origin}${COMPARE_ASR_PATH}`, {
    method: "POST",
    headers: {
      ...headers,
      "User-Agent": BROWSER_LIKE_USER_AGENT,
    },
    body: form,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, stage: "bad_json", status: response.status };
  }
  if (response.status === 503 && payload?.error?.code === "asr_workers_ai_unavailable") {
    return {
      ok: "skipped",
      stage: "unavailable",
      status: response.status,
      code: payload.error.code,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      stage: "http_error",
      status: response.status,
      code: payload?.error?.code,
      message: present(payload?.error?.message)
        ? String(payload.error.message).slice(0, 160)
        : undefined,
    };
  }
  if (typeof payload?.text !== "string") {
    return { ok: false, stage: "invalid_payload", status: response.status };
  }
  if (wavBytes === undefined && payload.text.trim().length === 0) {
    return {
      ok: false,
      stage: "empty_speech_transcript",
      status: response.status,
      model: payload.model,
    };
  }
  return {
    ok: true,
    status: response.status,
    text: payload.text,
    transport: payload.transport,
    model: payload.model,
    empty: payload.text.trim().length === 0,
  };
};

export const smokeWorkerVibratoConversion = ({
  origin,
  headers,
  input = COMPARE_WS_SMOKE_INPUT,
  timeoutMs = 20_000,
}) =>
  new Promise((resolve) => {
    if (typeof WebSocket === "undefined") {
      resolve({ ok: false, stage: "unsupported" });
      return;
    }
    /** @type {WebSocket} */
    let socket;
    try {
      socket = new WebSocket(`${origin.replace(/^http/u, "ws")}${COMPARE_WS_PATH}`, {
        headers: {
          ...headers,
          "User-Agent": BROWSER_LIKE_USER_AGENT,
        },
        protocols: ["azookey.text.v1"],
      });
    } catch (error) {
      resolve({
        ok: false,
        stage: "construct",
        message: error instanceof Error ? error.message : "websocket construct failed",
      });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(result);
    };
    const requestId = "st-ws-smoke-1";
    const timer = setTimeout(() => {
      finish({ ok: false, stage: "timeout", input });
    }, timeoutMs);
    socket.addEventListener("error", (event) => {
      finish({
        ok: false,
        stage: "error",
        input,
        message: String(event?.message ?? event?.error ?? "ws_error").slice(0, 160),
      });
    });
    socket.addEventListener("close", (event) => {
      finish({
        ok: false,
        stage: "close",
        input,
        code: event.code,
        message: String(event.reason || "").slice(0, 80),
      });
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        finish({ ok: false, stage: "bad_json", input });
        return;
      }
      if (message.type === "azookey.ready") {
        socket.send(
          JSON.stringify({
            type: "azookey.convert",
            requestId,
            source: "web-speech",
            language: "ja",
            sourceText: input,
            vibratoInput: input,
            mode: "worker-vibrato",
          }),
        );
        return;
      }
      if (message.type === "azookey.result" && message.requestId === requestId) {
        finish({
          ok: true,
          stage: "result",
          input,
          convertedText: message.convertedText,
          elapsedMs: message.elapsedMs ?? message.elapsed_ms,
          model: message.model,
        });
        return;
      }
      if (message.type === "azookey.error") {
        finish({
          ok: false,
          stage: "azookey_error",
          input,
          code: message.error?.code,
          message: String(message.error?.message ?? "").slice(0, 160),
        });
      }
    });
  });

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
  let websocketConversion;
  let workersAiAsr;
  if (!serviceToken) {
    console.warn(
      "Access Service Token missing in env/.env. Skipping authenticated compare checks (no OTP wait).",
    );
  } else {
    const headers = {
      ...accessServiceTokenHeaders(serviceToken),
      "User-Agent": BROWSER_LIKE_USER_AGENT,
    };
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
    try {
      websocketConversion = await smokeWorkerVibratoConversion({
        origin: COMPARE_ORIGIN,
        headers,
      });
    } catch (error) {
      websocketConversion = {
        ok: false,
        stage: "exception",
        message: error instanceof Error ? error.message : "unknown error",
      };
    }
    try {
      workersAiAsr = await smokeWorkersAiAsr({ origin: COMPARE_ORIGIN, headers });
    } catch (error) {
      workersAiAsr = {
        ok: false,
        stage: "exception",
        message: error instanceof Error ? error.message : "unknown error",
      };
    }
  }

  const summary = evaluateHostedChecks({
    unauthenticatedHome: unauthHome.status,
    unauthenticatedHealth: unauthHealth.status,
    authenticatedHealth: authenticatedHealth?.status,
    inferenceDirect: inferenceDirect.status,
    websocket: websocketStatus,
    websocketConversion,
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
        websocketConversion: summarizeWebsocketConversion(websocketConversion),
        workersAiAsr: workersAiAsr ?? "skipped",
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
      process.exit(code);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
