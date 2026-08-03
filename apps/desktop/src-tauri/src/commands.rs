use crate::audio::{pcm_base64_to_wav, AudioChunk};
use crate::browser_source;
use crate::config::AppConfig;
use crate::gateway;
use crate::macos;
use crate::models::{catalog, ModelCatalog};
use crate::native_output::{NativeOutputHandle, OverlayFrame};
use crate::pipeline::{
    CaptionPayload, ParapperRecognitionInput, Pipeline, PipelineError, PipelineStageEvent,
};
use crate::state::{
    AppState, ExpectedEmptyAsrResult, RecordedPipelineStage, RuntimeStatus, TranslationTicket,
    ASR_EMPTY_RESULT_WINDOW, TRANSLATION_DRAIN_TIMEOUT,
};
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
    /// Native capture generation the renderer observed before dispatching this
    /// invoke. Older renderers omit it; the command then falls back to the
    /// historical active-status-only check and cannot tell a stale attempt
    /// apart from a live one (see the MainApp/bridge handoff).
    #[serde(default)]
    pub capture_generation: Option<u64>,
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
    // Keep the full save transaction in order. Model reconciliation is async;
    // without a single guard, an older save can finish after a newer save and
    // overwrite the persisted config and live browser/native output state.
    let _save_guard = state.config_save_lock.lock().await;
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
    // The OBS Browser Source fallback is reconciled live so the settings
    // toggle applies without restarting the app. Bind failures are logged and
    // leave the previous state untouched; they never fail the save itself.
    browser_source::reconcile(&app, &config);
    // A native worker can become available after a transient startup failure.
    // Ensure the hidden publisher webview is mounted after every successful
    // native-output replacement as well as during initial app setup.
    if let Err(error) = ensure_native_overlay(&app, &config, &native_output_kind) {
        log::warn!("could not start hidden native overlay renderer: {error}");
    }
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
pub async fn start_capture(app: AppHandle, state: State<'_, AppState>) -> Result<u64, String> {
    let _capture_lifecycle = state.capture_lifecycle_lock.lock().await;
    // A new capture session gets its own bounded empty-turn observation
    // window. Do this before the early Web Speech return as well, so switching
    // recognition modes cannot retain a prior native ASR loss.
    state.reset_asr_health();
    let capture_generation = state.begin_capture_generation();
    let mut config = state.config.lock().map_err(|_| "config lock poisoned".to_string())?.clone();
    // Web Speech owns microphone capture and recognition in the webview. Do
    // not warm native dictionaries or wait for sidecars for this mode; the
    // frontend starts its SpeechRecognition stream immediately after this
    // command reports the capturing state.
    if config.recognition_mode == "web-speech" {
        return set_status(&app, &state, "capturing", None).map(|_| capture_generation);
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
    set_status(&app, &state, "capturing", None).map(|_| capture_generation)
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
pub async fn stop_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _capture_lifecycle = state.capture_lifecycle_lock.lock().await;
    // Freeze this capture generation before looking at the final status. A
    // source caption may already have spawned translation; give that bounded
    // work a chance to publish before idle makes caption events ineligible.
    let translation_generation = state.begin_translation_drain();
    if !state.drain_translations(translation_generation, TRANSLATION_DRAIN_TIMEOUT).await {
        log::warn!(
            "timed out waiting {}ms for pending translation generation {} during capture stop",
            TRANSLATION_DRAIN_TIMEOUT.as_millis(),
            translation_generation
        );
    }
    // A replacement capture may start while the bounded drain above is
    // waiting on a slow translator. Once start_capture bumps the generation,
    // this stop belongs to the superseded session and must not transition the
    // replacement back to idle or clear its replay/health state.
    if !stop_generation_is_current(state.inner(), translation_generation) {
        log::debug!(
            "ignoring stop completion for superseded capture generation {}",
            translation_generation
        );
        return Ok(());
    }
    // Preserve a processing/translation failure while making the native
    // session idle. The frontend and overlay use this field to distinguish a
    // successful stop (clear caption) from a failed session (retain caption).
    let previous_error =
        state.status.lock().map_err(|_| "status lock poisoned".to_string())?.last_error.clone();
    let had_previous_error = previous_error.is_some();
    set_status(&app, &state, "idle", previous_error)?;
    state.reset_asr_health();
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
    let capture_generation = state.current_capture_generation();
    // Stage 1: ASR + normalize only. Return as soon as normalized source text
    // is ready so the frontend chunkQueue is not blocked on translation latency.
    // Each stage is emitted immediately via on_stage (do not wait for full pipeline).
    // Standard captions begin only after normalization. Raw ASR is represented
    // by the `asr` stage event for DebugPanel, never painted as user-facing text.
    let mut stages: Vec<PipelineStageEvent> = Vec::with_capacity(3);
    let app_for_stages = app.clone();
    let config_for_stages = config.clone();
    let mut on_stage = move |stage: &PipelineStageEvent| {
        emit_pipeline_stage(&app_for_stages, &config_for_stages, stage, capture_generation);
    };
    let app_for_captions = app.clone();
    let mut on_caption = move |caption: &CaptionPayload| {
        emit_caption_update_for_generation(&app_for_captions, caption, capture_generation);
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
            mark_backend_healthy(&app, &state, capture_generation);
            // Stage 2: translate in the background with the same caption id.
            // `recognize_source_with_id` already emitted the normalized source
            // through `on_caption`. Do not emit the returned value a second
            // time: the invoke result is the caller's completion signal, while
            // `caption:update` is the single event stream. Native replay has
            // already retained the source before the command returns.
            if state.is_capture_generation_current(capture_generation) {
                spawn_translation(
                    app.clone(),
                    config.clone(),
                    state.pipeline.clone(),
                    partial.clone(),
                    capture_generation,
                    &state,
                );
            }

            Ok(partial)
        }
        Ok(None) => {
            // A chunk with a non-empty utterance id has already passed the
            // frontend speech gate. An empty ASR result for three distinct
            // accepted chunks is actionable result loss, just like the
            // persistent Parapper stream path below. Legacy callers and
            // ambient/noise chunks omit the id; those remain soft silence and
            // must never trip the ASR health tracker.
            match observe_http_empty_asr(
                state.inner(),
                capture_generation,
                chunk.utterance_id.as_deref(),
            ) {
                Some((utterance_id, ExpectedEmptyAsrResult::Transient { .. })) => {
                    mark_backend_reachable_without_clearing_error(&app, &state, capture_generation);
                    return Ok(empty_caption(&config, utterance_id));
                }
                Some((_, ExpectedEmptyAsrResult::PersistentLoss { consecutive })) => {
                    let detail = persistent_asr_loss_message(consecutive);
                    emit_persistent_asr_loss_status(
                        &app,
                        state.inner(),
                        capture_generation,
                        &detail,
                    );
                    return Err(detail);
                }
                None => {}
            }

            // Audio chunks are also sent for low-level ambient/noise input by
            // legacy/browser callers. Keep that intentional silence non-fatal,
            // but do not let it erase a prior ASR failure.
            mark_backend_reachable_without_clearing_error(&app, &state, capture_generation);
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
            // Generation-gated: a delayed Err after Stop+Start must not poison
            // the replacement session's runtime:status.
            if let Some(status) =
                state.apply_transcription_error_for_generation(capture_generation, &detail)
            {
                let _ = app.emit("runtime:status", &status);
            }
            Err(detail)
        }
    }
}

