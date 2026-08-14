use crate::{
    config::{AppConfig, STREAMING_INTERIM_ASR_MODEL_ID, STREAMING_INTERIM_ASR_MODEL_OFF},
    model_runtime::{self, ModelRuntimeSpec},
};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

#[cfg(windows)]
use std::ffi::OsString;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const GATEWAY_PORT: u16 = 8765;
const PARAPPER_PORT: u16 = 18082;
/// Headless Parapper keeps a brief pause inside the same turn.  Keep these
/// values explicit in the desktop-to-sidecar command contract so a persisted
/// interactive Parapper profile cannot reintroduce 96ms/320ms segmentation.
const PARAPPER_INTERIM_RESULT_SILENCE_MS: u32 = 96;
// Match the headless sidecar default: 960ms keeps a normal Japanese clause
// together across an ordinary breath, with a bounded finalization delay for
// genuinely short utterances.
const PARAPPER_TURN_CHECK_SILENCE_MS: u32 = 960;
/// Quality settings from Parapper's built-in rich Japanese preset. These are
/// passed explicitly so a stale sidecar config cannot fall back to Simple turns
/// or skip the final full-turn re-recognition.
const PARAPPER_TURN_DETECTOR: &str = "namo";
const PARAPPER_INTERIM_RESULT_ENABLED: bool = true;
const PARAPPER_RERECOGNIZE_FULL_ON_COMPLETE: bool = true;
const SERVICE_READY_ATTEMPTS: u32 = 90;
const PARAPPER_READY_ATTEMPTS: u32 = 300;

/// Best-effort cleanup of orphaned sidecars from a previous crash. Only used on
/// Unix where `lsof` is typically available; failures are ignored.
#[cfg(unix)]
fn kill_port(port: u16) {
    let output = std::process::Command::new("lsof").args(["-ti", &format!(":{port}")]).output();
    let Ok(output) = output else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let pids = String::from_utf8_lossy(&output.stdout);
    for pid in pids.split_whitespace() {
        log::warn!(target: "kotoba_runtime", "clearing stale listener on port {port} (pid {pid})");
        let _ = std::process::Command::new("kill").args(["-9", pid]).output();
    }
}

#[cfg(unix)]
fn clear_sidecar_ports() {
    kill_port(GATEWAY_PORT);
    kill_port(PARAPPER_PORT);
    for port in 8081..=8087_u16 {
        kill_port(port);
    }
}

#[cfg(not(unix))]
fn clear_sidecar_ports() {}

pub struct RuntimeServices {
    gateway: Mutex<Option<CommandChild>>,
    parapper: Mutex<Option<CommandChild>>,
    models: Mutex<HashMap<String, CommandChild>>,
    model_reconciliation: tokio::sync::Mutex<()>,
    lifecycle: Mutex<()>,
    stopping: AtomicBool,
}

impl Default for RuntimeServices {
    fn default() -> Self {
        Self {
            gateway: Mutex::new(None),
            parapper: Mutex::new(None),
            models: Mutex::new(HashMap::new()),
            model_reconciliation: tokio::sync::Mutex::new(()),
            lifecycle: Mutex::new(()),
            stopping: AtomicBool::new(false),
        }
    }
}

impl RuntimeServices {
    fn begin_start(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        let lifecycle =
            self.lifecycle.lock().map_err(|_| "runtime lifecycle lock poisoned".to_string())?;
        self.stopping.store(false, Ordering::Release);
        Ok(lifecycle)
    }

    fn begin_shutdown(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        let lifecycle =
            self.lifecycle.lock().map_err(|_| "runtime lifecycle lock poisoned".to_string())?;
        self.stopping.store(true, Ordering::Release);
        Ok(lifecycle)
    }

    fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }

    fn store_gateway(&self, child: CommandChild) -> Result<(), String> {
        self.store(&self.gateway, child, "inference gateway")
    }

    fn store_parapper(&self, child: CommandChild) -> Result<(), String> {
        self.store(&self.parapper, child, "Parapper")
    }

    fn has_model(&self, model_id: &str) -> Result<bool, String> {
        self.models
            .lock()
            .map(|models| models.contains_key(model_id))
            .map_err(|_| "model sidecar lock poisoned".to_string())
    }

    /// Snapshot process slots for diagnostics without exposing child handles.
    pub fn active_sidecar(&self, id: &str) -> Result<bool, String> {
        match id {
            "kotoba-inference-gateway" => self
                .gateway
                .lock()
                .map(|child| child.is_some())
                .map_err(|_| "gateway child lock poisoned".to_string()),
            "kotoba-parapper" => self
                .parapper
                .lock()
                .map(|child| child.is_some())
                .map_err(|_| "Parapper child lock poisoned".to_string()),
            model_id => self.has_model(model_id),
        }
    }

    fn store_model(&self, model_id: &str, child: CommandChild) -> Result<(), String> {
        let mut models =
            self.models.lock().map_err(|_| "model sidecar lock poisoned".to_string())?;
        if models.contains_key(model_id) {
            let _ = child.kill();
            return Err(format!("model server {model_id} is already running"));
        }
        models.insert(model_id.to_string(), child);
        Ok(())
    }

    fn forget_sidecar(&self, id: &str, pid: u32) {
        let slot = match id {
            "kotoba-inference-gateway" | "kotoba_inference_gateway" => &self.gateway,
            "kotoba-parapper" | "kotoba_parapper" => &self.parapper,
            _ => return,
        };
        let Ok(mut child) = slot.lock() else { return };
        // A restart can replace the slot before the old monitor observes
        // its Terminated event. Only clear the child that actually
        // emitted this event; never hide the replacement process.
        let Some(current) = child.as_ref() else { return };
        if current.pid() == pid {
            child.take();
        }
    }

    fn forget_model(&self, model_id: &str, pid: u32) {
        let Ok(mut models) = self.models.lock() else { return };
        let Some(current) = models.get(model_id) else { return };
        if current.pid() == pid {
            models.remove(model_id);
        }
    }

    fn store(
        &self,
        slot: &Mutex<Option<CommandChild>>,
        child: CommandChild,
        label: &str,
    ) -> Result<(), String> {
        let mut slot = slot.lock().map_err(|_| format!("{label} child lock poisoned"))?;
        if slot.is_some() {
            let _ = child.kill();
            return Err(format!("{label} is already running"));
        }
        *slot = Some(child);
        Ok(())
    }

    fn stop_parapper(&self) {
        stop_child(&self.parapper, "kotoba_parapper");
    }

    fn stop_models_except(&self, active_model_ids: &HashSet<&str>) {
        let stopped = match self.models.lock() {
            Ok(mut models) => models
                .extract_if(|model_id, _| !active_model_ids.contains(model_id.as_str()))
                .collect::<Vec<_>>(),
            Err(_) => {
                log::error!(target: "kotoba_llama_server", "model sidecar lock poisoned during shutdown");
                return;
            }
        };
        for (model_id, child) in stopped {
            stop_model_child(&model_id, child);
        }
    }

    fn stop_models(&self) {
        self.stop_models_except(&HashSet::new());
    }

    fn stop_all(&self) {
        stop_child(&self.gateway, "kotoba_inference_gateway");
        stop_child(&self.parapper, "kotoba_parapper");
        self.stop_models();
    }
}

fn default_gateway_config() -> serde_json::Value {
    serde_json::json!({
        "listen": { "host": "127.0.0.1", "port": GATEWAY_PORT },
        "parapper": {
            "url": "ws://127.0.0.1:18082/ws/recognition",
            "timeoutMs": 18_000
        },
        "models": model_runtime::gateway_routes(),
    })
}

pub fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve app config directory: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create app config directory: {error}"))?;
    let path = dir.join("gateway.config.json");
    // This is an internal implementation detail rather than a user-facing
    // configuration file. Recreate it so updates to the fixed model route
    // catalog also reach installations created by older application builds.
    let body = serde_json::to_vec_pretty(&default_gateway_config())
        .map_err(|error| format!("could not serialize embedded gateway config: {error}"))?;
    std::fs::write(&path, body)
        .map_err(|error| format!("could not write embedded gateway config: {error}"))?;
    Ok(path)
}

fn parapper_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve app data directory: {error}"))?
        .join("parapper");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create Parapper runtime directory: {error}"))?;
    Ok(dir)
}

fn model_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = model_runtime::model_runtime_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create model runtime directory: {error}"))?;
    Ok(dir)
}

#[cfg(windows)]
fn parapper_runtime_path(app: &AppHandle) -> Result<OsString, String> {
    resource_runtime_path(app, "parapper-runtime")
}

#[cfg(windows)]
fn model_server_runtime_path(
    app: &AppHandle,
    server: model_runtime::ModelServer,
) -> Result<OsString, String> {
    let runtime = match server {
        model_runtime::ModelServer::Zenz => "zenz-runtime",
        model_runtime::ModelServer::Llama => "llama-runtime",
    };
    resource_runtime_path(app, runtime)
}

#[cfg(windows)]
fn resource_runtime_path(app: &AppHandle, runtime_name: &str) -> Result<OsString, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("could not resolve bundled resource directory: {error}"))?;
    let runtime_dir = resource_dir.join(runtime_name);
    let mut paths = vec![runtime_dir];
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(paths)
        .map_err(|error| format!("could not construct Parapper DLL search path: {error}"))
}

fn map_gateway_resolution_error<T, E, F>(result: Result<T, E>, cleanup: F) -> Result<T, String>
where
    E: std::fmt::Display,
    F: FnOnce(),
{
    result.map_err(|error| {
        cleanup();
        format!("could not resolve embedded inference gateway: {error}")
    })
}

