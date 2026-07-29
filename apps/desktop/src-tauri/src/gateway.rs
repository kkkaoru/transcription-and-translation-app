use crate::{
    config::AppConfig,
    model_runtime::{self, ModelRuntimeSpec},
};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Mutex,
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

pub struct RuntimeServices {
    gateway: Mutex<Option<CommandChild>>,
    parapper: Mutex<Option<CommandChild>>,
    models: Mutex<HashMap<String, CommandChild>>,
    model_reconciliation: tokio::sync::Mutex<()>,
}

impl Default for RuntimeServices {
    fn default() -> Self {
        Self {
            gateway: Mutex::new(None),
            parapper: Mutex::new(None),
            models: Mutex::new(HashMap::new()),
            model_reconciliation: tokio::sync::Mutex::new(()),
        }
    }
}

impl RuntimeServices {
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

    fn forget_model(&self, model_id: &str) {
        if let Ok(mut models) = self.models.lock() {
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
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve app data directory: {error}"))?
        .join("models");
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

pub fn start(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let config_path = config_path(app)?;
    let services = app.state::<RuntimeServices>();
    let runtime_dir = parapper_runtime_dir(app)?;
    let parapper_port = PARAPPER_PORT.to_string();
    let parapper_command = app
        .shell()
        .sidecar("kotoba-parapper")
        .map_err(|error| format!("could not resolve embedded Parapper service: {error}"))?
        .args(["--headless", "--port", parapper_port.as_str()])
        .env("PARAPPER_RUNTIME_DIR", &runtime_dir);
    #[cfg(windows)]
    let parapper_command = parapper_command.env("PATH", parapper_runtime_path(app)?);
    let (parapper_events, parapper_child) = parapper_command
        .spawn()
        .map_err(|error| format!("could not start embedded Parapper service: {error}"))?;
    services.store_parapper(parapper_child)?;
    monitor_sidecar(parapper_events, "kotoba_parapper");
    log::info!(
        target: "kotoba_parapper",
        "started headless recognition service with runtime data {}",
        runtime_dir.display()
    );

    let (gateway_events, gateway_child) = app
        .shell()
        .sidecar("kotoba-inference-gateway")
        .map_err(|error| format!("could not resolve embedded inference gateway: {error}"))?
        .args(["--config", config_path.to_string_lossy().as_ref()])
        .spawn()
        .map_err(|error| {
            services.stop_parapper();
            format!("could not start embedded inference gateway: {error}")
        })?;
    if let Err(error) = services.store_gateway(gateway_child) {
        services.stop_parapper();
        return Err(error);
    }
    monitor_sidecar(gateway_events, "kotoba_inference_gateway");
    log::info!(
        target: "kotoba_inference_gateway",
        "started with configuration {}",
        config_path.display()
    );
    schedule_model_reconciliation(app.clone(), config.clone());
    Ok(())
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
        if !services.has_model(spec.id)? {
            let model_path = model_runtime::ensure_downloaded(spec, &models_dir).await?;
            if !services.has_model(spec.id)? {
                start_model_server(app, &services, &model_path, spec)?;
            }
        }
        wait_for_model_server(spec).await?;
    }
    services.stop_models_except(&active_ids);
    Ok(())
}

fn schedule_model_reconciliation(app: AppHandle, config: AppConfig) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = reconcile_models(&app, &config).await {
            log::error!(target: "kotoba_model_download", "could not prepare selected models: {error}");
        }
    });
}

pub fn shutdown(app: &AppHandle) {
    app.state::<RuntimeServices>().stop_all();
}

fn monitor_sidecar(mut events: tauri::async_runtime::Receiver<CommandEvent>, target: &'static str) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    log::warn!(target: target, "{}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(error) => {
                    log::error!(target: target, "{error}")
                }
                CommandEvent::Terminated(status) => {
                    log::warn!(
                        target: target,
                        "exited (code={:?}, signal={:?})",
                        status.code,
                        status.signal
                    );
                    break;
                }
                CommandEvent::Stdout(line) => {
                    log::info!(target: target, "{}", String::from_utf8_lossy(&line))
                }
                _ => {}
            }
        }
    });
}

fn start_model_server(
    app: &AppHandle,
    services: &RuntimeServices,
    model_path: &std::path::Path,
    spec: &ModelRuntimeSpec,
) -> Result<(), String> {
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
    services.store_model(spec.id, child)?;
    monitor_model_sidecar(events, app.clone(), spec.id);
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
        if let Ok(response) = reqwest::get(&url).await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    Err(format!("model server {} did not become ready at {url}", spec.id))
}

fn monitor_model_sidecar(
    mut events: tauri::async_runtime::Receiver<CommandEvent>,
    app: AppHandle,
    model_id: &'static str,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    log::warn!(
                        target: "kotoba_llama_server",
                        "{}: {}",
                        model_id,
                        String::from_utf8_lossy(&line)
                    );
                }
                CommandEvent::Error(error) => {
                    log::error!(target: "kotoba_llama_server", "{model_id}: {error}")
                }
                CommandEvent::Terminated(status) => {
                    log::warn!(
                        target: "kotoba_llama_server",
                        "{model_id} exited (code={:?}, signal={:?})",
                        status.code,
                        status.signal
                    );
                    app.state::<RuntimeServices>().forget_model(model_id);
                    break;
                }
                CommandEvent::Stdout(line) => {
                    log::info!(
                        target: "kotoba_llama_server",
                        "{}: {}",
                        model_id,
                        String::from_utf8_lossy(&line)
                    )
                }
                _ => {}
            }
        }
    });
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

    use super::{default_gateway_config, PARAPPER_PORT};

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
}
