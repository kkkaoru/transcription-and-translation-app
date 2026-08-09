//! OBS Browser Source fallback: a caption-only loopback HTTP page.
//!
//! The native Syphon/Spout2 lanes are platform-specific, so every platform
//! keeps a loopback fallback for when the native output path is unavailable.
//! When `overlay.browserSource.enabled` is set, this module serves a
//! caption-only page plus a JSON caption feed on `http://127.0.0.1:{port}/`
//! that OBS captures with a regular Browser Source. The transparent Tauri
//! window path is never touched: this output is purely additive, binds
//! loopback only, and any bind failure degrades to a logged warning instead of
//! failing app startup.

use crate::config::{AppConfig, CAPTION_MAX_CHARS_MAX, CAPTION_MAX_CHARS_MIN};
use crate::pipeline::CaptionPayload;
use crate::state::AppState;
use serde::Serialize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use unicode_segmentation::UnicodeSegmentation;

/// Serve-loop poll interval; a clean stop is observed within this window.
const RECV_TIMEOUT: Duration = Duration::from_millis(250);
/// How long `stop_running` waits for the serve thread to exit before
/// detaching it. The thread can be blocked inside `request.respond` when a
/// client stops reading (e.g. a hidden OBS browser source with a throttled
/// page); tiny_http writes with no socket timeout, so the join must not be
/// unbounded or settings saves and app exit would hang behind that client.
const STOP_JOIN_TIMEOUT: Duration = Duration::from_secs(2);
/// Poll interval while waiting for the serve thread to finish.
const STOP_JOIN_POLL: Duration = Duration::from_millis(25);
/// Log target shared by the listener so diagnostics stay greppable.
const LOG_TARGET: &str = "kotoba_overlay";

type FeedFn = Box<dyn Fn() -> BrowserSourceFeed + Send + Sync>;

/// Tauri-managed handle to the current listener (if any).
pub struct BrowserSourceRuntime {
    serving: Mutex<Option<RunningServer>>,
    /// Serialize reconcile operations. A config save can arrive while a prior
    /// save is still stopping or replacing the listener; without this guard,
    /// the later operation could overwrite the stored handle and leak a bound
    /// thread that shutdown can no longer reach.
    lifecycle: Mutex<()>,
}

struct RunningServer {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

impl Default for BrowserSourceRuntime {
    fn default() -> Self {
        Self { serving: Mutex::new(None), lifecycle: Mutex::new(()) }
    }
}

impl Drop for BrowserSourceRuntime {
    fn drop(&mut self) {
        let running = match self.serving.get_mut() {
            Ok(serving) => serving.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(running) = running {
            stop_running(running);
        }
    }
}

/// Mirror the configured overlay onto the current listener state. Calling this
/// repeatedly is idempotent: nothing happens while the desired state matches.
pub fn reconcile(app: &AppHandle, config: &AppConfig) {
    let Some(runtime) = app.try_state::<BrowserSourceRuntime>() else {
        return;
    };
    let desired = if config.overlay.browser_source.enabled {
        Some(config.overlay.browser_source.port)
    } else {
        None
    };
    runtime.reconcile_to(app.clone(), desired);
}

/// Stop the listener during app teardown. Safe to call when nothing is bound.
pub fn shutdown(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<BrowserSourceRuntime>() {
        runtime.reconcile_to(app.clone(), None);
    }
}

impl BrowserSourceRuntime {
    fn reconcile_to(&self, app: AppHandle, desired: Option<u16>) {
        self.reconcile_to_with(desired, |port| self.spawn(app, port));
    }

    fn reconcile_to_with<F>(&self, desired: Option<u16>, spawn: F)
    where
        F: FnOnce(u16) -> Option<RunningServer>,
    {
        let Ok(_lifecycle) = self.lifecycle.lock() else {
            log::error!(target: LOG_TARGET, "browser source lifecycle lock poisoned");
            return;
        };

        let current = self.serving.lock().ok().and_then(|serving| {
            serving.as_ref().map(|running| (running.port, !running.thread.is_finished()))
        });
        if current == desired.map(|port| (port, true)) {
            return;
        }

        // A listener that exited from an accept error no longer serves traffic,
        // even though its handle is still recorded. It must be joined before a
        // same-port replacement is bound; an already-dead listener cannot be
        // preserved as a fallback anyway.
        if current.is_some_and(|(_, alive)| !alive) {
            self.stop_current();
        }

        // Bind and start the replacement before stopping a healthy listener.
        // If the new bind fails, the old listener remains available and its
        // handle remains tracked for shutdown.
        let Some(port) = desired else {
            self.stop_current();
            return;
        };
        let Some(replacement) = spawn(port) else {
            return;
        };

        let previous = match self.serving.lock() {
            Ok(mut serving) => serving.replace(replacement),
            Err(_) => {
                log::error!(target: LOG_TARGET, "browser source state lock poisoned");
                stop_running(replacement);
                return;
            }
        };
        if let Some(previous) = previous {
            stop_running(previous);
        }
    }

    fn stop_current(&self) {
        let running = match self.serving.lock() {
            Ok(mut serving) => serving.take(),
            Err(_) => {
                log::error!(target: LOG_TARGET, "browser source state lock poisoned");
                None
            }
        };
        if let Some(running) = running {
            stop_running(running);
        }
    }