pub fn start(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    config.validate()?;
    clear_sidecar_ports();
    let config_path = config_path(app)?;
    let services = app.state::<RuntimeServices>();
    let _lifecycle = services.begin_start()?;
    let runtime_dir = parapper_runtime_dir(app)?;
    let parapper_args = parapper_headless_args(config);
    let parapper_command = app
        .shell()
        .sidecar("kotoba-parapper")
        .map_err(|error| format!("could not resolve embedded Parapper service: {error}"))?
        .args(parapper_args)
        .env("PARAPPER_RUNTIME_DIR", &runtime_dir);
    #[cfg(windows)]
    let parapper_command = parapper_command.env("PATH", parapper_runtime_path(app)?);
    let (parapper_events, parapper_child) = parapper_command
        .spawn()
        .map_err(|error| format!("could not start embedded Parapper service: {error}"))?;
    let parapper_pid = parapper_child.pid();
    services.store_parapper(parapper_child)?;
    monitor_sidecar(parapper_events, app.clone(), "kotoba_parapper", parapper_pid);
    log::info!(
        target: "kotoba_parapper",
        "started headless recognition service with runtime data {} (vad_interval_ms={} vad_threshold={:.3} interim_result_silence_ms={} turn_check_silence_ms={} turn_detector={} interim_result_enabled={} rerecognize_full_on_complete={} noise_cancellation_enabled={} streaming_interim_asr_enabled={} interim_asr_model={})",
        runtime_dir.display(),
        config.audio.vad_interval_ms,
        config.audio.vad_threshold,
        PARAPPER_INTERIM_RESULT_SILENCE_MS,
        PARAPPER_TURN_CHECK_SILENCE_MS,
        PARAPPER_TURN_DETECTOR,
        PARAPPER_INTERIM_RESULT_ENABLED,
        PARAPPER_RERECOGNIZE_FULL_ON_COMPLETE,
        config.audio.noise_suppression,
        config.audio.streaming_interim_asr_enabled,
        streaming_interim_asr_cli_value(config.audio.streaming_interim_asr_enabled),
    );

    let gateway_command =
        map_gateway_resolution_error(app.shell().sidecar("kotoba-inference-gateway"), || {
            services.stop_parapper()
        })?;
    let (gateway_events, gateway_child) = gateway_command
        .args(["--config", config_path.to_string_lossy().as_ref()])
        .spawn()
        .map_err(|error| {
            services.stop_parapper();
            format!("could not start embedded inference gateway: {error}")
        })?;
    let gateway_pid = gateway_child.pid();
    if let Err(error) = services.store_gateway(gateway_child) {
        services.stop_parapper();
        return Err(error);
    }
    monitor_sidecar(gateway_events, app.clone(), "kotoba_inference_gateway", gateway_pid);
    log::info!(
        target: "kotoba_inference_gateway",
        "started with configuration {}",
        config_path.display()
    );
    schedule_model_reconciliation(app.clone(), config.clone());
    Ok(())
}

/// Build the explicit command-line contract used by the bundled Parapper
/// sidecar. Keeping this as a pure helper makes it possible to test that the
/// desktop settings are not silently dropped when the process is restarted.
fn parapper_headless_args(config: &AppConfig) -> Vec<String> {
    parapper_headless_args_with_noise_cancellation(config, config.audio.noise_suppression)
}

fn streaming_interim_asr_cli_value(enabled: bool) -> &'static str {
    if enabled {
        STREAMING_INTERIM_ASR_MODEL_ID
    } else {
        STREAMING_INTERIM_ASR_MODEL_OFF
    }
}

fn parapper_headless_args_with_noise_cancellation(
    config: &AppConfig,
    noise_cancellation_enabled: bool,
) -> Vec<String> {
    vec![
        "--headless".to_string(),
        "--port".to_string(),
        PARAPPER_PORT.to_string(),
        "--vad-interval-ms".to_string(),
        config.audio.vad_interval_ms.to_string(),
        "--vad-threshold".to_string(),
        config.audio.vad_threshold.to_string(),
        "--interim-result-silence-ms".to_string(),
        PARAPPER_INTERIM_RESULT_SILENCE_MS.to_string(),
        "--turn-check-silence-ms".to_string(),
        PARAPPER_TURN_CHECK_SILENCE_MS.to_string(),
        "--noise-cancellation-enabled".to_string(),
        noise_cancellation_enabled.to_string(),
        "--interim-asr-model".to_string(),
        streaming_interim_asr_cli_value(config.audio.streaming_interim_asr_enabled).to_string(),
    ]
}

