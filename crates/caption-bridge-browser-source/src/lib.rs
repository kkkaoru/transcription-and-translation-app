//! OBS Browser Source HTTP server without a Tauri `AppHandle`.
//!
//! Desktop callers use a loopback-only listener. The Mobile companion can
//! explicitly opt into a LAN listener so OBS on the paired desktop can read the
//! phone-owned caption page. Both modes serve the same caption-only page and
//! JSON feed.
//!
//! Documented identities (see `caption-bridge-sidecar` `PortMap`):
//! - Tauri desktop app: port `1421`
//! - Native (GPUI) app: port `1521` (`1421 + 100`)
//! - Mobile companion: port `1522` (`1421 + 101`)
//!
//! Port `0` asks the OS for an ephemeral listener, which tests use so they never
//! collide with a running app.

#![forbid(unsafe_code)]

pub use caption_bridge_fonts::{NOTO_SANS_JP_BROWSER_PATH, NOTO_SANS_JP_VARIABLE_TTF};
use serde::Serialize;
use std::io::{Cursor, Error as IoError, ErrorKind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use thiserror::Error;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

/// Loopback port owned by the Tauri desktop app.
pub const TAURI_BROWSER_SOURCE_PORT: u16 = 1421;
/// Loopback port owned by the native (GPUI) app: Tauri identity plus 100.
pub const NATIVE_BROWSER_SOURCE_PORT: u16 = 1521;
/// Loopback interface used by desktop callers.
pub const LOOPBACK_HOST: &str = "127.0.0.1";
/// Opt-in LAN interface used only by the Mobile companion.
pub const LAN_HOST: &str = "0.0.0.0";
/// Port owned by the Mobile companion.
pub const MOBILE_BROWSER_SOURCE_PORT: u16 = 1522;

/// Accept-poll interval. A clean stop is observed within this window.
const ACCEPT_TIMEOUT: Duration = Duration::from_millis(250);
/// How long stop waits for the serve thread before detaching it.
const STOP_JOIN_TIMEOUT: Duration = Duration::from_secs(2);
/// Poll interval while waiting for the serve thread to finish.
const STOP_JOIN_POLL: Duration = Duration::from_millis(25);
/// Response workers keep request handling off the accept loop.
const REQUEST_WORKER_COUNT: usize = 1;
/// Finite work queue behind a stalled Browser Source client.
const REQUEST_QUEUE_CAPACITY: usize = REQUEST_WORKER_COUNT * 4;

/// Recoverable failures from starting the loopback listener.
#[derive(Debug, Error)]
pub enum BrowserSourceError {
    /// The loopback listener could not bind. Other output paths remain available.
    #[error("could not bind OBS browser source on {host}:{port}: {source}")]
    Bind {
        host: String,
        port: u16,
        #[source]
        source: IoError,
    },
    /// The serve thread could not be spawned.
    #[error("could not start browser source serve thread: {source}")]
    Spawn {
        #[source]
        source: IoError,
    },
}

/// One caption row served to the OBS Browser Source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionFeed {
    /// Source caption text as last fed by the caller.
    pub source: String,
    /// Translation caption text as last fed by the caller.
    pub translation: String,
}

/// JSON payload at `GET /captions.json` and the page's embedded snapshot.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSourceFeed {
    /// `None` until the first [`BrowserSourceServer::feed`] call.
    pub caption: Option<CaptionFeed>,
    /// Shared visual contract used by HTML and Native output surfaces.
    pub style: BrowserSourceStyle,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSourceStyle {
    pub font_family: String,
    pub font_weight: u16,
    pub letter_spacing_px: f32,
    pub line_height: f32,
    pub source_size_px: f32,
    pub source_color: String,
    pub source_opacity: f32,
    pub translation_size_px: f32,
    pub translation_color: String,
    pub translation_opacity: f32,
    pub x_percent: f32,
    pub y_percent: f32,
    pub background_enabled: bool,
    pub background_color: String,
    pub background_opacity: f32,
    pub shadow_enabled: bool,
    pub shadow_color: String,
    pub shadow_blur_px: f32,
    pub shadow_offset_x: f32,
    pub shadow_offset_y: f32,
    pub outline_enabled: bool,
    pub outline_color: String,
    pub outline_width_px: f32,
}

