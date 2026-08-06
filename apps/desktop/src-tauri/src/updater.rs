//! Signed, in-app updates for the desktop bundle.
//!
//! The updater replaces the complete Tauri bundle.  That is intentional: the
//! gateway, Parapper, model servers, native libraries and frontend must move
//! together so a running application never mixes incompatible sidecars.  The
//! feed and public key are supplied by `tauri.conf.json`; the private signing
//! key is only read by the release build process and is never stored here.

use crate::gateway;
use crate::native_output::NativeOutputHandle;
use crate::state::AppState;
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const AUTO_UPDATE_ENV: &str = "KOTOBA_BEACON_AUTO_UPDATE";
const CHANNEL_ENV: &str = "KOTOBA_BEACON_UPDATE_CHANNEL";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    pub target: String,
    pub source: String,
    pub channel: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub status: String,
    pub current_version: String,
    pub available_version: Option<String>,
    pub checked_at: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    pub source: Option<String>,
    pub channel: String,
    pub switch_result: Option<String>,
    pub relaunch_deferred: bool,
    pub metadata: Option<UpdateMetadata>,
}

struct Runtime {
    status: UpdateStatus,
    pending: Option<Update>,
    deferred_install: bool,
    history: Vec<UpdateStatus>,
}

static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();

fn channel() -> String {
    std::env::var(CHANNEL_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "stable".to_string())
}

fn initial_status() -> UpdateStatus {
    UpdateStatus {
        status: "idle".to_string(),
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        available_version: None,
        checked_at: None,
        downloaded_bytes: None,
        total_bytes: None,
        error: None,
        source: None,
        channel: channel(),
        switch_result: None,
        relaunch_deferred: false,
        metadata: None,
    }
}

fn runtime() -> &'static Mutex<Runtime> {
    RUNTIME.get_or_init(|| {
        Mutex::new(Runtime {
            status: initial_status(),
            pending: None,
            deferred_install: false,
            history: Vec::new(),
        })
    })
}

fn now() -> String {
    // Keep this dependency-free and machine-readable.  Millisecond precision
    // is enough to correlate updater transitions with the native log.
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{millis}")
}

fn update_metadata(update: &Update) -> UpdateMetadata {
    UpdateMetadata {
        version: update.version.clone(),
        date: update.date.map(|value| value.to_string()),
        body: update.body.as_deref().map(safe_error),
        target: update.target.clone(),
        source: safe_source(update.download_url.as_ref()),
        channel: channel(),
    }
}

fn emit(app: &AppHandle, status: UpdateStatus) {
    let mut status = status;
    if let Some(error) = status.error.clone() {
        status.error = Some(safe_error(&error));
    }
    if let Ok(mut runtime) = runtime().lock() {
        runtime.status = status.clone();
        runtime.history.push(status.clone());
        if runtime.history.len() > 32 {
            let excess = runtime.history.len() - 32;
            runtime.history.drain(0..excess);
        }
    }
    if let Err(error) = app.emit("update:status", &status) {
        log::debug!(target: "kotoba_updater", "could not emit update status: {error}");
    }
    log::info!(
        target: "kotoba_updater",
        "status={} current={} available={:?} downloaded={:?}/{:?} source={:?} error={:?}",
        status.status,
        status.current_version,
        status.available_version,
        status.downloaded_bytes,
        status.total_bytes,
        status.source.as_deref().map(safe_source),
        status.error,
    );
}

fn safe_source(value: &str) -> String {
    // Never log credentials or query values from a configured endpoint.
    match url::Url::parse(value) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }
        Err(_) => "<invalid-url>".to_string(),
    }
}

fn safe_error(value: &str) -> String {
    let mut output = value.to_string();
    for marker in [
        "access_token=",
        "refresh_token=",
        "id_token=",
        "api_key=",
        "apikey=",
        "token=",
        "secret=",
        "password=",
        "authorization=",
    ] {
        let lower = output.to_ascii_lowercase();
        if let Some(start) = lower.find(marker) {
            let end = output[start + marker.len()..]
                .find(['&', '#', ' ', '\n', '\r'])
                .map(|offset| start + marker.len() + offset)
                .unwrap_or(output.len());
            output.replace_range(start + marker.len()..end, "[REDACTED]");
        }
    }
    output
}

pub fn status() -> UpdateStatus {
    runtime().lock().map(|runtime| runtime.status.clone()).unwrap_or_else(|_| initial_status())
}

pub fn history() -> Vec<UpdateStatus> {
    runtime().lock().map(|runtime| runtime.history.clone()).unwrap_or_default()
}

pub fn status_value() -> serde_json::Value {
    serde_json::json!({
        "update": status(),
        "updateHistory": history(),
    })
}

pub fn auto_update_enabled() -> bool {
    !matches!(
        std::env::var(AUTO_UPDATE_ENV).ok().as_deref().map(str::trim),
        Some("0" | "false" | "off" | "no")
    )
}

fn capture_active(app: &AppHandle) -> bool {
    app.try_state::<crate::state::AppState>()
        .and_then(|state| {
            state
                .status
                .lock()
                .ok()
                .map(|status| matches!(status.status.as_str(), "starting" | "capturing"))
        })
        .unwrap_or(false)
}

