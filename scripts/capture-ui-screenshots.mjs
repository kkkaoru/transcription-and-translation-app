#!/usr/bin/env node
/**
 * Browser-only UI screenshot capture for Kotoba Beacon (Vite @ :1420).
 *
 * Prerequisites:
 *   bun run dev:web   (browser-only Vite preview; NOT the full Tauri app `bun run dev`)
 *   bun add -g playwright && playwright install chromium
 *
 * Usage:
 *   node scripts/capture-ui-screenshots.mjs
 *   node scripts/capture-ui-screenshots.mjs --exercise-recovery
 *   CB_BASE_URL=http://127.0.0.1:1420 CB_OUT_DIR=docs/evidence/screenshots/manual \
 *     node scripts/capture-ui-screenshots.mjs
 *
 * Does not exercise Tauri, mic capture, or native overlay compositor.
 * Captures fine-grained states: live, settings, model management, debug
 * (open / with sample content / log-level), plus hover states for motion checks.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadPlaywright() {
  const candidates = [
    () => require("playwright"),
    () => require(path.join(process.env.HOME || "", ".bun/install/global/node_modules/playwright")),
    () =>
      require(
        path.join(process.env.HOME || "", ".npm/_npx/e41f203b7505f1fb/node_modules/playwright"),
      ),
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
const exerciseRecovery =
  process.argv.includes("--exercise-recovery") || process.env.CB_EXERCISE_RECOVERY === "1";
const stamp =
  process.env.CB_STAMP ||
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19).replace("T", "-");
const OUT = path.resolve(repoRoot, process.env.CB_OUT_DIR || `docs/evidence/screenshots/${stamp}`);

const viewports = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {Array<Record<string, unknown>>} */
const hoverNotes = [];
/** @type {Array<{name: string, ok: boolean, detail?: string, synthetic?: boolean}>} */
const checks = [];

function recordCheck(name, ok, detail = "", options = {}) {
  const entry = {
    name,
    ok,
    ...(detail ? { detail } : {}),
    ...(options.synthetic ? { synthetic: true } : {}),
  };
  checks.push(entry);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function shot(page, name, options = {}) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: options.fullPage ?? false });
  console.log("wrote", path.relative(repoRoot, file));
  return file;
}

async function openLive(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".app-shell, #root", { timeout: 15000 });
  recordCheck(
    "live route rendered",
    (await page.locator(".live-grid").count()) > 0 &&
      (await page.locator(".preview-stage").count()) > 0,
    BASE,
  );
  const buildInfo = await page.evaluate(() => ({
    version: document.querySelector('[data-testid="build-version"]')?.textContent?.trim() || "",
    id: document.querySelector('[data-testid="build-id"]')?.textContent?.trim() || "",
  }));
  recordCheck(
    "main screen displays build version and unique build id",
    /^v\S+$/.test(buildInfo.version) && /^build\s+\S+$/.test(buildInfo.id),
    `${buildInfo.version} · ${buildInfo.id}`,
  );
  const pipelineText = (await page.locator(".pipeline-panel").textContent()) || "";
  recordCheck(
    "live pipeline displays the selected recognition mode",
    /Web Speech|Parapper ASR/i.test(pipelineText),
    pipelineText.replace(/\s+/g, " ").trim().slice(0, 180) || "pipeline panel is empty",
  );
  await sleep(350);
}

async function goSettings(page) {
  const buttons = page.locator(".nav-tabs button");
  if ((await buttons.count()) >= 2) {
    await buttons.nth(1).click();
    await sleep(450);
    const rendered = (await page.locator(".settings-section").count()) > 0;
    recordCheck("settings route rendered", rendered);
    return rendered;
  }
  recordCheck("settings route rendered", false, "Settings navigation button was not found");
  return false;
}

