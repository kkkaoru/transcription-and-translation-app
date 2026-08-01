use crate::audio::{pcm_base64_to_wav, AudioChunk};
use crate::config::AppConfig;
use crate::gateway;
use crate::macos;
use crate::models::{catalog, ModelCatalog};
use crate::native_output::{NativeOutputHandle, OverlayFrame};
use crate::pipeline::{
    CaptionPayload, ParapperRecognitionInput, Pipeline, PipelineError, PipelineStageEvent,
};
use crate::state::{AppState, RuntimeStatus};
use base64::Engine;
use serde::{Deserialize, Serialize};
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

/// Source-only caption supplied by a browser recognition path such as the Web
/// Speech API.  The native command deliberately keeps this contract separate
/// from [`AudioChunk`]: Web Speech has already performed recognition, so native
/// code must only publish the source event and retain it for overlay replay.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCaptionInput {
    pub id: String,
    pub source_text: String,
    pub source_language: String,
    pub target_language: String,
    pub started_at: u64,
    pub received_at: u64,
    pub is_final: bool,
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaunchResult {
    /// `true` means capture is still active and the restart will be requested
    /// by `stop_capture` after the microphone/backend session is idle.
    pub deferred: bool,
    pub reason: &'static str,
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
    // Raw Parapper and Web Speech do not execute the local normalizer or
    // translator. Do not make saving a mode selection depend on downloading
    // unused GGUF assets; the normalizer path still reconciles its selected
    // model as before.
    if config.recognition_mode == "parapper-azookey" {
        gateway::reconcile_models(&app, &config).await?;
    }
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

/// Return the most recent normalized source/translation caption for late
/// overlay subscribers. Raw ASR text is intentionally never retained here.
#[tauri::command]
pub fn get_latest_caption(state: State<'_, AppState>) -> Option<CaptionPayload> {
    state.latest_caption()
}

#[tauri::command]
pub fn get_update_status() -> crate::updater::UpdateStatus {
    crate::updater::status()
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
) -> Result<Option<crate::updater::UpdateMetadata>, String> {
    crate::updater::check(&app).await
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    crate::updater::install(&app).await
}

#[tauri::command]
pub async fn check_and_install_update(app: AppHandle) -> Result<(), String> {
    crate::updater::check_and_install(&app).await
}

/// Restart into the bundle currently installed at the app's path.
///
/// macOS update installers replace the `.app` directory while the old process
/// is still mapped. Tauri's request-restart path exits through the normal event
/// loop (which stops gateway/model sidecars) and then starts the executable from
/// that same path, so the next process loads the new bundle. Requests received
/// during capture are held until `stop_capture` has made the runtime idle.
#[tauri::command]
pub fn relaunch_to_updated_app(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RelaunchResult, String> {
    let active = {
        let status = state.status.lock().map_err(|_| "status lock poisoned".to_string())?;
        capture_is_active(status.status.as_str())
    };
    if active {
        *state.relaunch_after_capture.lock().map_err(|_| "relaunch lock poisoned".to_string())? =
            true;
        crate::updater::mark_switch_result(&app, "capture-active", true);
        let _ = app.emit("update:relaunch-deferred", "capture-active");
        return Ok(RelaunchResult { deferred: true, reason: "capture-active" });
    }
    macos::request_relaunch(&app)?;
    crate::updater::mark_switch_result(&app, "relaunch-requested", false);
    Ok(RelaunchResult { deferred: false, reason: "relaunch-requested" })
}

#[tauri::command]
pub async fn start_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|_| "config lock poisoned".to_string())?.clone();
    // Web Speech owns microphone capture and recognition in the webview. Do
    // not warm native dictionaries or wait for sidecars for this mode; the
    // frontend starts its SpeechRecognition stream immediately after this
    // command reports the capturing state.
    if config.recognition_mode == "web-speech" {
        return set_status(&app, &state, "capturing", None);
    }
    if config.recognition_mode == "parapper-azookey" {
        prepare_azookey_capture(&app, &state, &mut config).await?;
    }
    // Ensure gateway / Parapper are accepting traffic before the frontend opens
    // the microphone, then bring up the selected local GGUF servers.
    gateway::ensure_services_ready(&config).await?;
    if config.recognition_mode != "parapper-raw" {
        gateway::reconcile_models(&app, &config).await?;
    }
    set_status(&app, &state, "capturing", None)
}