impl Default for BrowserSourceStyle {
    fn default() -> Self {
        Self {
            font_family: "Noto Sans JP".to_string(),
            font_weight: 750,
            letter_spacing_px: 0.2,
            line_height: 1.3,
            source_size_px: 36.0,
            source_color: "#ffffff".to_string(),
            source_opacity: 1.0,
            translation_size_px: 29.0,
            translation_color: "#bfe8ff".to_string(),
            translation_opacity: 1.0,
            x_percent: 50.0,
            y_percent: 88.0,
            background_enabled: false,
            background_color: "#061018".to_string(),
            background_opacity: 0.72,
            shadow_enabled: true,
            shadow_color: "#000000".to_string(),
            shadow_blur_px: 8.0,
            shadow_offset_x: 0.0,
            shadow_offset_y: 3.0,
            outline_enabled: true,
            outline_color: "#061018".to_string(),
            outline_width_px: 3.0,
        }
    }
}

/// Bind configuration for the loopback caption server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserSourceConfig {
    /// Bind port. `0` requests an ephemeral OS-chosen port.
    pub port: u16,
    /// Whether serving is enabled. A disabled server holds feed state only.
    pub enabled: bool,
}

/// A running or dormant loopback caption server.
///
/// The listener always binds `127.0.0.1`. Dropping the server stops the
/// listener and joins (or detaches) the serve thread.
#[derive(Debug)]
pub struct BrowserSourceServer {
    bind: Option<BindHandle>,
    shared: Arc<SharedState>,
}

#[derive(Debug)]
struct BindHandle {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[derive(Debug)]
struct SharedState {
    feed: Mutex<BrowserSourceFeed>,
}

impl BrowserSourceConfig {
    /// Tauri app identity: port `1421`.
    pub const fn tauri() -> Self {
        Self { port: TAURI_BROWSER_SOURCE_PORT, enabled: true }
    }

    /// Native (GPUI) app identity: port `1521`.
    pub const fn native() -> Self {
        Self { port: NATIVE_BROWSER_SOURCE_PORT, enabled: true }
    }

    /// Mobile companion identity: port `1522`.
    pub const fn mobile() -> Self {
        Self { port: MOBILE_BROWSER_SOURCE_PORT, enabled: true }
    }
}

impl Default for BrowserSourceServer {
    fn default() -> Self {
        Self { bind: None, shared: Arc::new(SharedState { feed: Mutex::new(empty_feed()) }) }
    }
}

impl BrowserSourceServer {
    /// Start serving on the configured port when `enabled`.
    pub fn start(config: BrowserSourceConfig) -> Result<Self, BrowserSourceError> {
        Self::start_on_host(config, LOOPBACK_HOST)
    }

    /// Start an explicitly enabled LAN listener for the Mobile companion.
    ///
    /// This API is separate from [`Self::start`] so desktop call sites cannot
    /// accidentally expose their Browser Source outside the host.
    pub fn start_mobile(config: BrowserSourceConfig) -> Result<Self, BrowserSourceError> {
        Self::start_on_host(config, LAN_HOST)
    }

    fn start_on_host(
        config: BrowserSourceConfig,
        bind_host: &'static str,
    ) -> Result<Self, BrowserSourceError> {
        let shared = Arc::new(SharedState { feed: Mutex::new(empty_feed()) });
        let bind = if config.enabled {
            Some(bind_listener(bind_host, config.port, Arc::clone(&shared))?)
        } else {
            None
        };
        Ok(Self { bind, shared })
    }

    /// Stop the listener and reap the serve thread. Idempotent.
    pub fn stop(&mut self) {
        if let Some(bind) = self.bind.take() {
            stop_bind(bind);
        }
    }

    /// The loopback port actually bound, or `None` while disabled.
    pub fn bound_port(&self) -> Option<u16> {
        self.bind.as_ref().map(|bind| bind.port)
    }

    /// Whether a listener is currently bound.
    pub fn is_running(&self) -> bool {
        self.bind.is_some()
    }

    /// Replace the caption served to the browser source.
    pub fn feed(&self, source: &str, translation: &str) {
        let mut feed = match self.shared.feed.lock() {
            Ok(feed) => feed,
            Err(poisoned) => poisoned.into_inner(),
        };
        feed.caption =
            Some(CaptionFeed { source: source.to_string(), translation: translation.to_string() });
    }