fn mark_relaunch_after_capture(app: &AppHandle) {
    let _ = app.emit("update:relaunch-deferred", "capture-active");
}

/// Record the bundle switch decision in the updater snapshot as well as the
/// one-shot relaunch event, so support exports still explain a deferred switch.
pub fn mark_switch_result(app: &AppHandle, reason: &str, deferred: bool) {
    let mut next = status();
    next.switch_result = Some(reason.to_string());
    next.relaunch_deferred = deferred;
    emit(app, next);
}

fn take_pending() -> Option<Update> {
    runtime().lock().ok().and_then(|mut runtime| runtime.pending.take())
}

fn put_pending(update: Update) {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.pending = Some(update);
    }
}

fn set_deferred_install(deferred: bool) {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.deferred_install = deferred;
    }
}

fn clear_pending() {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.pending = None;
        runtime.deferred_install = false;
    }
}

/// Returns whether a verified update metadata object is waiting for an idle
/// capture session. The bytes are downloaded only after the session is idle,
/// so a long capture never gets interrupted halfway through a transfer.
pub fn pending_available() -> bool {
    runtime()
        .lock()
        .map(|runtime| runtime.deferred_install && runtime.pending.is_some())
        .unwrap_or(false)
}

fn recover_sidecars_after_install_failure(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return;
    };
    let Ok(config) = state.config.lock().map(|config| config.clone()) else {
        return;
    };
    if let Err(recovery) = gateway::start(app, &config) {
        log::error!(
            target: "kotoba_updater",
            "update install failed and sidecar recovery also failed: {}",
            safe_error(&recovery)
        );
    }
}

/// Finish a deferred update after the microphone has stopped. This is called
/// from the native `stop_capture` command and intentionally runs off the UI
/// thread; the final `request_restart` happens after signature verification and
/// installation have succeeded.
pub fn install_after_capture(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = install(&app).await {
            log::warn!(
                target: "kotoba_updater",
                "deferred update install failed: {}",
                safe_error(&error)
            );
        }
    });
}

async fn check_inner(app: &AppHandle) -> Result<Option<UpdateMetadata>, String> {
    // A fresh check replaces the previous candidate. Merely opening the
    // DebugPanel or pressing "Check" must never arm a deferred install.
    clear_pending();
    let mut checking = status();
    checking.status = "checking".to_string();
    checking.checked_at = Some(now());
    checking.error = None;
    checking.downloaded_bytes = None;
    checking.total_bytes = None;
    checking.switch_result = None;
    checking.relaunch_deferred = false;
    emit(app, checking);

    let updater = app.updater().map_err(|error| format!("updater is not configured: {error}"))?;
    let update = updater.check().await.map_err(|error| format!("update check failed: {error}"))?;
    let Some(update) = update else {
        clear_pending();
        let mut idle = status();
        idle.status = "idle".to_string();
        idle.checked_at = Some(now());
        idle.available_version = None;
        idle.metadata = None;
        idle.source = None;
        emit(app, idle);
        return Ok(None);
    };

    let metadata = update_metadata(&update);
    let mut available = status();
    available.status = "available".to_string();
    available.checked_at = Some(now());
    available.available_version = Some(metadata.version.clone());
    available.source = Some(metadata.source.clone());
    available.channel = metadata.channel.clone();
    available.metadata = Some(metadata.clone());
    emit(app, available);
    put_pending(update);
    Ok(Some(metadata))
}

pub async fn check(app: &AppHandle) -> Result<Option<UpdateMetadata>, String> {
    match check_inner(app).await {
        Ok(value) => Ok(value),
        Err(error) => {
            let mut failed = status();
            failed.status = "failed".to_string();
            failed.checked_at = Some(now());
            failed.error = Some(error.clone());
            emit(app, failed);
            Err(error)
        }
    }
}