/// Ensures that the bundled llama.cpp servers match the selected local models.
/// A missing GGUF is fetched into the writable app-data directory before its
/// server begins accepting requests.
pub async fn reconcile_models(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let desired = model_runtime::selected_specs(config)?;
    let active_ids = desired.iter().map(|spec| spec.id).collect::<HashSet<_>>();
    let services = app.state::<RuntimeServices>();
    let models_dir = model_runtime_dir(app)?;
    let _reconciliation = services.model_reconciliation.lock().await;

    for spec in desired {
        if services.is_stopping() {
            return Ok(());
        }
        reconcile_model_spec(app, &services, &models_dir, spec).await?;
    }
    services.stop_models_except(&active_ids);
    Ok(())
}

async fn reconcile_model_spec(
    app: &AppHandle,
    services: &RuntimeServices,
    models_dir: &std::path::Path,
    spec: &ModelRuntimeSpec,
) -> Result<(), String> {
    ensure_model_server(app, services, models_dir, spec).await?;
    if services.is_stopping() {
        return Ok(());
    }
    wait_for_model_server(spec).await
}

async fn ensure_model_server(
    app: &AppHandle,
    services: &RuntimeServices,
    models_dir: &std::path::Path,
    spec: &ModelRuntimeSpec,
) -> Result<(), String> {
    if services.has_model(spec.id)? {
        return Ok(());
    }
    let model_path = model_runtime::ensure_downloaded(spec, models_dir).await?;
    if services.is_stopping() {
        return Ok(());
    }
    if services.has_model(spec.id)? {
        return Ok(());
    }
    start_model_server(app, services, &model_path, spec)
}

/// Blocks until the inference gateway (and local Parapper, when configured) accept
/// traffic. Call this before opening the microphone so the first audio chunk is not
/// lost to connection-refused errors during sidecar startup / first-run model fetch.
pub async fn ensure_services_ready(config: &AppConfig) -> Result<(), String> {
    let base = config.endpoint.base_url.trim_end_matches('/');
    let health_url = format!("{base}/health");
    wait_for_http_ok(&health_url, "inference gateway", SERVICE_READY_ATTEMPTS).await?;
    if config.endpoint.mode == "local" {
        wait_for_tcp("127.0.0.1", PARAPPER_PORT, "Parapper recognition", PARAPPER_READY_ATTEMPTS)
            .await?;
    }
    Ok(())
}

/// Lightweight readiness snapshot for the Debug panel.
pub async fn probe_service_health(config: &AppConfig) -> serde_json::Value {
    let base = config.endpoint.base_url.trim_end_matches('/');
    let gateway = probe_http(&format!("{base}/health")).await;
    let mut parapper = probe_tcp("127.0.0.1", PARAPPER_PORT).await;
    add_parapper_vad_diagnostics(&mut parapper, config);
    serde_json::json!({
        "gateway": gateway,
        "parapper": parapper,
        "gatewayPort": GATEWAY_PORT,
        "parapperPort": PARAPPER_PORT,
    })
}

/// Return a support-safe version/health snapshot for every bundled sidecar.
///
/// The process command line and child output are intentionally omitted. A
/// sidecar can print request headers or prompts on stdout/stderr, so the Debug
/// panel receives only static identifiers, build metadata, ports, and health
/// booleans/status codes.
pub async fn probe_sidecar_statuses(
    config: &AppConfig,
    services: &RuntimeServices,
) -> Vec<serde_json::Value> {
    let base = config.endpoint.base_url.trim_end_matches('/');
    let gateway_url = format!("{base}/health");
    let gateway_health = probe_http(&gateway_url).await;
    let parapper_health = probe_tcp("127.0.0.1", PARAPPER_PORT).await;
    let mut rows = vec![sidecar_status(
        "kotoba-inference-gateway",
        "gateway",
        option_env!("KOTOBA_GATEWAY_VERSION").unwrap_or("0.1.0"),
        "build metadata",
        services.active_sidecar("kotoba-inference-gateway").unwrap_or(false),
        gateway_health,
        Some(GATEWAY_PORT),
    )];
    rows.push(sidecar_status(
        "kotoba-parapper",
        "asr",
        option_env!("KOTOBA_PARAPPER_VERSION").unwrap_or("0.3.0"),
        "build metadata",
        services.active_sidecar("kotoba-parapper").unwrap_or(false),
        parapper_health,
        Some(PARAPPER_PORT),
    ));
    if let Some(parapper) = rows.get_mut(1) {
        add_parapper_vad_diagnostics(parapper, config);
    }

    for runtime in model_runtime::all_specs() {
        let url = format!("http://127.0.0.1:{}/health", runtime.port);
        let health = probe_http_with_timeout(&url, Duration::from_millis(500)).await;
        rows.push(sidecar_status(
            runtime.id,
            match runtime.server {
                model_runtime::ModelServer::Zenz => "normalizer",
                model_runtime::ModelServer::Llama => "translator",
            },
            "bundled",
            "runtime spec",
            services.active_sidecar(runtime.id).unwrap_or(false),
            health,
            Some(runtime.port),
        ));
    }
    for row in &rows {
        log::info!(
            target: "kotoba_runtime",
            "sidecar id={} kind={} version={} health={} active={} port={}",
            row.get("id").and_then(serde_json::Value::as_str).unwrap_or("unknown"),
            row.get("kind").and_then(serde_json::Value::as_str).unwrap_or("runtime"),
            row.get("version").and_then(serde_json::Value::as_str).unwrap_or("unknown"),
            row.get("health").and_then(serde_json::Value::as_str).unwrap_or("unknown"),
            row.get("active").and_then(serde_json::Value::as_bool).unwrap_or(false),
            row.get("port").and_then(serde_json::Value::as_u64).unwrap_or(0),
        );
    }
    rows
}