    pub fn set_style(&self, style: BrowserSourceStyle) {
        let mut feed = match self.shared.feed.lock() {
            Ok(feed) => feed,
            Err(poisoned) => poisoned.into_inner(),
        };
        feed.style = style;
    }
}

impl Drop for BrowserSourceServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn empty_feed() -> BrowserSourceFeed {
    BrowserSourceFeed { caption: None, style: BrowserSourceStyle::default() }
}

fn bind_listener(
    host: &'static str,
    port: u16,
    shared: Arc<SharedState>,
) -> Result<BindHandle, BrowserSourceError> {
    let server = Server::http((host, port)).map_err(|error| BrowserSourceError::Bind {
        host: host.to_string(),
        port,
        source: IoError::new(ErrorKind::AddrInUse, error.to_string()),
    })?;
    let actual_port = server.server_addr().to_ip().map(|address| address.port()).unwrap_or(port);
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread = thread::Builder::new()
        .name("kotoba-browser-source".to_string())
        .spawn(move || serve(server, shared, thread_stop))
        .map_err(|source| BrowserSourceError::Spawn { source })?;
    Ok(BindHandle { port: actual_port, stop, thread: Some(thread) })
}

fn stop_bind(bind: BindHandle) {
    bind.stop.store(true, Ordering::Release);
    let deadline = Instant::now() + STOP_JOIN_TIMEOUT;
    let mut thread = bind.thread;
    let finished = match thread.as_ref() {
        Some(handle) => {
            while !handle.is_finished() && Instant::now() < deadline {
                thread::sleep(STOP_JOIN_POLL);
            }
            handle.is_finished()
        }
        None => true,
    };
    if finished {
        if let Some(handle) = thread.take() {
            let _ = handle.join();
        }
    }
}

fn serve(server: Server, shared: Arc<SharedState>, stop: Arc<AtomicBool>) {
    let (request_sender, request_receiver) = mpsc::sync_channel::<Request>(REQUEST_QUEUE_CAPACITY);
    let request_receiver = Arc::new(Mutex::new(request_receiver));
    let mut workers = Vec::with_capacity(REQUEST_WORKER_COUNT);

    let mut worker_index = 0;
    while worker_index < REQUEST_WORKER_COUNT {
        let shared = Arc::clone(&shared);
        let request_receiver = Arc::clone(&request_receiver);
        let worker = thread::Builder::new()
            .name(format!("kotoba-browser-source-request-{worker_index}"))
            .spawn(move || request_worker_loop(request_receiver, shared));
        if let Ok(worker) = worker {
            workers.push(worker);
        }
        worker_index += 1;
    }

    if workers.is_empty() {
        return;
    }

    while !stop.load(Ordering::Acquire) && accept_request(&server, &request_sender, &stop) {}

    drop(server);
    drop(request_sender);
    for worker in workers {
        let _ = worker.join();
    }
}

fn request_worker_loop(
    request_receiver: Arc<Mutex<mpsc::Receiver<Request>>>,
    shared: Arc<SharedState>,
) {
    loop {
        let request = match request_receiver.lock() {
            Ok(receiver) => receiver.recv().ok(),
            Err(_) => return,
        };
        let Some(request) = request else {
            return;
        };
        respond(request, &snapshot_feed(&shared));
    }
}

fn accept_request(
    server: &Server,
    request_sender: &mpsc::SyncSender<Request>,
    stop: &AtomicBool,
) -> bool {
    match server.recv_timeout(ACCEPT_TIMEOUT) {
        Ok(Some(request)) => enqueue_request(request_sender, request),
        Ok(None) => true,
        Err(_) if stop.load(Ordering::Acquire) => false,
        Err(_) => false,
    }
}

fn reject_request(request: Request) {
    drop(request.into_writer());
}

fn enqueue_request(request_sender: &mpsc::SyncSender<Request>, request: Request) -> bool {
    match request_sender.try_send(request) {
        Ok(()) => true,
        Err(mpsc::TrySendError::Full(request)) => {
            reject_request(request);
            true
        }
        Err(mpsc::TrySendError::Disconnected(request)) => {
            reject_request(request);
            false
        }
    }
}

fn snapshot_feed(shared: &SharedState) -> BrowserSourceFeed {
    let feed = match shared.feed.lock() {
        Ok(feed) => feed,
        Err(poisoned) => poisoned.into_inner(),
    };
    feed.clone()
}

fn respond(request: Request, feed: &BrowserSourceFeed) {
    let path = request.url().split('?').next().unwrap_or(request.url());
    if request.method() == &Method::Get && path == NOTO_SANS_JP_BROWSER_PATH {
        let response = Response::new(
            StatusCode(200),
            vec![
                header(b"Content-Type", b"font/ttf"),
                header(b"Cache-Control", b"public, max-age=31536000, immutable"),
                header(b"X-Content-Type-Options", b"nosniff"),
            ],
            Cursor::new(NOTO_SANS_JP_VARIABLE_TTF),
            Some(NOTO_SANS_JP_VARIABLE_TTF.len()),
            None,
        );
        let _ = request.respond(response);
        return;
    }

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
    let _ = request.respond(response);
}

fn header(name: &'static [u8], value: &'static [u8]) -> Header {
    Header::from_bytes(name, value).expect("static HTTP header is valid")
}

fn feed_json(feed: &BrowserSourceFeed) -> String {
    serde_json::to_string(feed).unwrap_or_else(|_| "{}".to_string())
}

/// Escape JSON embedded inside the page's `<script>` block. JSON.stringify does
/// not escape `<`, so a caption containing `</script>` could otherwise terminate
/// the script element.
fn escape_script_json(body: &str) -> String {
    body.replace('<', "\\u003c").replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029")
}

fn html_page(feed: &BrowserSourceFeed) -> String {
    let init = escape_script_json(&feed_json(feed));
    HTML_TEMPLATE.replace("__FEED_JSON__", &init)
}

/// Caption-only page for the OBS Browser Source. The page owns no state: it
/// polls `captions.json` and re-renders from the returned feed.
const HTML_TEMPLATE: &str = r##"<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Kotoba Beacon Captions</title>
<style>
  @font-face { font-family: "Noto Sans JP";
    src: url("/fonts/NotoSansJP-Variable.ttf") format("truetype");
    font-style: normal; font-weight: 100 900; font-display: block; }
  html, body { margin: 0; padding: 0; width: 100%; height: 100%;
    background: transparent; overflow: hidden; }
  #lines { position: absolute; width: 90%; transform: translate(-50%, -100%);
    box-sizing: border-box; overflow: visible; display: flex; flex-direction: column;
    align-items: center; gap: 14px; justify-content: flex-end; pointer-events: none;
    text-align: center; }
  #lines .line { white-space: pre-wrap; overflow-wrap: anywhere;
    display: block; width: fit-content; max-width: 100%;
    padding: 7px 14px; border-radius: 9px;
    box-decoration-break: slice; -webkit-box-decoration-break: slice; }