/// Provision and warm the optional AzooKey dictionary only for the native
/// normalizer path. Raw Parapper mode still needs the sidecar, but must not
/// pay for dictionary I/O or model reconciliation that it never uses.
async fn prepare_azookey_capture(
    app: &AppHandle,
    state: &AppState,
    config: &mut AppConfig,
) -> Result<(), String> {
    // AzooKey's compact fallback is intentionally tiny. Provision the pinned
    // public LOUDS dictionary once, then pass its root through the existing
    // `models.paths` route; the selected normalizer remains `azookey-rust`.
    if let Some(dictionary_root) =
        crate::azookey_runtime::ensure_system_dictionary(app, config).await
    {
        config
            .models
            .paths
            .insert("azookey-rust".to_string(), dictionary_root.to_string_lossy().into_owned());
        *state.config.lock().map_err(|_| "config lock poisoned".to_string())? = config.clone();
        let _ = app.emit("config:update", &*config);
        log::info!(
            target: "kotoba_azookey",
            "using public AzooKey dictionary root {}",
            dictionary_root.display()
        );
    }
    // Warm the dictionary while the capture command is already waiting for
    // native services. The first audio chunk can then go straight to Viterbi
    // instead of blocking the first subtitle on LOUDS initialization.
    if let Err(error) = state.pipeline.warm_azookey_dictionary(config) {
        log::warn!(target: "kotoba_azookey", "dictionary warm-up deferred: {error}");
    }
    Ok(())
}

#[tauri::command]
pub fn stop_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Preserve a processing/translation failure while making the native
    // session idle. The frontend and overlay use this field to distinguish a
    // successful stop (clear caption) from a failed session (retain caption).
    let previous_error =
        state.status.lock().map_err(|_| "status lock poisoned".to_string())?.last_error.clone();
    let had_previous_error = previous_error.is_some();
    set_status(&app, &state, "idle", previous_error)?;
    // Clear native replay only after the status transition and only for a
    // successful session. On a failed session the last caption remains
    // available to late overlay subscribers alongside the retained error.
    // `emit_caption_update` serializes on the same status lock, so a late
    // translation cannot refill a successfully-cleared slot after idle.
    if !had_previous_error {
        state.clear_latest_caption();
    }
    let restart = {
        let mut pending = state
            .relaunch_after_capture
            .lock()
            .map_err(|_| "relaunch lock poisoned".to_string())?;
        let restart = *pending;
        *pending = false;
        restart
    };
    let update_pending = crate::updater::pending_available();
    if restart && !update_pending {
        macos::request_relaunch(&app)?;
    }
    // An automatic update discovered while capture was active is downloaded
    // only after this command makes the native session idle. The updater owns
    // the final signed install + restart sequence.
    if update_pending {
        crate::updater::install_after_capture(app.clone());
    }
    Ok(())
}

#[tauri::command]
pub async fn transcribe_audio_chunk(
    app: AppHandle,
    state: State<'_, AppState>,
    chunk: AudioChunk,
) -> Result<CaptionPayload, String> {
    let wav = pcm_base64_to_wav(&chunk)?;
    let config = state.config.lock().map_err(|_| "config lock poisoned".to_string())?.clone();
    // Stage 1: ASR + normalize only. Return as soon as normalized source text
    // is ready so the frontend chunkQueue is not blocked on translation latency.
    // Each stage is emitted immediately via on_stage (do not wait for full pipeline).
    // Standard captions begin only after normalization. Raw ASR is represented
    // by the `asr` stage event for DebugPanel, never painted as user-facing text.
    let mut stages: Vec<PipelineStageEvent> = Vec::with_capacity(3);
    let app_for_stages = app.clone();
    let config_for_stages = config.clone();
    let mut on_stage = move |stage: &PipelineStageEvent| {
        emit_pipeline_stage(&app_for_stages, &config_for_stages, stage);
    };
    let app_for_captions = app.clone();
    let mut on_caption = move |caption: &CaptionPayload| {
        emit_caption_update(&app_for_captions, caption);
    };
    match state
        .pipeline
        .recognize_source_with_id(
            &config,
            wav,
            chunk.utterance_id.as_deref(),
            &mut stages,
            &mut on_stage,
            &mut on_caption,
        )
        .await
    {
        Ok(Some(partial)) => {
            mark_backend_healthy(&app, &state);
            // Final normalized source was already emitted via on_caption. Re-emit
            // once so late subscribers / invoke
            // fallback always see the post-normalize string (no-op on the UI if
            // display fields are identical).
            emit_caption_update(&app, &partial);

            // Stage 2: translate in the background with the same caption id.
            // UI already shows source_text; a later caption:update fills translation.
            spawn_translation(app.clone(), config.clone(), state.pipeline.clone(), partial.clone());

            Ok(partial)
        }
        Ok(None) => {
            // No speech in this chunk — keep capture healthy and do not toast.
            // ASR (and maybe normalize) stage events were already emitted.
            mark_backend_healthy(&app, &state);
            let silence_id = chunk
                .utterance_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("silence-{}", chrono_like_millis()));
            Ok(empty_caption(&config, silence_id))
        }
        Err(error) => {
            let detail = redact_runtime_text(&error.to_string());
            // Failed stage event was already emitted via on_stage.
            // Keep the session in "capturing" so the frontend Stop control remains
            // available. Surface the concrete failure through last_error only.
            let next_status = transcription_error_status(state.inner(), &detail);
            if let Some(status) = next_status {
                let _ = app.emit("runtime:status", &status);
            }
            Err(detail)
        }
    }
}