fn add_parapper_vad_diagnostics(value: &mut serde_json::Value, config: &AppConfig) {
    if let Some(object) = value.as_object_mut() {
        object.insert("vadIntervalMs".to_string(), serde_json::json!(config.audio.vad_interval_ms));
        object.insert("vadThreshold".to_string(), serde_json::json!(config.audio.vad_threshold));
        object.insert(
            "interimResultSilenceMs".to_string(),
            serde_json::json!(PARAPPER_INTERIM_RESULT_SILENCE_MS),
        );
        object.insert(
            "turnCheckSilenceMs".to_string(),
            serde_json::json!(PARAPPER_TURN_CHECK_SILENCE_MS),
        );
        object.insert("turnDetector".to_string(), serde_json::json!(PARAPPER_TURN_DETECTOR));
        object.insert(
            "interimResultEnabled".to_string(),
            serde_json::json!(PARAPPER_INTERIM_RESULT_ENABLED),
        );
        object.insert(
            "rerecognizeFullOnComplete".to_string(),
            serde_json::json!(PARAPPER_RERECOGNIZE_FULL_ON_COMPLETE),
        );
        object.insert(
            "noiseCancellationEnabled".to_string(),
            serde_json::json!(config.audio.noise_suppression),
        );
        object.insert(
            "streamingInterimAsrEnabled".to_string(),
            serde_json::json!(config.audio.streaming_interim_asr_enabled),
        );
        object.insert(
            "interimAsrModel".to_string(),
            serde_json::json!(streaming_interim_asr_cli_value(
                config.audio.streaming_interim_asr_enabled
            )),
        );
    }
}

fn sidecar_status(
    id: &str,
    kind: &str,
    version: &str,
    version_source: &str,
    active: bool,
    health: serde_json::Value,
    port: Option<u16>,
) -> serde_json::Value {
    let ok = health.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let health_state = if ok {
        "healthy"
    } else if active {
        "unhealthy"
    } else {
        "inactive"
    };
    serde_json::json!({
        "id": id,
        "kind": kind,
        "version": version,
        "versionSource": version_source,
        "health": health_state,
        "healthUrl": health.get("url").cloned().unwrap_or(serde_json::Value::Null),
        "port": port,
        "active": active,
        "lastError": health.get("error").cloned().unwrap_or(serde_json::Value::Null),
        "startedAt": serde_json::Value::Null,
        "switchResult": serde_json::Value::Null,
    })
}