    fn spawn(&self, app: AppHandle, port: u16) -> Option<RunningServer> {
        spawn_feed(port, Box::new(move || feed(&app)))
    }
}

fn spawn_feed(port: u16, feed: FeedFn) -> Option<RunningServer> {
    let server = match Server::http(("127.0.0.1", port)) {
        Ok(server) => server,
        Err(error) => {
            log::warn!(
                target: LOG_TARGET,
                "could not bind OBS browser source on 127.0.0.1:{port}: {error}; \
                 the transparent window output remains available"
            );
            return None;
        }
    };
    // Port 0 is useful in tests: let the OS choose the listener port, then
    // retain the actual address so teardown assertions never race a probe/drop
    // rebind window. Production callers pass a validated fixed port.
    let actual_port = server.server_addr().to_ip().map(|address| address.port()).unwrap_or(port);
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread = match thread::Builder::new()
        .name("kotoba-browser-source".to_string())
        .spawn(move || serve(server, feed, thread_stop))
    {
        Ok(thread) => thread,
        Err(error) => {
            log::warn!(target: LOG_TARGET, "could not start browser source thread: {error}");
            return None;
        }
    };
    log::info!(
        target: LOG_TARGET,
        "OBS browser source listening on http://127.0.0.1:{actual_port}/ (caption-only fallback)"
    );
    Some(RunningServer { port: actual_port, stop, thread })
}

fn stop_running(running: RunningServer) {
    running.stop.store(true, Ordering::Release);
    // The serve loop wakes at most every RECV_TIMEOUT, so a healthy thread
    // exits quickly. A client that stops reading (a hidden or paused OBS
    // browser source) can fill the TCP send buffer and block the thread inside
    // request.respond; tiny_http has no write timeout, so wait at most
    // STOP_JOIN_TIMEOUT and then detach rather than hang reconcile or app exit.
    // The detached thread releases the port once the stalled client resumes or
    // disconnects; until then a same-port rebind degrades to the logged bind
    // warning, which is the same graceful path as any bind failure.
    let deadline = Instant::now() + STOP_JOIN_TIMEOUT;
    while !running.thread.is_finished() && Instant::now() < deadline {
        thread::sleep(STOP_JOIN_POLL);
    }
    if running.thread.is_finished() {
        if let Err(error) = running.thread.join() {
            log::warn!(target: LOG_TARGET, "browser source thread panicked: {error:?}");
        }
    } else {
        log::warn!(
            target: LOG_TARGET,
            "browser source thread is stuck on a stalled client; detached (port {} releases when the client resumes)",
            running.port
        );
    }
    log::info!(target: LOG_TARGET, "stopped OBS browser source on port {}", running.port);
}

/// Snapshot the latest caption and the overlay layout/styles for one request.
fn feed(app: &AppHandle) -> BrowserSourceFeed {
    let Some(state) = app.try_state::<AppState>() else {
        // A detached response worker can outlive Tauri state teardown when a
        // client stopped reading during shutdown. Return a valid empty feed
        // instead of panicking in that late request.
        log::warn!(target: LOG_TARGET, "browser source request arrived after app state teardown");
        return feed_from_parts(&AppConfig::default(), None);
    };
    let config = state.config.lock().map(|config| config.clone()).unwrap_or_default();
    feed_from_parts(&config, state.latest_caption().as_ref())
}

fn feed_from_parts(config: &AppConfig, caption: Option<&CaptionPayload>) -> BrowserSourceFeed {
    let overlay = serde_json::to_value(&config.overlay).unwrap_or_else(|_| serde_json::json!({}));
    let budgets = config.overlay.caption_max_chars;
    let caption = caption.map(|payload| {
        let source = crate::sentence_boundary::visible_caption_sentence(
            &payload.source_text,
            false,
            Some(payload.sentence_end_offsets.as_slice()),
        );
        let translation = crate::sentence_boundary::visible_caption_sentence(
            &payload.translation_text,
            true,
            None,
        );
        CaptionFeed {
            source: segment_caption_line(&source, budgets.source),
            translation: segment_caption_line(&translation, budgets.translation),
        }
    });
    BrowserSourceFeed { caption, overlay }
}

/// Clamp a configured budget into the supported range. Legacy or hand-edited
/// configs can carry an out-of-range value; keep parity with the frontend
/// `resolveCaptionMaxChars` so both outputs break lines identically.
fn resolve_caption_max_chars(value: u32) -> usize {
    value.clamp(CAPTION_MAX_CHARS_MIN, CAPTION_MAX_CHARS_MAX) as usize
}

/// Pre-segment one caption row into logical lines joined by `\n`. The served
/// page renders with `white-space: pre-wrap`, so the browser source breaks
/// lines where the DOM overlay and native canvas do.
fn segment_caption_line(text: &str, max_chars: u32) -> String {
    segment_caption_text(text, resolve_caption_max_chars(max_chars)).join("\n")
}

/// Punctuation the segmenter prefers to break after. Kept in sync with the
/// frontend `preferredBreak` regex in `apps/desktop/src/overlay/captions.ts`.
fn is_preferred_break(character: char) -> bool {
    matches!(
        character,
        '。' | '．' | '！' | '？' | '!' | '?' | '、' | ',' | '，' | '；' | ';' | '：' | ':'
    )
}

fn is_breakable_grapheme(grapheme: &str) -> bool {
    // Faithful port of the frontend `preferredBreak.test(character) ||
    // /\s/u.test(character)` in `apps/desktop/src/overlay/captions.ts`, where
    // `character` is one grapheme cluster. The DOM overlay matches when ANY
    // code point in the cluster is a preferred break or whitespace, so a
    // multi-codepoint cluster such as `！\u{301}` (punctuation + combining mark)
    // or ` \u{301}` is still a break site. The old `all(char::is_whitespace)`
    // fallback only matched clusters that were entirely whitespace, so the
    // browser source diverged from the DOM/native output for combining-mark
    // clusters by breaking at the full budget instead of at the punctuation.
    grapheme.chars().any(|character| is_preferred_break(character) || character.is_whitespace())
}

/// Find the preferred break index within `(lower..=max_chars]`, scanning from
/// the limit downward so Japanese clauses and Latin words stay together. The
/// scan never goes below half a line, so a very long clause still makes
/// forward progress. Returns `max_chars` when no preferred break exists.
fn preferred_break_index(remaining: &[String], max_chars: usize) -> usize {
    // Clamp the lower bound to 1 so `remaining[index - 1]` never underflows.
    let lower = (max_chars / 2).max(1);
    for index in (lower..=max_chars).rev() {
        if is_breakable_grapheme(&remaining[index - 1]) {
            return index;
        }
    }
    max_chars
}

/// A grapheme cluster is whitespace-only when it trims to an empty string.
/// A cluster like U+0020 + U+0301 (space + combining acute) is one grapheme
/// that is NOT whitespace-only, so it must never be stripped by a boundary
/// trim. Port of the frontend `isWhitespaceGrapheme` in `captions.ts`.
fn is_whitespace_grapheme(grapheme: &str) -> bool {
    grapheme.trim().is_empty()
}

/// Remove leading and trailing whitespace grapheme clusters from a slice.
/// Port of the frontend `trimGraphemes` in `captions.ts`.
fn trim_graphemes(graphemes: &[String]) -> &[String] {
    let mut start = 0;
    let mut end = graphemes.len();
    while start < end && is_whitespace_grapheme(&graphemes[start]) {
        start += 1;
    }
    while end > start && is_whitespace_grapheme(&graphemes[end - 1]) {
        end -= 1;
    }
    &graphemes[start..end]
}

/// Remove leading whitespace grapheme clusters from a slice.
/// Port of the frontend `trimStartGraphemes` in `captions.ts`.
fn trim_start_graphemes(graphemes: &[String]) -> &[String] {
    let mut start = 0;
    while start < graphemes.len() && is_whitespace_grapheme(&graphemes[start]) {
        start += 1;
    }
    &graphemes[start..]
}

/// Port of `splitLongLine` from `apps/desktop/src/overlay/captions.ts`.
/// Counts user-visible grapheme clusters, not Unicode scalar values, so ZWJ
/// emoji and combining marks stay intact across the configured budget. Trims
/// at the grapheme-cluster level — not on the joined string — so a cluster
/// like U+0020 + U+0301 is never split by a boundary trim.
fn split_long_line(line: &str, max_chars: usize) -> Vec<String> {
    let characters: Vec<String> = line.graphemes(true).map(str::to_string).collect();
    if characters.len() <= max_chars {
        return vec![line.to_string()];
    }

    let mut segments: Vec<String> = Vec::new();
    let mut remaining: &[String] = &characters;
    while remaining.len() > max_chars {
        let break_at = preferred_break_index(remaining, max_chars);
        // Trim at the grapheme-cluster level, not on the joined string: a
        // cluster like U+0020 + U+0301 is one grapheme, and str::trim_start
        // would strip the space and leave a bare combining mark at the start
        // of the next line.
        let segment = trim_graphemes(&remaining[..break_at]).concat();
        if !segment.is_empty() {
            segments.push(segment);
        }
        remaining = trim_start_graphemes(&remaining[break_at..]);
    }
    let tail = trim_graphemes(remaining).concat();
    if !tail.is_empty() {
        segments.push(tail);
    }
    if segments.is_empty() {
        vec![line.trim().to_string()]
    } else {
        segments
    }
}

/// Port of `segmentCaptionText` from `apps/desktop/src/overlay/captions.ts`.
/// Splits caption text into readable logical lines without dropping content.
fn segment_caption_text(text: &str, max_chars: usize) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim();
    if normalized.is_empty() {
        return Vec::new();
    }
    let safe_max_chars = max_chars.max(1);
    normalized
        .split('\n')
        .flat_map(|line| split_long_line(line.trim(), safe_max_chars))
        .filter(|line| !line.is_empty())
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSourceFeed {
    pub caption: Option<CaptionFeed>,
    /// `OverlayConfig` serialization: layout plus both text styles.
    pub overlay: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionFeed {
    /// Logical caption lines joined by `\n`; the served page renders with
    /// `white-space: pre-wrap` so these breaks paint like the DOM overlay.
    pub source: String,
    pub translation: String,
}

/// Keep request handling off the accept loop. A Browser Source client can stop
/// reading while tiny_http is writing a response; serving inline would then
/// prevent every other client (including health checks and OBS reloads) from
/// being accepted.
const REQUEST_WORKER_COUNT: usize = 4;
/// Keep a finite amount of work queued behind stalled Browser Source clients.
/// A full queue drops only the newly accepted request instead of allowing
/// unbounded memory growth while all response workers are blocked in a socket
/// write.
const REQUEST_QUEUE_CAPACITY: usize = REQUEST_WORKER_COUNT * 4;

fn request_worker_loop(request_receiver: Arc<Mutex<mpsc::Receiver<Request>>>, feed: Arc<FeedFn>) {
    loop {
        let request = match request_receiver.lock() {
            Ok(receiver) => receiver.recv().ok(),
            Err(_) => {
                log::error!(target: LOG_TARGET, "browser source request queue lock poisoned");
                return;
            }
        };
        let Some(request) = request else {
            return;
        };
        serve_request(request, feed.as_ref());
    }
}

fn serve(server: Server, feed: FeedFn, stop: Arc<AtomicBool>) {
    let feed = Arc::new(feed);
    let (request_sender, request_receiver) = mpsc::sync_channel::<Request>(REQUEST_QUEUE_CAPACITY);
    let request_receiver = Arc::new(Mutex::new(request_receiver));
    let mut workers = Vec::with_capacity(REQUEST_WORKER_COUNT);

    for worker_index in 0..REQUEST_WORKER_COUNT {
        let feed = Arc::clone(&feed);
        let request_receiver = Arc::clone(&request_receiver);
        let worker = thread::Builder::new()
            .name(format!("kotoba-browser-source-request-{worker_index}"))
            .spawn(move || request_worker_loop(request_receiver, feed));
        match worker {
            Ok(worker) => workers.push(worker),
            Err(error) => {
                log::warn!(
                    target: LOG_TARGET,
                    "could not start browser source request worker {worker_index}: {error}"
                );
            }
        }
    }

    if workers.is_empty() {
        log::error!(target: LOG_TARGET, "browser source has no request workers");
        return;
    }

    while !stop.load(Ordering::Acquire) && accept_request(&server, &request_sender, &stop) {}

    // Drop the listener before waiting for response workers. A worker can be
    // blocked indefinitely in `request.respond` when a client stops reading;
    // the listening socket must still close promptly during shutdown.
    drop(server);
    drop(request_sender);
    for worker in workers {
        if let Err(error) = worker.join() {
            log::warn!(target: LOG_TARGET, "browser source request worker panicked: {error:?}");
        }
    }
}

fn accept_request(
    server: &Server,
    request_sender: &mpsc::SyncSender<Request>,
    stop: &AtomicBool,
) -> bool {
    match server.recv_timeout(RECV_TIMEOUT) {
        Ok(Some(request)) => enqueue_request(request_sender, request),
        Ok(None) => true,
        Err(_) if stop.load(Ordering::Acquire) => false,
        Err(error) => {
            log::warn!(target: LOG_TARGET, "browser source accept failed: {error}");
            false
        }
    }
}

/// Reject an accepted request without letting tiny_http's `Request::drop`
/// synchronously write its implicit 500 response. The serve loop must never
/// drop an unanswered request itself: a stalled client could otherwise block
/// the listener while tiny_http flushes that response.
fn reject_request(request: Request) {
    drop(request.into_writer());
}

fn enqueue_request(request_sender: &mpsc::SyncSender<Request>, request: Request) -> bool {
    match request_sender.try_send(request) {
        Ok(()) => true,
        Err(mpsc::TrySendError::Full(request)) => {
            reject_request(request);
            log::warn!(
                target: LOG_TARGET,
                "browser source request queue full; dropped one request without response"
            );
            true
        }
        Err(mpsc::TrySendError::Disconnected(request)) => {
            reject_request(request);
            false
        }
    }
}

/// Handle one request. A panicking feed (e.g. a poisoned state lock edge case)
/// must drop only that request, never the listener itself.
fn serve_request(request: Request, feed: &FeedFn) {
    match catch_unwind(AssertUnwindSafe(feed)) {
        Ok(feed) => respond(request, &feed),
        Err(_) => {
            reject_request(request);
            log::error!(
                target: LOG_TARGET,
                "browser source feed panicked; dropped one caption request"
            );
        }
    }
}

fn respond(request: Request, feed: &BrowserSourceFeed) {
    let path = request.url().split('?').next().unwrap_or(request.url());
    let (status, content_type, body) = match (request.method(), path) {
        (&Method::Get, "/") => (StatusCode(200), "text/html; charset=utf-8", html_page(feed)),
        (&Method::Get, "/captions.json") => {
            (StatusCode(200), "application/json; charset=utf-8", feed_json(feed))
        }
        (&Method::Get, "/health") => {
            (StatusCode(200), "text/plain; charset=utf-8", "ok".to_string())
        }
        _ => (StatusCode(404), "text/plain; charset=utf-8", "not found".to_string()),
    };
    let response = Response::from_string(body)
        .with_status_code(status)
        .with_header(header(b"Content-Type", content_type.as_bytes()))
        .with_header(header(b"Cache-Control", b"no-store"))
        .with_header(header(b"X-Content-Type-Options", b"nosniff"));
    // A hung or disconnected OBS browser source must never stall the listener.
    let _ = request.respond(response);
}

fn header(name: &'static [u8], value: &'static [u8]) -> Header {
    Header::from_bytes(name, value).expect("static HTTP header is valid")
}

fn feed_json(feed: &BrowserSourceFeed) -> String {
    serde_json::to_string(feed).unwrap_or_else(|_| "{}".to_string())
}

/// Escape JSON embedded inside the page's `<script>` block. JSON.stringify
/// does not escape `<`, so a caption containing `</script>` could otherwise
/// terminate the script element and be interpreted as HTML.
fn escape_script_json(body: &str) -> String {
    body.replace('<', "\\u003c").replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029")
}

fn html_page(feed: &BrowserSourceFeed) -> String {
    let init = escape_script_json(&feed_json(feed));
    HTML_TEMPLATE.replace("__FEED_JSON__", &init)
}

/// Caption-only page for the OBS Browser Source. The page owns no state: it
/// polls `captions.json` and re-renders from the returned feed, so OBS can
/// refresh or resize it at any time. The inline styles intentionally mirror
/// `toCaptionCss`/`overlayCaptionCss` in `apps/desktop/src/core/style.ts` so
/// the fallback renders like the transparent window path.
const HTML_TEMPLATE: &str = r#"<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Kotoba Beacon Captions</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%;
    background: transparent; overflow: hidden; }
  #lines { position: absolute; box-sizing: border-box; overflow: visible;
    display: flex; flex-direction: column; align-items: center;
    justify-content: flex-end; pointer-events: none; }
  #lines .line { white-space: pre-wrap; overflow-wrap: anywhere;
    box-decoration-break: clone; -webkit-box-decoration-break: clone; }
