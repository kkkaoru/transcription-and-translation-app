use crate::audio::{pcm_base64_to_wav, AudioChunk};
use crate::config::AppConfig;
use crate::gateway;
use crate::models::{catalog, ModelCatalog};
use crate::native_output::{NativeOutputHandle, OverlayFrame};
use crate::pipeline::{CaptionPayload, PipelineStageEvent};
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
    // Stage 1: ASR + normalize only. Return as soon as source text is ready so
    // the frontend chunkQueue is not blocked on translation latency.
    // Each stage is emitted immediately via on_stage (do not wait for full pipeline).
    // Progressive captions: raw ASR paints first, then normalized source if it changes.
    let mut stages: Vec<PipelineStageEvent> = Vec::with_capacity(3);
    let app_for_stages = app.clone();
    let config_for_stages = config.clone();
    let mut on_stage = move |stage: &PipelineStageEvent| {
        emit_pipeline_stage(&app_for_stages, &config_for_stages, stage);
    };
    let app_for_captions = app.clone();
    let mut on_caption = move |caption: &CaptionPayload| {
        if let Err(error) = app_for_captions.emit("caption:update", caption) {
            log::warn!("could not emit progressive caption: {error}");
        }
    };
    match state
        .pipeline
        .recognize_source(&config, wav, &mut stages, &mut on_stage, &mut on_caption)
        .await
    {
        Ok(Some(partial)) => {
            mark_backend_healthy(&app, &state);
            // Final normalized source was already emitted via on_caption when it
            // differed from raw ASR. Re-emit once so late subscribers / invoke
            // fallback always see the post-normalize string (no-op on the UI if
            // display fields are identical).
            let _ = app.emit("caption:update", &partial);

            // Stage 2: translate in the background with the same caption id.
            // UI already shows source_text; a later caption:update fills translation.
            let pipeline = state.pipeline.clone();
            let app_for_translate = app.clone();
            let config_for_translate = config.clone();
            let partial_for_translate = partial.clone();
            tauri::async_runtime::spawn(async move {
                let mut translate_stages: Vec<PipelineStageEvent> = Vec::with_capacity(1);
                let app_for_stage = app_for_translate.clone();
                let config_for_stage = config_for_translate.clone();
                let mut on_translate_stage = move |stage: &PipelineStageEvent| {
                    emit_pipeline_stage(&app_for_stage, &config_for_stage, stage);
                };
                match pipeline
                    .complete_translation(
                        &config_for_translate,
                        partial_for_translate,
                        &mut translate_stages,
                        &mut on_translate_stage,
                    )
                    .await
                {
                    Ok(final_caption) => {
                        let _ = app_for_translate.emit("caption:update", &final_caption);
                    }
                    Err(error) => {
                        // Keep the already-shown source caption; only surface last_error.
                        // translate stage event was already emitted via on_stage.
                        log::warn!("translation failed for progressive caption: {error}");
                        let detail = error.to_string();
                        if let Some(app_state) = app_for_translate.try_state::<AppState>() {
                            if let Ok(mut status) = app_state.status.lock() {
                                let mut dirty = false;
                                if status.status != "idle"
                                    && status.status != "starting"
                                    && status.status != "capturing"
                                {
                                    status.status = "capturing".to_string();
                                    dirty = true;
                                }
                                // Source ASR already succeeded; do not mark the whole
                                // backend unreachable solely because translation failed.
                                if status.last_error.as_deref() != Some(detail.as_str()) {
                                    status.last_error = Some(detail);
                                    dirty = true;
                                }
                                if dirty {
                                    let next = status.clone();
                                    drop(status);
                                    let _ = app_for_translate.emit("runtime:status", &next);
                                }
                            }
                        }
                    }
                }
            });

            Ok(partial)
        }
        Ok(None) => {
            // No speech in this chunk — keep capture healthy and do not toast.
            // ASR (and maybe normalize) stage events were already emitted.
            mark_backend_healthy(&app, &state);
            Ok(CaptionPayload {
                id: format!("silence-{}", chrono_like_millis()),
                source_text: String::new(),
                translation_text: String::new(),
                source_language: config.language.source,
                target_language: config.language.target,
                started_at: 0,
                received_at: 0,
                stage: "source",
                sequence: 0,
                is_final: false,
                confidence: None,
            })
        }
        Err(error) => {
            let detail = error.to_string();
            // Failed stage event was already emitted via on_stage.
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

/// Emit one stage immediately for DebugPanel progressive rows.
/// Always emits `pipeline:stage`; raises log detail when `debug.verboseLogging`.
fn emit_pipeline_stage(app: &AppHandle, config: &AppConfig, stage: &PipelineStageEvent) {
    if config.debug.verbose_logging {
        log::info!(
            target: "pipeline_stage",
            "stage={} model={} ok={} duration_ms={} started_at={} ended_at={} utterance={} in={} out={} err={:?}",
            stage.stage,
            stage.model_id,
            stage.ok,
            stage.duration_ms,
            stage.started_at,
            stage.at,
            stage.utterance_id,
            stage.input_snippet,
            stage.output_text,
            stage.error
        );
    } else {
        log::info!(
            target: "pipeline_stage",
            "stage={} model={} ok={} duration_ms={} started_at={} ended_at={} utterance={}",
            stage.stage,
            stage.model_id,
            stage.ok,
            stage.duration_ms,
            stage.started_at,
            stage.at,
            stage.utterance_id
        );
    }
    if let Err(error) = app.emit("pipeline:stage", stage) {
        log::warn!("could not emit pipeline:stage: {error}");
    }
}

fn mark_backend_healthy(app: &AppHandle, state: &State<'_, AppState>) {
    if let Ok(mut status) = state.status.lock() {
        let mut dirty = false;
        if !status.backend_reachable {
            status.backend_reachable = true;
            dirty = true;
        }
        if status.last_error.is_some() {
            status.last_error = None;
            dirty = true;
        }
        // A successful chunk must not flip a transient processing
        // failure into a hard "error" session state — stay capturing.
        if status.status == "error" {
            status.status = "capturing".to_string();
            dirty = true;
        }
        // Avoid flooding the UI with identical runtime:status events on every
        // silent/success chunk — each emit used to re-render the live shell.
        if !dirty {
            return;
        }
        let next = status.clone();
        drop(status);
        let _ = app.emit("runtime:status", &next);
    }
}

fn chrono_like_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
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
    let log_dir = app.path().app_log_dir().unwrap_or_default();
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
    let ready_models =
        models.iter().filter(|m| m.get("ready").and_then(|v| v.as_bool()) == Some(true)).count();
    let total_models = models.len();
    let last_error = status.last_error.clone();
    Ok(serde_json::json!({
        "config": serde_json::to_value(&config).unwrap_or_default(),
        "runtimeStatus": serde_json::to_value(&status).unwrap_or_default(),
        "services": services,
        "modelsDir": models_dir.display().to_string(),
        "configDir": config_dir.display().to_string(),
        "appDataDir": app_data.display().to_string(),
        "logDir": log_dir.display().to_string(),
        "models": models,
        "modelSummary": {
            "ready": ready_models,
            "total": total_models,
            "allReady": ready_models == total_models && total_models > 0,
        },
        "debug": {
            "verboseLogging": config.debug.verbose_logging,
            "logDir": log_dir.display().to_string(),
            "logFilePrefix": "kotoba-beacon",
        },
        "env": {
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
            "pkgVersion": env!("CARGO_PKG_VERSION"),
            "rustcVersion": option_env!("RUSTC_VERSION").unwrap_or("unknown"),
            "tauriVersion": tauri::VERSION,
            "debugAssertions": cfg!(debug_assertions),
            "nativeOutputFeature": cfg!(feature = "native-output"),
        },
        // Flat convenience fields kept for older UI scrapers / support paste.
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
        "lastError": last_error,
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
