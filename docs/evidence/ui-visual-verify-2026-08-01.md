# UI visual verification — 2026-08-01

**Host:** macOS (Playwright Chromium, headless)  
**Run path:** `bun run dev` → Vite `http://127.0.0.1:1420/` (browser preview, no Tauri)  
**Scope:** Live view, preview stage, settings/model cards, debug panel, `?overlay=1` caption route  
**Not claimed:** Tauri window chrome, real mic/pipeline, native overlay compositor

## Screenshots (captured this run)

| File | Subject |
|------|---------|
| [`ui-live-full.png`](./ui-live-full.png) | Live workspace full page (1440×~1245) |
| [`ui-preview-stage.png`](./ui-preview-stage.png) | Caption preview stage crop |
| [`ui-caption-overlay.png`](./ui-caption-overlay.png) | Scaled overlay host inside stage |
| [`ui-preview-stage-long-caption.png`](./ui-preview-stage-long-caption.png) | Long JA/EN caption wrap stress |
| [`ui-live-narrow-1024.png`](./ui-live-narrow-1024.png) | Live layout at 1024px width |
| [`ui-settings-full.png`](./ui-settings-full.png) | Settings full page |
| [`ui-model-cards.png`](./ui-model-cards.png) | Model selection grid (post-fix) |
| [`ui-settings-models-viewport.png`](./ui-settings-models-viewport.png) | Settings models + install viewport |
| [`ui-debug-panel.png`](./ui-debug-panel.png) | Debug panel expanded (browser preview) |
| [`ui-settings-debug-full.png`](./ui-settings-debug-full.png) | Settings + debug full page (pre-fix pass) |
| [`ui-overlay-route.png`](./ui-overlay-route.png) | `?overlay=1` transparent route |
| [`ui-overlay-route-on-dark.png`](./ui-overlay-route-on-dark.png) | Overlay route on dark bg for readability |

Older prior evidence (`full.png`, `stage.png`, `preview-*-verify.png`) left in place for history.

## Visual checks

| Check | Result | Notes |
|-------|--------|-------|
| Live view layout (topbar, sidebar, preview, side panels) | **PASS** | No overlapping panels/controls at 1440 and 1024 |
| Preview stage / scaled overlay host | **PASS** | 1280×720 design scaled into stage (~58% at 1440); checkerboard + stage label OK |
| Caption overlay readability | **PASS** | JA white + EN cyan on dark; shadows present; long wrap stays in safe area |
| Cramped captions | **PASS** | Default and long stress captions have clear gap; no host clipping |
| Truncated text (controls) | **PASS** (after fix) | Model selects no longer cut “Recommended” mid-word |
| Low contrast labels | **PASS** (after fix) | Eyebrow / muted uppercase labels ~5.4:1 on `#f0f8ff` (was ~4.26) |
| Settings / model cards | **PASS** | 3-column grid readable; optional AzooKey path fields OK |
| Debug panel reachable (browser) | **PASS** | Collapsible details + Refresh; empty models/backend expected without Tauri |
| Hover motion remnants | **PASS** (after `d71d240`) | Interactive hover no longer uses `translateY` / scale / rotate; primary/secondary/text buttons are color/border/shadow only. Remaining `translateY(-50%)` is static meter-thumb centering, not hover motion |

## Defects found

1. **Model card select truncation (FIXED)**  
   Closed native `<select>` showed e.g. `Parapper ASR / Japanese · Recommende` mid-word cut at ~340px card width.

2. **Section eyebrow contrast slightly under AA (FIXED)**  
   `.eyebrow` / related uppercase labels used `--muted-2` (~4.26:1 on app bg). Cosmetic for non-body text; still improved.

3. **Primary button hover translate (FIXED in `d71d240`)**  
   Hover motion on controls was removed in `fix: remove hover motion and stabilize desktop shell layout`. No residual interactive `translateY(-1px)` on primary/secondary/text buttons.

4. **Browser-preview debug emptiness (expected)**  
   Environment/runtime/models show placeholders (`unknown`, `0/0 ready`). Not a layout bug.

## Fixes applied

| Change | Files |
|--------|--------|
| Shorter recommended marker in select (`★`); full string in `title`; “Recommended” hint under select | `apps/desktop/src/settings/ModelCard.tsx` |
| Model select min-width/ellipsis padding; recommended hint style | `apps/desktop/src/styles.css` |
| Eyebrow-family labels use `--muted` for contrast | `apps/desktop/src/styles.css` |

## Automation

| Gate | Result |
|------|--------|
| `bun run typecheck` | PASS |
| `bun --filter=@caption-bridge/desktop run test` | PASS (12 files / 53 tests) |

## Residual risks

- Headless Chromium ≠ Tauri WebView; glass/blur and OS font metrics may differ slightly.
- Full native overlay + mic path not exercised in this browser-only pass.
- Hover motion cleanup shipped in `d71d240` (CSS). This note supersedes the earlier residual claim about primary-button `translateY(-1px)`.
