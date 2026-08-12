#!/usr/bin/env node
/**
 * Playwright UI regression for azookey-compare.
 *
 *   bun --filter=@caption-bridge/azookey-compare run test:e2e
 *   COMPARE_BASE_URL=http://127.0.0.1:3000 node apps/azookey-compare/e2e/compare-ui.mjs
 *
 * Production (Access ST from env/.env, never printed):
 *   COMPARE_BASE_URL=https://azookey-compare.kaoru.workers.dev node apps/azookey-compare/e2e/compare-ui.mjs
 *
 * Requires: bun add -g playwright && playwright install chromium
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "../../../scripts/setup-cursor-cloudflare-mcp.mjs";
import {
  accessServiceTokenHeaders,
  resolveAccessServiceToken,
} from "../../../scripts/verify-cloudflare-hosted.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const compareRoot = path.resolve(here, "..");

const loadPlaywright = () => {
  const candidates = [
    () => require("playwright"),
    () => require(path.join(homedir(), ".bun/install/global/node_modules/playwright")),
    () => require(path.join(compareRoot, "node_modules/playwright")),
    () => require(path.join(repoRoot, "node_modules/playwright")),
  ];
  for (const load of candidates) {
    try {
      const mod = load();
      if (mod?.chromium) {
        return mod;
      }
    } catch {
      // try next resolver
    }
  }
  throw new Error(
    "playwright not found. Install with: bun add -g playwright && playwright install chromium",
  );
};

const { chromium } = loadPlaywright();

const DEFAULT_LOCAL = "http://127.0.0.1:3000";
const PRODUCTION = "https://azookey-compare.kaoru.workers.dev";
const BASE = (process.env.COMPARE_BASE_URL || DEFAULT_LOCAL).replace(/\/$/, "");
const EVIDENCE_DIR =
  process.env.COMPARE_E2E_EVIDENCE_DIR || path.join(repoRoot, "docs/evidence/azookey-compare-e2e");
const PREPARING_JA = "準備しています";
const MIC_DENIED_JA = "マイク許可が必要です";
const CHROMIUM_ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];

const loadDotEnv = () => {
  const envPath = path.join(repoRoot, ".env");
  return existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};
};

const accessHeaders = () => {
  const token = resolveAccessServiceToken({ env: process.env, dotenv: loadDotEnv() });
  return token ? accessServiceTokenHeaders(token) : {};
};

const isProductionHost = (url) => {
  try {
    return new URL(url).hostname === new URL(PRODUCTION).hostname;
  } catch {
    return false;
  }
};

const extraHeaders = () => (isProductionHost(BASE) ? accessHeaders() : {});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @type {Array<{ name: string, ok: boolean, detail: string }>} */
const results = [];

const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const screenshot = async (page, name) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
};

const DEFAULT_FOOTER_JA = "結果はブラウザ内だけに表示されます";

const footerText = async (page) =>
  (
    (await page
      .locator("footer.status-footer")
      .innerText()
      .catch(() => "")) || ""
  )
    .replace(/\n?\d+\s*\/\s*\d+\s*events(?:\s*·\s*\d+\s*omitted)?\s*$/i, "")
    .trim();

const speechPill = async (page) =>
  (
    (await page
      .locator('[data-testid="speech-lane"] .state-pill')
      .innerText()
      .catch(() => "")) || ""
  ).trim();

const startButtonLabel = async (page) =>
  ((await page.locator('[data-testid="speech-lane"] button.button-primary').innerText()) || "")
    .replace(/\s+/g, " ")
    .trim();

const phoneticOpen = async (page) =>
  page.locator('[data-testid="phonetic-input-disclosure"]').evaluate((node) => node.open);

const readingVisible = async (page) => page.locator("#manual-reading").isVisible();

const openConfigIfNeeded = async (page) => {
  const select = page.locator('[data-testid="recognition-mode-select"]');
  if (await select.isVisible()) {
    return;
  }
  const toggle = page.locator('[data-testid="config-panel-toggle"]');
  if (await toggle.isVisible()) {
    await toggle.click();
  }
  await select.waitFor({ state: "visible", timeout: 5_000 });
};