</style>
</head>
<body>
<div id="lines"></div>
<script>
const INIT = __FEED_JSON__;
let feed = INIT;
const lines = document.getElementById("lines");
function rgba(hex, opacity) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) || 0;
  const g = parseInt(value.slice(2, 4), 16) || 0;
  const b = parseInt(value.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${opacity})`;
}
function applyLineStyle(line, style, translated) {
  line.style.fontFamily = style.fontFamily;
  line.style.fontWeight = String(style.fontWeight);
  line.style.letterSpacing = `${style.letterSpacingPx}px`;
  line.style.lineHeight = String(style.lineHeight);
  const fontSize = translated ? style.translationSizePx : style.sourceSizePx;
  line.style.fontSize = `${fontSize}px`;
  line.style.minHeight = translated ? `${fontSize * style.lineHeight}px` : "";
  line.style.color = translated ? style.translationColor : style.sourceColor;
  line.style.opacity = String(translated ? style.translationOpacity : style.sourceOpacity);
  line.style.background = style.backgroundEnabled
    ? rgba(style.backgroundColor, style.backgroundOpacity) : "transparent";
  line.style.textShadow = style.shadowEnabled
    ? `${style.shadowOffsetX}px ${style.shadowOffsetY}px ${style.shadowBlurPx}px ${style.shadowColor}`
    : "none";
  line.style.webkitTextStroke = style.outlineEnabled
    ? `${style.outlineWidthPx}px ${style.outlineColor}` : "0 transparent";
  line.style.paintOrder = "stroke fill";
}
function render(f) {
  lines.textContent = "";
  lines.style.left = `${f.style.xPercent}%`;
  lines.style.top = `${f.style.yPercent}%`;
  const source = f.caption ? f.caption.source : "";
  const translation = f.caption ? f.caption.translation : "";
  for (const [text, translated] of [[source, false], [translation, true]]) {
    if (!text.trim().length && !translated) { continue; }
    const line = document.createElement("div");
    line.className = "line";
    line.textContent = text;
    applyLineStyle(line, f.style, translated);
    lines.appendChild(line);
  }
}
let refreshInFlight = false;
async function refresh() {
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
render(feed);
setInterval(refresh, 120);
refresh();
</script>
</body>
</html>
"##;

#[cfg(test)]
mod tests {
    use super::{
        feed_json, html_page, BrowserSourceConfig, BrowserSourceFeed, BrowserSourceServer,
        CaptionFeed, NATIVE_BROWSER_SOURCE_PORT, TAURI_BROWSER_SOURCE_PORT,
    };
    use std::io::{ErrorKind, Read, Write};
    use std::net::TcpStream;
    use std::time::{Duration, Instant};

    fn http_get(port: u16, path: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect loopback");
        stream.set_read_timeout(Some(Duration::from_secs(5))).expect("set read timeout");
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
        response.split_once("\r\n\r\n").map(|(_, body)| body).unwrap_or(response)
    }

    fn http_get_bytes(port: u16, path: &str) -> Vec<u8> {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect loopback");
        stream.set_read_timeout(Some(Duration::from_secs(5))).expect("set read timeout");
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        )
        .expect("send request");
        let mut response = Vec::new();
        stream.read_to_end(&mut response).expect("read response");
        response
    }

    fn response_body_bytes(response: &[u8]) -> &[u8] {
        response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map_or(response, |index| &response[index + 4..])
    }

    fn server_is_stopped(port: u16) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while TcpStream::connect(("127.0.0.1", port)).is_ok() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        TcpStream::connect(("127.0.0.1", port)).is_err()
    }

    #[test]
    fn config_ports_lock_the_desktop_and_native_identities() {
        let tauri = BrowserSourceConfig::tauri();
        assert_eq!(tauri.port, 1421);
        assert_eq!(tauri.port, TAURI_BROWSER_SOURCE_PORT);
        let native = BrowserSourceConfig::native();
        assert_eq!(native.port, 1521);
        assert_eq!(native.port, NATIVE_BROWSER_SOURCE_PORT);
        assert_eq!(native.port, tauri.port + 100);
        assert!(tauri.enabled);
        assert!(native.enabled);
    }

    #[test]
    fn disabled_config_binds_no_listener() {
        let server = BrowserSourceServer::start(BrowserSourceConfig { port: 0, enabled: false })
            .expect("disabled start succeeds");
        assert!(!server.is_running());
        assert_eq!(server.bound_port(), None);
    }

    #[test]
    fn html_page_contains_expected_obs_snippet() {
        let feed = BrowserSourceFeed {
            caption: Some(CaptionFeed {
                source: "こんにちは、世界".to_string(),
                translation: "Hello, world".to_string(),
            }),
            style: super::BrowserSourceStyle::default(),
        };
        let page = html_page(&feed);
        assert!(page.contains("Kotoba Beacon Captions"));
        assert!(page.contains("captions.json"));
        assert!(page.contains("setInterval(refresh, 120)"));
        assert!(page.contains("refreshInFlight"));
        assert!(page.contains("render(feed);"));
        assert!(page.contains("#lines .line { white-space: pre-wrap; overflow-wrap: anywhere;"));
        assert!(!page.contains("layout=vertical"));
        assert!(!page.contains("data-layout"));
        assert!(page.contains("line.style.webkitTextStroke"));
        assert!(page.contains("line.style.paintOrder = \"stroke fill\""));
        assert!(page.contains("@font-face { font-family: \"Noto Sans JP\";"));
        assert!(page.contains("/fonts/NotoSansJP-Variable.ttf"));
        assert!(page.contains("line.style.minHeight"));
        assert!(page.contains("!text.trim().length && !translated"));
        assert!(page.contains("style.backgroundEnabled"));
        assert!(page.contains("box-decoration-break: slice"));
        assert!(!page.contains("box-decoration-break: clone"));
        assert!(page.contains("こんにちは、世界"));
        assert!(!page.contains("<script>alert"));
    }

    #[test]
    fn page_escapes_script_terminators_in_caption_text() {
        let feed = BrowserSourceFeed {
            caption: Some(CaptionFeed {
                source: "</script><script>alert(1)</script>".to_string(),
                translation: "x".to_string(),
            }),
            style: super::BrowserSourceStyle::default(),
        };
        let page = html_page(&feed);
        assert!(page.contains(r"\u003c/script"));
        assert!(!page.contains("</script><script>alert"));
    }

    #[test]
    fn json_payload_shape_matches_expected_feed() {
        let feed = BrowserSourceFeed {
            caption: Some(CaptionFeed {
                source: "こんにちは、世界".to_string(),
                translation: "Hello, world".to_string(),
            }),
            style: super::BrowserSourceStyle::default(),
        };
        let body = feed_json(&feed);
        let json: serde_json::Value = serde_json::from_str(&body).expect("feed is valid JSON");
        assert_eq!(json["caption"]["source"], "こんにちは、世界");
        assert_eq!(json["caption"]["translation"], "Hello, world");
        assert_eq!(json["style"]["fontWeight"], 750);
        assert_eq!(json["style"]["backgroundEnabled"], false);
        assert!(json.get("overlay").is_none());
    }

    #[test]
    fn feed_omits_the_caption_when_none_has_been_fed() {
        let body = feed_json(&BrowserSourceFeed {
            caption: None,
            style: super::BrowserSourceStyle::default(),
        });
        let json: serde_json::Value = serde_json::from_str(&body).expect("feed is valid JSON");
        assert!(json["caption"].is_null());
    }

    #[test]
    fn bind_port_zero_get_root_returns_200_then_drop_stops_listener() {
        let mut server = BrowserSourceServer::start(BrowserSourceConfig { port: 0, enabled: true })
            .expect("bind ephemeral listener");
        server.feed("こんにちは", "Hello");
        let port = server.bound_port().expect("OS must have chosen a port");
        assert!(port > 0);

        let page = http_get(port, "/");
        assert!(page.starts_with("HTTP/1.1 200 OK"));
        assert!(page.to_lowercase().contains("content-type: text/html"));
        assert!(page.contains("Kotoba Beacon Captions"));
        assert!(page.contains("こんにちは"));

        let feed_body = http_get(port, "/captions.json");
        assert!(feed_body.starts_with("HTTP/1.1 200 OK"));
        let json: serde_json::Value =
            serde_json::from_str(response_body(&feed_body)).expect("feed JSON");
        assert_eq!(json["caption"]["source"], "こんにちは");
        assert_eq!(json["caption"]["translation"], "Hello");

        let font_response = http_get_bytes(port, "/fonts/NotoSansJP-Variable.ttf");
        assert!(font_response.starts_with(b"HTTP/1.1 200 OK"));
        assert!(font_response
            .windows(b"Content-Type: font/ttf".len())
            .any(|window| { window.eq_ignore_ascii_case(b"Content-Type: font/ttf") }));
        assert!(response_body_bytes(&font_response).windows(4).any(|bytes| bytes == b"\0\x01\0\0"));

        server.stop();
        assert!(!server.is_running());
        assert_eq!(server.bound_port(), None);
        assert!(server_is_stopped(port), "dropping the listener must stop accepting");
    }

    #[test]
    fn mobile_listener_is_lan_bound_and_serves_the_shared_feed() {
        let server =
            BrowserSourceServer::start_mobile(BrowserSourceConfig { port: 0, enabled: true })
                .expect("bind mobile LAN listener");
        server.feed("モバイル字幕", "Mobile caption");
        let port = server.bound_port().expect("bound port");

        let feed_body = http_get(port, "/captions.json");
        assert!(feed_body.starts_with("HTTP/1.1 200 OK"));
        let json: serde_json::Value =
            serde_json::from_str(response_body(&feed_body)).expect("feed JSON");
        assert_eq!(json["caption"]["source"], "モバイル字幕");
        assert_eq!(json["caption"]["translation"], "Mobile caption");
    }

    #[test]
    fn unknown_route_returns_404_and_health_returns_ok() {
        let server = BrowserSourceServer::start(BrowserSourceConfig { port: 0, enabled: true })
            .expect("bind ephemeral listener");
        let port = server.bound_port().expect("bound port");
        let health = http_get(port, "/health");
        assert!(health.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(response_body(&health), "ok");
        let missing = http_get(port, "/nope");
        assert!(missing.starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn bind_error_reports_the_loopback_host() {
        let first = BrowserSourceServer::start(BrowserSourceConfig { port: 0, enabled: true })
            .expect("first ephemeral bind");
        let occupied_port = first.bound_port().expect("first bound port");
        let error =
            BrowserSourceServer::start(BrowserSourceConfig { port: occupied_port, enabled: true })
                .expect_err("same port must be denied while the first listener owns it");
        assert!(format!("{error}").contains("127.0.0.1"));
        match error {
            super::BrowserSourceError::Bind { host, port, source } => {
                assert_eq!(host, "127.0.0.1");
                assert_eq!(port, occupied_port);
                assert_eq!(source.kind(), ErrorKind::AddrInUse);
            }
            super::BrowserSourceError::Spawn { source } => {
                panic!("expected bind error, got spawn: {source}");
            }
        }
    }
}