async function expandDebug(page) {
  const details = page.locator(".debug-panel details").first();
  if (!(await details.count())) {
    recordCheck("debug panel is present", false, "details element not found");
    return false;
  }
  const wasOpen = await details.evaluate((element) => element.open);
  if (!wasOpen) {
    await details.locator("summary").click();
  }
  const open = await details.evaluate((element) => element.open);
  recordCheck("debug panel opens through its real summary control", open);
  await sleep(200);
  const refresh = page
    .locator("button")
    .filter({ hasText: /^更新$|^Refresh$/i })
    .first();
  if (await refresh.count()) {
    try {
      await refresh.click({ timeout: 2000 });
      await sleep(600);
    } catch {
      // optional
    }
  }
  recordCheck(
    "debug panel exposes structured-log and pipeline sections",
    (await page.locator('[data-testid="debug-structured-logs"]').count()) > 0 &&
      (await page.locator('[data-testid="debug-pipeline-stages"]').count()) > 0,
  );
  return open;
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
      content.scrollTop +=
        details.getBoundingClientRect().top - content.getBoundingClientRect().top - 80;
    }
  });
  await sleep(250);
}

async function alignModelManagement(page) {
  await page.evaluate(() => {
    const content = document.querySelector(".content");
    const section = Array.from(
      document.querySelectorAll(".panel, .model-download-panel, section"),
    ).find((el) => /モデル管理|Model management|MODEL INSTALL/i.test(el.textContent || ""));
    if (content && section) {
      content.scrollTop +=
        section.getBoundingClientRect().top - content.getBoundingClientRect().top - 90;
    }
  });
  await sleep(250);
}

/**
 * Record computed transform/size before+after hover.
 * Motion is disallowed: transform must stay none/identity and box size must not change.
 * Scroll-into-view is done *before* the baseline measurement so auto-scroll is not
 * mistaken for hover lift.
 */
async function captureHover(page, selector, name, vpName) {
  const loc = page.locator(selector).first();
  if (!(await loc.count())) {
    hoverNotes.push({ name, vp: vpName, selector, skipped: true });
    return null;
  }
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
  } catch {
    // element may be covered by sticky chrome; still attempt hover
  }
  await sleep(120);
  const metrics = async () =>
    loc.evaluate(
      (el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          transform: s.transform,
          boxShadow: s.boxShadow,
          zIndex: s.zIndex,
          top: r.top,
          left: r.left,
          width: r.width,
          height: r.height,
        };
      },
      undefined,
      { timeout: 2_000 },
    );
  let before;
  try {
    before = await metrics();
  } catch (error) {
    hoverNotes.push({ name, vp: vpName, selector, skipped: true, error: String(error) });
    console.log(`hover ${name} (${vpName}): skipped because the node disappeared`);
    return null;
  }
  // Prefer real hover; fall back to force if sticky chrome intercepts.
  try {
    await loc.hover({ timeout: 1500 });
  } catch {
    try {
      await loc.hover({ force: true });
    } catch (error) {
      hoverNotes.push({ name, vp: vpName, selector, skipped: true, error: String(error) });
      console.log(`hover ${name} (${vpName}): skipped because hover was unavailable`);
      return null;
    }
  }
  await sleep(180);
  let after;
  try {
    after = await metrics();
  } catch (error) {
    hoverNotes.push({ name, vp: vpName, selector, skipped: true, error: String(error) });
    console.log(`hover ${name} (${vpName}): skipped because the node disappeared after hover`);
    return null;
  }
  const transformIdle =
    after.transform === "none" ||
    after.transform === "matrix(1, 0, 0, 1, 0, 0)" ||
    after.transform === before.transform;
  // Size must not grow/shrink on hover. Absolute top/left may still drift if a
  // parent reflows for unrelated reasons; only flag if transform or size changes.
  const sizeIdle =
    Math.abs(after.width - before.width) < 0.5 && Math.abs(after.height - before.height) < 0.5;
  const positionIdle =
    Math.abs(after.top - before.top) < 1 && Math.abs(after.left - before.left) < 1;
  const note = {
    name,
    vp: vpName,
    selector,
    before,
    after,
    transformIdle,
    sizeIdle,
    positionIdle,
    ok: transformIdle && sizeIdle,
  };
  hoverNotes.push(note);
  console.log(
    `hover ${name} (${vpName}): transform=${after.transform} ok=${note.ok} sizeIdle=${sizeIdle} positionIdle=${positionIdle}`,
  );
  await shot(page, `hover-${name}-${vpName}.png`);
  // Move pointer away so subsequent hovers start clean.
  await page.mouse.move(2, 2);
  await sleep(80);
  return note;
}