/// Continue the live Parapper path after its persistent WebSocket has emitted
/// an interim/final output. Parapper already performed VAD, segmentation and
/// ASR; this command deliberately starts at its Hiragana text and reuses the
/// same cached AzooKey normalizer and translation stages as HTTP callers.
#[tauri::command]
pub async fn normalize_parapper_output(
    app: AppHandle,
    state: State<'_, AppState>,
    output: ParapperRecognitionInput,
) -> Result<CaptionPayload, String> {
    let config = state.config.lock().map_err(|_| "config lock poisoned".to_string())?.clone();
    let output_is_final = output.is_final;
    let empty_id =
        format!("parapper:{}:{}:{}", output.session_id, output.turn_session_id, output.turn_id);
    let mut stages: Vec<PipelineStageEvent> = Vec::with_capacity(2);
    let app_for_stages = app.clone();
    let config_for_stages = config.clone();
    let mut on_stage = move |stage: &PipelineStageEvent| {
        emit_pipeline_stage(&app_for_stages, &config_for_stages, stage);
    };
    let app_for_captions = app.clone();
    let mut on_caption = move |caption: &CaptionPayload| {
        emit_caption_update(&app_for_captions, caption);
    };
    match state
        .pipeline
        .normalize_parapper_output(&config, output, &mut stages, &mut on_stage, &mut on_caption)
        .await
    {
        Ok(Some(partial)) => {
            mark_backend_healthy(&app, &state);
            if output_is_final {
                spawn_translation(
                    app.clone(),
                    config.clone(),
                    state.pipeline.clone(),
                    partial.clone(),
                );
            }
            Ok(partial)
        }
        Ok(None) => {
            mark_backend_healthy(&app, &state);
            Ok(empty_caption(&config, empty_id))
        }
        Err(error) => {
            let detail = redact_runtime_text(&error.to_string());
            if let Some(status) = transcription_error_status(state.inner(), &detail) {
                let _ = app.emit("runtime:status", &status);
            }
            Err(detail)
        }
    }
}

/// Publish a source caption produced outside the native ASR pipeline.
///
/// Web Speech has already recognized the utterance, so this command does not
/// invoke Parapper, AzooKey, or translation. It emits the same source-stage
/// `caption:update` event used by native recognition and stores the caption in
/// `AppState` so a late overlay subscriber can replay it.
#[tauri::command]
pub fn publish_source_caption(
    app: AppHandle,
    state: State<'_, AppState>,
    caption: SourceCaptionInput,
) -> Result<(), String> {
    let payload = source_caption_payload(caption)?;
    let active = state
        .status
        .lock()
        .map_err(|_| "status lock poisoned".to_string())
        .map(|status| capture_is_active(status.status.as_str()))?;
    if !active {
        return Err("capture is not active".to_string());
    }
    emit_caption_update(&app, &payload);
    Ok(())
}

