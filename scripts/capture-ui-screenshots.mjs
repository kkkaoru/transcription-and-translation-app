#!/usr/bin/env node
/**
 * Browser-only UI screenshot capture for Kotoba Beacon (Vite @ :1420).
 *
 * Prerequisites:
 *   bun run dev
 *   bun add -g playwright && playwright install chromium
 *
 * Usage:
 *   node scripts/capture-ui-screenshots.mjs
 *   CB_BASE_URL=http://127.0.0.1:1420 CB_OUT_DIR=docs/evidence/screenshots/manual \
 *     node scripts/capture-ui-screenshots.mjs
 *
 * Does not exercise Tauri, mic capture, or native overlay compositor.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadPlaywright() {
  const candidates = [
    () => require("playwright"),
    () => require(path.join(process.env.HOME || "", ".bun/install/global/node_modules/playwright")),
    () => require(path.join(process.env.HOME || "", ".npm/_npx/e41f203b7505f1fb/node_modules/playwright")),
  ];
  for (const load of candidates) {
    try {
      const mod = load();
      if (mod?.chromium) return mod;
    } catch {
      // try next
    }
  }
  throw new Error(
    "playwright not found. Install with: bun add -g playwright && playwright install chromium",
  );
}

const { chromium } = loadPlaywright();

const BASE = process.env.CB_BASE_URL || "http://127.0.0.1:1420";
const stamp =
  process.env.CB_STAMP ||
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19).replace("T", "-");
const OUT = path.resolve(
  repoRoot,
  process.env.CB_OUT_DIR || `docs/evidence/screenshots/${stamp}`,
);

const viewports = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name, options = {}) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: options.fullPage ?? false });
  console.log("wrote", path.relative(repoRoot, file));
  return file;
}

async function openLive(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".app-shell, #root", { timeout: 15000 });
  await sleep(350);
}

async function goSettings(page) {
  const buttons = page.locator(".nav-tabs button");
  if ((await buttons.count()) >= 2) {
    await buttons.nth(1).click();
    await sleep(450);
  }
}

async function goLive(page) {
  const buttons = page.locator(".nav-tabs button");
  if ((await buttons.count()) >= 1) {
    await buttons.nth(0).click();
    await sleep(350);
  }
}

async function expandDebug(page) {
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("details")) {
      const text = d.textContent || "";
      if (/デバッグ|Debug|DEVELOPER TOOLS/i.test(text)) {
        d.open = true;
      }
    }
  });
  await sleep(200);
  const refresh = page.locator("button").filter({ hasText: /^更新$|^Refresh$/i }).first();
  if (await refresh.count()) {
    try {
      await refresh.click({ timeout: 2000 });
      await sleep(600);
    } catch {
      // optional
    }
  }
}

async function scrollContent(page, y) {
  await page.evaluate((yy) => {
    const el = document.querySelector(".content");
    if (el) el.scrollTop = yy;
  }, y);
  await sleep(200);
}

async function alignDebug(page) {
  await page.evaluate(() => {
    const content = document.querySelector(".content");
    const details = Array.from(document.querySelectorAll("details")).find((d) =>
      /デバッグ|Debug|DEVELOPER TOOLS/i.test(d.textContent || ""),
    );
    if (content && details) {
      content.scrollTop += details.getBoundingClientRect().top - content.getBoundingClientRect().top - 80;
    }
  });
  await sleep(250);
}

async function runViewport(vp) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    locale: "ja-JP",
  });
  const page = await context.newPage();

  await openLive(page);
  await shot(page, `live-${vp.name}.png`);
  await shot(page, `live-${vp.name}-fullpage.png`, { fullPage: true });

  const stage = page.locator(".preview-stage").first();
  if (await stage.count()) {
    await stage.screenshot({ path: path.join(OUT, `overlay-preview-${vp.name}.png`) });
    console.log("wrote", `overlay-preview-${vp.name}.png`);
  }

  await page.evaluate(() => {
    const src = document.querySelector(".caption-line-source");
    const tr = document.querySelector(".caption-line-translation");
    if (src) {
      src.textContent =
        "これは非常に長いプレビュー用の日本語字幕です。画面端での折り返しとセーフエリアを確認するために、意図的に長い文章を表示しています。認識結果が長くなっても重ならないことを確認します。";
    }
    if (tr) {
      tr.textContent =
        "This is a deliberately long English preview caption used to stress-test wrapping, safe-area margins, and vertical spacing between source and translation lines under constrained preview width.";
    }
  });
  await sleep(150);
  if (await stage.count()) {
    await stage.screenshot({
      path: path.join(OUT, `overlay-preview-long-caption-${vp.name}.png`),
    });
    console.log("wrote", `overlay-preview-long-caption-${vp.name}.png`);
  }

  await scrollContent(page, 1200);
  await shot(page, `live-scrolled-${vp.name}.png`);
  await scrollContent(page, 280);
  await shot(page, `live-midscroll-${vp.name}.png`);
  await scrollContent(page, 0);

  const primary = page.locator(".primary-button").first();
  if (await primary.count()) {
    await primary.hover();
    await sleep(150);
    const transform = await primary.evaluate((el) => getComputedStyle(el).transform);
    console.log(`primary hover transform (${vp.name}):`, transform);
    await shot(page, `live-hover-primary-${vp.name}.png`);
  }

  await goSettings(page);
  await shot(page, `settings-models-${vp.name}.png`);

  await page.evaluate(() => {
    const content = document.querySelector(".content");
    const card = document.querySelector(".model-card");
    if (content && card) {
      content.scrollTop += card.getBoundingClientRect().top - content.getBoundingClientRect().top - 90;
    }
  });
  await sleep(200);
  await shot(page, `settings-models-focus-${vp.name}.png`);

  const selects = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".model-card select")).map((el) => ({
      text: el.options[el.selectedIndex]?.text ?? "",
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflow: el.scrollWidth > el.clientWidth + 1,
      title: el.getAttribute("title"),
    })),
  );
  console.log(`model selects (${vp.name}):`, JSON.stringify(selects));

  await expandDebug(page);
  await alignDebug(page);
  await shot(page, `settings-debug-aligned-${vp.name}.png`);

  await scrollContent(page, 5000);
  await shot(page, `settings-scroll-bleed-${vp.name}.png`);
  await scrollContent(page, 0);
  await shot(page, `settings-fullpage-${vp.name}.png`, { fullPage: true });

  await page.goto(`${BASE}/?overlay=1`, { waitUntil: "networkidle" });
  await sleep(400);
  await shot(page, `overlay-route-${vp.name}.png`);
  await page.evaluate(() => {
    document.documentElement.style.background = "#111";
    document.body.style.background = "#111";
  });
  await sleep(150);
  await shot(page, `overlay-route-darkbg-${vp.name}.png`);

  if (vp.name === "1280x800") {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openLive(page);
    await shot(page, "live-narrow-1024.png");
  }

  await browser.close();
}

fs.mkdirSync(OUT, { recursive: true });
console.log("OUT", OUT);
console.log("BASE", BASE);

// Probe server
try {
  const res = await fetch(BASE);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (error) {
  console.error(`Dev server not reachable at ${BASE}. Start with: bun run dev`);
  console.error(String(error));
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "ja-JP" });
await openLive(page);
const inventory = await page.evaluate(() => ({
  title: document.title,
  nav: Array.from(document.querySelectorAll(".nav-tabs button")).map((el) =>
    (el.textContent || "").replace(/\s+/g, " ").trim(),
  ),
  headings: Array.from(document.querySelectorAll("h1,h2,h3"))
    .slice(0, 12)
    .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()),
}));
fs.writeFileSync(path.join(OUT, "dom-inventory.json"), JSON.stringify(inventory, null, 2));
await shot(page, "ui-live-full.png", { fullPage: true });
await browser.close();

const hoverNotes = [];
for (const vp of viewports) {
  console.log("===", vp.name, "===");
  await runViewport(vp);
}

fs.writeFileSync(
  path.join(OUT, "capture-meta.json"),
  JSON.stringify(
    {
      base: BASE,
      out: OUT,
      stamp,
      capturedAt: new Date().toISOString(),
      hoverNotes,
      viewports,
    },
    null,
    2,
  ),
);

console.log("DONE");
console.log(fs.readdirSync(OUT).sort().join("\n"));