</style>
</head>
<body>
<div id="lines"></div>
<script>
const INIT = __FEED_JSON__;
let feed = INIT;
const lines = document.getElementById("lines");
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo)); }
function styleCss(s) {
  const cullingOpacity = clamp(s.cullingOpacity, 0, 1) * 100;
  const cullingColor = "color-mix(in srgb, " + s.cullingColor + " " + cullingOpacity + "%, transparent)";
  const outline = s.cullingEnabled
    ? "0 0 " + s.cullingWidthPx + "px " + cullingColor
    : null;
  const shadow = s.shadowEnabled
    ? s.shadowOffsetX + "px " + s.shadowOffsetY + "px " + s.shadowBlurPx + "px " + s.shadowColor
    : null;
  const parts = [outline, shadow].filter(Boolean);
  const bg = s.backgroundEnabled
    ? "color-mix(in srgb, " + s.backgroundColor + " " + clamp(s.backgroundOpacity, 0, 1) * 100 + "%, transparent)"
    : "transparent";
  // cssText consumes CSS property names, not JavaScript style object keys.
  // Keep this list kebab-cased so Browser Source matches the in-app overlay.
  const css = [
    ["color", s.color],
    ["opacity", clamp(s.opacity, 0, 1)],
    ["font-size", Math.max(1, s.fontSizePx) + "px"],
    ["font-weight", clamp(s.fontWeight, 100, 900)],
    ["letter-spacing", s.letterSpacingPx + "px"],
    ["line-height", s.lineHeight],
    ["text-align", s.textAlign],
    ["max-width", clamp(s.maxWidthPercent, 1, 100) + "%"],
    ["-webkit-text-stroke", s.cullingEnabled ? s.cullingWidthPx + "px " + cullingColor : "0 transparent"],
    ["paint-order", "stroke fill"],
    ["text-shadow", parts.length ? parts.join(", ") : "none"],
    ["background-color", bg],
    ["padding", Math.max(0, s.paddingY) + "px " + Math.max(0, s.paddingX) + "px"],
    ["border-radius", Math.max(0, s.borderRadius) + "px"]
  ];
  return css.map(([key, value]) => key + ": " + value).join("; ");
}
function applyStyle(element, style) {
  element.style.cssText = styleCss(style);
  // setProperty parses the value as one declaration, so a configured font
  // family cannot inject additional declarations into cssText.
  element.style.setProperty("font-family", style.fontFamily);
}
function layoutCss(o) {
  const safe = Math.max(0, o.safeAreaPx);
  const x = clamp(o.captionXPercent, 0, 100);
  const y = clamp(o.captionYPercent, 0, 100);
  return "left: " + x + "%; top: " + y + "%; width: calc(100% - " + (safe * 2) + "px); " +
    "max-width: calc(100% - " + (safe * 2) + "px); transform: translate(-50%, -100%); " +
    "gap: " + Math.max(10, o.gapPx) + "px;";
}
function render(f) {
  lines.style.cssText = layoutCss(f.overlay);
  const source = f.caption ? f.caption.source : "";
  const translation = f.caption ? f.caption.translation : "";
  const first = f.overlay.order === "translation-first" ? translation : source;
  const second = f.overlay.order === "translation-first" ? source : translation;
  const firstStyle = f.overlay.order === "translation-first"
    ? f.overlay.translation : f.overlay.source;
  const secondStyle = f.overlay.order === "translation-first"
    ? f.overlay.source : f.overlay.translation;
  const items = [];
  if (first.trim().length) { items.push([first, firstStyle]); }
  if (second.trim().length) { items.push([second, secondStyle]); }
  lines.textContent = "";
  for (const [text, style] of items) {
    const line = document.createElement("div");
    line.className = "line";
    applyStyle(line, style);
    line.textContent = text;
    lines.appendChild(line);
  }
}
let refreshInFlight = false;
async function refresh() {
  // OBS can keep a slow response alive while the timer fires again. Avoid
  // overlapping fetches so an older response can never overwrite a newer feed.
  if (refreshInFlight) { return; }
  refreshInFlight = true;
  try {
    const response = await fetch("captions.json?t=" + Date.now(), { cache: "no-store" });
    if (response.ok) { feed = await response.json(); }
  } catch (error) { /* transient; keep the last good feed */ }
  finally {
    refreshInFlight = false;
    render(feed);
  }
}
// Paint the embedded snapshot before the first network round-trip. OBS can
// keep a local request in flight while the page is restoring; the initial
// caption must remain visible instead of waiting for that fetch to resolve.
render(feed);
setInterval(refresh, 120);
refresh();
</script>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::{
        feed_from_parts, feed_json, html_page, serve, spawn_feed, stop_running,
        BrowserSourceRuntime, RunningServer, RECV_TIMEOUT, STOP_JOIN_TIMEOUT,
    };
    use crate::config::{AppConfig, CAPTION_MAX_CHARS_MIN};
    use crate::output::OutputStatus;
    use crate::pipeline::CaptionPayload;
    use crate::state::AppState;
    use std::io::{ErrorKind, Read, Write};
    use std::net::TcpStream;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};
    use tiny_http::{ListenAddr, Server};
    use unicode_segmentation::UnicodeSegmentation;

    fn sample_caption() -> CaptionPayload {
        CaptionPayload {
            id: "browser-source:1".to_string(),
            source_text: "こんにちは、世界".to_string(),
            azookey_input_text: None,
            translation_text: "Hello, world".to_string(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 100,
            received_at: 200,
            stage: "source",
            sequence: 0,
            is_final: true,
            confidence: None,
            sentence_end_offsets: Vec::new(),
        }
    }

    #[test]
    fn feed_serializes_caption_text_and_overlay_layout() {
        let config = AppConfig::default();
        let feed = feed_from_parts(&config, Some(&sample_caption()));
        let body = feed_json(&feed);
        let json: serde_json::Value = serde_json::from_str(&body).expect("feed is valid JSON");
        assert_eq!(json["caption"]["source"], "こんにちは、世界");
        assert_eq!(json["caption"]["translation"], "Hello, world");
        assert_eq!(json["overlay"]["gapPx"], config.overlay.gap_px);
        assert_eq!(json["overlay"]["order"], "source-first");
        assert_eq!(json["overlay"]["captionYPercent"], config.overlay.caption_y_percent);
        assert_eq!(json["overlay"]["source"]["fontSizePx"], config.overlay.source.font_size_px);
        assert_eq!(
            json["overlay"]["translation"]["cullingColor"],
            config.overlay.translation.culling_color
        );
    }

    #[test]
    fn feed_omits_the_caption_when_none_is_retained() {
        let config = AppConfig::default();
        let feed = feed_from_parts(&config, None);
        let json: serde_json::Value =
            serde_json::from_str(&feed_json(&feed)).expect("feed is valid JSON");
        assert!(json["caption"].is_null());
    }

    #[test]
    fn page_embeds_the_latest_feed_and_polls_the_json_endpoint() {
        let config = AppConfig::default();
        let feed = feed_from_parts(&config, Some(&sample_caption()));
        let page = html_page(&feed);
        assert!(page.contains("Kotoba Beacon Captions"));
        assert!(page.contains("captions.json"));
        assert!(page.contains("setInterval(refresh, 120)"));
        assert!(page.contains("refreshInFlight"), "polling stays single-flight");
        assert!(page.contains("render(feed);"), "embedded feed paints before the first fetch");
        assert!(
            page.contains("setProperty(\"font-family\", style.fontFamily)"),
            "font family is assigned through CSSStyleDeclaration"
        );
        assert!(page.contains("[\"-webkit-text-stroke\""), "outline uses a valid stroke property");
        assert!(page.contains("こんにちは、世界"), "initial feed is embedded for first paint");
        assert!(!page.contains("<script>alert"), "caption text cannot break out of script");
    }

    #[test]
    fn page_escapes_script_terminators_in_caption_text() {
        let config = AppConfig::default();
        let mut caption = sample_caption();
        caption.source_text = "</script><script>alert(1)</script>".to_string();
        let page = html_page(&feed_from_parts(&config, Some(&caption)));
        assert!(
            page.contains(r"\u003c/script"),
            "< in caption text is JSON-escaped inside the script block"
        );
        assert!(!page.contains("</script><script>alert"), "raw script tag must not appear");
    }

    #[test]
    fn page_escapes_legacy_javascript_line_separators() {
        let config = AppConfig::default();
        let mut caption = sample_caption();
        caption.source_text = "before\u{2028}\u{2029}after".to_string();
        let page = html_page(&feed_from_parts(&config, Some(&caption)));
        assert!(page.contains("before\\u2028\\u2029after"));
        assert!(!page.contains("before\u{2028}\u{2029}after"));
    }

    #[test]
    fn page_line_box_wraps_long_tokens_like_the_dom_overlay() {
        // The DOM `.caption-line` (apps/desktop/src/styles.css) declares
        // `overflow-wrap: anywhere` so a single long Latin token wraps instead
        // of overflowing the max-width plate. The OBS page must render the
        // same way; without the declaration the browser source breaks after
        // punctuation/whitespace only and long tokens overflow.
        let config = AppConfig::default();
        let feed = feed_from_parts(&config, Some(&sample_caption()));
        let page = html_page(&feed);
        assert!(
            page.contains("#lines .line { white-space: pre-wrap; overflow-wrap: anywhere;"),
            "OBS line box must wrap over-long tokens exactly like the DOM overlay"
        );
    }

    #[test]
    fn runtime_drop_releases_the_listener_port() {
        // Let the OS choose the port, then verify that the listener no longer
        // accepts connections. Rebinding is not a reliable release probe on
        // macOS because a recent connection can leave the port in TIME_WAIT.
        let config = Arc::new(AppConfig::default());
        let feed_config = Arc::clone(&config);
        let running = spawn_feed(0, Box::new(move || feed_from_parts(&feed_config, None)))
            .expect("bind browser source listener");
        let port = running.port;
        let runtime =
            BrowserSourceRuntime { serving: Mutex::new(Some(running)), lifecycle: Mutex::new(()) };
        drop(runtime);

        assert!(
            server_is_stopped(port),
            "dropping the runtime must stop the browser source listener"
        );
    }

    #[test]
    fn failed_replacement_bind_preserves_existing_listener() {
        let config = Arc::new(AppConfig::default());
        let feed_config = Arc::clone(&config);
        let running = spawn_feed(0, Box::new(move || feed_from_parts(&feed_config, None)))
            .expect("bind existing browser source listener");
        let old_port = running.port;

        // Hold the desired port so the replacement bind fails. The old listener
        // must remain both reachable and tracked for later shutdown.
        let occupied = Server::http(("127.0.0.1", 0)).expect("bind replacement blocker");
        let ListenAddr::IP(address) = occupied.server_addr() else {
            panic!("expected a TCP listener address");
        };
        let desired_port = address.port();
        let runtime =
            BrowserSourceRuntime { serving: Mutex::new(Some(running)), lifecycle: Mutex::new(()) };

        runtime.reconcile_to_with(Some(desired_port), |port| {
            spawn_feed(port, Box::new(|| feed_from_parts(&AppConfig::default(), None)))
        });

        let current_port = runtime
            .serving
            .lock()
            .expect("browser source state lock")
            .as_ref()
            .map(|server| server.port);
        assert_eq!(
            current_port,
            Some(old_port),
            "failed replacement must not discard the healthy listener"
        );
        assert!(
            http_get(old_port, "/health").starts_with("HTTP/1.1 200 OK"),
            "the existing listener must remain reachable after a bind failure"
        );

        drop(runtime);
        drop(occupied);
    }

    fn wait_for_stop(stop: Arc<AtomicBool>) {
        while !stop.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn fake_running_server(port: u16) -> RunningServer {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = thread::spawn(move || wait_for_stop(thread_stop));
        RunningServer { port, stop, thread }
    }

    fn fake_spawn_after_first_attempt(
        attempts: &std::sync::atomic::AtomicUsize,
        port: u16,
    ) -> Option<RunningServer> {
        if attempts.fetch_add(1, Ordering::Relaxed) == 0 {
            return None;
        }
        Some(fake_running_server(port))
    }

    #[test]
    fn reconcile_retries_after_spawn_failure_for_same_desired_port() {
        let config = Arc::new(AppConfig::default());
        let feed_config = Arc::clone(&config);
        let running = spawn_feed(0, Box::new(move || feed_from_parts(&feed_config, None)))
            .expect("bind existing browser source listener");
        let old_port = running.port;
        let desired_port = if old_port == u16::MAX { old_port - 1 } else { old_port + 1 };
        let runtime =
            BrowserSourceRuntime { serving: Mutex::new(Some(running)), lifecycle: Mutex::new(()) };
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempts_for_spawn = Arc::clone(&attempts);

        runtime.reconcile_to_with(Some(desired_port), move |port| {
            fake_spawn_after_first_attempt(&attempts_for_spawn, port)
        });
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
        assert_eq!(
            runtime
                .serving
                .lock()
                .expect("browser source state lock")
                .as_ref()
                .map(|server| server.port),
            Some(old_port)
        );

        runtime.reconcile_to_with(Some(desired_port), |port| Some(fake_running_server(port)));
        assert_eq!(
            runtime
                .serving
                .lock()
                .expect("browser source state lock")
                .as_ref()
                .map(|server| server.port),
            Some(desired_port)
        );

        drop(runtime);
    }

    #[test]
    fn serves_the_page_feed_and_health_over_real_loopback_sockets() {
        let config = AppConfig::default();
        let state =
            Arc::new(AppState::new(config.clone(), OutputStatus { platform: "test".to_string() }));
        state.record_latest_caption(&sample_caption());
        let server = Server::http(("127.0.0.1", 0)).expect("ephemeral bind");
        let ListenAddr::IP(addr) = server.server_addr() else {
            panic!("expected a TCP listener address");
        };
        let feed_state = Arc::clone(&state);
        let feed_config = config.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let feed_fn: super::FeedFn =
            Box::new(move || feed_from_parts(&feed_config, feed_state.latest_caption().as_ref()));
        let thread = std::thread::spawn(move || serve(server, feed_fn, thread_stop));
        let port = addr.port();

        let page = http_get(port, "/");
        assert!(page.starts_with("HTTP/1.1 200 OK"));
        assert!(page.to_lowercase().contains("content-type: text/html"));
        assert!(page.contains("Kotoba Beacon Captions"));

        let feed_body = http_get(port, "/captions.json");
        let json: serde_json::Value =
            serde_json::from_str(response_body(&feed_body)).expect("feed JSON");
        assert_eq!(json["caption"]["source"], "こんにちは、世界");
        assert_eq!(json["caption"]["translation"], "Hello, world");

        let health = http_get(port, "/health");
        assert!(health.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(response_body(&health), "ok");

        let missing = http_get(port, "/nope");
        assert!(missing.starts_with("HTTP/1.1 404"));

        stop.store(true, Ordering::Release);
        thread.join().expect("serve thread exits cleanly");
        // The listener must stop accepting requests after the serve thread exits.
        // Rebinding immediately after several short-lived HTTP connections is
        // not a reliable release probe on macOS: those connections can leave
        // the port in TIME_WAIT even though the listener itself is gone.
        assert!(server_is_stopped(port), "browser source stopped accepting requests");
    }

    fn http_get(port: u16, path: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).expect("read timeout");
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        )
        .expect("send request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        response
    }

    fn response_body(response: &str) -> &str {
        response.split("\r\n\r\n").nth(1).unwrap_or(response)
    }

    /// Probe listener ownership without requiring an immediate rebind. A
    /// recently closed listener can leave short-lived connections in TIME_WAIT
    /// on macOS, so a bind failure does not prove that the serve thread stopped.
    fn server_is_stopped(port: u16) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while TcpStream::connect(("127.0.0.1", port)).is_ok() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        TcpStream::connect(("127.0.0.1", port)).is_err()
    }

    #[test]
    fn saturated_request_is_rejected_without_tiny_http_implicit_500() {
        let server = Server::http(("127.0.0.1", 0)).expect("ephemeral bind");
        let ListenAddr::IP(addr) = server.server_addr() else {
            panic!("expected a TCP listener address");
        };
        let port = addr.port();
        let (result_sender, result_receiver) = mpsc::channel();
        let thread = thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(2))
                .expect("receive request")
                .expect("request arrives");
            let (request_sender, _request_receiver) = mpsc::sync_channel(0);
            let accepted = super::enqueue_request(&request_sender, request);
            result_sender.send(accepted).expect("send enqueue result");
        });

        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream.set_read_timeout(Some(Duration::from_secs(2))).expect("read timeout");
        write!(
            stream,
            "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        )
        .expect("send request");
        // `into_writer` releases tiny_http's implicit-response guard, but the
        // crate may retain the connection until its client task observes the
        // dropped writer. Probe for a response rather than waiting for EOF: a
        // read timeout is the expected no-response outcome for this rejection.
        let mut response = [0_u8; 1];
        let response_len = match stream.read(&mut response) {
            Ok(length) => length,
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => 0,
            Err(error) => panic!("read rejected response: {error}"),
        };

        assert!(result_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("enqueue result arrives"));
        thread.join().expect("request thread exits");
        assert_eq!(
            response_len, 0,
            "a saturated request must not receive tiny_http's implicit 500 response"
        );
    }

    #[test]
    fn serve_loop_survives_a_panicking_feed_closure() {
        // A feed that panics must drop only the offending request; the next
        // request still gets a fresh snapshot from the listener thread.
        let config = AppConfig::default();
        let state =
            Arc::new(AppState::new(config.clone(), OutputStatus { platform: "test".to_string() }));
        state.record_latest_caption(&sample_caption());
        let server = Server::http(("127.0.0.1", 0)).expect("ephemeral bind");
        let ListenAddr::IP(addr) = server.server_addr() else {
            panic!("expected a TCP listener address");
        };
        let panic_feed = Arc::new(AtomicBool::new(true));
        let panic_flag = Arc::clone(&panic_feed);
        let feed_state = Arc::clone(&state);
        let feed_config = config.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let feed_fn: super::FeedFn =
            Box::new(move || feed_or_panic(&panic_flag, &feed_config, &feed_state));
        let thread = std::thread::spawn(move || serve(server, feed_fn, thread_stop));
        let port = addr.port();

        // The panicking request is dropped; the connection is closed without
        // a body. The listener must still be alive afterwards.
        let _ = http_get(port, "/captions.json");
        panic_feed.store(false, Ordering::Release);
        std::thread::sleep(RECV_TIMEOUT * 2);

        let body = http_get(port, "/captions.json");
        assert!(body.starts_with("HTTP/1.1 200 OK"));
        assert!(body.contains("こんにちは、世界"));

        stop.store(true, Ordering::Release);
        thread.join().expect("serve thread exits despite a panicking feed");
    }

    fn feed_or_panic(
        panic_flag: &AtomicBool,
        config: &AppConfig,
        state: &Arc<AppState>,
    ) -> super::BrowserSourceFeed {
        if panic_flag.load(Ordering::Relaxed) {
            panic!("test feed failure");
        }
        feed_from_parts(config, state.latest_caption().as_ref())
    }

    #[test]
    fn stop_returns_within_budget_when_a_client_stalls_the_serve_thread() {
        // A client that never reads fills the TCP send buffer; tiny_http's
        // respond() then blocks the serve thread with no write timeout.
        // stop_running must detach within its budget instead of joining
        // forever, or settings saves and app exit would hang.
        let config = AppConfig::default();
        let server = Server::http(("127.0.0.1", 0)).expect("ephemeral bind");
        let ListenAddr::IP(addr) = server.server_addr() else {
            panic!("expected a TCP listener address");
        };
        let port = addr.port();

        let mut huge = sample_caption();
        huge.source_text = "あ".repeat(8 * 1024 * 1024);
        let feed_fn: super::FeedFn = Box::new(move || feed_from_parts(&config, Some(&huge)));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = std::thread::spawn(move || serve(server, feed_fn, thread_stop));

        // Send a request and never read the response, stalling the write.
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        write!(stream, "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").expect("send request");
        // Give the serve thread time to start (and block inside) the write.
        std::thread::sleep(RECV_TIMEOUT * 2);

        let started = Instant::now();
        stop_running(RunningServer { port, stop, thread });
        let elapsed = started.elapsed();
        assert!(
            elapsed < STOP_JOIN_TIMEOUT + Duration::from_secs(2),
            "stop_running must bound the join; took {elapsed:?}"
        );
        assert!(
            server_is_stopped(port),
            "stopping the server must close the listener while the client remains stalled"
        );
        // tiny_http can retain the listener's local port while the detached
        // response still owns an active stalled connection. Closing that client
        // is the deterministic release boundary; the final probe below verifies
        // the port is reclaimable before the test exits.
        drop(stream);
        let released = Instant::now();
        while Server::http(("127.0.0.1", port)).is_err() {
            assert!(
                released.elapsed() < Duration::from_secs(5),
                "port must be released after the stalled client closes"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn feed_pre_segments_caption_rows_using_the_configured_budget() {
        let mut config = AppConfig::default();
        config.overlay.caption_max_chars.source = 4;
        config.overlay.caption_max_chars.translation = 5;

        let mut caption = sample_caption();
        caption.source_text = "あ".repeat(12);
        caption.translation_text = "b".repeat(12);

        let feed = feed_from_parts(&config, Some(&caption));
        let json: serde_json::Value =
            serde_json::from_str(&feed_json(&feed)).expect("feed is valid JSON");

        let source = json["caption"]["source"].as_str().expect("source string");
        let translation = json["caption"]["translation"].as_str().expect("translation string");

        // A shrunk budget breaks the row into logical lines joined by `\n`.
        assert_eq!(source, "ああああ\nああああ\nああああ");
        assert_eq!(translation, "bbbbb\nbbbbb\nbb");
        // Segmentation only inserts breaks; no character is dropped.
        assert_eq!(source.replace('\n', ""), "あ".repeat(12));
        assert_eq!(translation.replace('\n', ""), "b".repeat(12));
    }

    #[test]
    fn feed_pages_to_the_newest_completed_sentence() {
        let config = AppConfig::default();
        let mut caption = sample_caption();
        caption.source_text = "今日は晴れです。明日は雨です。".to_string();
        caption.translation_text = "It is sunny today. It will rain tomorrow.".to_string();
        caption.sentence_end_offsets =
            crate::sentence_boundary::heuristic_sentence_end_offsets(&caption.source_text, false);

        let feed = feed_from_parts(&config, Some(&caption));
        let json: serde_json::Value =
            serde_json::from_str(&feed_json(&feed)).expect("feed is valid JSON");

        assert_eq!(json["caption"]["source"], "明日は雨です。");
        assert_eq!(json["caption"]["translation"], "It will rain tomorrow.");
    }

    #[test]
    fn feed_clamps_an_out_of_range_persisted_budget_before_segmenting() {
        // A hand-edited config can carry a budget below the supported minimum;
        // the feed must clamp it rather than degenerate to empty/one-char lines.
        let mut config = AppConfig::default();
        config.overlay.caption_max_chars.source = 0;

        let mut caption = sample_caption();
        caption.source_text = "あ".repeat(8);

        let feed = feed_from_parts(&config, Some(&caption));
        let json: serde_json::Value =
            serde_json::from_str(&feed_json(&feed)).expect("feed is valid JSON");
        let source = json["caption"]["source"].as_str().expect("source string");

        // Clamped up to CAPTION_MAX_CHARS_MIN (4): 8 graphemes -> two lines.
        assert_eq!(source, "ああああ\nああああ");
    }

    #[test]
    fn feed_breaks_after_preferred_punctuation_that_carries_a_combining_mark() {
        // A full-width punctuation that forms one multi-codepoint grapheme with a
        // trailing combining mark is still a preferred break site. This must match
        // the DOM/native reference (captions.segment.smoke.test.tsx), where the
        // frontend matches the punctuation inside the cluster. The old
        // `all(char::is_whitespace)` fallback only matched fully-whitespace
        // clusters, so the browser source diverged by breaking at the full budget.
        let mut config = AppConfig::default();
        config.overlay.caption_max_chars.source = 8;
        config.overlay.caption_max_chars.translation = 8;

        let mut caption = sample_caption();
        caption.source_text = "ああああ！\u{301}あああああ".to_string();

        let feed = feed_from_parts(&config, Some(&caption));
        let json: serde_json::Value =
            serde_json::from_str(&feed_json(&feed)).expect("feed is valid JSON");
        let source = json["caption"]["source"].as_str().expect("source string");

        // Break after the punctuation cluster, exactly like the DOM/native output,
        // not at the full budget.
        assert_eq!(source, "ああああ！\u{301}\nあああああ");
        assert_eq!(source.replace('\n', ""), "ああああ！\u{301}あああああ");
    }

    #[test]
    fn feed_keeps_zwj_emoji_and_combining_marks_inside_the_budget() {
        // The budget is the clamp floor, so a split is actually forced here
        // rather than silently skipped.
        let budget = CAPTION_MAX_CHARS_MIN as usize;
        let mut config = AppConfig::default();
        config.overlay.caption_max_chars.source = CAPTION_MAX_CHARS_MIN;
        config.overlay.caption_max_chars.translation = CAPTION_MAX_CHARS_MIN;

        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        let combining =
            "\u{304B}\u{3099}\u{304D}\u{3099}\u{304F}\u{3099}\u{3051}\u{3099}\u{3053}\u{3099}";
        let mut caption = sample_caption();
        caption.source_text = family.repeat(6);
        caption.translation_text = combining.to_string();

        let feed = feed_from_parts(&config, Some(&caption));
        let json: serde_json::Value =
            serde_json::from_str(&feed_json(&feed)).expect("feed is valid JSON");
        let source = json["caption"]["source"].as_str().expect("source string");
        let translation = json["caption"]["translation"].as_str().expect("translation string");

        // Six clusters at a budget of four: split, but only between clusters.
        assert_eq!(source, format!("{}\n{}", family.repeat(4), family.repeat(2)));
        assert_eq!(source.replace('\n', ""), family.repeat(6));
        assert!(!source.lines().any(|line| line.starts_with('\u{200D}')));
        assert!(!source.lines().any(|line| line.ends_with('\u{200D}')));

        assert_eq!(translation.replace('\n', ""), combining);
        assert!(!translation.lines().any(|line| line.starts_with('\u{3099}')));
        for line in source.lines().chain(translation.lines()) {
            assert!(line.graphemes(true).count() <= budget, "line too long: {line:?}");
        }
    }

    #[test]
    fn segment_caption_text_does_not_split_a_whitespace_grapheme_cluster_when_trimming() {
        // A space plus a combining mark (U+0020 + U+0301) is one grapheme cluster.
        // When the hard break falls *before* it, str::trim_start on the joined
        // remaining would strip the space and leave a bare combining mark at the
        // start of the next line. The segmenter must trim whole clusters.
        // Mirrors the TS test `does not split a whitespace grapheme cluster when
        // trimming the remaining tail` in captions.segment.smoke.test.tsx.
        let text = "\u{3042}\u{3042}\u{3042} \u{301}\u{3042}\u{3042}\u{3042}";
        let lines = super::segment_caption_text(text, 3);
        assert!(
            !lines.iter().any(|line| line.starts_with('\u{301}')),
            "no line should start with a bare combining mark: {lines:?}"
        );
        let rejoined: String =
            lines.iter().flat_map(|line| line.graphemes(true)).collect::<String>();
        assert_eq!(rejoined, text, "grapheme content must be preserved");
    }

    #[test]
    fn segment_caption_text_consumes_pure_whitespace_grapheme_clusters_at_break_boundaries() {
        // A pure space at the break point is consumed: it is trimmed from the
        // segment tail (trim_graphemes) and from the remaining head
        // (trim_start_graphemes). No caption line should start or end with a
        // bare space, and the non-whitespace content is preserved. Mirrors the
        // TS test `consumes pure-whitespace grapheme clusters at break
        // boundaries` in captions.segment.smoke.test.tsx.
        let text = "\u{3042}\u{3042} \u{3042}\u{3042}\u{3042}  \u{3042}\u{3042}\u{3042}";
        let lines = super::segment_caption_text(text, 3);
        assert!(
            lines.iter().all(|line| !line.starts_with(' ') && !line.ends_with(' ')),
            "no line should start or end with a bare space: {lines:?}"
        );
        assert_eq!(lines.join(""), text.replace(' ', ""),);
    }
}
