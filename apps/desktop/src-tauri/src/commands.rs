use crate::audio::{pcm_base64_to_wav, AudioChunk};
use crate::config::AppConfig;
use crate::gateway;
use crate::models::{catalog, ModelCatalog};
use crate::native_output::{NativeOutputHandle, OverlayFrame};
use crate::pipeline::CaptionPayload;
use crate::state::{AppState, RuntimeStatus};
use base64::Engine;
use serde::Deserialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOverlayFrame {
    pub rgba_base64: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    state.config.lock().map(|config| config.clone()).map_err(|_| "config lock poisoned".to_string())
}

#[tauri::command]
pub async fn save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: AppConfig,
) -> Result<(), String> {
    config.validate()?;
    gateway::reconcile_models(&app, &config).await?;
    if let Some(window) = app.get_webview_window("overlay") {
        window
            .set_size(LogicalSize::new(config.overlay.width as f64, config.overlay.height as f64))
            .map_err(|error| format!("could not resize overlay: {error}"))?;
        window
            .set_position(LogicalPosition::new(config.overlay.x as f64, config.overlay.y as f64))
            .map_err(|error| format!("could not move overlay: {error}"))?;
    }
    let config_path = config_path(&app)?;
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create config directory: {error}"))?;
    }
    let payload = serde_json::to_vec_pretty(&config)
        .map_err(|error| format!("could not serialize config: {error}"))?;
    std::fs::write(config_path, payload)
        .map_err(|error| format!("could not write config: {error}"))?;
    let native_output = NativeOutputHandle::new(config.overlay.width, config.overlay.height);
    let native_output_kind = native_output.kind().to_string();
    *state.config.lock().map_err(|_| "config lock poisoned".to_string())? = config.clone();
    *state.native_output.lock().map_err(|_| "native output lock poisoned".to_string())? =
        native_output;
    let next_status = {
        let mut status = state.status.lock().map_err(|_| "status lock poisoned".to_string())?;
        status.native_output = native_output_kind;
        status.clone()
    };
    app.emit("runtime:status", &next_status)
        .map_err(|error| format!("could not emit runtime status: {error}"))?;
    app.emit("config:update", &config).map_err(|error| format!("could not emit config: {error}"))
}

#[tauri::command]
pub fn list_models() -> ModelCatalog {
    catalog()
}

#[tauri::command]
pub fn get_runtime_status(state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    state.status.lock().map(|status| status.clone()).map_err(|_| "status lock poisoned".to_string())
}

#[tauri::command]
pub async fn start_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let config = state.config.lock().map_err(|_| "config lock poisoned".to_string())?.clone();
    // Ensure gateway / Parapper are accepting traffic before the frontend opens
    // the microphone, then bring up the selected local GGUF servers.
    gateway::ensure_services_ready(&config).await?;
    gateway::reconcile_models(&app, &config).await?;
    set_status(&app, &state, "capturing", None)
}

#[tauri::command]
pub fn stop_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    set_status(&app, &state, "idle", None)
}

#[tauri::command]
pub async fn transcribe_audio_chunk(
    app: AppHandle,
    state: State<'_, AppState>,
    chunk: AudioChunk,
) -> Result<CaptionPayload, String> {
    let wav = pcm_base64_to_wav(&chunk)?;
    let config = state.config.lock().map_err(|_| "config lock poisoned".to_string())?.clone();
    match state.pipeline.process(&config, wav).await {
        Ok(caption) => {
            let next_status = {
                if let Ok(mut status) = state.status.lock() {
                    status.backend_reachable = true;
                    status.last_error = None;
                    // A successful chunk must not flip a transient processing
                    // failure into a hard "error" session state — stay capturing.
                    if status.status == "error" {
                        status.status = "capturing".to_string();
                    }
                    Some(status.clone())
                } else {
                    None
                }
            };
            if let Some(status) = next_status {
                let _ = app.emit("runtime:status", &status);
            }
            app.emit("caption:update", &caption)
                .map_err(|error| format!("could not emit caption: {error}"))?;
            Ok(caption)
        }
        Err(error) => {
            let detail = error.to_string();
            // Keep the session in "capturing" so the frontend Stop control remains
            // available. Surface the concrete failure through last_error only.
            let next_status = {
                if let Ok(mut status) = state.status.lock() {
                    if status.status != "idle" && status.status != "starting" {
                        status.status = "capturing".to_string();
                    }
                    status.backend_reachable = false;
                    status.last_error = Some(detail.clone());
                    Some(status.clone())
                } else {
                    None
                }
            };
            if let Some(status) = next_status {
                let _ = app.emit("runtime:status", &status);
            }
            Err(detail)
        }
    }
}