async fn install_pending_inner(app: &AppHandle, update: Update) -> Result<(), String> {
    if capture_active(app) {
        put_pending(update);
        set_deferred_install(true);
        mark_relaunch_after_capture(app);
        let mut ready = status();
        ready.status = "ready".to_string();
        ready.error = Some("capture-active; update deferred until capture stops".to_string());
        ready.switch_result = Some("capture-active".to_string());
        ready.relaunch_deferred = true;
        emit(app, ready);
        return Ok(());
    }

    let metadata = update_metadata(&update);
    let mut downloading = status();
    downloading.status = "downloading".to_string();
    downloading.available_version = Some(metadata.version.clone());
    downloading.source = Some(metadata.source.clone());
    downloading.metadata = Some(metadata.clone());
    downloading.downloaded_bytes = Some(0);
    downloading.total_bytes = None;
    emit(app, downloading);

    let app_for_progress = app.clone();
    let progress_metadata = metadata.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                let mut progress = status();
                progress.status = "downloading".to_string();
                progress.downloaded_bytes =
                    Some(progress.downloaded_bytes.unwrap_or(0).saturating_add(chunk as u64));
                progress.total_bytes = total;
                progress.available_version = Some(progress_metadata.version.clone());
                progress.source = Some(progress_metadata.source.clone());
                progress.metadata = Some(progress_metadata.clone());
                emit(&app_for_progress, progress);
            },
            || {},
        )
        .await
        .map_err(|error| format!("update download or signature verification failed: {error}"))?;

    // A capture can begin while a download is in flight. Do not tear down a
    // live microphone session; keep the verified metadata and let the next
    // stop_capture call retry the download from an idle state.
    if capture_active(app) {
        put_pending(update);
        set_deferred_install(true);
        mark_relaunch_after_capture(app);
        let mut ready = status();
        ready.status = "ready".to_string();
        ready.error = Some("capture-started during download; update deferred".to_string());
        ready.switch_result = Some("capture-active".to_string());
        ready.relaunch_deferred = true;
        emit(app, ready);
        return Ok(());
    }

    // Stop Syphon/Spout and bundled sidecars before replacing the bundle. This
    // is needed even when the updater exits without delivering RunEvent::Exit.
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut output) = state.native_output.lock() {
            *output = NativeOutputHandle::inactive();
        }
    }
    for label in ["native-renderer", "transparent"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }
    gateway::shutdown(app);
    if let Err(error) = update.install(bytes) {
        // Keep the running app usable when the signed bundle cannot be
        // replaced (permissions, disk full, malformed package, etc.).
        recover_sidecars_after_install_failure(app);
        return Err(format!("update install failed: {error}"));
    }
    set_deferred_install(false);

    let mut installed = status();
    installed.status = "installed".to_string();
    installed.checked_at = Some(now());
    installed.available_version = Some(metadata.version);
    installed.downloaded_bytes = None;
    installed.total_bytes = None;
    installed.error = None;
    installed.switch_result = Some("relaunch-requested".to_string());
    installed.relaunch_deferred = false;
    emit(app, installed);
    // request_restart delivers the normal Exit event where possible and
    // starts the executable from the same .app path, loading the new bundle.
    app.request_restart();
    Ok(())
}

pub async fn install(app: &AppHandle) -> Result<(), String> {
    let Some(update) = take_pending() else {
        return Err("no update is ready; run check_for_update first".to_string());
    };
    set_deferred_install(false);
    match install_pending_inner(app, update).await {
        Ok(()) => Ok(()),
        Err(error) => {
            set_deferred_install(false);
            let mut failed = status();
            failed.status = "failed".to_string();
            failed.error = Some(error.clone());
            emit(app, failed);
            Err(error)
        }
    }
}

pub async fn check_and_install(app: &AppHandle) -> Result<(), String> {
    if check(app).await?.is_some() {
        install(app).await
    } else {
        Ok(())
    }
}

/// Install an update discovered by the automatic check, or defer it while a
/// capture session is active. Keeping this branch outside `start_auto_check`
/// avoids deeply nested callback control flow while preserving the same
/// deferred-install and error-reporting behavior.
async fn install_auto_update(app: &AppHandle) {
    if capture_active(app) {
        // Keep the verified update object. `stop_capture` will call
        // install_after_capture once the native session is idle.
        set_deferred_install(true);
        mark_relaunch_after_capture(app);
        return;
    }

    if let Err(error) = install(app).await {
        log::error!(
            target: "kotoba_updater",
            "automatic install failed: {}",
            safe_error(&error)
        );
    }
}

pub fn start_auto_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Debug/browser builds should never silently contact a release feed.
        if cfg!(debug_assertions) {
            let mut unsupported = status();
            unsupported.status = "unsupported".to_string();
            unsupported.error = Some("automatic updates are disabled in debug builds".to_string());
            emit(&app, unsupported);
            return;
        }
        if !auto_update_enabled() {
            let mut disabled = status();
            disabled.status = "unsupported".to_string();
            disabled.error = Some(format!("disabled by {AUTO_UPDATE_ENV}=0"));
            emit(&app, disabled);
            return;
        }
        match check(&app).await {
            Ok(Some(_)) => install_auto_update(&app).await,
            Ok(None) => {}
            Err(error) => log::warn!(
                target: "kotoba_updater",
                "automatic check skipped: {}",
                safe_error(&error)
            ),
        }
    });
}

pub fn install_plugin<R: tauri::Runtime>(
) -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new().build()
}

#[cfg(test)]
mod tests {
    use super::{auto_update_enabled, safe_source};

    #[test]
    fn source_redaction_removes_query_and_fragment() {
        assert_eq!(
            safe_source("https://example.com/latest.json?token=secret#fragment"),
            "https://example.com/latest.json"
        );
        assert_eq!(
            safe_source("https://user:password@example.com/latest.json"),
            "https://example.com/latest.json"
        );
    }

    #[test]
    fn default_auto_update_is_enabled() {
        // Environment-sensitive opt-out behavior is covered by the runtime
        // implementation; this asserts that the normal process default is on.
        if std::env::var("KOTOBA_BEACON_AUTO_UPDATE").is_err() {
            assert!(auto_update_enabled());
        }
    }
}