async fn wait_for_http_ok(url: &str, label: &str, attempts: u32) -> Result<(), String> {
    for attempt in 1..=attempts {
        if http_request_succeeded(url).await {
            return Ok(());
        }
        if attempt == attempts {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err(format!(
        "{label} did not become ready at {url} within {attempts}s. \
         Check that the embedded inference gateway sidecar is running."
    ))
}

async fn http_request_succeeded(url: &str) -> bool {
    reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

async fn wait_for_tcp(host: &str, port: u16, label: &str, attempts: u32) -> Result<(), String> {
    for attempt in 1..=attempts {
        if tokio::net::TcpStream::connect((host, port)).await.is_ok() {
            return Ok(());
        }
        if attempt == attempts {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err(format!(
        "{label} did not become ready on {host}:{port} within {attempts}s. \
         On first launch Parapper downloads ASR models into app data; wait and retry, \
         or inspect the kotoba-beacon-parapper log."
    ))
}

async fn probe_http(url: &str) -> serde_json::Value {
    probe_http_with_timeout(url, Duration::from_secs(2)).await
}

async fn probe_http_with_timeout(url: &str, timeout: Duration) -> serde_json::Value {
    match reqwest::Client::new().get(url).timeout(timeout).send().await {
        Ok(response) => serde_json::json!({
            "ok": response.status().is_success(),
            "status": response.status().as_u16(),
            "url": safe_health_url(url),
        }),
        Err(error) => serde_json::json!({
            "ok": false,
            "error": redact_runtime_error(&error.to_string()),
            "url": safe_health_url(url),
        }),
    }
}

async fn probe_tcp(host: &str, port: u16) -> serde_json::Value {
    match tokio::net::TcpStream::connect((host, port)).await {
        Ok(_) => serde_json::json!({ "ok": true, "host": host, "port": port }),
        Err(error) => serde_json::json!({
            "ok": false,
            "error": redact_runtime_error(&error.to_string()),
            "host": host,
            "port": port,
        }),
    }
}

/// Strip query/fragment and userinfo from a URL before diagnostics display it.
fn safe_health_url(url: &str) -> String {
    let without_fragment = url.split('#').next().unwrap_or(url);
    let without_query = without_fragment.split('?').next().unwrap_or(without_fragment);
    redact_health_url_userinfo(without_query).unwrap_or_else(|| without_query.to_string())
}

fn redact_health_url_userinfo(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let authority_start = scheme_end + 3;
    let path_offset = url[authority_start..].find('/')?;
    let authority_end = authority_start + path_offset;
    let authority = &url[authority_start..authority_end];
    let at = authority.rfind('@')?;
    Some(format!(
        "{}://[REDACTED]@{}{}",
        &url[..scheme_end],
        &authority[at + 1..],
        &url[authority_end..]
    ))
}

fn redact_runtime_error(error: &str) -> String {
    let mut value = error.to_string();
    for marker in [
        "access_token=",
        "refresh_token=",
        "id_token=",
        "api_key=",
        "apikey=",
        "token=",
        "secret=",
        "password=",
    ] {
        let lower = value.to_ascii_lowercase();
        if let Some(start) = lower.find(marker) {
            let end = value[start + marker.len()..]
                .find(['&', '#', ' ', '\n', '\r'])
                .map(|offset| start + marker.len() + offset)
                .unwrap_or(value.len());
            value.replace_range(start + marker.len()..end, "[REDACTED]");
        }
    }
    value
}

fn schedule_model_reconciliation(app: AppHandle, config: AppConfig) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = reconcile_models(&app, &config).await {
            log::error!(
                target: "kotoba_model_download",
                "could not prepare selected models: {}",
                redact_runtime_error(&error)
            );
        }
    });
}

pub fn shutdown(app: &AppHandle) {
    let services = app.state::<RuntimeServices>();
    match services.begin_shutdown() {
        Ok(_lifecycle) => services.stop_all(),
        Err(error) => log::error!(
            target: "kotoba_runtime",
            "could not acquire runtime lifecycle lock: {error}"
        ),
    };
}

fn safe_sidecar_event(line: &str) -> Option<&'static str> {
    [
        ("session start", "session-start"),
        ("session completed", "session-completed"),
        ("session done without final transcript", "no-final-transcript"),
        ("Streaming recognition client connected", "recognition-connected"),
        ("Streaming recognition client disconnected", "recognition-disconnected"),
    ]
    .iter()
    .find_map(|(needle, label)| line.contains(needle).then_some(*label))
}

fn log_sidecar_stdout(target: &'static str, line: &[u8]) {
    let text = std::str::from_utf8(line).unwrap_or_default();
    if let Some(event) = safe_sidecar_event(text) {
        log::info!(
            target: target,
            "sidecar stdout event={} ({} bytes)",
            event,
            line.len()
        );
    } else {
        log::info!(target: target, "sidecar stdout received ({} bytes)", line.len());
    }
}

fn monitor_sidecar(
    events: tauri::async_runtime::Receiver<CommandEvent>,
    app: AppHandle,
    target: &'static str,
    pid: u32,
) {
    tauri::async_runtime::spawn(run_sidecar_monitor(events, app, target, pid));
}

async fn run_sidecar_monitor(
    mut events: tauri::async_runtime::Receiver<CommandEvent>,
    app: AppHandle,
    target: &'static str,
    pid: u32,
) {
    while let Some(event) = events.recv().await {
        if handle_sidecar_event(event, target) {
            break;
        }
    }
    // A closed event channel is also terminal from the monitor's point of
    // view. Reconcile the slot so diagnostics and a later start do not retain
    // a dead child when the shell plugin omitted its Terminated event.
    app.state::<RuntimeServices>().forget_sidecar(target, pid);
}

fn handle_sidecar_event(event: CommandEvent, target: &'static str) -> bool {
    match event {
        CommandEvent::Stderr(line) => {
            // Sidecars may echo request headers or model prompts. Keep
            // native logs useful for health triage without persisting
            // arbitrary process output (which can contain secrets).
            log::warn!(target: target, "sidecar stderr received ({} bytes)", line.len());
            false
        }
        CommandEvent::Error(error) => {
            log::error!(target: target, "{}", redact_runtime_error(&error));
            false
        }
        CommandEvent::Terminated(status) => {
            log::warn!(
                target: target,
                "exited (code={:?}, signal={:?})",
                status.code,
                status.signal
            );
            true
        }
        CommandEvent::Stdout(line) => {
            log_sidecar_stdout(target, &line);
            false
        }
        _ => false,
    }
}

fn start_model_server(
    app: &AppHandle,
    services: &RuntimeServices,
    model_path: &std::path::Path,
    spec: &ModelRuntimeSpec,
) -> Result<(), String> {
    let _lifecycle =
        services.lifecycle.lock().map_err(|_| "runtime lifecycle lock poisoned".to_string())?;
    if services.is_stopping() {
        return Ok(());
    }
    let command = app
        .shell()
        .sidecar(spec.server.sidecar_name())
        .map_err(|error| format!("could not resolve bundled model server: {error}"))?
        .args(model_runtime::sidecar_arguments(spec, model_path));
    #[cfg(windows)]
    let command = command.env("PATH", model_server_runtime_path(app, spec.server)?);
    let (events, child) = command
        .spawn()
        .map_err(|error| format!("could not start model server {}: {error}", spec.id))?;
    let child_pid = child.pid();
    services.store_model(spec.id, child)?;
    monitor_model_sidecar(events, app.clone(), spec.id, child_pid);
    log::info!(
        target: "kotoba_llama_server",
        "started bundled model server {} with model path {}",
        spec.id,
        model_path.display()
    );
    Ok(())
}

async fn wait_for_model_server(spec: &ModelRuntimeSpec) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/health", spec.port);
    for _ in 0..120 {
        if model_request_succeeded(&url).await {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    Err(format!("model server {} did not become ready at {url}", spec.id))
}

async fn model_request_succeeded(url: &str) -> bool {
    reqwest::get(url).await.map(|response| response.status().is_success()).unwrap_or(false)
}

fn monitor_model_sidecar(
    events: tauri::async_runtime::Receiver<CommandEvent>,
    app: AppHandle,
    model_id: &'static str,
    pid: u32,
) {
    tauri::async_runtime::spawn(run_model_sidecar_monitor(events, app, model_id, pid));
}

async fn run_model_sidecar_monitor(
    mut events: tauri::async_runtime::Receiver<CommandEvent>,
    app: AppHandle,
    model_id: &'static str,
    pid: u32,
) {
    while let Some(event) = events.recv().await {
        if handle_model_sidecar_event(event, &app, model_id, pid) {
            break;
        }
    }
    app.state::<RuntimeServices>().forget_model(model_id, pid);
}

fn handle_model_sidecar_event(
    event: CommandEvent,
    app: &AppHandle,
    model_id: &'static str,
    pid: u32,
) -> bool {
    match event {
        CommandEvent::Stderr(line) => {
            log::warn!(
                target: "kotoba_llama_server",
                "{}: sidecar stderr received ({} bytes)",
                model_id,
                line.len()
            );
            false
        }
        CommandEvent::Error(error) => {
            log::error!(
                target: "kotoba_llama_server",
                "{model_id}: {}",
                redact_runtime_error(&error)
            );
            false
        }
        CommandEvent::Terminated(status) => {
            log::warn!(
                target: "kotoba_llama_server",
                "{model_id} exited (code={:?}, signal={:?})",
                status.code,
                status.signal
            );
            app.state::<RuntimeServices>().forget_model(model_id, pid);
            true
        }
        CommandEvent::Stdout(line) => {
            log::info!(
                target: "kotoba_llama_server",
                "{}: sidecar stdout received ({} bytes)",
                model_id,
                line.len()
            );
            false
        }
        _ => false,
    }
}

fn stop_child(slot: &Mutex<Option<CommandChild>>, target: &'static str) {
    let child = match slot.lock() {
        Ok(mut slot) => slot.take(),
        Err(_) => {
            log::error!(target: target, "child lock poisoned during shutdown");
            None
        }
    };
    if let Some(child) = child {
        if let Err(error) = child.kill() {
            log::warn!(target: target, "could not stop child process: {error}");
        } else {
            log::info!(target: target, "stopped child process");
        }
    }
}

fn stop_model_child(model_id: &str, child: CommandChild) {
    if let Err(error) = child.kill() {
        log::warn!(target: "kotoba_llama_server", "could not stop {model_id}: {error}");
    } else {
        log::info!(target: "kotoba_llama_server", "stopped {model_id}");
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        add_parapper_vad_diagnostics, default_gateway_config, map_gateway_resolution_error,
        parapper_headless_args, parapper_headless_args_with_noise_cancellation,
        redact_runtime_error, safe_health_url, safe_sidecar_event, AppConfig, PARAPPER_PORT,
    };

    #[test]
    fn gateway_resolution_failure_runs_cleanup_before_returning_error() {
        let mut cleaned_up = false;
        let result =
            map_gateway_resolution_error(Result::<(), &str>::Err("sidecar is not bundled"), || {
                cleaned_up = true
            });

        assert_eq!(
            result.unwrap_err(),
            "could not resolve embedded inference gateway: sidecar is not bundled"
        );
        assert!(cleaned_up);
    }

    #[test]
    fn embedded_gateway_defaults_to_loopback_only() {
        let config = default_gateway_config();
        assert_eq!(config["listen"]["host"], "127.0.0.1");
        assert_eq!(config["listen"]["port"], 8765);
        assert_eq!(config["parapper"]["url"], "ws://127.0.0.1:18082/ws/recognition");
    }

    #[test]
    fn embedded_parapper_uses_the_gateway_websocket_port() {
        assert_eq!(PARAPPER_PORT, 18_082);
    }

    #[test]
    fn embedded_parapper_receives_desktop_vad_settings_on_startup() {
        let mut config = AppConfig::default();
        config.audio.vad_interval_ms = 64;
        config.audio.vad_threshold = 0.25;

        assert_eq!(
            parapper_headless_args(&config),
            vec![
                "--headless",
                "--port",
                "18082",
                "--vad-interval-ms",
                "64",
                "--vad-threshold",
                "0.25",
                "--interim-result-silence-ms",
                "96",
                "--turn-check-silence-ms",
                "960",
                "--noise-cancellation-enabled",
                "true",
                "--interim-asr-model",
                "none",
            ],
        );
    }

    #[test]
    fn embedded_parapper_can_enable_streaming_interim_asr() {
        let mut config = AppConfig::default();
        config.audio.streaming_interim_asr_enabled = true;
        let args = parapper_headless_args(&config);

        assert!(args.ends_with(&[
            "--interim-asr-model".to_string(),
            "nemotron_3_5_asr_streaming_0_6b_160ms_int8".to_string(),
        ]));
    }

    #[test]
    fn embedded_parapper_defaults_streaming_interim_asr_off() {
        let config = AppConfig::default();
        let args = parapper_headless_args(&config);

        assert!(args.ends_with(&["--interim-asr-model".to_string(), "none".to_string(),]));
    }

    #[test]
    fn embedded_parapper_can_disable_noise_cancellation_for_parent_diagnostics() {
        let config = AppConfig::default();
        let args = parapper_headless_args_with_noise_cancellation(&config, false);

        assert!(args.windows(2).any(|window| {
            window == ["--noise-cancellation-enabled".to_string(), "false".to_string()]
        }));
        assert!(args.ends_with(&["--interim-asr-model".to_string(), "none".to_string(),]));
    }

    #[test]
    fn parapper_health_diagnostics_include_effective_vad_settings() {
        let mut config = AppConfig::default();
        config.audio.vad_interval_ms = 128;
        config.audio.vad_threshold = 1.0;
        let mut health = serde_json::json!({ "ok": true });

        add_parapper_vad_diagnostics(&mut health, &config);

        assert_eq!(health["vadIntervalMs"], 128);
        assert_eq!(health["vadThreshold"], 1.0);
        assert_eq!(health["interimResultSilenceMs"], 96);
        assert_eq!(health["turnCheckSilenceMs"], 960);
        assert_eq!(health["turnDetector"], "namo");
        assert_eq!(health["interimResultEnabled"], true);
        assert_eq!(health["rerecognizeFullOnComplete"], true);
        assert_eq!(health["noiseCancellationEnabled"], true);
        assert_eq!(health["streamingInterimAsrEnabled"], false);
        assert_eq!(health["interimAsrModel"], "none");
    }

    #[test]
    fn embedded_gateway_routes_every_bundled_model_server() {
        let config = default_gateway_config();
        assert_eq!(config["models"].as_object().expect("model map").len(), 7);
        assert_eq!(config["models"]["hy-mt2-7b-gguf"]["baseUrl"], "http://127.0.0.1:8086");
    }

    #[test]
    fn parapper_runtime_data_is_separate_from_gateway_configuration() {
        let base = Path::new("/tmp/kotoba-beacon");
        assert_eq!(base.join("parapper"), Path::new("/tmp/kotoba-beacon/parapper"));
    }

    #[test]
    fn diagnostics_strip_credentials_from_health_urls_and_errors() {
        assert_eq!(
            safe_health_url("https://user:password@example.test/health?access_token=secret"),
            "https://[REDACTED]@example.test/health"
        );
        let redacted = redact_runtime_error("request failed api_key=abc123&status=503");
        assert!(!redacted.contains("abc123"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn sidecar_event_summary_keeps_only_safe_marker_names() {
        assert_eq!(
            safe_sidecar_event("session completed { token: secret-value }"),
            Some("session-completed")
        );
        assert_eq!(
            safe_sidecar_event("Streaming recognition client connected"),
            Some("recognition-connected")
        );
        assert_eq!(safe_sidecar_event("model logits: [0.1, 0.2]"), None);
    }
}
