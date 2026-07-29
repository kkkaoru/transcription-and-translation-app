use std::{path::PathBuf, sync::Mutex};

#[cfg(windows)]
use std::ffi::OsString;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const GATEWAY_PORT: u16 = 8765;
const PARAPPER_PORT: u16 = 18082;

#[derive(Default)]
pub struct RuntimeServices {
    gateway: Mutex<Option<CommandChild>>,
    parapper: Mutex<Option<CommandChild>>,
}

impl RuntimeServices {
    fn store_gateway(&self, child: CommandChild) -> Result<(), String> {
        self.store(&self.gateway, child, "inference gateway")
    }

    fn store_parapper(&self, child: CommandChild) -> Result<(), String> {
        self.store(&self.parapper, child, "Parapper")
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

    fn stop_all(&self) {
        stop_child(&self.gateway, "kotoba_inference_gateway");
        stop_child(&self.parapper, "kotoba_parapper");
    }
}

fn default_gateway_config() -> serde_json::Value {
    serde_json::json!({
        "listen": { "host": "127.0.0.1", "port": GATEWAY_PORT },
        "parapper": {
            "url": "ws://127.0.0.1:18082/ws/recognition",
            "timeoutMs": 18_000
        },
        "models": {
            "zenz-v3.2-xsmall-gguf": {
                "baseUrl": "http://127.0.0.1:8081",
                "servedModel": "zenz-v3.2-xsmall-gguf"
            },
            "zenz-v3.2-small-gguf": {
                "baseUrl": "http://127.0.0.1:8082",
                "servedModel": "zenz-v3.2-small-gguf"
            },
            "zenz-v2-q5-k-m-gguf": {
                "baseUrl": "http://127.0.0.1:8087",
                "servedModel": "zenz-v2-q5-k-m-gguf"
            },
            "hy-mt2-1.8b-gguf": {
                "baseUrl": "http://127.0.0.1:8083",
                "servedModel": "hy-mt2-1.8b-gguf"
            }
        }
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
    if !path.is_file() {
        let body = serde_json::to_vec_pretty(&default_gateway_config())
            .map_err(|error| format!("could not serialize embedded gateway config: {error}"))?;
        std::fs::write(&path, body)
            .map_err(|error| format!("could not write embedded gateway config: {error}"))?;
    }
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

#[cfg(windows)]
fn parapper_runtime_path(app: &AppHandle) -> Result<OsString, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("could not resolve bundled resource directory: {error}"))?;
    let runtime_dir = resource_dir.join("parapper-runtime");
    let mut paths = vec![runtime_dir];
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(paths)
        .map_err(|error| format!("could not construct Parapper DLL search path: {error}"))
}

pub fn start(app: &AppHandle) -> Result<(), String> {
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
    Ok(())
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
    fn parapper_runtime_data_is_separate_from_gateway_configuration() {
        let base = Path::new("/tmp/kotoba-beacon");
        assert_eq!(base.join("parapper"), Path::new("/tmp/kotoba-beacon/parapper"));
    }
}
