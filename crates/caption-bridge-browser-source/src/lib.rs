//! OBS Browser Source loopback HTTP server without a Tauri `AppHandle`.
//!
//! The native Syphon/Spout2 lanes are platform-specific, so every platform
//! keeps a loopback fallback. This crate serves a caption-only page plus a JSON
//! caption feed on `http://127.0.0.1:{port}/` that OBS captures with a regular
//! Browser Source.
//!
//! Documented identities (see `caption-bridge-sidecar` `PortMap`):
//! - Tauri desktop app: port `1421`
//! - Native (GPUI) app: port `1521` (`1421 + 100`)
//!
//! Port `0` asks the OS for an ephemeral listener, which tests use so they never
//! collide with a running app.

#![forbid(unsafe_code)]

use serde::Serialize;
use std::io::{Error as IoError, ErrorKind};
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
/// Interface the listener binds. The page is never exposed beyond the host.
pub const LOOPBACK_HOST: &str = "127.0.0.1";

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
}

impl Default for BrowserSourceServer {
    fn default() -> Self {
        Self { bind: None, shared: Arc::new(SharedState { feed: Mutex::new(empty_feed()) }) }
    }
}

impl BrowserSourceServer {
    /// Start serving on the configured port when `enabled`.
    pub fn start(config: BrowserSourceConfig) -> Result<Self, BrowserSourceError> {
        let shared = Arc::new(SharedState { feed: Mutex::new(empty_feed()) });
        let bind = if config.enabled {
            Some(bind_listener(config.port, Arc::clone(&shared))?)
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
}

impl Drop for BrowserSourceServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn empty_feed() -> BrowserSourceFeed {
    BrowserSourceFeed { caption: None }
}

fn bind_error(port: u16, source: impl Into<IoError>) -> BrowserSourceError {
    BrowserSourceError::Bind { host: LOOPBACK_HOST.to_string(), port, source: source.into() }
}

fn bind_listener(port: u16, shared: Arc<SharedState>) -> Result<BindHandle, BrowserSourceError> {
    let server = Server::http((LOOPBACK_HOST, port))
        .map_err(|error| bind_error(port, IoError::new(ErrorKind::AddrInUse, error.to_string())))?;
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
const HTML_TEMPLATE: &str = r#"<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Kotoba Beacon Captions</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%;
    background: transparent; overflow: hidden; }
  #lines { position: absolute; left: 50%; bottom: 8%; width: 90%;
    transform: translateX(-50%); box-sizing: border-box; overflow: visible;
    display: flex; flex-direction: column; align-items: center; gap: 0.3em;
    justify-content: flex-end; pointer-events: none; text-align: center;
    color: #fff; font-family: sans-serif; font-size: clamp(28px, 4.8vw, 72px);
    font-weight: 700; line-height: 1.25; }
  body[data-layout="vertical"] #lines { bottom: 12%; width: 88%;
    font-size: clamp(32px, 7vw, 76px); }
  #lines .line { white-space: pre-wrap; overflow-wrap: anywhere;
    padding: 0.08em 0.24em; background: rgba(0, 0, 0, 0.62);
    border-radius: 0.16em; text-shadow: 0 0.04em 0.08em #000;
    box-decoration-break: clone; -webkit-box-decoration-break: clone; }
</style>
</head>
<body>
<div id="lines"></div>
<script>
const INIT = __FEED_JSON__;
const layout = new URLSearchParams(location.search).get("layout");
document.body.dataset.layout = layout === "vertical" ? "vertical" : "horizontal";
let feed = INIT;
const lines = document.getElementById("lines");
function render(f) {
  lines.textContent = "";
  const source = f.caption ? f.caption.source : "";
  const translation = f.caption ? f.caption.translation : "";
  const rows = [source, translation].filter((text) => text.trim().length);
  for (const text of rows) {
    const line = document.createElement("div");
    line.className = "line";
    line.textContent = text;
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
"#;

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
        };
        let page = html_page(&feed);
        assert!(page.contains("Kotoba Beacon Captions"));
        assert!(page.contains("captions.json"));
        assert!(page.contains("setInterval(refresh, 120)"));
        assert!(page.contains("refreshInFlight"));
        assert!(page.contains("render(feed);"));
        assert!(page.contains("#lines .line { white-space: pre-wrap; overflow-wrap: anywhere;"));
        assert!(page.contains("layout === \"vertical\""));
        assert!(page.contains("body[data-layout=\"vertical\"] #lines"));
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
        };
        let body = feed_json(&feed);
        let json: serde_json::Value = serde_json::from_str(&body).expect("feed is valid JSON");
        assert_eq!(json["caption"]["source"], "こんにちは、世界");
        assert_eq!(json["caption"]["translation"], "Hello, world");
        assert!(json.get("overlay").is_none());
    }

    #[test]
    fn feed_omits_the_caption_when_none_has_been_fed() {
        let body = feed_json(&BrowserSourceFeed { caption: None });
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

        server.stop();
        assert!(!server.is_running());
        assert_eq!(server.bound_port(), None);
        assert!(server_is_stopped(port), "dropping the listener must stop accepting");
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