/** Inject sample structured-log / stage rows into the open debug panel for visual QA. */
async function injectDebugSampleContent(page) {
  await page.evaluate(() => {
    const section = document.querySelector('[data-testid="debug-structured-logs"]');
    if (!section) return;
    let list = section.querySelector(".debug-structured-log-list");
    if (!list) {
      const empty = section.querySelector(".download-empty");
      if (empty) empty.remove();
      list = document.createElement("ul");
      list.className = "debug-structured-log-list";
      list.setAttribute("data-testid", "debug-structured-log-list");
      section.append(list);
    }
    list.innerHTML = "";
    const samples = [
      {
        level: "error",
        source: "frontend/audio",
        stage: "asr",
        ms: "842ms",
        text: "Microphone permission denied while starting capture. Check system privacy settings and re-select the input device, then retry Start captioning.",
      },
      {
        level: "warn",
        source: "backend/gateway",
        stage: "normalize",
        ms: "41ms",
        text: "AzooKey converter returned an empty conversion for a long utterance that should wrap without ellipsis or clipping in the structured log feed.",
      },
      {
        level: "info",
        source: "frontend/pipeline",
        stage: "translate",
        ms: "118ms",
        text: "HY-MT2 produced a long English caption: This deliberately long translation sample verifies wrapping, contrast, and that stacked log rows do not overlap neighbours.",
      },
      {
        level: "debug",
        source: "frontend/diagnostics",
        stage: null,
        ms: null,
        text: "Verbose stage logging enabled; ring buffer capacity 400; export JSON/JSONL ready.",
      },
    ];
    for (const sample of samples) {
      const li = document.createElement("li");
      li.className = `debug-structured-log-row debug-log-${sample.level}`;
      li.setAttribute("data-testid", "debug-structured-log-row");
      li.setAttribute("data-log-level", sample.level);
      const main = document.createElement("div");
      main.className = "debug-structured-log-main";
      main.innerHTML = [
        `<span class="debug-event-kind">${sample.level}</span>`,
        `<span class="debug-log-source">${sample.source}</span>`,
        sample.stage ? `<span class="debug-stage-status">${sample.stage}</span>` : "",
        sample.ms ? `<span class="debug-stage-ms">${sample.ms}</span>` : "",
      ].join("");
      const code = document.createElement("code");
      code.className = "debug-path debug-stage-text";
      code.textContent = sample.text;
      li.append(main, code);
      list.append(li);
    }

    // Ensure pipeline stage cards show multi-line sample text when present.
    for (const card of document.querySelectorAll(".debug-stage-card")) {
      const text = card.querySelector(".debug-stage-text");
      if (text && !(text.textContent || "").trim()) {
        text.textContent =
          "Sample stage output that must fully wrap inside the card without mid-word ellipsis or overlapping the next card.";
      }
    }
  });
  await sleep(150);
}