#[tauri::command]
pub fn open_overlay(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.show().map_err(|error| format!("could not show overlay: {error}"))?;
        window.set_focus().map_err(|error| format!("could not focus overlay: {error}"))?;
        return Ok(());
    }
    let config = state.config.lock().map_err(|_| "config lock poisoned".to_string())?.clone();
    WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("index.html?overlay=1".into()))
        .title("Kotoba Beacon Overlay")
        .inner_size(config.overlay.width as f64, config.overlay.height as f64)
        .position(config.overlay.x as f64, config.overlay.y as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        // Output dimensions are configured numerically. Keeping the overlay fixed
        // prevents a user resize from desynchronizing the window and the native
        // Spout2/Syphon frame dimensions.
        .resizable(false)
        .build()
        .map(|_| ())
        .map_err(|error| format!("could not create overlay: {error}"))
}

#[tauri::command]
pub fn close_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.close().map_err(|error| format!("could not close overlay: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn publish_overlay_frame(
    window: WebviewWindow,
    state: State<'_, AppState>,
    frame: NativeOverlayFrame,
) -> Result<(), String> {
    ensure_overlay_window(window.label())?;
    let config = state.config.lock().map_err(|_| "config lock poisoned".to_string())?;
    validate_overlay_frame_dimensions(
        frame.width,
        frame.height,
        config.overlay.width,
        config.overlay.height,
    )?;
    drop(config);
    let rgba = base64::engine::general_purpose::STANDARD
        .decode(frame.rgba_base64)
        .map_err(|error| format!("invalid overlay frame base64: {error}"))?;
    let expected = usize::try_from(frame.width)
        .ok()
        .and_then(|width| {
            usize::try_from(frame.height).ok().map(|height| width.saturating_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "overlay frame dimensions are too large".to_string())?;
    if rgba.len() != expected {
        return Err("overlay frame byte length does not match dimensions".to_string());
    }
    state
        .native_output
        .lock()
        .map_err(|_| "native output lock poisoned".to_string())?
        .publish(OverlayFrame { rgba, width: frame.width, height: frame.height })
}

fn ensure_overlay_window(label: &str) -> Result<(), String> {
    if label == "overlay" {
        Ok(())
    } else {
        Err("native output frames may only be published by the overlay window".to_string())
    }
}

fn validate_overlay_frame_dimensions(
    frame_width: u32,
    frame_height: u32,
    output_width: u32,
    output_height: u32,
) -> Result<(), String> {
    if frame_width == output_width && frame_height == output_height {
        Ok(())
    } else {
        Err("overlay frame dimensions do not match the configured output resolution".to_string())
    }
}

fn set_status(
    app: &AppHandle,
    state: &State<'_, AppState>,
    status: &str,
    error: Option<String>,
) -> Result<(), String> {
    let next = {
        let mut current = state.status.lock().map_err(|_| "status lock poisoned".to_string())?;
        current.status = status.to_string();
        current.last_error = error;
        current.clone()
    };
    app.emit("runtime:status", &next)
        .map_err(|emit_error| format!("could not emit status: {emit_error}"))
}

#[tauri::command]
pub async fn get_debug_info(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let config = state.config.lock().map_err(|_| "config lock poisoned".to_string())?.clone();
    let status = state.status.lock().map_err(|_| "status lock poisoned".to_string())?.clone();
    let app_data = app.path().app_data_dir().unwrap_or_default();
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    let models_dir = app_data.join("models");
    let models: Vec<_> = crate::model_runtime::MODEL_RUNTIME_SPECS
        .iter()
        .map(|s| {
            let path = crate::model_runtime::model_path(&models_dir, s);
            let metadata = std::fs::metadata(&path).ok();
            let installed_bytes = metadata.as_ref().map(|m| m.len());
            let ready = installed_bytes == Some(s.expected_bytes);
            serde_json::json!({
                "id": s.id,
                "path": path.display().to_string(),
                "installed": path.exists(),
                "ready": ready,
                "installedBytes": installed_bytes,
                "expectedBytes": s.expected_bytes,
                "server": format!("{:?}", s.server),
                "port": s.port,
            })
        })
        .collect();
    let services = gateway::probe_service_health(&config).await;
    Ok(serde_json::json!({
        "config": serde_json::to_value(&config).unwrap_or_default(),
        "runtimeStatus": serde_json::to_value(&status).unwrap_or_default(),
        "services": services,
        "modelsDir": models_dir.display().to_string(),
        "configDir": config_dir.display().to_string(),
        "appDataDir": app_data.display().to_string(),
        "models": models,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve app config directory: {error}"))?
        .join("config.json"))
}

#[cfg(test)]
mod tests {
    use super::{ensure_overlay_window, validate_overlay_frame_dimensions};

    #[test]
    fn only_the_overlay_window_can_publish_a_native_frame() {
        assert!(ensure_overlay_window("overlay").is_ok());
        assert!(ensure_overlay_window("main").is_err());
    }

    #[test]
    fn native_frame_must_match_the_configured_output_resolution() {
        assert!(validate_overlay_frame_dimensions(1920, 1080, 1920, 1080).is_ok());
        assert!(validate_overlay_frame_dimensions(1280, 720, 1920, 1080).is_err());
    }
}
