# Screenshot UI verification

**Date:** 2026-08-01  
**Scope key:** `screenshot-ui-verification`  
**Host:** macOS · Playwright Chromium (headless)  
**App path:** Vite only — `http://127.0.0.1:1420/` (`bun --filter=@caption-bridge/desktop run dev`)  
**Not claimed:** Tauri window chrome, real mic/pipeline, native Syphon/OBS compositor  

Browser bridge fallback already exists in `apps/desktop/src/core/bridge.ts` when `window.__TAURI_INTERNALS__` is absent (no page blanking). No new mock was required.

## Screenshots (captured and viewed this run)

All under [`docs/evidence/screenshots/`](./screenshots/).

| File | Viewport | Subject |
|------|----------|---------|
| [`live-1280x800.png`](./screenshots/live-1280x800.png) | 1280×800 | Live workspace (top of content) |
| [`live-1920x1080.png`](./screenshots/live-1920x1080.png) | 1920×1080 | Live workspace |
| [`live-scrolled-1280x800.png`](./screenshots/live-scrolled-1280x800.png) | 1280×800 | Live after content scroll (latest caption + full pipeline) |
| [`live-scrolled-1920x1080.png`](./screenshots/live-scrolled-1920x1080.png) | 1920×1080 | Live after content scroll |
| [`overlay-preview-1280x800.png`](./screenshots/overlay-preview-1280x800.png) | crop | Live caption preview stage |
| [`overlay-preview-1920x1080.png`](./screenshots/overlay-preview-1920x1080.png) | crop | Live caption preview stage |
| [`settings-models-1280x800.png`](./screenshots/settings-models-1280x800.png) | 1280×800 | Settings top (language + models peek) |
| [`settings-models-1920x1080.png`](./screenshots/settings-models-1920x1080.png) | 1920×1080 | Settings language + model cards |
| [`settings-models-focus-1280x800.png`](./screenshots/settings-models-focus-1280x800.png) | 1280×800 | Model cards focused |
| [`settings-models-focus-1920x1080.png`](./screenshots/settings-models-focus-1920x1080.png) | 1920×1080 | Model cards focused |
| [`settings-debug-1280x800.png`](./screenshots/settings-debug-1280x800.png) | 1280×800 | Debug panel expanded |
| [`settings-debug-1920x1080.png`](./screenshots/settings-debug-1920x1080.png) | 1920×1080 | Debug panel expanded |
| [`settings-scroll-bleed-after-1280x800.png`](./screenshots/settings-scroll-bleed-after-1280x800.png) | 1280×800 | Deep settings scroll (chrome seal check) |
| [`settings-scroll-bleed-after-1920x1080.png`](./screenshots/settings-scroll-bleed-after-1920x1080.png) | 1920×1080 | Deep settings scroll |
| [`overlay-route-1280x800.png`](./screenshots/overlay-route-1280x800.png) | 1280×800 | `?overlay=1` (transparent bg) |
| [`overlay-route-1920x1080.png`](./screenshots/overlay-route-1920x1080.png) | 1920×1080 | `?overlay=1` |
| [`overlay-route-darkbg-1280x800.png`](./screenshots/overlay-route-darkbg-1280x800.png) | 1280×800 | Overlay on dark page bg (readability) |
| [`overlay-route-darkbg-1920x1080.png`](./screenshots/overlay-route-darkbg-1920x1080.png) | 1920×1080 | Overlay on dark page bg |

Helper evidence (pre-fix bleed proof, not primary deliverables):  
`settings-scroll-bleed-before.png`, `settings-debug-scroll-before.png`, `live-1280x800-fullpage.png`.

## Defects found (from images)

1. **Topbar content bleed (FIXED)**  
   Semi-transparent sticky topbar (`rgba(240,248,255,0.86)`) let scrolled settings/debug text show through (ghost URLs, “RUNTIME”, pipeline copy).

2. **Whole-document scroll moved sidebar away (FIXED)**  
   On long Settings pages, sidebar intro/nav scrolled off; only the privacy note remained at the bottom. Live privacy note and pipeline footers were clipped at 1280×800 by the window edge.

3. **Sticky content heading incomplete seal (FIXED / improved)**  
   Sticky “Settings” / “Live” heading used a translucent gradient and small negative margin, so panel text peeked above/around it while scrolling.

4. **Debug Environment card unreadable in browser (FIXED)**  
   Browser preview rendered `— · —/—` (missing native pkg/platform/arch). Looked like a broken string, not intentional empty state.

5. **AzooKey path placeholders mid-word cut (FIXED)**  
   Long placeholder `Example: /models/azookey-user-dictionary` truncated mid-word in narrow model cards.

6. **Overlay preview / `?overlay=1` captions (PASS, no defect)**  
   JA white + EN cyan captions render on checkerboard stage and on dark overlay route; readable shadows present.

## Fixes applied

| Change | Files |
|--------|--------|
| Viewport-locked shell: only `.content` scrolls; sidebar + topbar fixed | `apps/desktop/src/styles.css` |
| Opaque topbar + solid content-heading sticky seal (`#f0f8ff`) | `apps/desktop/src/styles.css` |
| `#root` / `html` / `body` height lock; overlay-document opts out | `apps/desktop/src/styles.css` |
| Browser debug env shows `browser` + frontend-only note | `apps/desktop/src/settings/DebugPanel.tsx`, `apps/desktop/src/i18n/messages.ts` |
| Shorter AzooKey path placeholder + `title` for full string | `apps/desktop/src/i18n/messages.ts`, `apps/desktop/src/settings/ModelCard.tsx` |

## Before → after (visual)

| Check | Before | After |
|-------|--------|-------|
| Topbar while scrolling Settings | Ghost text under brand / pills | Clean solid bar |
| Sidebar on long Settings | Intro/nav gone | Intro + Live/Settings + privacy stay put |
| Live 1280×800 pipeline | Hy-MT2 cut by window | Full 01–03 visible; content scrolls for latest caption |
| Debug Environment | `— · —/—` | `browser` + desktop-unavailable note |
| Model path placeholders | Mid-word cut | Shorter `…/azookey-dict` + title tooltip |
| Overlay route | Captions OK | Captions OK (unchanged, re-verified) |

## Residual / acceptable

- Mid-scroll, content still passes *under* the sticky Live/Settings heading (expected sticky behavior). Solid bar + shadow seal prevents topbar bleed; faint edge cases may remain during fast scroll.
- Browser preview debug still shows empty model install / unknown backend reachability — expected without Tauri.
- Interactive hover motion on primary/secondary/text buttons was removed in `d71d240` (`fix: remove hover motion and stabilize desktop shell layout`). No residual control hover `translateY(-1px)`.

## Automation gates

| Gate | Result |
|------|--------|
| `bun run typecheck` | **PASS** |
| `bun run lint` | **PASS** (2 pre-existing `noDescendingSpecificity` warnings on `.overlay-root`) |
| `bun --filter=@caption-bridge/desktop run build` | **PASS** |

## Verdict

**PASS** for screenshot-driven visual verification of Live, Settings (models + debug), overlay preview stage, and `?overlay=1` at 1280×800 and 1920×1080, after layout/chrome fixes confirmed by re-capture and image review.