async function verifyAzooKeyAndAudioSettings(page, vpName) {
  const azoo = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".model-card"));
    const normalizer = cards.find((card) => {
      const chip = card.querySelector(".model-chip")?.textContent?.trim().toLowerCase() || "";
      return chip === "azookey-rust" || /azookey/i.test(card.textContent || "");
    });
    return {
      found: Boolean(normalizer),
      chip: normalizer?.querySelector(".model-chip")?.textContent?.trim() || null,
      text: normalizer?.textContent?.replace(/\s+/g, " ").trim().slice(0, 600) || null,
      pathInputs: normalizer ? normalizer.querySelectorAll("input").length : 0,
      fieldLabels: normalizer
        ? Array.from(normalizer.querySelectorAll(".field > span")).map((el) =>
            el.textContent?.trim(),
          )
        : [],
    };
  });
  fs.writeFileSync(
    path.join(OUT, `azookey-settings-${vpName}.json`),
    JSON.stringify(azoo, null, 2),
  );
  recordCheck(
    "Settings displays the AzooKey normalizer",
    azoo.found && azoo.chip === "azookey-rust",
    `${azoo.chip || "missing"} · fields=${azoo.pathInputs}`,
  );
  recordCheck(
    "AzooKey dictionary and learning-memory fields are visible",
    azoo.pathInputs >= 2 &&
      azoo.fieldLabels.some((label) => /AzooKey.*(辞書|dictionary)/i.test(label || "")),
    azoo.fieldLabels.filter(Boolean).join(" | "),
  );

  const audio = await page.evaluate(() => {
    const section = Array.from(
      document.querySelectorAll(".settings-section:not(.debug-panel)"),
    ).find((element) => /無音ゲート|無音判定|Silence gate|VAD/i.test(element.textContent || ""));
    if (!section) return { found: false, labels: [], numbers: [], checkboxes: [] };
    return {
      found: true,
      labels: Array.from(section.querySelectorAll(".field > span"))
        .map((element) => element.textContent?.replace(/\s+/g, " ").trim())
        .filter(Boolean),
      numbers: Array.from(
        section.querySelectorAll('input[type="number"], input[type="range"]'),
      ).map((element) => ({
        value: Number(element.value),
        min: Number(element.min),
        max: Number(element.max),
        step: Number(element.step),
        label: element.getAttribute("aria-label") || "",
      })),
      checkboxes: Array.from(section.querySelectorAll('input[type="checkbox"]')).map((element) => ({
        checked: element.checked,
        label: element.parentElement?.textContent?.replace(/\s+/g, " ").trim() || "",
      })),
    };
  });
  fs.writeFileSync(path.join(OUT, `vad-settings-${vpName}.json`), JSON.stringify(audio, null, 2));
  const chunk = audio.numbers.find((entry) =>
    /音声区間|字幕チャンク|Caption chunk|audio\.chunk/i.test(entry.label),
  );
  const gate = audio.numbers.find((entry) => /無音判定|無音ゲート|Silence gate/i.test(entry.label));
  const vadInterval = audio.numbers.find((entry) => /VAD区間|VAD interval/i.test(entry.label));
  const vadThreshold = audio.numbers.find((entry) =>
    /VADしきい値|VAD threshold/i.test(entry.label),
  );
  recordCheck(
    "VAD/chunk settings are visible in Settings",
    audio.found && Boolean(chunk) && Boolean(gate) && Boolean(vadInterval) && Boolean(vadThreshold),
    `chunk=${chunk?.value ?? "missing"} gate=${gate?.value ?? "missing"} interval=${vadInterval?.value ?? "missing"} threshold=${vadThreshold?.value ?? "missing"}`,
  );
  recordCheck(
    "VAD settings expose noise-suppression state",
    audio.checkboxes.length >= 2,
    audio.checkboxes.map((entry) => `${entry.checked ? "on" : "off"}:${entry.label}`).join(" | "),
  );
  return { azoo, audio };
}

async function verifyDebugDisplay(page, vpName) {
  const state = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="debug-panel"]');
    const details = panel?.querySelector("details");
    return {
      present: Boolean(panel),
      open: details?.open === true,
      rows: panel?.querySelectorAll('[data-testid="debug-structured-log-row"]').length || 0,
      stageCards: panel?.querySelectorAll('[data-testid^="debug-stage-"]').length || 0,
      errorRows: panel?.querySelectorAll('[data-log-level="error"]').length || 0,
    };
  });
  fs.writeFileSync(path.join(OUT, `debug-state-${vpName}.json`), JSON.stringify(state, null, 2));
  recordCheck(
    "Debug panel displays pipeline and structured logs",
    state.present && state.open && state.rows > 0 && state.stageCards >= 3,
    `open=${state.open} rows=${state.rows} stages=${state.stageCards}`,
  );
  recordCheck(
    "Debug panel displays an error row without hiding recovery controls",
    state.errorRows > 0 && (await page.locator(".debug-panel .secondary-button").count()) > 0,
    `errorRows=${state.errorRows}`,
    { synthetic: true },
  );
  return state;
}

