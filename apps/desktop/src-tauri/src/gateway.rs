use std::path::PathBuf;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{ShellExt, process::CommandEvent};

const GATEWAY_PORT: u16 = 8765;

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

pub fn start(app: &AppHandle) -> Result<(), String> {
    let config_path = config_path(app)?;
    let (mut events, _child) = app
        .shell()
        .sidecar("kotoba-inference-gateway")
        .map_err(|error| format!("could not resolve embedded inference gateway: {error}"))?
        .args(["--config", config_path.to_string_lossy().as_ref()])
        .spawn()
        .map_err(|error| format!("could not start embedded inference gateway: {error}"))?;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    log::warn!(
                        target: "kotoba_inference_gateway",
                        "{}",
                        String::from_utf8_lossy(&line)
                    );
                }
                CommandEvent::Error(error) => {
                    log::error!(target: "kotoba_inference_gateway", "{error}")
                }
                CommandEvent::Terminated(status) => {
                    log::warn!(
                        target: "kotoba_inference_gateway",
                        "exited (code={:?}, signal={:?})",
                        status.code, status.signal
                    );
                    break;
                }
                CommandEvent::Stdout(line) => {
                    log::info!(
                        target: "kotoba_inference_gateway",
                        "{}",
                        String::from_utf8_lossy(&line)
                    )
                }
                _ => {}
            }
        }
    });
    log::info!(
        target: "kotoba_inference_gateway",
        "started with configuration {}",
        config_path.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::default_gateway_config;

    #[test]
    fn embedded_gateway_defaults_to_loopback_only() {
        let config = default_gateway_config();
        assert_eq!(config["listen"]["host"], "127.0.0.1");
        assert_eq!(config["listen"]["port"], 8765);
        assert_eq!(
            config["parapper"]["url"],
            "ws://127.0.0.1:18082/ws/recognition"
        );
    }
}