/// Continue the live Parapper path after its persistent WebSocket has emitted
/// an interim/final output. Parapper already performed VAD, segmentation and
/// ASR; this command uses the sidecar's explicit AzooKey input when present and
/// otherwise falls back to the protocol text, then reuses the same cached
/// normalizer and translation stages as HTTP callers.
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
    // The frontend queue (`parapper-output-queue.ts`) keeps at most one
    // pending partial and can serialize this item behind a slow in-flight
    // normalizer call, so it can still reach this command after a Stop+Start
    // bumped the capture generation. Use the generation the queue captured at
    // enqueue time (not a fresh read of "current") so a stale item is
    // recognized as stale here instead of silently adopting whatever session
    // happens to be active when it is finally processed. Legacy callers that
    // omit it fall back to the historical current-generation read, which is
    // unconditionally current by construction and changes no behavior.
    let capture_generation =
        output.capture_generation.unwrap_or_else(|| state.current_capture_generation());
    if !parapper_output_generation_is_current(&state, output.capture_generation) {
        // Superseded before any pipeline work started: drop, not error, the
        // same contract as the ASR-empty and translation-backlog superseded
        // paths below. Count it so `get_debug_info` can explain a Parapper
        // turn that never became a caption without log scraping.
        state.record_parapper_output_superseded();
        emit_pipeline_drop(&app, "parapper-output-queue", "superseded-generation", 1);
        log::debug!(
            "dropped Parapper output queued for a superseded capture generation \
             (enqueued_generation={capture_generation})"
        );
        return Ok(empty_caption(&config, empty_id));
    }
    // A legacy output without any generation passes the gate unconditionally
    // and is deliberately never rejected; count it as an unfenced accept so
    // the debug snapshot can quantify these producers alongside source
    // captions that take the same no-generation path.
    if output.capture_generation.is_none() {
        state.record_unfenced_caption_accepted();
    }
    let mut stages: Vec<PipelineStageEvent> = Vec::with_capacity(2);
    let app_for_stages = app.clone();
    let config_for_stages = config.clone();
    let mut on_stage = move |stage: &PipelineStageEvent| {
        emit_pipeline_stage(&app_for_stages, &config_for_stages, stage, capture_generation);
    };
    let app_for_captions = app.clone();
    let mut on_caption = move |caption: &CaptionPayload| {
        emit_caption_update_for_generation(&app_for_captions, caption, capture_generation);
    };
    match state
        .pipeline
        .normalize_parapper_output(&config, output, &mut stages, &mut on_stage, &mut on_caption)
        .await
    {
        Ok(Some(partial)) => {
            mark_backend_healthy(&app, &state, capture_generation);
            if output_is_final && state.is_capture_generation_current(capture_generation) {
                spawn_translation(
                    app.clone(),
                    config.clone(),
                    state.pipeline.clone(),
                    partial.clone(),
                    capture_generation,
                    &state,
                );
            }
            Ok(partial)
        }
        Ok(None) => {
            // Persistent Parapper output is produced only after its VAD has
            // identified a speech turn. Treat one/two blank revisions as a
            // soft skip, but surface a bounded run as ASR result loss instead
            // of repeatedly clearing `last_error` as though it were silence.
            // Use record_expected_empty_asr_for_generation to ensure the
            // generation check is atomic with the health record, preventing
            // a Stop+Start from poisoning the new session's health tracker.
            match state.record_expected_empty_asr_for_generation(capture_generation, &empty_id) {
                Some(ExpectedEmptyAsrResult::Transient { .. }) => {
                    mark_backend_reachable_without_clearing_error(&app, &state, capture_generation);
                    Ok(empty_caption(&config, empty_id))
                }
                Some(ExpectedEmptyAsrResult::PersistentLoss { consecutive }) => {
                    let detail = persistent_asr_loss_message(consecutive);
                    emit_persistent_asr_loss_status(
                        &app,
                        state.inner(),
                        capture_generation,
                        &detail,
                    );
                    Err(detail)
                }
                None => {
                    // Generation has been superseded by a Stop+Start since we
                    // captured it. Return empty caption without recording health.
                    Ok(empty_caption(&config, empty_id))
                }
            }
        }
        Err(error) => {
            let detail = redact_runtime_text(&error.to_string());
            if let Some(status) =
                state.apply_transcription_error_for_generation(capture_generation, &detail)
            {
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
    let capture_generation = caption.capture_generation;
    let payload = source_caption_payload(caption)?;
    match capture_generation {
        // The renderer checks its attempt token before awaiting, so an invoke
        // dispatched for attempt N can resolve after Stop+Start. Publish under
        // the tracker lock so a stale attempt cannot clobber the replacement
        // session's overlay/replay slot; it is dropped silently because the
        // renderer already decided this result is obsolete.
        Some(generation) => {
            let _ = publish_source_caption_gated(&state, Some(generation), &payload, |payload| {
                emit_caption_event(&app, payload)
            });
            Ok(())
        }
        // Legacy renderers send no generation. Keep the historical
        // active-status check and unversioned publish.
        None => {
            publish_source_caption_gated(&state, None, &payload, |payload| {
                emit_caption_update(&app, payload);
            })?;
            Ok(())
        }
    }
}

/// Generation-aware publication for a source caption. `Ok(true)` means the
/// caption was accepted; `Ok(false)` means a stale generation silently dropped
/// it; `Err` is reserved for the legacy unversioned path when capture is not
/// active.
///
/// Both silent outcomes are counted here, where the result is decided, so a
/// producer stamping a wrong generation (or a legacy producer that can never
/// be checked) is observable through `get_debug_info` rather than
/// indistinguishable from a healthy publish.
fn publish_source_caption_gated(
    state: &AppState,
    generation: Option<u64>,
    caption: &CaptionPayload,
    emit: impl FnOnce(&CaptionPayload),
) -> Result<bool, String> {
    match generation {
        Some(generation) => {
            let published = state.publish_caption_for_generation(generation, caption, emit);
            // The drop is silent by design (the renderer already decided this
            // attempt is obsolete), so count it: without the counter a stale
            // generation loses every caption with zero observability.
            if !published {
                state.record_source_caption_stale_dropped();
            }
            Ok(published)
        }
        None => {
            let active = state
                .status
                .lock()
                .map_err(|_| "status lock poisoned".to_string())
                .map(|status| capture_is_active(status.status.as_str()))?;
            if !active {
                return Err("capture is not active".to_string());
            }
            emit(caption);
            // Legacy no-generation publishes are deliberately never fenced
            // (rejecting them would turn mis-attribution into silent loss);
            // count the unfenced volume instead so the debug snapshot can
            // quantify producers that cannot be generation-checked.
            state.record_unfenced_caption_accepted();
            Ok(true)
        }
    }
}

/// Generation gate for a Parapper turn output the frontend queue
/// (`parapper-output-queue.ts`) enqueued before this command ran.
///
/// Returns `true` when the output should still be processed: either its
/// enqueue-time generation is still the active capture generation, or it is a
/// legacy caller that never captured one (kept unconditionally current, same
/// as the historical behavior of always reading "current" fresh). Returns
/// `false` when the item was queued under a capture generation that a
/// Stop+Start has since superseded; the caller must drop it — never surface
/// it as an error — and is responsible for counting the drop via
/// [`AppState::record_parapper_output_superseded`] so it stays observable.
fn parapper_output_generation_is_current(
    state: &AppState,
    enqueued_generation: Option<u64>,
) -> bool {
    match enqueued_generation {
        Some(generation) => state.is_capture_generation_current(generation),
        None => true,
    }
}

fn source_caption_payload(caption: SourceCaptionInput) -> Result<CaptionPayload, String> {
    let source_text = caption.source_text.trim().to_string();
    if source_text.is_empty() {
        return Err("source caption text is required".to_string());
    }
    Ok(CaptionPayload {
        id: caption.id,
        source_text,
        azookey_input_text: None,
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

/// Run translation after the source caption has been returned to the UI.
/// Keeping the spawned future in a top-level helper avoids adding another
/// closure/match nesting level to the command handler.
fn spawn_translation(
    app: AppHandle,
    config: AppConfig,
    pipeline: Pipeline,
    caption: CaptionPayload,
    generation: u64,
    state: &State<'_, AppState>,
) {
    let Some((ticket, superseded)) = state.register_translation_for_generation(generation) else {
        // Stop has already frozen this generation, or this source result
        // arrived outside an active native capture session.
        log::debug!("skipped background translation because its capture generation is unavailable");
        return;
    };
    if superseded.is_some() {
        // Keep the current source caption immediate while making translator
        // backpressure explicit: the oldest unfinished result is retired and
        // cannot overwrite the latest caption when it eventually completes.
        emit_pipeline_drop(&app, "translation", "retired", 1);
        log::debug!(
            "translation backlog reached its cap; retired the oldest pending result (latest wins)"
        );
    }
    tauri::async_runtime::spawn(async move {
        translate_caption(app, config, pipeline, caption, ticket).await;
    });
}

async fn translate_caption(
    app: AppHandle,
    config: AppConfig,
    pipeline: Pipeline,
    caption: CaptionPayload,
    ticket: TranslationTicket,
) {
    let mut stages: Vec<PipelineStageEvent> = Vec::with_capacity(1);
    let generation = ticket.generation();
    let mut on_stage =
        |stage: &PipelineStageEvent| emit_pipeline_stage(&app, &config, stage, generation);
    let result = pipeline.complete_translation(&config, caption, &mut stages, &mut on_stage).await;
    handle_translation_result(&app, ticket, result);
    if let Some(state) = app.try_state::<AppState>() {
        state.finish_translation(ticket);
    }
}

fn handle_translation_result(
    app: &AppHandle,
    ticket: TranslationTicket,
    result: Result<CaptionPayload, PipelineError>,
) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    match result {
        // Publication is ticket-atomic under the tracker lock: a stop-bounded
        // task may finish during the next capture session but can never publish
        // into it. The helper records the caption and invokes the raw emit
        // closure while holding runtime status, so the closure must not
        // re-lock status.
        Ok(caption) => {
            state.publish_translation_for_ticket(ticket, &caption, |payload| {
                emit_caption_event(app, payload);
            });
        }
        // A stale translation failure must not poison the replacement
        // session's runtime status either; same ticket-atomic gate.
        Err(error) => {
            let detail = redact_runtime_text(&error.to_string());
            log::warn!("translation failed for progressive caption: {detail}");
            if let Some(next) = state.apply_translation_error_for_ticket(ticket, &detail) {
                let _ = app.emit("runtime:status", &next);
            }
        }
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

/// ASR/normalizer work can outlive a stop/start boundary. Source updates carry
/// the capture generation they started under so an old completion cannot paint
/// over the newer session. Generation and active-status are checked under one
/// lock sequence before record+emit (see AppState::publish_caption_for_generation).
fn emit_caption_update_for_generation(app: &AppHandle, caption: &CaptionPayload, generation: u64) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let _ = state.publish_caption_for_generation(generation, caption, |payload| {
        emit_caption_event(app, payload);
    });
}

/// Emit a caption while a publish helper holds the runtime status lock. The
/// helpers (`publish_caption_for_generation`, `publish_translation_for_ticket`)
/// already record the caption; the closure must not re-lock status.
fn emit_caption_event(app: &AppHandle, caption: &CaptionPayload) {
    if let Err(error) = app.emit("caption:update", caption) {
        log::warn!("could not emit caption:update: {error}");
    }
}

/// Emit one bounded pipeline drop signal for the renderer diagnostics store.
///
/// Drop paths are intentionally non-fatal: a failed diagnostics event must
/// never turn a successfully handled caption into a runtime error.
fn emit_pipeline_drop(app: &AppHandle, source: &str, reason: &str, count: u64) {
    if count == 0 {
        return;
    }
    let payload = serde_json::json!({
        "source": source,
        "reason": reason,
        "count": count,
    });
    if let Err(error) = app.emit("pipeline:drop", payload) {
        log::warn!("could not emit pipeline:drop: {error}");
    }
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
///
/// `generation` is the capture generation this stage's work belongs to (the
/// same value already threaded through the surrounding generation-atomic
/// helpers for its command). Unlike a caption publish or a runtime status
/// mutation, a stage row is diagnostics-only and append-only, so a stale
/// generation is deliberately *not* gated out here — silently dropping a
/// completed stage would itself be a silent-loss bug, the exact failure
/// class this codebase is eliminating. Instead every retained row and live
/// event is tagged with its generation so a debug consumer can tell a stale
/// session's rows apart from the current one without losing them.
fn emit_pipeline_stage(
    app: &AppHandle,
    config: &AppConfig,
    stage: &PipelineStageEvent,
    generation: u64,
) {
    let tagged = RecordedPipelineStage { capture_generation: generation, stage: stage.clone() };

    // Tauri events are delivered only to listeners that are already attached.
    // Retain the completed row first so opening DebugPanel after capture (or
    // during a fast local stage) can recover the same output/timing/error data
    // through get_debug_info.
    if let Some(state) = app.try_state::<AppState>() {
        state.record_pipeline_stage(generation, stage);
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
                "stage={} model={} ok=true duration_ms={} started_at={} ended_at={} utterance={} input_bytes={} output_bytes={} generation={}",
                stage.stage,
                stage.model_id,
                stage.duration_ms,
                stage.started_at,
                stage.at,
                stage.utterance_id,
                input_bytes,
                output_bytes,
                generation
            );
        } else {
            log::error!(
                target: "pipeline_stage",
                "stage={} model={} ok=false duration_ms={} started_at={} ended_at={} utterance={} input_bytes={} output_bytes={} error_present={} generation={}",
                stage.stage,
                stage.model_id,
                stage.duration_ms,
                stage.started_at,
                stage.at,
                stage.utterance_id,
                input_bytes,
                output_bytes,
                stage.error.is_some(),
                generation
            );
        }
    }
    if let Err(error) = app.emit("pipeline:stage", &tagged) {
        log::warn!("could not emit pipeline:stage: {error}");
    }
}

fn mark_backend_healthy(app: &AppHandle, state: &State<'_, AppState>, generation: u64) {
    // A request that was already in flight may complete after Stop/Start.
    // Generation check and status mutation share one lock sequence so a new
    // Start cannot interleave between them.
    if let Some(next) = state.mark_backend_healthy_for_generation(generation) {
        let _ = app.emit("runtime:status", &next);
    }
}

/// A response without a caption proves the sidecar is reachable, but it is
/// not proof that ASR has recovered. In particular, this must never clear a
/// persistent transcript-loss error after a VAD-confirmed speech turn.
fn mark_backend_reachable_without_clearing_error(
    app: &AppHandle,
    state: &State<'_, AppState>,
    generation: u64,
) {
    if let Some(next) = state.mark_backend_reachable_for_generation(generation) {
        let _ = app.emit("runtime:status", &next);
    }
}

/// Observe an empty HTTP ASR result only when the caller supplied a meaningful
/// utterance identity and the request still belongs to the active generation.
///
/// Frontend-gated chunks carry a stable utterance id; legacy callers and
/// ambient/noise input do not. Keeping this distinction at the command
/// boundary prevents ordinary silence from incrementing the persistent-loss
/// tracker while still making repeated accepted speech failures visible.
fn observe_http_empty_asr(
    state: &AppState,
    generation: u64,
    provided_id: Option<&str>,
) -> Option<(String, ExpectedEmptyAsrResult)> {
    let utterance_id = provided_id.map(str::trim).filter(|id| !id.is_empty())?.to_string();
    let result = state.record_expected_empty_asr_for_generation(generation, &utterance_id)?;
    Some((utterance_id, result))
}

fn persistent_asr_loss_message(consecutive: u8) -> String {
    format!(
        "ASR result loss: {consecutive} VAD-confirmed speech turns produced empty output within {} seconds.",
        ASR_EMPTY_RESULT_WINDOW.as_secs()
    )
}

fn emit_persistent_asr_loss_status(
    app: &AppHandle,
    state: &AppState,
    generation: u64,
    detail: &str,
) {
    if let Some(status) = state.apply_persistent_asr_loss_for_generation(generation, detail) {
        let _ = app.emit("runtime:status", &status);
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
        azookey_input_text: None,
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

fn create_overlay_window(
    app: &AppHandle,
    config: &AppConfig,
    visible: bool,
    native_renderer: bool,
) -> Result<(), String> {
    let url =
        if native_renderer { "index.html?overlay=1&native=1" } else { "index.html?overlay=1" };
    WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App(url.into()))
        .title("Kotoba Beacon Overlay")
        .inner_size(config.overlay.width as f64, config.overlay.height as f64)
        .position(config.overlay.x as f64, config.overlay.y as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(visible)
        // Output dimensions are configured numerically. Keeping the overlay fixed
        // prevents a user resize from desynchronizing the window and the native
        // Spout2/Syphon frame dimensions.
        .resizable(false)
        .build()
        .map(|_| ())
        .map_err(|error| format!("could not create overlay: {error}"))
}

/// Start the caption-only overlay renderer when a native transport is active.
///
/// Spout2 and Syphon publish frames from the overlay webview's canvas. The
/// native sender itself can be ready at app setup, but no caption frame can
/// reach OBS until that webview is mounted. Keep this renderer hidden so native
/// output does not add a desktop window; the existing Open Overlay action shows
/// the same window when a user wants to inspect it locally.
pub(crate) fn ensure_native_overlay(
    app: &AppHandle,
    config: &AppConfig,
    native_output_kind: &str,
) -> Result<(), String> {
    if !matches!(native_output_kind, "spout2" | "syphon") {
        return Ok(());
    }
    if app.get_webview_window("overlay").is_some() {
        return Ok(());
    }
    create_overlay_window(app, config, false, true)
}

#[tauri::command]
pub fn open_overlay(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.show().map_err(|error| format!("could not show overlay: {error}"))?;
        window.set_focus().map_err(|error| format!("could not focus overlay: {error}"))?;
        return Ok(());
    }
    let config = state.config.lock().map_err(|_| "config lock poisoned".to_string())?.clone();
    create_overlay_window(&app, &config, true, false)
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
        // Number of translation tickets retired by the bounded latest-wins
        // queue. Expose this alongside the frontend drop diagnostics so a
        // single debug view can explain missing output without log scraping.
        "translationRetired": state.translation_retired_count(),
        // Parapper turn outputs dropped because their enqueue-time capture
        // generation had already been superseded before this command
        // processed them. Companion counter to `translationRetired` above.
        "parapperOutputSuperseded": state.parapper_output_superseded_count(),
        // Source captions dropped as stale: their stamped capture generation
        // was superseded before publish, so a producer stamping a wrong
        // generation silently loses every caption. Companion counter to
        // `parapperOutputSuperseded`, covering the fenced source path.
        "sourceCaptionStaleDropped": state.source_caption_stale_dropped_count(),
        // Captions and Parapper turn outputs accepted through the legacy
        // no-generation path (older renderers, DebugPanel test captions).
        // Deliberately never fenced, so this counter quantifies the unfenced
        // volume instead of leaving it indistinguishable from fenced accepts.
        "unfencedCaptionAccepted": state.unfenced_caption_accepted_count(),
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

/// A stop issued for generation zero is the idle/no-op path. For an active
/// generation, only the session that began the drain may finish the idle
/// transition; a later start invalidates this stop completion.
fn stop_generation_is_current(state: &AppState, generation: u64) -> bool {
    generation == 0 || state.is_capture_generation_current(generation)
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
        capture_is_active, ensure_overlay_window, observe_http_empty_asr,
        parapper_output_generation_is_current, persistent_asr_loss_message,
        publish_source_caption_gated, redact_runtime_text, sanitize_debug_json,
        sanitize_export_body, source_caption_payload, stop_generation_is_current,
        validate_overlay_frame_dimensions, NativeOverlayFrame, SourceCaptionInput,
    };
    use crate::config::AppConfig;
    use crate::output::OutputStatus;
    use crate::pipeline::ParapperRecognitionInput;
    use crate::state::{AppState, ExpectedEmptyAsrResult, ASR_EMPTY_RESULT_WINDOW};
    use base64::Engine;

    #[test]
    fn update_relaunch_is_deferred_only_for_active_capture_states() {
        assert!(capture_is_active("starting"));
        assert!(capture_is_active("capturing"));
        assert!(!capture_is_active("idle"));
        assert!(!capture_is_active("error"));
    }

    #[test]
    fn repeated_vad_confirmed_empty_results_remain_a_visible_asr_failure() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
            status.backend_reachable = true;
            status.last_error = Some("an earlier error".to_string());
        }
        let detail = persistent_asr_loss_message(3);
        let generation = state.current_capture_generation();
        let next = state
            .apply_persistent_asr_loss_for_generation(generation, &detail)
            .expect("active capture status");

        assert_eq!(next.status, "capturing");
        assert!(!next.backend_reachable);
        assert_eq!(next.last_error.as_deref(), Some(detail.as_str()));
        assert!(detail.contains("ASR result loss"));
        assert!(detail.contains(&ASR_EMPTY_RESULT_WINDOW.as_secs().to_string()));
        assert!(
            !detail.to_ascii_lowercase().contains("no transcript"),
            "the frontend must not classify persistent result loss as a no-speech soft skip"
        );
    }

    #[test]
    fn http_empty_results_for_distinct_speech_chunks_surface_asr_loss() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
            status.backend_reachable = true;
        }
        let generation = state.current_capture_generation();

        assert!(matches!(
            observe_http_empty_asr(&state, generation, Some("speech-1")),
            Some((ref id, ExpectedEmptyAsrResult::Transient { consecutive: 1 })) if id == "speech-1"
        ));
        assert!(matches!(
            observe_http_empty_asr(&state, generation, Some("speech-2")),
            Some((ref id, ExpectedEmptyAsrResult::Transient { consecutive: 2 })) if id == "speech-2"
        ));
        assert!(matches!(
            observe_http_empty_asr(&state, generation, Some("speech-3")),
            Some((ref id, ExpectedEmptyAsrResult::PersistentLoss { consecutive: 3 })) if id == "speech-3"
        ));

        let detail = persistent_asr_loss_message(3);
        let status = state
            .apply_persistent_asr_loss_for_generation(generation, &detail)
            .expect("active generation status");
        assert!(!status.backend_reachable);
        assert_eq!(status.last_error.as_deref(), Some(detail.as_str()));
    }

    #[test]
    fn http_empty_legacy_or_silence_chunks_do_not_fire_asr_loss() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
            status.backend_reachable = true;
        }
        let generation = state.current_capture_generation();

        for id in [None, Some(""), Some("  "), Some("\t")] {
            assert!(observe_http_empty_asr(&state, generation, id).is_none());
        }
        let status = state.status.lock().expect("status lock");
        assert_eq!(status.last_error, None);
        drop(status);
        assert!(matches!(
            observe_http_empty_asr(&state, generation, Some("speech-after-silence")),
            Some((_, ExpectedEmptyAsrResult::Transient { consecutive: 1 }))
        ));
    }

    #[test]
    fn delayed_error_after_generation_bump_does_not_mutate_runtime_status() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        let delayed_generation = state.current_capture_generation();
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
            status.backend_reachable = true;
            status.last_error = None;
        }

        assert!(state
            .apply_transcription_error_for_generation(delayed_generation, "late failure")
            .is_none());
        let status = state.status.lock().expect("status lock");
        assert!(status.backend_reachable);
        assert_eq!(status.last_error, None);
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
            capture_generation: Some(2),
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
            capture_generation: None,
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
            "captureGeneration": 3,
        }))
        .expect("bridge payload should deserialize");

        assert_eq!(input.source_text, "こんにちは");
        assert_eq!(input.source_language, "ja");
        assert_eq!(input.target_language, "en");
        assert_eq!(input.confidence, None);
        assert_eq!(input.capture_generation, Some(3));
    }

    #[test]
    fn source_caption_input_defaults_capture_generation_to_none_for_legacy_payloads() {
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
        .expect("legacy bridge payloads must still deserialize");

        assert_eq!(input.capture_generation, None);
    }

    #[test]
    fn parapper_recognition_input_defaults_capture_generation_to_none_for_legacy_payloads() {
        // Older sidecar/queue producers never send captureGeneration; the
        // command must still deserialize their payload and fall back to a
        // fresh current-generation read (see `normalize_parapper_output`).
        let input: ParapperRecognitionInput = serde_json::from_value(serde_json::json!({
            "text": "こんにちは",
            "sessionId": "socket-session",
            "turnSessionId": 1,
            "turnId": 1,
            "revision": 0,
            "segmentId": 1,
            "isFinal": false,
        }))
        .expect("legacy Parapper payloads must still deserialize");

        assert_eq!(input.capture_generation, None);
    }

    #[test]
    fn parapper_recognition_input_captures_enqueue_time_generation_when_present() {
        let input: ParapperRecognitionInput = serde_json::from_value(serde_json::json!({
            "text": "こんにちは",
            "sessionId": "socket-session",
            "turnSessionId": 1,
            "turnId": 1,
            "revision": 0,
            "segmentId": 1,
            "isFinal": false,
            "captureGeneration": 4,
        }))
        .expect("Parapper payloads carrying an enqueue-time generation must deserialize");

        assert_eq!(input.capture_generation, Some(4));
    }

    #[test]
    fn parapper_output_without_generation_is_always_current() {
        // A legacy caller that never captured an enqueue-time generation must
        // never be treated as superseded; this preserves the historical
        // current-generation-read behavior exactly.
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        assert!(parapper_output_generation_is_current(&state, None));
        state.begin_capture_generation();
        assert!(parapper_output_generation_is_current(&state, None));
    }

    #[test]
    fn parapper_output_generation_gate_drops_a_superseded_enqueue_time_generation() {
        // Pins the enqueue-time generation-ownership fix: an item enqueued
        // under session N (captured at enqueue time, not re-read at dequeue)
        // must be recognized as stale once a Stop+Start bumps the generation
        // to N+1, even though it is only now reaching this command.
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        let enqueued_generation = state.current_capture_generation();
        assert!(parapper_output_generation_is_current(&state, Some(enqueued_generation)));

        state.begin_capture_generation();
        let live_generation = state.current_capture_generation();
        assert_ne!(enqueued_generation, live_generation);
        assert!(
            !parapper_output_generation_is_current(&state, Some(enqueued_generation)),
            "an item queued for a superseded generation must be dropped, not processed"
        );
        assert!(parapper_output_generation_is_current(&state, Some(live_generation)));
    }

    #[test]
    fn stop_completion_is_rejected_after_a_replacement_capture_starts() {
        // A stop can be waiting for a bounded translation drain while the
        // frontend starts a replacement session. The old stop must not make
        // that replacement idle when its drain eventually completes.
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        let stopping_generation = state.begin_translation_drain();
        assert!(stop_generation_is_current(&state, stopping_generation));

        let replacement_generation = state.begin_capture_generation();
        assert_ne!(stopping_generation, replacement_generation);
        assert!(
            !stop_generation_is_current(&state, stopping_generation),
            "an old stop completion must not transition the replacement session"
        );
        assert!(stop_generation_is_current(&state, replacement_generation));
    }

    #[test]
    fn superseded_parapper_output_drop_is_counted_for_diagnostics() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        assert_eq!(state.parapper_output_superseded_count(), 0);
        state.begin_capture_generation();
        let enqueued_generation = state.current_capture_generation();
        state.begin_capture_generation();

        // Mirrors what `normalize_parapper_output` does on the drop path: it
        // is the caller's responsibility to count a drop the gate reports.
        assert!(!parapper_output_generation_is_current(&state, Some(enqueued_generation)));
        state.record_parapper_output_superseded();

        assert_eq!(state.parapper_output_superseded_count(), 1);
    }

    fn source_caption_with_generation(id: &str) -> (AppState, crate::pipeline::CaptionPayload) {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
            status.backend_reachable = true;
            status.last_error = None;
        }
        let payload = source_caption_payload(SourceCaptionInput {
            id: id.to_string(),
            source_text: format!("{id} の字幕"),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 100,
            received_at: 120,
            is_final: true,
            confidence: None,
            capture_generation: None,
        })
        .expect("non-empty source text should be accepted");
        (state, payload)
    }

    #[test]
    fn stale_generation_source_caption_is_dropped_without_emit_or_replay_and_is_counted() {
        let (state, payload) = source_caption_with_generation("webspeech:stale");
        let stale_generation = state.current_capture_generation();
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
            status.backend_reachable = true;
            status.last_error = None;
        }
        assert_eq!(state.source_caption_stale_dropped_count(), 0);

        let mut emitted = 0;
        let published =
            publish_source_caption_gated(&state, Some(stale_generation), &payload, |_| {
                emitted += 1;
            })
            .expect("a stale attempt is dropped, not rejected");
        assert!(!published);
        assert_eq!(emitted, 0, "a stale attempt must not emit into the new session");
        assert_eq!(
            state.latest_caption(),
            None,
            "a stale attempt must not touch the replacement session's replay slot"
        );
        assert_eq!(
            state.source_caption_stale_dropped_count(),
            1,
            "a silent stale drop must be observable through the debug counter"
        );
    }

    #[test]
    fn current_generation_source_caption_publishes_and_records() {
        let (state, payload) = source_caption_with_generation("webspeech:live");
        let generation = state.current_capture_generation();

        let mut emitted = 0;
        let published = publish_source_caption_gated(&state, Some(generation), &payload, |_| {
            emitted += 1;
        })
        .expect("a current attempt is accepted");
        assert!(published);
        assert_eq!(emitted, 1);
        assert_eq!(state.latest_caption(), Some(payload));
    }

    #[test]
    fn legacy_source_caption_without_generation_keeps_active_status_contract() {
        let (state, payload) = source_caption_with_generation("webspeech:legacy");

        let mut emitted = 0;
        let published = publish_source_caption_gated(&state, None, &payload, |_| {
            emitted += 1;
        })
        .expect("an active legacy session accepts the caption");
        assert!(published);
        assert_eq!(emitted, 1);
        assert_eq!(
            state.unfenced_caption_accepted_count(),
            1,
            "an unfenced publish must still be observable"
        );

        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "idle".to_string();
        }
        assert_eq!(
            publish_source_caption_gated(&state, None, &payload, |_| emitted += 1).unwrap_err(),
            "capture is not active"
        );
        assert_eq!(emitted, 1, "an idle session must not emit");
        assert_eq!(
            state.unfenced_caption_accepted_count(),
            1,
            "a rejected publish must not count as an accept"
        );
    }

    #[test]
    fn parapper_output_without_generation_still_processes_and_is_counted_unfenced() {
        // Mirrors `normalize_parapper_output`'s legacy path: an output without
        // an enqueue-time generation always passes the gate (never treated as
        // superseded) and is counted as an unfenced accept so the debug
        // snapshot can quantify producers that cannot be generation-checked.
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        assert_eq!(state.unfenced_caption_accepted_count(), 0);
        assert!(parapper_output_generation_is_current(&state, None));
        state.record_unfenced_caption_accepted();
        assert_eq!(state.unfenced_caption_accepted_count(), 1);
    }

    #[test]
    fn overlay_frame_validation_rejects_mismatched_dimensions() {
        assert!(validate_overlay_frame_dimensions(640, 480, 640, 480).is_ok());
        assert!(validate_overlay_frame_dimensions(640, 480, 1920, 1080).is_err());
        assert!(validate_overlay_frame_dimensions(1920, 1080, 640, 480).is_err());
        assert!(validate_overlay_frame_dimensions(640, 480, 640, 481).is_err());
    }

    #[test]
    fn overlay_frame_base64_decode_validates_format() {
        let rgba = vec![0u8; 4];
        let valid_base64 = base64::engine::general_purpose::STANDARD.encode(&rgba);
        let frame = NativeOverlayFrame { rgba_base64: valid_base64, width: 1, height: 1 };
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(frame.rgba_base64)
            .expect("valid base64");
        assert_eq!(decoded.len(), 4);

        let invalid = NativeOverlayFrame { rgba_base64: "!!!".to_string(), width: 1, height: 1 };
        let result = base64::engine::general_purpose::STANDARD.decode(invalid.rgba_base64);
        assert!(result.is_err());
    }

    #[test]
    fn overlay_frame_byte_length_must_match_dimensions() {
        let width = 16u32;
        let height = 9u32;
        let expected_bytes = (width as usize) * (height as usize) * 4;
        assert_eq!(expected_bytes, 576);

        let correct_rgba = vec![0u8; expected_bytes];
        let correct_base64 = base64::engine::general_purpose::STANDARD.encode(&correct_rgba);
        let frame = NativeOverlayFrame { rgba_base64: correct_base64, width, height };
        let rgba = base64::engine::general_purpose::STANDARD
            .decode(frame.rgba_base64.clone())
            .expect("valid base64");
        assert_eq!(rgba.len(), expected_bytes);

        let short_rgba = vec![0u8; expected_bytes - 4];
        let short_base64 = base64::engine::general_purpose::STANDARD.encode(&short_rgba);
        let short_frame = NativeOverlayFrame { rgba_base64: short_base64, width, height };
        let short_decoded = base64::engine::general_purpose::STANDARD
            .decode(short_frame.rgba_base64)
            .expect("valid base64");
        assert_eq!(short_decoded.len(), expected_bytes - 4);
        assert_ne!(short_decoded.len(), expected_bytes);
    }

    #[test]
    fn overlay_frame_dimensions_overflow_check() {
        let huge_width = usize::MAX / 2;
        let huge_height = 3usize;

        let result = huge_width.checked_mul(huge_height).and_then(|pixels| pixels.checked_mul(4));

        assert!(result.is_none(), "overflow should be detected");

        let safe_width = 1920usize;
        let safe_height = 1080usize;
        let safe_result =
            safe_width.checked_mul(safe_height).and_then(|pixels| pixels.checked_mul(4));

        assert!(safe_result.is_some(), "safe dimensions should not overflow");
        assert_eq!(safe_result.unwrap(), 1920 * 1080 * 4);
    }
}