async function exerciseBrowserErrorRecovery() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "ja-JP",
  });
  // Browser-only capture cannot grant a real microphone. Inject a deterministic
  // NotAllowedError to exercise the same MainApp error/retry path while marking
  // the evidence synthetic (it is not a native TCC result).
  await context.addInitScript(() => {
    // Chromium exposes Web Speech by default, so the runtime-aware config would
    // otherwise select the Web Speech path and never call getUserMedia. Force
    // the native-style Parapper path for this probe; the setting is synthetic
    // and scoped to this temporary browser context only.
    localStorage.setItem(
      "caption-bridge.config.v1",
      JSON.stringify({ recognitionMode: "parapper-azookey" }),
    );
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = () => {
        throw new DOMException("synthetic microphone denial", "NotAllowedError");
      };
    }
  });
  const page = await context.newPage();
  try {
    await openLive(page);
    const start = page.locator(".content-heading .primary-button").first();
    await start.click();
    await page.waitForTimeout(800);
    const first = await page.evaluate(() => ({
      // Prefer the actionable alert over the persistent input-level status;
      // both are present on the live screen after a failed start.
      notice: document.querySelector('[role="alert"], [role="status"]')?.textContent?.trim() || "",
      button: document.querySelector(".content-heading .primary-button")?.textContent?.trim() || "",
      disabled: Boolean(document.querySelector(".content-heading .primary-button")?.disabled),
    }));
    await page.screenshot({ path: path.join(OUT, "live-error-recovery.png") });
    fs.writeFileSync(path.join(OUT, "error-recovery-state.json"), JSON.stringify(first, null, 2));
    recordCheck(
      "capture permission error is surfaced to the user",
      /permission|microphone|マイク|許可|音声/i.test(first.notice),
      first.notice || "no notice text",
      { synthetic: true },
    );
    recordCheck(
      "capture remains recoverable after an error",
      !first.disabled && /開始|Start/i.test(first.button),
      `button=${first.button} disabled=${first.disabled}`,
      { synthetic: true },
    );
    await start.click();
    await page.waitForTimeout(400);
    const second = await page.locator(".content-heading .primary-button").first().isEnabled();
    recordCheck("capture can be retried after the first failure", second, undefined, {
      synthetic: true,
    });
  } finally {
    await browser.close();
  }
}