const runPhoneticMobile = async (browser) => {
  const name = "phonetic:390x844 default closed, summary opens";
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: extraHeaders(),
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForSelector('[data-testid="phonetic-input-panel"]');
    await sleep(300);
    const closedOpen = await phoneticOpen(page);
    const closedVisible = await readingVisible(page);
    await screenshot(page, "phonetic-390-closed");
    if (closedOpen || closedVisible) {
      record(
        name,
        false,
        `expected closed; open=${closedOpen} readingVisible=${closedVisible} status=${response?.status()}`,
      );
      return;
    }
    await page.locator('[data-testid="phonetic-input-toggle"]').click();
    await page.locator("#manual-reading").waitFor({ state: "visible", timeout: 5_000 });
    const opened = await phoneticOpen(page);
    await screenshot(page, "phonetic-390-open");
    record(
      name,
      opened === true,
      `after summary click open=${opened} cache-control=${response?.headers()["cache-control"] ?? ""}`,
    );
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  } finally {
    await context.close();
  }
};

const runPhoneticDesktop = async (browser) => {
  const name = "phonetic:1280x800 always open";
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: extraHeaders(),
  });
  const page = await context.newPage();
  try {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForSelector('[data-testid="phonetic-input-panel"]');
    await sleep(400);
    const opened = await phoneticOpen(page);
    const visible = await readingVisible(page);
    const summaryVisible = await page.locator('[data-testid="phonetic-input-toggle"]').isVisible();
    await screenshot(page, "phonetic-1280-open");
    record(
      name,
      opened === true && visible === true && summaryVisible === false,
      `open=${opened} readingVisible=${visible} summaryVisible=${summaryVisible}`,
    );
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  } finally {
    await context.close();
  }
};

const waitAfterAsrStart = async (page) => {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const footer = await footerText(page);
    const pill = await speechPill(page);
    const button = await startButtonLabel(page);
    if (footer.includes(PREPARING_JA)) {
      return { footer, pill, button, kind: "preparing" };
    }
    if (footer.includes(MIC_DENIED_JA)) {
      return { footer, pill, button, kind: "mic-denied" };
    }
    if (button.includes("認識を停止") || pill === "認識中" || pill === "起動中") {
      return { footer, pill, button, kind: "started" };
    }
    if (pill === "エラー" && footer && footer !== DEFAULT_FOOTER_JA) {
      return { footer, pill, button, kind: "other-error" };
    }
    await sleep(200);
  }
  return {
    footer: await footerText(page),
    pill: await speechPill(page),
    button: await startButtonLabel(page),
    kind: "timeout",
  };
};

const installGrantedMicrophone = async (page) => {
  await page.addInitScript(() => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (typeof Ctx !== "function") {
      return;
    }
    const getUserMedia = async () => {
      const ctx = new Ctx();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      osc.frequency.value = 220;
      osc.connect(dest);
      osc.start();
      if (typeof ctx.resume === "function" && ctx.state === "suspended") {
        await ctx.resume();
      }
      return dest.stream;
    };
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia },
      });
      return;
    }
    navigator.mediaDevices.getUserMedia = getUserMedia;
  });
};