fn source_caption_payload(caption: SourceCaptionInput) -> Result<CaptionPayload, String> {
    let source_text = caption.source_text.trim().to_string();
    if source_text.is_empty() {
        return Err("source caption text is required".to_string());
    }
    Ok(CaptionPayload {
        id: caption.id,
        source_text,
        translation_text: String::new(),
        source_language: caption.source_language,
        target_language: caption.target_language,
        started_at: caption.started_at,
        received_at: caption.received_at,
        stage: "source",
        sequence: 0,
        is_final: caption.is_final,
        confidence: caption.confidence,
    })
}

/// Surface a translation failure without turning a healthy ASR session into a
/// backend-unreachable state. The helper keeps the async translation callback
/// shallow enough for the configured Clippy nesting budget.
fn update_translation_error_status(app: &AppHandle, detail: &str) {
    let Some(app_state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(mut status) = app_state.status.lock() else {
        return;
    };

    // A background translator can finish after stop_capture made the session
    // idle. Do not resurrect an error/runtime event for that completed session.
    if status.status == "idle" {
        return;
    }

    let mut dirty = false;
    if !matches!(status.status.as_str(), "idle" | "starting" | "capturing") {
        status.status = "capturing".to_string();
        dirty = true;
    }
    // Source ASR already succeeded; do not mark the whole backend unreachable
    // solely because translation failed.
    if status.last_error.as_deref() != Some(detail) {
        status.last_error = Some(detail.to_string());
        dirty = true;
    }
    if !dirty {
        return;
    }

    let next = status.clone();
    drop(status);
    let _ = app.emit("runtime:status", &next);
}

/// Build the status snapshot for a failed transcription request. Returning an
/// `Option` via `ok()?` avoids nesting lock/error handling in the hot command.
fn transcription_error_status(state: &AppState, detail: &str) -> Option<RuntimeStatus> {
    let mut status = state.status.lock().ok()?;
    if status.status == "idle" {
        return None;
    }
    if status.status != "idle" && status.status != "starting" {
        status.status = "capturing".to_string();
    }
    status.backend_reachable = false;
    status.last_error = Some(detail.to_string());
    Some(status.clone())
}

/// Run translation after the source caption has been returned to the UI.
/// Keeping the spawned future in a top-level helper avoids adding another
/// closure/match nesting level to the command handler.
fn spawn_translation(
    app: AppHandle,
    config: AppConfig,
    pipeline: Pipeline,
    caption: CaptionPayload,
) {
    tauri::async_runtime::spawn(async move {
        translate_caption(app, config, pipeline, caption).await;
    });
}

async fn translate_caption(
    app: AppHandle,
    config: AppConfig,
    pipeline: Pipeline,
    caption: CaptionPayload,
) {
    let mut stages: Vec<PipelineStageEvent> = Vec::with_capacity(1);
    let mut on_stage = |stage: &PipelineStageEvent| emit_pipeline_stage(&app, &config, stage);
    let result = pipeline.complete_translation(&config, caption, &mut stages, &mut on_stage).await;
    handle_translation_result(&app, result);
}

fn handle_translation_result(app: &AppHandle, result: Result<CaptionPayload, PipelineError>) {
    match result {
        Ok(caption) => emit_caption_update(app, &caption),
        Err(error) => report_translation_error(app, &error),
    }
}

/// Retain a user-facing caption before the best-effort event emit. The source
/// callback is invoked only after normalization, so this cannot replay raw ASR.
fn emit_caption_update(app: &AppHandle, caption: &CaptionPayload) {
    if let Some(state) = app.try_state::<AppState>() {
        // A translation task may finish after the user pressed Stop. Hold the
        // runtime lock through the record + event so stop_capture's idle event
        // is ordered after any caption that was accepted before the stop.
        let Ok(status) = state.status.lock() else {
            return;
        };
        if !capture_is_active(status.status.as_str()) {
            return;
        }
        state.record_latest_caption(caption);
        if let Err(error) = app.emit("caption:update", caption) {
            log::warn!("could not emit caption:update: {error}");
        }
        return;
    }
    if let Err(error) = app.emit("caption:update", caption) {
        log::warn!("could not emit caption:update: {error}");
    }
}

fn report_translation_error(app: &AppHandle, error: &PipelineError) {
    // Keep the already-shown source caption; only surface last_error.
    // The translate stage event was already emitted via on_stage.
    let detail = redact_runtime_text(&error.to_string());
    log::warn!("translation failed for progressive caption: {detail}");
    update_translation_error_status(app, &detail);
}

/// Normalize config logLevel into a filter rank (error=0 … trace=4).
fn log_level_rank(level: &str) -> u8 {
    match level.trim().to_ascii_lowercase().as_str() {
        "error" => 0,
        "warn" | "warning" => 1,
        "info" => 2,
        "debug" => 3,
        "trace" => 4,
        _ => 2,
    }
}

/// Emit one stage immediately for DebugPanel progressive rows.
/// Always emits `pipeline:stage`. File/console detail respects `debug.logLevel`
/// and includes I/O samples when `debug.verboseLogging` is on.
fn emit_pipeline_stage(app: &AppHandle, config: &AppConfig, stage: &PipelineStageEvent) {
    // Tauri events are delivered only to listeners that are already attached.
    // Retain the completed row first so opening DebugPanel after capture (or
    // during a fast local stage) can recover the same output/timing/error data
    // through get_debug_info.
    if let Some(state) = app.try_state::<AppState>() {
        state.record_pipeline_stage(stage);
    }

    // success → debug (rank 3); failure → error (rank 0)
    let event_rank: u8 = if stage.ok { 3 } else { 0 };
    let threshold = log_level_rank(&config.debug.log_level);
    if event_rank <= threshold {
        let input_bytes = stage
            .input_snippet
            .strip_prefix("wavBytes=")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(stage.input_snippet.len());
        let output_bytes = stage.output_text.len();
        if stage.ok {
            log::debug!(
                target: "pipeline_stage",
                "stage={} model={} ok=true duration_ms={} started_at={} ended_at={} utterance={} input_bytes={} output_bytes={}",
                stage.stage,
                stage.model_id,
                stage.duration_ms,
                stage.started_at,
                stage.at,
                stage.utterance_id,
                input_bytes,
                output_bytes
            );
        } else {
            log::error!(
                target: "pipeline_stage",
                "stage={} model={} ok=false duration_ms={} started_at={} ended_at={} utterance={} input_bytes={} output_bytes={} error_present={}",
                stage.stage,
                stage.model_id,
                stage.duration_ms,
                stage.started_at,
                stage.at,
                stage.utterance_id,
                input_bytes,
                output_bytes,
                stage.error.is_some()
            );
        }
    }
    if let Err(error) = app.emit("pipeline:stage", stage) {
        log::warn!("could not emit pipeline:stage: {error}");
    }
}

fn mark_backend_healthy(app: &AppHandle, state: &State<'_, AppState>) {
    if let Ok(mut status) = state.status.lock() {
        // A request that was already in flight may complete after Stop. Keep
        // the completed session idle instead of publishing a healthy status
        // that would resurrect its caption/replay state.
        if status.status == "idle" {
            return;
        }
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

fn empty_caption(config: &AppConfig, id: String) -> CaptionPayload {
    CaptionPayload {
        id,
        source_text: String::new(),
        translation_text: String::new(),
        source_language: config.language.source.clone(),
        target_language: config.language.target.clone(),
        started_at: 0,
        received_at: 0,
        stage: "source",
        sequence: 0,
        is_final: false,
        confidence: None,
    }
}

fn is_sensitive_debug_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key == "token"
        || key.contains("api_key")
        || key.contains("apikey")
        || key.contains("access_token")
        || key.contains("refresh_token")
        || key.contains("id_token")
        || key.contains("authorization")
        || key.contains("password")
        || key.contains("passwd")
        || key.contains("secret")
        || key.contains("private_key")
        || key.contains("client_secret")
        || key.contains("cookie")
        || key.contains("signature")
}

/// Redact credentials from strings persisted in native diagnostics. Keep
/// status/error context while avoiding bearer tokens and query-string secrets.
fn redact_runtime_text(text: &str) -> String {
    let mut value = text.to_string();
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
        let lower = value.to_ascii_lowercase();
        if let Some(start) = lower.find(marker) {
            let end = value[start + marker.len()..]
                .find(['&', '#', ' ', '\n', '\r', '"'])
                .map(|offset| start + marker.len() + offset)
                .unwrap_or(value.len());
            value.replace_range(start + marker.len()..end, "[REDACTED]");
        }
    }
    value = value
        .split_once("Bearer ")
        .map(|(prefix, _)| format!("{prefix}Bearer [REDACTED]"))
        .unwrap_or(value);
    value
}

fn sanitize_debug_json(value: serde_json::Value, key: Option<&str>) -> serde_json::Value {
    if key.is_some_and(is_sensitive_debug_key) {
        return if value.is_null() {
            serde_json::Value::Null
        } else {
            serde_json::Value::String("[REDACTED]".to_string())
        };
    }
    match value {
        serde_json::Value::String(text) => serde_json::Value::String(redact_runtime_text(&text)),
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items.into_iter().map(|item| sanitize_debug_json(item, None)).collect(),
        ),
        serde_json::Value::Object(object) => serde_json::Value::Object(
            object
                .into_iter()
                .map(|(child_key, child_value)| {
                    let sanitized = sanitize_debug_json(child_value, Some(&child_key));
                    (child_key, sanitized)
                })
                .collect(),
        ),
        other => other,
    }
}