function measureOverflow(page) {
  return page.evaluate(() => {
    const interesting = Array.from(
      document.querySelectorAll(
        ".model-card select, .model-card h3, .model-chip, .debug-log-level, .debug-structured-log-row, .nav-tabs button, .content-heading h2, .download-model-id, .debug-inline-meta",
      ),
    );
    return interesting.map((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        className: String(el.className || "").slice(0, 80),
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: el.scrollWidth > el.clientWidth + 1,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
        transform: style.transform,
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
  });
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

  // Hover motion checks on live controls
  await captureHover(page, ".primary-button", "live-primary", vp.name);
  await captureHover(page, ".secondary-button", "live-secondary", vp.name);
  await captureHover(page, ".nav-tabs button", "live-nav", vp.name);

  await goSettings(page);
  await shot(page, `settings-models-${vp.name}.png`);

  await page.evaluate(() => {
    const content = document.querySelector(".content");
    const card = document.querySelector(".model-card");
    if (content && card) {
      content.scrollTop +=
        card.getBoundingClientRect().top - content.getBoundingClientRect().top - 90;
    }
  });
  await sleep(200);
  await shot(page, `settings-models-focus-${vp.name}.png`);
  await verifyAzooKeyAndAudioSettings(page, vp.name);

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
  fs.writeFileSync(
    path.join(OUT, `model-selects-${vp.name}.json`),
    JSON.stringify(selects, null, 2),
  );

  await captureHover(page, ".model-card", "settings-model-card", vp.name);
  await captureHover(page, ".primary-button", "settings-primary", vp.name);
  await captureHover(page, ".secondary-button", "settings-secondary", vp.name);

  await alignModelManagement(page);
  await shot(page, `settings-model-management-${vp.name}.png`);

  await expandDebug(page);
  await alignDebug(page);
  await shot(page, `settings-debug-aligned-${vp.name}.png`);

  // Log-level control focused
  const logLevel = page.locator('[data-testid="debug-log-level"]');
  if (await logLevel.count()) {
    await logLevel.scrollIntoViewIfNeeded();
    await sleep(150);
    await logLevel.focus();
    await shot(page, `settings-debug-log-level-${vp.name}.png`);
    // Open the native select via keyboard to capture option list when possible.
    try {
      await logLevel.selectOption("debug");
      await sleep(150);
      await shot(page, `settings-debug-log-level-debug-${vp.name}.png`);
      await logLevel.selectOption("info");
    } catch {
      // selectOption may fail if control is disabled mid-save
    }
  }

  await injectDebugSampleContent(page);
  await verifyDebugDisplay(page, vp.name);
  // Align to structured log feed so sample rows are actually in frame.
  await page.evaluate(() => {
    const content = document.querySelector(".content");
    const logs = document.querySelector('[data-testid="debug-structured-logs"]');
    if (content && logs) {
      content.scrollTop +=
        logs.getBoundingClientRect().top - content.getBoundingClientRect().top - 70;
    }
  });
  await sleep(200);
  await shot(page, `settings-debug-with-logs-${vp.name}.png`);
  await captureHover(page, ".debug-structured-log-row", "debug-log-row", vp.name);
  await captureHover(page, ".debug-panel .secondary-button", "debug-secondary", vp.name);

  // Stage cards + chunk timing (Lane B panels) — scroll each into view.
  await page.evaluate(() => {
    const content = document.querySelector(".content");
    const stages = document.querySelector('[data-testid="debug-pipeline-stages"]');
    if (content && stages) {
      content.scrollTop +=
        stages.getBoundingClientRect().top - content.getBoundingClientRect().top - 70;
    }
  });
  await sleep(200);
  await shot(page, `settings-debug-stages-${vp.name}.png`);
  await captureHover(page, ".debug-stage-card", "debug-stage-card", vp.name);

  await page.evaluate(() => {
    const content = document.querySelector(".content");
    const timing = document.querySelector('[data-testid="debug-chunk-timing"]');
    if (content && timing) {
      content.scrollTop +=
        timing.getBoundingClientRect().top - content.getBoundingClientRect().top - 70;
    }
  });
  await sleep(200);
  await shot(page, `settings-debug-chunk-timing-${vp.name}.png`);

  const overflow = await measureOverflow(page);
  fs.writeFileSync(
    path.join(OUT, `overflow-audit-${vp.name}.json`),
    JSON.stringify(overflow, null, 2),
  );
  console.log(
    `overflow audit (${vp.name}):`,
    overflow.filter((row) => row.overflowX).length,
    "potential overflow nodes",
  );

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
    await goSettings(page);
    await shot(page, "settings-narrow-1024.png");
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
  console.error(`Dev server not reachable at ${BASE}. Start with: bun run dev:web`);
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

for (const vp of viewports) {
  console.log("===", vp.name, "===");
  await runViewport(vp);
}

if (exerciseRecovery) {
  console.log("=== browser error recovery probe (synthetic microphone denial) ===");
  await exerciseBrowserErrorRecovery();
}

const failedHovers = hoverNotes.filter((n) => n && n.ok === false);
const failedChecks = checks.filter((entry) => !entry.ok);
fs.writeFileSync(
  path.join(OUT, "capture-meta.json"),
  JSON.stringify(
    {
      base: BASE,
      out: OUT,
      stamp,
      capturedAt: new Date().toISOString(),
      hoverNotes,
      hoverFailures: failedHovers.length,
      checks,
      failedChecks: failedChecks.map((entry) => entry.name),
      exerciseRecovery,
      viewports,
    },
    null,
    2,
  ),
);
fs.writeFileSync(path.join(OUT, "hover-transforms.json"), JSON.stringify(hoverNotes, null, 2));

console.log("DONE");
console.log("hover failures:", failedHovers.length);
console.log("check failures:", failedChecks.length);
console.log(fs.readdirSync(OUT).sort().join("\n"));
if (failedHovers.length || failedChecks.length) {
  if (failedHovers.length) console.error("FAIL: hover motion detected on one or more controls");
  if (failedChecks.length) {
    console.error(`FAIL: ${failedChecks.length} UI verification check(s) failed`);
  }
  process.exitCode = 2;
}