const runAsrGranted = async (browser) => {
  const name = "asr: select Workers AI then 認識を開始 with mocked mic";
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: extraHeaders(),
    permissions: ["microphone"],
  });
  await context.grantPermissions(["microphone"], { origin: BASE });
  const page = await context.newPage();
  const pageerrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => {
    pageerrors.push(error.message);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  try {
    await installGrantedMicrophone(page);
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForSelector('[data-testid="speech-lane"]');
    await openConfigIfNeeded(page);
    await page.locator('[data-testid="recognition-mode-select"]').selectOption("workers-ai-asr");
    const start = page.getByRole("button", { name: "認識を開始" });
    await start.waitFor({ state: "visible", timeout: 5_000 });
    await start.click();
    const after = await waitAfterAsrStart(page);
    await screenshot(page, "asr-granted");
    const oldBug = after.kind === "preparing" || after.footer.includes(PREPARING_JA);
    const overlayCrash = pageerrors.length > 0;
    const ok = after.kind === "started" && !oldBug && !overlayCrash;
    record(
      name,
      ok,
      `kind=${after.kind} pill=${after.pill} button=${after.button} footer=${after.footer.slice(0, 120)} pageerrors=${pageerrors.length}${
        consoleErrors.length ? ` console=${consoleErrors.slice(0, 3).join(" | ")}` : ""
      }`,
    );
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  } finally {
    await context.close();
  }
};

const runAsrDenied = async (browser) => {
  const name = "asr: mic deny shows マイク許可 error, not 準備しています";
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: extraHeaders(),
    permissions: [],
  });
  const page = await context.newPage();
  const pageerrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => {
    pageerrors.push(error.message);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  await page.addInitScript(() => {
    const deny = () => {
      const error = new Error("Permission denied");
      error.name = "NotAllowedError";
      return Promise.reject(error);
    };
    const defineFakeDevices = () => {
      if (!navigator.mediaDevices) {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: deny },
        });
        return;
      }
      navigator.mediaDevices.getUserMedia = deny;
    };
    defineFakeDevices();
  });
  try {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForSelector('[data-testid="speech-lane"]');
    await openConfigIfNeeded(page);
    await page.locator('[data-testid="recognition-mode-select"]').selectOption("workers-ai-asr");
    const start = page.getByRole("button", { name: "認識を開始" });
    await start.click();
    const after = await waitAfterAsrStart(page);
    await screenshot(page, "asr-denied");
    const preparing = after.footer.includes(PREPARING_JA);
    const denied = after.kind === "mic-denied" || after.footer.includes(MIC_DENIED_JA);
    const operable = after.button.includes("認識を開始");
    const overlay = pageerrors.length > 0;
    const logged = consoleErrors.some((text) => text.includes(MIC_DENIED_JA));
    record(
      name,
      denied && !preparing && after.pill === "エラー" && operable && !overlay && logged,
      `kind=${after.kind} pill=${after.pill} footer=${after.footer.slice(0, 160)} pageerrors=${pageerrors.length} console=${logged}`,
    );
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  } finally {
    await context.close();
  }
};

const runCacheControl = async (browser) => {
  const name = "html Cache-Control contains no-store";
  if (!isProductionHost(BASE)) {
    record(name, true, `skipped on local ${BASE}`);
    return;
  }
  const context = await browser.newContext({ extraHTTPHeaders: extraHeaders() });
  const page = await context.newPage();
  try {
    const response = await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const cacheControl = response?.headers()["cache-control"] ?? "";
    record(
      name,
      /\bno-store\b/i.test(cacheControl) && response?.ok() === true,
      `status=${response?.status()} cache-control=${cacheControl}`,
    );
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  } finally {
    await context.close();
  }
};

const main = async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const headers = extraHeaders();
  if (isProductionHost(BASE) && Object.keys(headers).length === 0) {
    throw new Error("production URL needs CF_ACCESS_CLIENT_ID/SECRET in env/.env");
  }
  console.log(`base=${BASE}`);
  console.log(`evidence=${EVIDENCE_DIR}`);
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  try {
    await runCacheControl(browser);
    await runPhoneticMobile(browser);
    await runPhoneticDesktop(browser);
    await runAsrGranted(browser);
    await runAsrDenied(browser);
  } finally {
    await browser.close();
  }
  const failed = results.filter((row) => !row.ok);
  console.log(
    JSON.stringify(
      {
        base: BASE,
        evidence: EVIDENCE_DIR,
        ok: failed.length === 0,
        passed: results.filter((row) => row.ok).map((row) => row.name),
        failed: failed.map((row) => ({ name: row.name, detail: row.detail })),
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