fn sanitize_export_body(body: &str, format: &str) -> String {
    match format {
        "json" => sanitize_json_body(body).unwrap_or_else(|| redact_runtime_text(body)),
        "jsonl" => sanitize_jsonl_body(body).unwrap_or_else(|| redact_runtime_text(body)),
        _ => redact_runtime_text(body),
    }
}

fn sanitize_json_body(body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    Some(
        serde_json::to_string_pretty(&sanitize_debug_json(value, None))
            .unwrap_or_else(|_| redact_runtime_text(body)),
    )
}

fn sanitize_jsonl_body(body: &str) -> Option<String> {
    let mut parsed_any = false;
    let lines = body.lines().map(|line| sanitize_jsonl_line(line, &mut parsed_any));
    let sanitized = lines.collect::<Vec<_>>().join("\n");
    parsed_any.then_some(sanitized)
}

fn sanitize_jsonl_line(line: &str, parsed_any: &mut bool) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return redact_runtime_text(line);
    };
    *parsed_any = true;
    serde_json::to_string(&sanitize_debug_json(value, None))
        .unwrap_or_else(|_| redact_runtime_text(line))
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
    // Snapshot before the health probes below. Stage events can continue while
    // this command awaits sidecar status, but the bounded snapshot is
    // self-consistent and can be merged into the frontend store on refresh.
    let pipeline_stages = state.pipeline_stage_history();
    let latest_caption = state.latest_caption();
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
    let sidecars =
        gateway::probe_sidecar_statuses(&config, &app.state::<gateway::RuntimeServices>()).await;
    let ready_models =
        models.iter().filter(|m| m.get("ready").and_then(|v| v.as_bool()) == Some(true)).count();
    let total_models = models.len();
    let last_error = status.last_error.as_deref().map(redact_runtime_text);
    let safe_config = sanitize_debug_json(serde_json::to_value(&config).unwrap_or_default(), None);
    let safe_runtime_status =
        sanitize_debug_json(serde_json::to_value(&status).unwrap_or_default(), None);
    // Stage snippets are already bounded by pipeline.rs; run the same
    // credential redaction as the rest of diagnostics before exposing them to
    // support tooling or the Debug panel.
    let safe_pipeline_stages = sanitize_debug_json(
        serde_json::to_value(&pipeline_stages)
            .unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
        None,
    );
    let safe_latest_caption = sanitize_debug_json(
        serde_json::to_value(&latest_caption).unwrap_or(serde_json::Value::Null),
        None,
    );
    let updater_snapshot = crate::updater::status_value();
    Ok(serde_json::json!({
        "config": safe_config,
        "runtimeStatus": safe_runtime_status,
        // Newest first, matching the frontend pipeline stage store. This
        // recovers `pipeline:stage` rows emitted before DebugPanel subscribed.
        "pipelineStages": safe_pipeline_stages.clone(),
        // Alias kept for callers that describe the same rows as a history.
        "stageHistory": safe_pipeline_stages,
        // Latest normalized source/translation caption for late overlay/debug
        // consumers. Raw ASR is not stored in AppState and cannot appear here.
        "latestCaption": safe_latest_caption,
        "services": services,
        "sidecars": sidecars,
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
            "logLevel": config.debug.log_level,
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
        "update": updater_snapshot.get("update").cloned().unwrap_or_default(),
        "updateHistory": updater_snapshot.get("updateHistory").cloned().unwrap_or_default(),
    }))
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve app config directory: {error}"))?
        .join("config.json"))
}

fn capture_is_active(status: &str) -> bool {
    matches!(status, "starting" | "capturing")
}

/// Persist a frontend-exported structured log payload into the app log directory.
/// Body is expected to be JSON or JSONL text produced by the Debug panel export.
#[tauri::command]
pub async fn export_debug_logs(
    app: AppHandle,
    body: String,
    format: Option<String>,
) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("could not resolve app log directory: {error}"))?;
    std::fs::create_dir_all(&log_dir)
        .map_err(|error| format!("could not create log directory: {error}"))?;
    let ext = match format.as_deref().map(str::trim).unwrap_or("jsonl") {
        "json" => "json",
        _ => "jsonl",
    };
    let stamp = chrono_like_millis();
    let path = log_dir.join(format!("kotoba-beacon-export-{stamp}.{ext}"));
    let safe_body = sanitize_export_body(&body, ext);
    std::fs::write(&path, safe_body.as_bytes())
        .map_err(|error| format!("could not write log export: {error}"))?;
    log::info!(
        target: "debug_export",
        "wrote structured log export path={} bytes={}",
        path.display(),
        safe_body.len()
    );
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        capture_is_active, ensure_overlay_window, redact_runtime_text, sanitize_debug_json,
        sanitize_export_body, source_caption_payload, validate_overlay_frame_dimensions,
        SourceCaptionInput,
    };

    #[test]
    fn update_relaunch_is_deferred_only_for_active_capture_states() {
        assert!(capture_is_active("starting"));
        assert!(capture_is_active("capturing"));
        assert!(!capture_is_active("idle"));
        assert!(!capture_is_active("error"));
    }

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

    #[test]
    fn debug_redaction_removes_tokens_but_keeps_status_context() {
        let redacted = redact_runtime_text("HTTP 401 token=abc123 status=401");
        assert!(!redacted.contains("abc123"));
        assert!(redacted.contains("status=401"));
        let value = serde_json::json!({
            "endpoint": "https://example.test/?access_token=abc123",
            "token": "abc123",
            "status": 503,
        });
        let safe = sanitize_debug_json(value, None);
        assert!(!safe.to_string().contains("abc123"));
        assert!(safe.to_string().contains("503"));
        let export = sanitize_export_body(r#"{"token":"abc123","ok":true}"#, "json");
        assert!(!export.contains("abc123"));
        assert!(export.contains("true"));
    }

    #[test]
    fn source_caption_payload_trims_text_and_keeps_source_stage_contract() {
        let payload = source_caption_payload(SourceCaptionInput {
            id: "webspeech:session:1".to_string(),
            source_text: "  こんにちは  ".to_string(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 100,
            received_at: 120,
            is_final: true,
            confidence: Some(0.87),
        })
        .expect("non-empty source text should be accepted");

        assert_eq!(payload.id, "webspeech:session:1");
        assert_eq!(payload.source_text, "こんにちは");
        assert!(payload.translation_text.is_empty());
        assert_eq!(payload.stage, "source");
        assert_eq!(payload.sequence, 0);
        assert!(payload.is_final);
        assert_eq!(payload.confidence, Some(0.87));
    }

    #[test]
    fn source_caption_payload_rejects_blank_text() {
        let result = source_caption_payload(SourceCaptionInput {
            id: "webspeech:session:1".to_string(),
            source_text: " \n\t".to_string(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 100,
            received_at: 120,
            is_final: false,
            confidence: None,
        });

        assert_eq!(result.unwrap_err(), "source caption text is required");
    }

    #[test]
    fn source_caption_input_uses_camel_case_ipc_keys() {
        let input: SourceCaptionInput = serde_json::from_value(serde_json::json!({
            "id": "webspeech:session:1",
            "sourceText": "こんにちは",
            "sourceLanguage": "ja",
            "targetLanguage": "en",
            "startedAt": 100,
            "receivedAt": 120,
            "isFinal": false,
            "confidence": null,
        }))
        .expect("bridge payload should deserialize");

        assert_eq!(input.source_text, "こんにちは");
        assert_eq!(input.source_language, "ja");
        assert_eq!(input.target_language, "en");
        assert_eq!(input.confidence, None);
    }
}
