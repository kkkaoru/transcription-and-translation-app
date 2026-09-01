//! Microphone capture connected to in-process recognition and translation workers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use caption_bridge_audio::{
    initialize_input_device_change_notifications, input_devices_changed,
    is_permission_denied_error, is_recoverable_stream_error, list_input_devices, AudioCapture,
    AudioCaptureConfig, AudioError, InputDevice,
};
use parapper_engine::{
    CaptionUpdateMode, EngineConfig, EngineEvent, LocalTranslator, ParapperEngine,
};
use rust_lib_kotoba_beacon_companion::api::simple::{
    convert_azookey, convert_azookey_hiragana, encode_audio_boundary, encode_stage_request,
    encode_translation_enabled, initialize_azookey_dictionary, release_azookey_dictionary,
    should_continue_on_mobile, ExecutionDevice, MobileStageResult, PipelineRoute, ProcessingStage,
};

use crate::companion::{
    CompanionConnectionSnapshot, CompanionHandle, CompanionInbound, CompanionServer,
};
use crate::domain::{parapper_runtime_dir, CaptureStatus};
use crate::hot_path::{normalize_pcm16_into, NATIVE_PCM_FRAME_SAMPLES};
use crate::memory::release_unused_process_memory;
use crate::microphone_permission::ensure_microphone_access;
use crate::pipeline_diagnostics::record_pipeline_event;

const PARAPPER_VAD_INTERVAL_MS: u32 = 32;
const POLL_TIMEOUT: Duration = Duration::from_millis(16);
const RMS_PUBLISH_INTERVAL: Duration = Duration::from_millis(100);
const COMMAND_QUEUE_CAPACITY: usize = 4;
const EVENT_QUEUE_CAPACITY: usize = 64;
const TRANSLATOR_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MINIMUM_PAIRED_CAPTION_HOLD: Duration = Duration::from_secs(3);
const MOBILE_FINAL_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const MICROPHONE_PERMISSION_MESSAGE: &str = "Microphone access is not permitted";
const DEVICE_NOT_FOUND_MESSAGE: &str = "The selected microphone was not found";
const MAX_CAPTION_CHARACTERS: usize = 2_048;

static DESKTOP_AZOOKEY_READY: Mutex<bool> = Mutex::new(false);

#[derive(Clone, Debug, PartialEq)]
pub struct CaptureSnapshot {
    pub status: CaptureStatus,
    pub devices: Vec<InputDevice>,
    pub selected_device_id: Option<String>,
    pub source_text: String,
    pub translation_text: String,
    pub last_error: Option<String>,
    pub last_rms_dbfs: Option<f32>,
    pub engine_ready: bool,
}

impl Default for CaptureSnapshot {
    fn default() -> Self {
        Self {
            status: CaptureStatus::Idle,
            devices: Vec::new(),
            selected_device_id: None,
            source_text: String::new(),
            translation_text: String::new(),
            last_error: None,
            last_rms_dbfs: None,
            engine_ready: false,
        }
    }
}

impl CaptureSnapshot {
    fn apply_worker_event(&mut self, event: WorkerEvent) {
        match event {
            WorkerEvent::Status(status) => self.status = status,
            WorkerEvent::Caption { source, update_mode, .. } => {
                apply_caption_update(&mut self.source_text, &source, update_mode);
            }
            WorkerEvent::Translation { source, translation, .. } => {
                if self.source_text == source {
                    self.translation_text = translation;
                }
            }
            WorkerEvent::Rms(rms) => self.last_rms_dbfs = rms,
            WorkerEvent::Error(error) => {
                self.last_error = Some(error);
                self.status = CaptureStatus::Error;
            }
            WorkerEvent::TranslationError { message, .. } => self.last_error = Some(message),
            WorkerEvent::EngineReady(ready) => self.engine_ready = ready,
        }
    }
}

enum WorkerCommand {
    Stop,
    ResetCaption,
    SetTranslationEnabled(bool),
}

#[derive(Debug, PartialEq, Eq)]
struct TranslationRequest {
    turn_id: u64,
    revision: u64,
    source: String,
}

enum TranslationCommand {
    Warm,
    Translate(TranslationRequest),
}

#[derive(Default)]
struct TranslationMailboxState {
    warm_requested: bool,
    latest_request: Option<TranslationRequest>,
}

struct TranslationMailboxSender {
    state: Arc<Mutex<TranslationMailboxState>>,
    wake_sender: SyncSender<()>,
}

struct TranslationMailboxReceiver {
    state: Arc<Mutex<TranslationMailboxState>>,
    wake_receiver: Receiver<()>,
}

enum WorkerEvent {
    Status(CaptureStatus),
    Caption {
        turn_id: u64,
        revision: u64,
        source: String,
        update_mode: CaptionUpdateMode,
        is_final: bool,
    },
    Translation {
        turn_id: u64,
        revision: u64,
        source: String,
        translation: String,
    },
    TranslationError {
        revision: Option<u64>,
        message: String,
    },
    Rms(Option<f32>),
    Error(String),
    EngineReady(bool),
}

struct TranslationWorker {
    sender: TranslationMailboxSender,
    handle: JoinHandle<()>,
    stop_requested: Arc<AtomicBool>,
}

struct CaptureWorkerOptions {
    models_root: std::path::PathBuf,
    device_id: Option<String>,
    translation_enabled: bool,
    companion_route: PipelineRoute,
    companion_session: Option<(CompanionHandle, String)>,
}

struct RoutedStageOutput {
    turn_id: u64,
    revision: u64,
    text: String,
    display_text: String,
    is_final: bool,
}

struct RoutingContext<'a> {
    route: PipelineRoute,
    companion: Option<&'a CompanionHandle>,
    session_id: Option<&'a str>,
    event_tx: &'a SyncSender<WorkerEvent>,
    translation_tx: Option<&'a TranslationMailboxSender>,
    translation_enabled: bool,
}

struct EnginePublishState<'a> {
    recognition_text: &'a mut String,
    recognition_surface_text: &'a mut String,
    recognition_turn_id: &'a mut Option<String>,
    recognition_input_is_hiragana: &'a mut bool,
    caption_revision: &'a mut u64,
    canonical_seen_turn: &'a mut Option<(u64, u64)>,
}

pub struct CaptureController {
    snapshot: CaptureSnapshot,
    caption_expires_at: Option<Instant>,
    command_tx: Option<SyncSender<WorkerCommand>>,
    event_rx: Option<Receiver<WorkerEvent>>,
    worker: Option<JoinHandle<()>>,
    worker_stop_requested: Option<Arc<AtomicBool>>,
    translation_enabled: bool,
    current_caption_turn_id: Option<u64>,
    current_caption_revision: u64,
    awaiting_translation_revision: Option<u64>,
    recognition_in_progress: bool,
    companion_route: PipelineRoute,
    companion_server: Option<CompanionServer>,
}

impl CaptureController {
    pub fn new() -> Self {
        initialize_input_device_change_notifications();
        let mut controller = Self {
            snapshot: CaptureSnapshot::default(),
            caption_expires_at: None,
            command_tx: None,
            event_rx: None,
            worker: None,
            worker_stop_requested: None,
            translation_enabled: false,
            current_caption_turn_id: None,
            current_caption_revision: 0,
            awaiting_translation_revision: None,
            recognition_in_progress: false,
            companion_route: desktop_pipeline_route(),
            companion_server: None,
        };
        controller.refresh_devices();
        controller
    }

    pub fn snapshot(&self) -> &CaptureSnapshot {
        &self.snapshot
    }

    pub fn translation_enabled(&self) -> bool {
        self.translation_enabled
    }

    pub fn companion_snapshot(&self) -> Option<CompanionConnectionSnapshot> {
        self.companion_server.as_ref().map(CompanionServer::snapshot)
    }

    pub fn publish_mobile_browser_caption(
        &self,
        source: &str,
        translation: &str,
    ) -> Result<bool, String> {
        let Some(server) = &self.companion_server else {
            return Ok(false);
        };
        server.publish_browser_source_caption(source, translation)
    }

    pub fn configure_companion(&mut self, route: PipelineRoute) -> Result<(), String> {
        if self.worker.is_some() {
            return Err("Stop capture before changing companion processing locations".to_string());
        }
        if self.companion_route == route && self.companion_server.is_some() {
            return Ok(());
        }
        if let Some(server) = &self.companion_server {
            server.set_route(route)?;
            if route.azookey == ExecutionDevice::Mobile {
                release_desktop_azookey();
            }
            self.companion_route = route;
            return Ok(());
        }
        let server = CompanionServer::start(route)?;
        if route.azookey == ExecutionDevice::Mobile {
            release_desktop_azookey();
        }
        self.companion_route = route;
        self.companion_server = Some(server);
        Ok(())
    }

    pub fn disable_companion(&mut self) -> Result<(), String> {
        if self.worker.is_some() {
            return Err("Stop capture before disabling the mobile companion".to_string());
        }
        self.companion_server = None;
        self.companion_route = desktop_pipeline_route();
        Ok(())
    }

    pub fn refresh_devices(&mut self) -> bool {
        let previous_selection = self.snapshot.selected_device_id.clone();
        let changed = match list_input_devices() {
            Ok(devices) => {
                let devices_changed = self.snapshot.devices != devices;
                self.apply_device_list(devices);
                devices_changed || self.snapshot.selected_device_id != previous_selection
            }
            Err(error) => {
                let message = error.to_string();
                let error_changed = self.snapshot.last_error.as_deref() != Some(message.as_str())
                    || self.snapshot.status != CaptureStatus::Error;
                self.snapshot.last_error = Some(message);
                self.snapshot.status = CaptureStatus::Error;
                error_changed
            }
        };
        changed
    }

    pub fn select_device(&mut self, id: &str) {
        if self.snapshot.devices.iter().any(|device| device.id == id) {
            self.snapshot.selected_device_id = Some(id.to_string());
        }
    }

    pub fn poll(&mut self, caption_timeout_ms: u64) -> bool {
        let now = Instant::now();
        let route_changed = self.sync_companion_route();
        let mut changed = route_changed || (input_devices_changed() && self.refresh_devices());
        let Some(receiver) = self.event_rx.as_ref() else {
            return self.expire_caption_at(now) || changed;
        };
        let mut events = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            events.push(event);
        }
        for event in events {
            let refresh_devices = matches!(event, WorkerEvent::Error(_));
            self.apply_worker_event_at(event, now, caption_timeout_ms);
            if refresh_devices {
                self.refresh_devices();
            }
            changed = true;
        }
        changed |= self.expire_caption_at(now);
        if self
            .worker_stop_requested
            .as_ref()
            .is_some_and(|stop_requested| stop_requested.load(Ordering::Acquire))
            && self.worker.as_ref().is_some_and(|worker| !worker.is_finished())
            && self.snapshot.status != CaptureStatus::Stopping
        {
            self.snapshot.status = CaptureStatus::Stopping;
            changed = true;
        }
        changed |= self.reap_finished_worker();
        changed
    }

    fn sync_companion_route(&mut self) -> bool {
        if self.snapshot.status != CaptureStatus::Idle {
            return false;
        }
        let Some(server) = &self.companion_server else {
            return false;
        };
        let route = server.snapshot().route;
        if route == self.companion_route {
            return false;
        }
        self.companion_route = route;
        if route.azookey == ExecutionDevice::Mobile {
            release_desktop_azookey();
        }
        true
    }

    pub fn start(&mut self, translation_enabled: bool) -> Result<(), String> {
        self.reap_finished_worker();
        if self.worker.is_some() {
            return if self.snapshot.status == CaptureStatus::Capturing {
                Ok(())
            } else {
                Err("Speech recognition is still stopping".to_string())
            };
        }
        self.refresh_devices();
        let companion_session = if route_uses_mobile(self.companion_route) {
            let server = self.companion_server.as_ref().ok_or_else(|| {
                "Enable the companion LAN server before starting capture".to_string()
            })?;
            let snapshot = server.snapshot();
            let session_id = snapshot.session_id.ok_or_else(|| {
                "Connect and pair the mobile companion before starting capture".to_string()
            })?;
            Some((server.handle(), session_id))
        } else {
            None
        };
        let models_root = parapper_runtime_dir()?.join("models");
        let device_id = self.snapshot.selected_device_id.clone();
        let companion_route = self.companion_route;
        let (command_tx, command_rx) = mpsc::sync_channel(COMMAND_QUEUE_CAPACITY);
        let (event_tx, event_rx) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let stop_requested = Arc::new(AtomicBool::new(false));
        let worker_stop_requested = stop_requested.clone();
        let worker_options = CaptureWorkerOptions {
            models_root,
            device_id,
            translation_enabled,
            companion_route,
            companion_session,
        };
        let handle = thread::Builder::new()
            .name("native-recognition".to_string())
            .spawn(move || {
                run_capture_worker(worker_options, command_rx, event_tx, worker_stop_requested)
            })
            .map_err(|error| format!("could not start recognition thread: {error}"))?;
        self.command_tx = Some(command_tx);
        self.event_rx = Some(event_rx);
        self.worker = Some(handle);
        self.worker_stop_requested = Some(stop_requested);
        self.translation_enabled = translation_enabled;
        self.current_caption_turn_id = None;
        self.current_caption_revision = 0;
        self.awaiting_translation_revision = None;
        self.recognition_in_progress = false;
        self.snapshot.status = CaptureStatus::Capturing;
        self.snapshot.last_error = None;
        self.snapshot.source_text.clear();
        self.snapshot.translation_text.clear();
        self.caption_expires_at = None;
        Ok(())
    }

    pub fn set_translation_enabled(&mut self, enabled: bool) -> Result<(), String> {
        if self.translation_enabled == enabled {
            return Ok(());
        }
        if let Some(sender) = self.command_tx.as_ref() {
            sender.try_send(WorkerCommand::SetTranslationEnabled(enabled)).map_err(|error| {
                format!("could not update translation while capturing: {error}")
            })?;
        }
        self.translation_enabled = enabled;
        if !enabled {
            self.snapshot.translation_text.clear();
            self.awaiting_translation_revision = None;
            if !self.snapshot.source_text.is_empty() {
                self.caption_expires_at = Some(Instant::now() + MINIMUM_PAIRED_CAPTION_HOLD);
            }
        }
        Ok(())
    }

    pub fn stop(&mut self) {
        // Never join here. ONNX/Core ML and CoreAudio initialization may synchronously dispatch
        // work to the macOS main thread; joining from a GPUI callback would deadlock that work.
        if let Some(stop_requested) = self.worker_stop_requested.as_ref() {
            stop_requested.store(true, Ordering::Release);
        }
        if let Some(sender) = self.command_tx.take() {
            let _ = sender.try_send(WorkerCommand::Stop);
        }
        self.snapshot.status = if self.worker.as_ref().is_some_and(|worker| !worker.is_finished()) {
            CaptureStatus::Stopping
        } else {
            self.reap_finished_worker();
            CaptureStatus::Idle
        };
        self.snapshot.engine_ready = false;
        self.awaiting_translation_revision = None;
        self.recognition_in_progress = false;
    }

    fn apply_worker_event_at(&mut self, event: WorkerEvent, now: Instant, caption_timeout_ms: u64) {
        let configured_hold = Duration::from_millis(caption_timeout_ms);
        match event {
            WorkerEvent::Caption { turn_id, revision, source, update_mode, is_final } => {
                let current_turn = self.current_caption_turn_id;
                let stale = current_turn.is_some_and(|current| turn_id < current)
                    || (current_turn == Some(turn_id) && revision < self.current_caption_revision);
                if stale {
                    record_pipeline_event(
                        "ui_caption_discarded",
                        &serde_json::json!({
                            "turn_id": turn_id,
                            "current_turn_id": current_turn,
                            "revision": revision,
                            "current_revision": self.current_caption_revision,
                            "source": &source,
                            "is_final": is_final,
                            "reason": "stale_turn_or_revision",
                        }),
                    );
                    return;
                }
                let starts_new_turn = current_turn != Some(turn_id);
                if starts_new_turn {
                    self.snapshot.source_text.clear();
                    self.snapshot.translation_text.clear();
                    self.awaiting_translation_revision = None;
                }
                // Keep the latest translation from this same turn visible while
                // recognition advances. A newer translation replaces it; only a
                // genuinely new turn clears it.
                self.current_caption_turn_id = Some(turn_id);
                self.current_caption_revision = revision;
                self.recognition_in_progress = !is_final;
                self.snapshot.apply_worker_event(WorkerEvent::Caption {
                    turn_id,
                    revision,
                    source,
                    update_mode,
                    is_final,
                });
                record_pipeline_event(
                    "ui_caption_applied",
                    &serde_json::json!({
                        "turn_id": turn_id,
                        "revision": revision,
                        "displayed_source": &self.snapshot.source_text,
                        "is_final": is_final,
                        "update_mode": format!("{update_mode:?}"),
                    }),
                );
                if self.translation_enabled && is_final {
                    self.awaiting_translation_revision = Some(revision);
                    self.caption_expires_at = None;
                } else {
                    self.caption_expires_at = Some(now + configured_hold);
                }
            }
            WorkerEvent::Translation { turn_id, revision, source, translation } => {
                if !self.translation_enabled || self.current_caption_turn_id != Some(turn_id) {
                    record_pipeline_event(
                        "ui_translation_discarded",
                        &serde_json::json!({
                            "turn_id": turn_id,
                            "current_turn_id": self.current_caption_turn_id,
                            "revision": revision,
                            "current_revision": self.current_caption_revision,
                            "source": source,
                            "reason": "stale_turn",
                        }),
                    );
                    return;
                }
                self.snapshot.translation_text = translation;
                record_pipeline_event(
                    "ui_translation_applied",
                    &serde_json::json!({
                        "turn_id": turn_id,
                        "revision": revision,
                        "current_revision": self.current_caption_revision,
                        "source": source,
                    }),
                );
                if self.awaiting_translation_revision == Some(revision) {
                    self.awaiting_translation_revision = None;
                }
                self.caption_expires_at =
                    Some(now + configured_hold.max(MINIMUM_PAIRED_CAPTION_HOLD));
            }
            WorkerEvent::TranslationError { revision, message } => {
                if !self.translation_enabled
                    || revision.is_some_and(|revision| revision != self.current_caption_revision)
                {
                    return;
                }
                self.snapshot
                    .apply_worker_event(WorkerEvent::TranslationError { revision, message });
                if revision.is_none() || self.awaiting_translation_revision == revision {
                    self.awaiting_translation_revision = None;
                    self.caption_expires_at = Some(now + configured_hold);
                }
            }
            other => {
                if matches!(
                    &other,
                    WorkerEvent::Error(_)
                        | WorkerEvent::Status(CaptureStatus::Idle | CaptureStatus::Error)
                ) {
                    self.recognition_in_progress = false;
                }
                self.snapshot.apply_worker_event(other);
            }
        }
    }

    fn reap_finished_worker(&mut self) -> bool {
        if !self.worker.as_ref().is_some_and(JoinHandle::is_finished) {
            return false;
        }
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
        self.command_tx = None;
        self.event_rx = None;
        self.worker_stop_requested = None;
        if self.snapshot.status == CaptureStatus::Stopping {
            self.snapshot.status = CaptureStatus::Idle;
        }
        true
    }

    fn expire_caption_at(&mut self, now: Instant) -> bool {
        if self.recognition_in_progress
            || self.awaiting_translation_revision.is_some()
            || !self.caption_expires_at.is_some_and(|deadline| now >= deadline)
        {
            return false;
        }
        self.snapshot.source_text.clear();
        self.snapshot.translation_text.clear();
        self.caption_expires_at = None;
        self.awaiting_translation_revision = None;
        if let Some(sender) = self.command_tx.as_ref() {
            let _ = sender.try_send(WorkerCommand::ResetCaption);
        }
        true
    }

    fn apply_device_list(&mut self, devices: Vec<InputDevice>) {
        if let Some(selected) = self.snapshot.selected_device_id.as_deref() {
            if !devices.iter().any(|device| device.id == selected) {
                self.snapshot.selected_device_id = None;
            }
        }
        if self.snapshot.selected_device_id.is_none() {
            self.snapshot.selected_device_id =
                devices.iter().find(|device| device.is_default).map(|device| device.id.clone());
        }
        self.snapshot.devices = devices;
    }
}

impl Drop for CaptureController {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_capture_worker(
    options: CaptureWorkerOptions,
    command_rx: Receiver<WorkerCommand>,
    event_tx: SyncSender<WorkerEvent>,
    stop_requested: Arc<AtomicBool>,
) {
    let result = run_capture_inner(options, &command_rx, &event_tx, &stop_requested);
    // At this boundary every ASR, VAD, turn-detector, translation, and audio
    // owner created by run_capture_inner has been dropped. Trim only now so
    // allocator pages cannot outlive a completed capture session.
    release_unused_process_memory();
    if let Err(error) = result {
        let _ = event_tx.send(WorkerEvent::Error(error));
    }
    let _ = event_tx.send(WorkerEvent::EngineReady(false));
    let _ = event_tx.send(WorkerEvent::Status(CaptureStatus::Idle));
}

fn run_capture_inner(
    options: CaptureWorkerOptions,
    command_rx: &Receiver<WorkerCommand>,
    event_tx: &SyncSender<WorkerEvent>,
    stop_requested: &AtomicBool,
) -> Result<(), String> {
    let CaptureWorkerOptions {
        models_root,
        device_id,
        translation_enabled,
        companion_route,
        companion_session,
    } = options;
    if stop_requested.load(Ordering::Acquire) {
        return Ok(());
    }
    if !ensure_microphone_access() {
        return Err(MICROPHONE_PERMISSION_MESSAGE.to_string());
    }
    if stop_requested.load(Ordering::Acquire) {
        return Ok(());
    }
    let mut engine = if companion_route.asr == ExecutionDevice::Desktop {
        let config = native_engine_config(models_root.clone());
        Some(
            ParapperEngine::load(&config)
                .map_err(|error| format!("Could not initialize speech recognition: {error:#}"))?,
        )
    } else {
        None
    };
    // Start QuickMT only after any selected desktop ASR, VAD, and turn-detector initialization.
    // A mobile-owned stage must not retain its desktop model counterpart.
    let mut translation_requested = translation_enabled;
    let desktop_translation_enabled =
        translation_requested && companion_route.translation == ExecutionDevice::Desktop;
    let mut translation_worker = start_translation_worker(
        desktop_translation_enabled,
        models_root.clone(),
        event_tx.clone(),
    )?;
    if stop_requested.load(Ordering::Acquire) {
        return Ok(());
    }
    let _ = event_tx.send(WorkerEvent::EngineReady(true));

    let mut capture = AudioCapture::new(native_audio_config())
        .map_err(|error| format!("Could not initialize microphone: {error}"))?;
    capture.start(device_id.as_deref()).map_err(format_audio_start_error)?;
    if stop_requested.load(Ordering::Acquire) {
        let _ = capture.stop();
        return Ok(());
    }
    let _ = event_tx.send(WorkerEvent::Status(CaptureStatus::Capturing));
    let mut recognition_text = String::new();
    let mut recognition_surface_text = String::new();
    let mut recognition_turn_id = None;
    let mut recognition_input_is_hiragana = false;
    let mut caption_revision = 0_u64;
    let mut canonical_seen_turn = None;
    let mut normalized_samples = Vec::with_capacity(NATIVE_PCM_FRAME_SAMPLES);
    let mut last_rms_publish = Instant::now() - RMS_PUBLISH_INTERVAL;
    let (companion_handle, companion_session_id) = match companion_session {
        Some((handle, session_id)) => (Some(handle), Some(session_id)),
        None => (None, None),
    };
    if let (Some(companion), Some(session_id)) =
        (companion_handle.as_ref(), companion_session_id.as_deref())
    {
        companion.send_text(encode_translation_enabled(
            session_id.to_string(),
            translation_requested,
        )?)?;
    }
    if companion_route.asr == ExecutionDevice::Mobile {
        send_companion_audio_boundary(
            companion_handle.as_ref(),
            companion_session_id.as_deref(),
            "audio.start",
            1,
            1,
        )?;
    }

    loop {
        if stop_requested.load(Ordering::Acquire) {
            break;
        }
        match command_rx.recv_timeout(POLL_TIMEOUT) {
            Ok(WorkerCommand::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(WorkerCommand::ResetCaption) => {
                recognition_text.clear();
                recognition_surface_text.clear();
                recognition_turn_id = None;
                recognition_input_is_hiragana = false;
                canonical_seen_turn = None;
            }
            Ok(WorkerCommand::SetTranslationEnabled(enabled)) => {
                translation_requested = enabled;
                if let (Some(companion), Some(session_id)) =
                    (companion_handle.as_ref(), companion_session_id.as_deref())
                {
                    companion.send_text(encode_translation_enabled(
                        session_id.to_string(),
                        translation_requested,
                    )?)?;
                }
                let enabled = translation_requested
                    && companion_route.translation == ExecutionDevice::Desktop;
                if enabled && translation_worker.is_none() {
                    translation_worker =
                        start_translation_worker(true, models_root.clone(), event_tx.clone())?;
                } else if !enabled {
                    if let Some(worker) = translation_worker.take() {
                        stop_translation_worker(worker, false);
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        loop {
            match capture.try_next_frame() {
                Ok(Some(frame)) => {
                    if companion_route.asr == ExecutionDevice::Mobile {
                        companion_handle
                            .as_ref()
                            .ok_or_else(|| "mobile ASR companion is unavailable".to_string())?
                            .send_pcm16(&frame)?;
                    }
                    let events = if let Some(engine) = engine.as_mut() {
                        normalize_pcm16_into(&frame, &mut normalized_samples);
                        engine
                            .push_audio(&normalized_samples)
                            .map_err(|error| format!("Speech recognition failed: {error:#}"))?
                    } else {
                        Vec::new()
                    };
                    let routing = RoutingContext {
                        route: companion_route,
                        companion: companion_handle.as_ref(),
                        session_id: companion_session_id.as_deref(),
                        event_tx,
                        translation_tx: translation_worker.as_ref().map(|worker| &worker.sender),
                        translation_enabled: translation_requested,
                    };
                    let mut state = EnginePublishState {
                        recognition_text: &mut recognition_text,
                        recognition_surface_text: &mut recognition_surface_text,
                        recognition_turn_id: &mut recognition_turn_id,
                        recognition_input_is_hiragana: &mut recognition_input_is_hiragana,
                        caption_revision: &mut caption_revision,
                        canonical_seen_turn: &mut canonical_seen_turn,
                    };
                    publish_engine_events(events, &routing, &mut state)?;
                }
                Ok(None) => break,
                Err(error) if is_recoverable_stream_error(&error) => continue,
                Err(error) => return Err(format_audio_read_error(error)),
            }
        }
        if let (Some(companion), Some(session_id)) =
            (companion_handle.as_ref(), companion_session_id.as_deref())
        {
            let routing = RoutingContext {
                route: companion_route,
                companion: Some(companion),
                session_id: Some(session_id),
                event_tx,
                translation_tx: translation_worker.as_ref().map(|worker| &worker.sender),
                translation_enabled: translation_requested,
            };
            while let Some(inbound) = companion.try_recv() {
                match inbound {
                    CompanionInbound::StageResult(result) => {
                        handle_mobile_result(
                            result,
                            &routing,
                            &mut caption_revision,
                            &mut recognition_text,
                        )?;
                    }
                    CompanionInbound::Disconnected { session_id }
                        if disconnected_current_session(
                            &session_id,
                            companion_session_id.as_deref(),
                        ) =>
                    {
                        return Err("mobile companion disconnected during capture".to_string());
                    }
                    CompanionInbound::Disconnected { .. } => {}
                }
            }
        }
        let routing = RoutingContext {
            route: companion_route,
            companion: companion_handle.as_ref(),
            session_id: companion_session_id.as_deref(),
            event_tx,
            translation_tx: translation_worker.as_ref().map(|worker| &worker.sender),
            translation_enabled: translation_requested,
        };
        let mut state = EnginePublishState {
            recognition_text: &mut recognition_text,
            recognition_surface_text: &mut recognition_surface_text,
            recognition_turn_id: &mut recognition_turn_id,
            recognition_input_is_hiragana: &mut recognition_input_is_hiragana,
            caption_revision: &mut caption_revision,
            canonical_seen_turn: &mut canonical_seen_turn,
        };
        let tick_events = engine.as_mut().map_or_else(Vec::new, ParapperEngine::tick);
        publish_engine_events(tick_events, &routing, &mut state)?;
        if last_rms_publish.elapsed() >= RMS_PUBLISH_INTERVAL {
            let _ = event_tx.try_send(WorkerEvent::Rms(capture.stats().last_input_rms_dbfs));
            last_rms_publish = Instant::now();
        }
    }

    let _ = capture.stop();
    let events = engine.map_or_else(Vec::new, |engine| engine.shutdown().1);
    let routing = RoutingContext {
        route: companion_route,
        companion: companion_handle.as_ref(),
        session_id: companion_session_id.as_deref(),
        event_tx,
        translation_tx: translation_worker.as_ref().map(|worker| &worker.sender),
        translation_enabled: translation_requested,
    };
    let mut state = EnginePublishState {
        recognition_text: &mut recognition_text,
        recognition_surface_text: &mut recognition_surface_text,
        recognition_turn_id: &mut recognition_turn_id,
        recognition_input_is_hiragana: &mut recognition_input_is_hiragana,
        caption_revision: &mut caption_revision,
        canonical_seen_turn: &mut canonical_seen_turn,
    };
    publish_engine_events(events, &routing, &mut state)?;
    if companion_route.asr == ExecutionDevice::Mobile {
        send_companion_audio_boundary(
            companion_handle.as_ref(),
            companion_session_id.as_deref(),
            "audio.end",
            1,
            1,
        )?;
    }
    if route_uses_mobile(companion_route) && caption_revision > 0 {
        let companion = companion_handle
            .as_ref()
            .ok_or_else(|| "mobile companion is unavailable during final drain".to_string())?;
        drain_mobile_final_results(
            &routing,
            companion,
            &mut caption_revision,
            &mut recognition_text,
        )?;
    }
    if let Some(worker) = translation_worker.take() {
        stop_translation_worker(worker, true);
    }
    Ok(())
}

fn translation_mailbox() -> (TranslationMailboxSender, TranslationMailboxReceiver) {
    let state = Arc::new(Mutex::new(TranslationMailboxState::default()));
    let (wake_sender, wake_receiver) = mpsc::sync_channel(1);
    (
        TranslationMailboxSender { state: Arc::clone(&state), wake_sender },
        TranslationMailboxReceiver { state, wake_receiver },
    )
}

impl TranslationMailboxSender {
    fn request_warmup(&self) -> bool {
        {
            let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.warm_requested = true;
        }
        match self.wake_sender.try_send(()) {
            Ok(()) | Err(TrySendError::Full(())) => true,
            Err(TrySendError::Disconnected(())) => false,
        }
    }

    fn replace_translation(&self, request: TranslationRequest) -> bool {
        {
            let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.latest_request = Some(request);
            state.warm_requested = false;
        }
        match self.wake_sender.try_send(()) {
            Ok(()) | Err(TrySendError::Full(())) => true,
            Err(TrySendError::Disconnected(())) => false,
        }
    }
}

impl TranslationMailboxReceiver {
    fn recv_timeout(&self, timeout: Duration) -> Result<TranslationCommand, RecvTimeoutError> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(command) = self.take_pending() {
                return Ok(command);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(RecvTimeoutError::Timeout);
            }
            self.wake_receiver.recv_timeout(remaining)?;
        }
    }

    fn take_pending(&self) -> Option<TranslationCommand> {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(request) = state.latest_request.take() {
            state.warm_requested = false;
            return Some(TranslationCommand::Translate(request));
        }
        if std::mem::take(&mut state.warm_requested) {
            return Some(TranslationCommand::Warm);
        }
        None
    }
}

fn start_translation_worker(
    enabled: bool,
    models_root: std::path::PathBuf,
    event_tx: SyncSender<WorkerEvent>,
) -> Result<Option<TranslationWorker>, String> {
    if !enabled {
        return Ok(None);
    }
    let (sender, receiver) = translation_mailbox();
    let stop_requested = Arc::new(AtomicBool::new(false));
    let worker_stop_requested = Arc::clone(&stop_requested);
    let handle = thread::Builder::new()
        .name("native-translation".to_string())
        .spawn(move || {
            run_translation_worker(models_root, receiver, event_tx, &worker_stop_requested)
        })
        .map_err(|error| format!("could not start translation thread: {error}"))?;
    if !sender.request_warmup() {
        return Err("could not warm QuickMT translation: worker stopped".to_string());
    }
    Ok(Some(TranslationWorker { sender, handle, stop_requested }))
}

fn stop_translation_worker(worker: TranslationWorker, join: bool) {
    worker.stop_requested.store(true, Ordering::Release);
    drop(worker.sender);
    if join {
        let _ = worker.handle.join();
    }
}

fn run_translation_worker(
    models_root: std::path::PathBuf,
    receiver: TranslationMailboxReceiver,
    event_tx: SyncSender<WorkerEvent>,
    stop_requested: &AtomicBool,
) {
    let mut translator = None;
    loop {
        if stop_requested.load(Ordering::Acquire) {
            break;
        }
        let command = match receiver.recv_timeout(TRANSLATOR_IDLE_TIMEOUT) {
            Ok(command) => command,
            Err(RecvTimeoutError::Timeout) => {
                translator = None;
                release_unused_process_memory();
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let revision = match &command {
            TranslationCommand::Warm => None,
            TranslationCommand::Translate(request) => Some(request.revision),
        };
        if translator.is_none() {
            match LocalTranslator::load(&models_root) {
                Ok(loaded) => translator = Some(loaded),
                Err(error) => {
                    let _ = event_tx.send(WorkerEvent::TranslationError {
                        revision,
                        message: format!("QuickMT INT8 model is unavailable: {error:#}"),
                    });
                    continue;
                }
            }
        }
        if stop_requested.load(Ordering::Acquire) {
            break;
        }
        let TranslationCommand::Translate(request) = command else {
            continue;
        };
        let Some(translator) = translator.as_mut() else {
            continue;
        };
        match translator.translate_ja_to_en(&request.source) {
            Ok(translation) => {
                record_pipeline_event(
                    "desktop_translation_completed",
                    &serde_json::json!({
                        "turn_id": request.turn_id,
                        "revision": request.revision,
                        "source": &request.source,
                    }),
                );
                if !stop_requested.load(Ordering::Acquire) {
                    let _ = event_tx.send(WorkerEvent::Translation {
                        turn_id: request.turn_id,
                        revision: request.revision,
                        source: request.source,
                        translation,
                    });
                }
            }
            Err(error) => {
                let _ = event_tx.send(WorkerEvent::TranslationError {
                    revision: Some(request.revision),
                    message: format!("Translation failed: {error:#}"),
                });
            }
        }
    }
    drop(translator);
    release_unused_process_memory();
}

fn send_companion_audio_boundary(
    companion: Option<&CompanionHandle>,
    session_id: Option<&str>,
    message_type: &str,
    turn_id: u64,
    revision: u64,
) -> Result<(), String> {
    let companion = companion.ok_or_else(|| "mobile companion is unavailable".to_string())?;
    let session_id =
        session_id.ok_or_else(|| "mobile companion session is unavailable".to_string())?;
    companion.send_text(encode_audio_boundary(
        message_type.to_string(),
        session_id.to_string(),
        turn_id,
        revision,
    )?)
}

fn initialize_desktop_azookey() -> Result<(), String> {
    let mut ready = DESKTOP_AZOOKEY_READY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if *ready {
        return Ok(());
    }
    let path = desktop_azookey_dictionary_path().ok_or_else(|| {
        "bundled AzooKey dictionary is unavailable; package Native again".to_string()
    })?;
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    initialize_azookey_dictionary(bytes)?;
    *ready = true;
    Ok(())
}

fn release_desktop_azookey() {
    release_azookey_dictionary();
    let mut ready = DESKTOP_AZOOKEY_READY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *ready = false;
    release_unused_process_memory();
}

fn desktop_azookey_dictionary_path() -> Option<std::path::PathBuf> {
    let configured = std::env::var_os("KOTOBA_AZOOKEY_DICTIONARY")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from);
    let executable = std::env::current_exe().ok();
    let macos_resource = executable.as_ref().and_then(|path| {
        path.parent()?
            .parent()
            .map(|contents| contents.join("Resources").join("azookey").join("system.azkdict.gz"))
    });
    let portable_resource = executable.as_ref().and_then(|path| {
        path.parent().map(|directory| directory.join("azookey").join("system.azkdict.gz"))
    });
    let repository_resource = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../cloudflare-worker-server/public/azookey/system.azkdict.gz");
    configured
        .into_iter()
        .chain(macos_resource)
        .chain(portable_resource)
        .chain([repository_resource])
        .find(|path| path.is_file())
}

fn route_asr_output(
    context: &RoutingContext<'_>,
    output: RoutedStageOutput,
    input_is_normalized_hiragana: bool,
) -> Result<(), String> {
    record_pipeline_event(
        "asr_routed",
        &serde_json::json!({
            "turn_id": output.turn_id,
            "revision": output.revision,
            "azookey_input": &output.text,
            "input_is_normalized_hiragana": input_is_normalized_hiragana,
            "is_final": output.is_final,
            "route": context.route,
        }),
    );
    let _ = context.event_tx.send(WorkerEvent::Caption {
        turn_id: output.turn_id,
        revision: output.revision,
        source: output.display_text.clone(),
        update_mode: CaptionUpdateMode::Replace,
        is_final: output.is_final,
    });
    // Mobile AzooKey conversion is intentionally reserved for the finalized
    // canonical reading. While the turn is open, translate the ASR surface
    // directly so long speech still receives useful incremental translations.
    if context.route.azookey == ExecutionDevice::Mobile && !output.is_final {
        let surface = output.display_text.clone();
        return route_translation_input(
            context,
            RoutedStageOutput { text: surface.clone(), display_text: surface, ..output },
            ProcessingStage::Asr,
        );
    }
    if context.route.azookey == ExecutionDevice::Mobile {
        if should_continue_on_mobile(context.route, ProcessingStage::Asr) {
            return Ok(());
        }
        let companion = context
            .companion
            .ok_or_else(|| "mobile AzooKey companion is unavailable".to_string())?;
        let session_id = context
            .session_id
            .ok_or_else(|| "mobile companion session is unavailable".to_string())?;
        let request = encode_stage_request(
            "azookey.request".to_string(),
            session_id.to_string(),
            output.turn_id,
            output.revision,
            output.text,
            output.is_final,
        )?;
        return companion.send_text(request);
    }
    initialize_desktop_azookey()?;
    let converted_source = if input_is_normalized_hiragana {
        convert_azookey_hiragana(output.text.clone())?.text
    } else {
        convert_azookey(output.text.clone())?.text
    };
    route_azookey_output(
        context,
        RoutedStageOutput {
            text: converted_source.clone(),
            display_text: converted_source,
            ..output
        },
    )
}

fn route_azookey_output(
    context: &RoutingContext<'_>,
    output: RoutedStageOutput,
) -> Result<(), String> {
    record_pipeline_event(
        "azookey_output",
        &serde_json::json!({
            "turn_id": output.turn_id,
            "revision": output.revision,
            "text": &output.text,
            "is_final": output.is_final,
            "execution_device": context.route.azookey,
        }),
    );
    let _ = context.event_tx.send(WorkerEvent::Caption {
        turn_id: output.turn_id,
        revision: output.revision,
        source: output.display_text.clone(),
        update_mode: CaptionUpdateMode::Replace,
        is_final: output.is_final,
    });
    route_translation_input(context, output, ProcessingStage::Azookey)
}

fn route_translation_input(
    context: &RoutingContext<'_>,
    output: RoutedStageOutput,
    input_stage: ProcessingStage,
) -> Result<(), String> {
    if !context.translation_enabled {
        return Ok(());
    }
    if context.route.translation == ExecutionDevice::Mobile {
        if input_stage == ProcessingStage::Azookey
            && should_continue_on_mobile(context.route, ProcessingStage::Azookey)
        {
            return Ok(());
        }
        let companion = context
            .companion
            .ok_or_else(|| "mobile translation companion is unavailable".to_string())?;
        let session_id = context
            .session_id
            .ok_or_else(|| "mobile companion session is unavailable".to_string())?;
        record_pipeline_event(
            "mobile_translation_queued",
            &serde_json::json!({
                "turn_id": output.turn_id,
                "revision": output.revision,
                "source": &output.text,
                "is_final": output.is_final,
                "input_stage": format!("{input_stage:?}"),
            }),
        );
        return companion.send_text(encode_stage_request(
            "translation.request".to_string(),
            session_id.to_string(),
            output.turn_id,
            output.revision,
            output.text,
            output.is_final,
        )?);
    }
    if let Some(sender) = context.translation_tx {
        record_pipeline_event(
            "desktop_translation_queued",
            &serde_json::json!({
                "turn_id": output.turn_id,
                "revision": output.revision,
                "source": &output.text,
                "is_final": output.is_final,
                "input_stage": format!("{input_stage:?}"),
            }),
        );
        queue_translation(
            sender,
            TranslationRequest {
                turn_id: output.turn_id,
                revision: output.revision,
                source: output.text,
            },
            context.event_tx,
        );
    }
    Ok(())
}

fn handle_mobile_result(
    result: MobileStageResult,
    context: &RoutingContext<'_>,
    caption_revision: &mut u64,
    latest_source: &mut String,
) -> Result<bool, String> {
    let accepted = context.session_id == Some(result.session_id.as_str())
        && result.revision >= *caption_revision;
    record_pipeline_event(
        "mobile_stage_result",
        &serde_json::json!({
            "message_type": &result.message_type,
            "turn_id": result.turn_id,
            "revision": result.revision,
            "text": &result.text,
            "is_final": result.is_final,
            "accepted": accepted,
        }),
    );
    if !accepted {
        return Ok(false);
    }
    match result.message_type.as_str() {
        "asr.update" if context.route.asr == ExecutionDevice::Mobile => {
            *caption_revision = (*caption_revision).max(result.revision);
            *latest_source = result.text.clone();
            route_asr_output(
                context,
                RoutedStageOutput {
                    turn_id: result.turn_id,
                    revision: result.revision,
                    display_text: result.text.clone(),
                    text: result.text,
                    is_final: result.is_final,
                },
                false,
            )?;
            Ok(true)
        }
        "azookey.result" if context.route.azookey == ExecutionDevice::Mobile => {
            *latest_source = result.text.clone();
            route_azookey_output(
                context,
                RoutedStageOutput {
                    turn_id: result.turn_id,
                    revision: result.revision,
                    display_text: result.text.clone(),
                    text: result.text,
                    is_final: result.is_final,
                },
            )?;
            Ok(true)
        }
        "translation.result" if context.route.translation == ExecutionDevice::Mobile => {
            let _ = context.event_tx.send(WorkerEvent::Translation {
                turn_id: result.turn_id,
                revision: result.revision,
                source: latest_source.clone(),
                translation: result.text,
            });
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn drain_mobile_final_results(
    context: &RoutingContext<'_>,
    companion: &CompanionHandle,
    caption_revision: &mut u64,
    latest_source: &mut String,
) -> Result<(), String> {
    drain_mobile_final_results_with_timeout(
        context,
        companion,
        caption_revision,
        latest_source,
        MOBILE_FINAL_DRAIN_TIMEOUT,
    )
}

fn drain_mobile_final_results_with_timeout(
    context: &RoutingContext<'_>,
    companion: &CompanionHandle,
    caption_revision: &mut u64,
    latest_source: &mut String,
    timeout: Duration,
) -> Result<(), String> {
    let terminal_stage =
        if context.translation_enabled && context.route.translation == ExecutionDevice::Mobile {
            "translation.result"
        } else if context.route.azookey == ExecutionDevice::Mobile {
            "azookey.result"
        } else {
            "asr.update"
        };
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match companion.try_recv() {
            Some(CompanionInbound::StageResult(result)) => {
                let is_terminal = result.message_type == terminal_stage && result.is_final;
                let accepted =
                    handle_mobile_result(result, context, caption_revision, latest_source)?;
                if accepted && is_terminal {
                    return Ok(());
                }
            }
            Some(CompanionInbound::Disconnected { session_id })
                if disconnected_current_session(&session_id, context.session_id) =>
            {
                return Err("mobile companion disconnected before final output".to_string());
            }
            Some(CompanionInbound::Disconnected { .. }) => {}
            None => thread::sleep(POLL_TIMEOUT),
        }
    }
    Err(format!(
        "mobile companion did not return {terminal_stage} within {} ms",
        timeout.as_millis()
    ))
}

fn disconnected_current_session(disconnected: &str, current: Option<&str>) -> bool {
    current == Some(disconnected)
}

fn desktop_pipeline_route() -> PipelineRoute {
    PipelineRoute {
        asr: ExecutionDevice::Desktop,
        azookey: ExecutionDevice::Desktop,
        translation: ExecutionDevice::Desktop,
    }
}

fn route_uses_mobile(route: PipelineRoute) -> bool {
    route.asr == ExecutionDevice::Mobile
        || route.azookey == ExecutionDevice::Mobile
        || route.translation == ExecutionDevice::Mobile
}

fn native_engine_config(models_root: std::path::PathBuf) -> EngineConfig {
    let mut config = EngineConfig::new(models_root);
    // ReazonSpeech otherwise emits nothing during an uninterrupted segment until
    // the eight-second segment boundary. Bounded, low-priority partial windows
    // provide the first visible caption while normal segment/final ASR retains
    // ownership of the canonical caption.
    config.partial_window_asr_enabled = true;
    config
}

fn native_audio_config() -> AudioCaptureConfig {
    AudioCaptureConfig {
        chunk_ms: PARAPPER_VAD_INTERVAL_MS,
        drop_silence_frames: false,
        ..AudioCaptureConfig::default()
    }
}

fn publish_engine_events(
    events: Vec<EngineEvent>,
    routing: &RoutingContext<'_>,
    state: &mut EnginePublishState<'_>,
) -> Result<(), String> {
    for event in events {
        match event {
            EngineEvent::Caption {
                turn_id,
                turn_session_id,
                logical_turn_id,
                text,
                azookey_input_text,
                is_final,
                update_mode,
                elapsed_millis,
                speech_to_first_partial_millis,
                speech_to_final_millis,
            } => {
                record_pipeline_event(
                    "asr_engine_caption",
                    &serde_json::json!({
                        "turn_id": &turn_id,
                        "turn_session_id": turn_session_id,
                        "logical_turn_id": logical_turn_id,
                        "surface": &text,
                        "canonical_reading": azookey_input_text.as_deref(),
                        "is_final": is_final,
                        "update_mode": format!("{update_mode:?}"),
                        "elapsed_millis": elapsed_millis,
                        "speech_to_first_partial_millis": speech_to_first_partial_millis,
                        "speech_to_final_millis": speech_to_final_millis,
                        "route": routing.route,
                    }),
                );
                if routing.route.asr != ExecutionDevice::Desktop {
                    continue;
                }
                let input_is_normalized_hiragana = azookey_input_text.is_some();
                let starts_new_input = state.recognition_turn_id.as_deref() != Some(&turn_id)
                    || update_mode == CaptionUpdateMode::Replace;
                if starts_new_input {
                    *state.recognition_input_is_hiragana = input_is_normalized_hiragana;
                } else {
                    *state.recognition_input_is_hiragana &= input_is_normalized_hiragana;
                }
                let normalizer_input = azookey_input_text.as_deref().unwrap_or(&text);
                apply_turn_caption_update(
                    state.recognition_text,
                    state.recognition_turn_id,
                    &turn_id,
                    normalizer_input,
                    update_mode,
                );
                if starts_new_input {
                    state.recognition_surface_text.clear();
                }
                apply_caption_update(state.recognition_surface_text, &text, update_mode);
                *state.canonical_seen_turn = Some((turn_session_id, logical_turn_id));
                *state.caption_revision = state.caption_revision.wrapping_add(1).max(1);
                let revision = *state.caption_revision;
                route_asr_output(
                    routing,
                    RoutedStageOutput {
                        turn_id: logical_turn_id,
                        revision,
                        text: state.recognition_text.clone(),
                        display_text: state.recognition_surface_text.clone(),
                        is_final,
                    },
                    *state.recognition_input_is_hiragana,
                )?;
            }
            EngineEvent::PartialWindow {
                turn_id,
                turn_session_id,
                logical_turn_id,
                text,
                starts_turn,
            } => {
                let preview_turn = (turn_session_id, logical_turn_id);
                let should_display = routing.route.asr == ExecutionDevice::Desktop
                    && starts_turn
                    && !text.trim().is_empty()
                    && state.canonical_seen_turn.is_none_or(|current| preview_turn > current);
                record_pipeline_event(
                    "asr_partial_window",
                    &serde_json::json!({
                        "turn_id": &turn_id,
                        "turn_session_id": turn_session_id,
                        "logical_turn_id": logical_turn_id,
                        "surface": &text,
                        "starts_turn": starts_turn,
                        "displayed": should_display,
                        "route": routing.route,
                    }),
                );
                if !should_display {
                    continue;
                }
                // PartialWindow text is a bounded raw-ASR preview. Do not put it
                // into canonical turn state or send it through AzooKey/translation:
                // the normal Caption event replaces it with the complete canonical
                // reading. Windows for later internal 8-second segments are ignored
                // so they cannot erase an already accumulated caption prefix.
                *state.caption_revision = state.caption_revision.wrapping_add(1).max(1);
                let revision = *state.caption_revision;
                let _ = routing.event_tx.send(WorkerEvent::Caption {
                    turn_id: logical_turn_id,
                    revision,
                    source: text,
                    update_mode: CaptionUpdateMode::Replace,
                    is_final: false,
                });
                record_pipeline_event(
                    "partial_window_routed",
                    &serde_json::json!({
                        "turn_id": &turn_id,
                        "turn_session_id": turn_session_id,
                        "logical_turn_id": logical_turn_id,
                        "revision": revision,
                    }),
                );
            }
        }
    }
    Ok(())
}

fn queue_translation(
    sender: &TranslationMailboxSender,
    request: TranslationRequest,
    event_tx: &SyncSender<WorkerEvent>,
) {
    let revision = request.revision;
    if !sender.replace_translation(request) {
        let _ = event_tx.try_send(WorkerEvent::TranslationError {
            revision: Some(revision),
            message: "Translation worker stopped; the current caption was kept".to_string(),
        });
    }
}

fn apply_turn_caption_update(
    target: &mut String,
    current_turn_id: &mut Option<String>,
    turn_id: &str,
    text: &str,
    update_mode: CaptionUpdateMode,
) {
    if current_turn_id.as_deref() != Some(turn_id) {
        target.clear();
        *current_turn_id = Some(turn_id.to_string());
    }
    apply_caption_update(target, text, update_mode);
}

fn apply_caption_update(target: &mut String, text: &str, update_mode: CaptionUpdateMode) {
    if update_mode == CaptionUpdateMode::Replace {
        target.clear();
    }
    target.push_str(text);
    let excess = target.chars().count().saturating_sub(MAX_CAPTION_CHARACTERS);
    if excess == 0 {
        return;
    }
    let keep_from = target.char_indices().nth(excess).map_or(target.len(), |(index, _)| index);
    target.drain(..keep_from);
}

fn format_audio_start_error(error: AudioError) -> String {
    if is_permission_denied_error(&error) {
        return MICROPHONE_PERMISSION_MESSAGE.to_string();
    }
    match error {
        AudioError::DeviceNotFound(id) => format!("{DEVICE_NOT_FOUND_MESSAGE}: {id}"),
        AudioError::NoInputDevice => "No microphone was detected".to_string(),
        other => format!("Could not start microphone: {other}"),
    }
}

fn format_audio_read_error(error: AudioError) -> String {
    if is_permission_denied_error(&error) {
        MICROPHONE_PERMISSION_MESSAGE.to_string()
    } else {
        format!("Could not read microphone: {error}")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::{Duration, Instant};

    use caption_bridge_audio::{should_emit_pcm_frame, AdaptiveNoiseFloor};
    use rust_lib_kotoba_beacon_companion::api::simple::{
        ExecutionDevice, MobileStageResult, PipelineRoute,
    };

    use crate::companion::{CompanionHandle, CompanionInbound, CompanionOutbound};

    use super::{
        apply_caption_update, apply_turn_caption_update, disconnected_current_session,
        drain_mobile_final_results_with_timeout, handle_mobile_result, native_audio_config,
        native_engine_config, publish_engine_events, queue_translation, route_asr_output,
        route_azookey_output, translation_mailbox, CaptionUpdateMode, CaptureController,
        CaptureSnapshot, CaptureStatus, EngineEvent, RoutedStageOutput, RoutingContext,
        TranslationCommand, TranslationRequest, WorkerCommand, WorkerEvent, MAX_CAPTION_CHARACTERS,
    };

    #[test]
    fn expired_caption_clears_recognition_and_translation() {
        let mut controller = CaptureController::new();
        controller.snapshot.source_text = "こんにちは。".to_string();
        controller.snapshot.translation_text = "Hello.".to_string();
        let now = Instant::now();
        controller.caption_expires_at = Some(now - Duration::from_millis(1));
        assert!(controller.expire_caption_at(now));
        assert!(controller.snapshot.source_text.is_empty());
        assert!(controller.snapshot.translation_text.is_empty());
    }

    #[test]
    fn native_capture_preserves_silence_before_speech_for_vad_pre_roll() {
        let config = native_audio_config();

        assert_eq!(config.chunk_ms, 32);
        assert!(!config.drop_silence_frames);
        assert!(should_emit_pcm_frame(
            config,
            f32::NEG_INFINITY,
            &mut AdaptiveNoiseFloor::default()
        ));
    }

    #[test]
    fn native_engine_enables_bounded_partial_windows_for_uninterrupted_speech() {
        let config = native_engine_config(std::path::PathBuf::from("models"));

        assert!(config.partial_window_asr_enabled);
    }

    #[test]
    fn quickmt_warmup_is_queued_immediately_when_translation_starts() {
        let (sender, receiver) = translation_mailbox();

        assert!(sender.request_warmup());
        assert!(matches!(
            receiver.recv_timeout(Duration::from_millis(10)),
            Ok(TranslationCommand::Warm)
        ));
    }

    #[test]
    fn translation_mailbox_replaces_obsolete_partial_requests_with_the_latest_caption() {
        let (sender, receiver) = translation_mailbox();

        assert!(sender.replace_translation(TranslationRequest {
            turn_id: 1,
            revision: 1,
            source: "古い途中結果".to_string(),
        }));
        assert!(sender.replace_translation(TranslationRequest {
            turn_id: 1,
            revision: 2,
            source: "最新の確定結果".to_string(),
        }));

        assert!(matches!(
            receiver.recv_timeout(Duration::from_millis(10)),
            Ok(TranslationCommand::Translate(TranslationRequest {
                turn_id: 1,
                revision: 2,
                source,
            })) if source == "最新の確定結果"
        ));
        assert!(matches!(
            receiver.recv_timeout(Duration::from_millis(1)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
    }

    #[test]
    fn desktop_azookey_uses_the_full_portable_dictionary() {
        super::initialize_desktop_azookey().expect("initialize desktop AzooKey");
        assert_eq!(
            super::convert_azookey("きょう".to_string())
                .expect("convert with desktop AzooKey")
                .text,
            "今日"
        );
        assert_eq!(
            super::convert_azookey_hiragana("ろくじゅうど".to_string())
                .expect("convert numeric temperature with desktop AzooKey")
                .text,
            "60度"
        );
    }

    #[test]
    fn root_partial_window_is_visible_then_canonical_caption_replaces_it() {
        let (event_tx, event_rx) = mpsc::sync_channel(8);
        let mut recognition_text = String::new();
        let mut recognition_surface_text = String::new();
        let mut recognition_turn_id = None;
        let mut recognition_input_is_hiragana = false;
        let mut caption_revision = 0;
        let mut canonical_seen_turn = None;
        let routing = super::RoutingContext {
            route: super::PipelineRoute {
                asr: super::ExecutionDevice::Desktop,
                azookey: super::ExecutionDevice::Desktop,
                translation: super::ExecutionDevice::Desktop,
            },
            companion: None,
            session_id: None,
            event_tx: &event_tx,
            translation_tx: None,
            translation_enabled: false,
        };
        let mut state = super::EnginePublishState {
            recognition_text: &mut recognition_text,
            recognition_surface_text: &mut recognition_surface_text,
            recognition_turn_id: &mut recognition_turn_id,
            recognition_input_is_hiragana: &mut recognition_input_is_hiragana,
            caption_revision: &mut caption_revision,
            canonical_seen_turn: &mut canonical_seen_turn,
        };

        publish_engine_events(
            vec![
                EngineEvent::PartialWindow {
                    turn_id: "partial-window-1-1-1".to_string(),
                    turn_session_id: 1,
                    logical_turn_id: 1,
                    text: "きょ".to_string(),
                    starts_turn: true,
                },
                EngineEvent::Caption {
                    turn_id: "turn-1-1-0".to_string(),
                    turn_session_id: 1,
                    logical_turn_id: 1,
                    text: "今日".to_string(),
                    azookey_input_text: Some("きょう".to_string()),
                    is_final: false,
                    update_mode: CaptionUpdateMode::Replace,
                    elapsed_millis: 10,
                    speech_to_first_partial_millis: Some(450),
                    speech_to_final_millis: None,
                },
            ],
            &routing,
            &mut state,
        )
        .expect("route root partial and canonical caption");

        publish_engine_events(
            vec![
                EngineEvent::PartialWindow {
                    turn_id: "partial-window-1-1-2".to_string(),
                    turn_session_id: 1,
                    logical_turn_id: 1,
                    text: "後続だけ".to_string(),
                    starts_turn: false,
                },
                EngineEvent::PartialWindow {
                    turn_id: "partial-window-1-1-delayed".to_string(),
                    turn_session_id: 1,
                    logical_turn_id: 1,
                    text: "遅延した古い認識".to_string(),
                    starts_turn: true,
                },
            ],
            &routing,
            &mut state,
        )
        .expect("ignore later internal segment preview");

        assert!(matches!(
            event_rx.try_recv(),
            Ok(WorkerEvent::Caption { revision: 1, source, is_final: false, .. })
                if source == "きょ"
        ));
        assert!(matches!(
            event_rx.try_recv(),
            Ok(WorkerEvent::Caption { revision: 2, source, is_final: false, .. })
                if source == "今日"
        ));
        assert!(matches!(
            event_rx.try_recv(),
            Ok(WorkerEvent::Caption { revision: 2, source, is_final: false, .. })
                if source == "今日"
        ));
        assert!(event_rx.try_recv().is_err());
        assert_eq!(*state.caption_revision, 2);
        assert_eq!(state.recognition_text.as_str(), "きょう");
        assert_eq!(state.recognition_turn_id.as_deref(), Some("turn-1-1-0"));
    }

    #[test]
    fn canonical_append_keeps_surface_and_reading_accumulation_in_sync() {
        let (event_tx, _event_rx) = mpsc::sync_channel(8);
        let mut recognition_text = String::new();
        let mut recognition_surface_text = String::new();
        let mut recognition_turn_id = None;
        let mut recognition_input_is_hiragana = false;
        let mut caption_revision = 0;
        let mut canonical_seen_turn = None;
        let routing = RoutingContext {
            route: PipelineRoute {
                asr: ExecutionDevice::Desktop,
                azookey: ExecutionDevice::Desktop,
                translation: ExecutionDevice::Desktop,
            },
            companion: None,
            session_id: None,
            event_tx: &event_tx,
            translation_tx: None,
            translation_enabled: false,
        };
        let mut state = super::EnginePublishState {
            recognition_text: &mut recognition_text,
            recognition_surface_text: &mut recognition_surface_text,
            recognition_turn_id: &mut recognition_turn_id,
            recognition_input_is_hiragana: &mut recognition_input_is_hiragana,
            caption_revision: &mut caption_revision,
            canonical_seen_turn: &mut canonical_seen_turn,
        };

        publish_engine_events(
            vec![
                EngineEvent::Caption {
                    turn_id: "turn-1-1-0".to_string(),
                    turn_session_id: 1,
                    logical_turn_id: 1,
                    text: "今日".to_string(),
                    azookey_input_text: Some("きょう".to_string()),
                    is_final: false,
                    update_mode: CaptionUpdateMode::Replace,
                    elapsed_millis: 10,
                    speech_to_first_partial_millis: Some(100),
                    speech_to_final_millis: None,
                },
                EngineEvent::Caption {
                    turn_id: "turn-1-1-0".to_string(),
                    turn_session_id: 1,
                    logical_turn_id: 1,
                    text: "です".to_string(),
                    azookey_input_text: Some("です".to_string()),
                    is_final: true,
                    update_mode: CaptionUpdateMode::Append,
                    elapsed_millis: 20,
                    speech_to_first_partial_millis: Some(100),
                    speech_to_final_millis: Some(200),
                },
            ],
            &routing,
            &mut state,
        )
        .expect("route replacement and append");

        assert_eq!(state.recognition_text, "きょうです");
        assert_eq!(state.recognition_surface_text, "今日です");
        assert!(*state.recognition_input_is_hiragana);
        assert_eq!(*state.caption_revision, 2);
    }

    #[test]
    fn desktop_engine_caption_is_ignored_when_mobile_owns_asr() {
        let (event_tx, event_rx) = mpsc::sync_channel(2);
        let mut recognition_text = String::new();
        let mut recognition_surface_text = String::new();
        let mut recognition_turn_id = None;
        let mut recognition_input_is_hiragana = false;
        let mut caption_revision = 0;
        let mut canonical_seen_turn = None;
        let routing = RoutingContext {
            route: PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Desktop,
                translation: ExecutionDevice::Desktop,
            },
            companion: None,
            session_id: None,
            event_tx: &event_tx,
            translation_tx: None,
            translation_enabled: false,
        };
        let mut state = super::EnginePublishState {
            recognition_text: &mut recognition_text,
            recognition_surface_text: &mut recognition_surface_text,
            recognition_turn_id: &mut recognition_turn_id,
            recognition_input_is_hiragana: &mut recognition_input_is_hiragana,
            caption_revision: &mut caption_revision,
            canonical_seen_turn: &mut canonical_seen_turn,
        };

        publish_engine_events(
            vec![EngineEvent::Caption {
                turn_id: "stale-desktop-caption".to_string(),
                turn_session_id: 1,
                logical_turn_id: 1,
                text: "無視".to_string(),
                azookey_input_text: Some("むし".to_string()),
                is_final: false,
                update_mode: CaptionUpdateMode::Replace,
                elapsed_millis: 10,
                speech_to_first_partial_millis: None,
                speech_to_final_millis: None,
            }],
            &routing,
            &mut state,
        )
        .expect("ignore desktop event");

        assert_eq!(*state.caption_revision, 0);
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn mobile_asr_result_reaches_desktop_azookey_with_surface_preserved() {
        let (event_tx, event_rx) = mpsc::sync_channel(4);
        let routing = RoutingContext {
            route: PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Desktop,
                translation: ExecutionDevice::Desktop,
            },
            companion: None,
            session_id: Some("session-1"),
            event_tx: &event_tx,
            translation_tx: None,
            translation_enabled: false,
        };
        let mut caption_revision = 0;
        let mut source = String::new();

        assert!(handle_mobile_result(
            MobileStageResult {
                message_type: "asr.update".to_string(),
                session_id: "session-1".to_string(),
                turn_id: 3,
                revision: 7,
                text: "きょう".to_string(),
                is_final: true,
            },
            &routing,
            &mut caption_revision,
            &mut source,
        )
        .expect("route mobile ASR"));

        assert_eq!(caption_revision, 7);
        assert_eq!(source, "きょう");
        assert!(matches!(
            event_rx.try_recv(),
            Ok(WorkerEvent::Caption { turn_id: 3, source, .. }) if source == "きょう"
        ));
        assert!(matches!(
            event_rx.try_recv(),
            Ok(WorkerEvent::Caption { turn_id: 3, source, .. }) if source == "今日"
        ));
    }

    #[test]
    fn partial_recognition_uses_canonical_reading_before_azookey_and_translation() {
        let (translation_tx, translation_rx) = translation_mailbox();
        let (event_tx, event_rx) = mpsc::sync_channel(4);
        let mut recognition_text = String::new();
        let mut recognition_surface_text = String::new();
        let mut recognition_turn_id = None;
        let mut recognition_input_is_hiragana = false;
        let mut caption_revision = 0;
        let mut canonical_seen_turn = None;

        let routing = super::RoutingContext {
            route: super::PipelineRoute {
                asr: super::ExecutionDevice::Desktop,
                azookey: super::ExecutionDevice::Desktop,
                translation: super::ExecutionDevice::Desktop,
            },
            companion: None,
            session_id: None,
            event_tx: &event_tx,
            translation_tx: Some(&translation_tx),
            translation_enabled: true,
        };
        let mut state = super::EnginePublishState {
            recognition_text: &mut recognition_text,
            recognition_surface_text: &mut recognition_surface_text,
            recognition_turn_id: &mut recognition_turn_id,
            recognition_input_is_hiragana: &mut recognition_input_is_hiragana,
            caption_revision: &mut caption_revision,
            canonical_seen_turn: &mut canonical_seen_turn,
        };
        publish_engine_events(
            vec![EngineEvent::Caption {
                turn_id: "turn-1".to_string(),
                turn_session_id: 1,
                logical_turn_id: 1,
                text: "こんにちは聞超えますか".to_string(),
                azookey_input_text: Some("こんにちはきこえますか".to_string()),
                is_final: false,
                update_mode: CaptionUpdateMode::Replace,
                elapsed_millis: 10,
                speech_to_first_partial_millis: Some(120),
                speech_to_final_millis: None,
            }],
            &routing,
            &mut state,
        )
        .expect("desktop routing");

        assert!(matches!(
            translation_rx.recv_timeout(Duration::from_millis(10)),
            Ok(TranslationCommand::Translate(TranslationRequest {
                turn_id: 1,
                revision: 1,
                source,
            })) if source == "こんにちは聞こえますか"
        ));
        assert!(matches!(
            event_rx.try_recv(),
            Ok(WorkerEvent::Caption { revision: 1, source, is_final: false, .. })
                if source == "こんにちは聞超えますか"
        ));
        assert!(matches!(
            event_rx.try_recv(),
            Ok(WorkerEvent::Caption { revision: 1, source, is_final: false, .. })
                if source == "こんにちは聞こえますか"
        ));
    }

    #[test]
    fn runtime_translation_toggle_clears_output_and_notifies_capture_worker() {
        let mut controller = CaptureController::new();
        let (command_tx, command_rx) = mpsc::sync_channel(4);
        controller.command_tx = Some(command_tx);
        controller.translation_enabled = true;
        controller.snapshot.source_text = "こんにちは".to_string();
        controller.snapshot.translation_text = "Hello".to_string();

        controller
            .set_translation_enabled(false)
            .expect("runtime translation toggle must fit the bounded command queue");

        assert!(!controller.translation_enabled());
        assert!(controller.snapshot.translation_text.is_empty());
        assert!(matches!(command_rx.try_recv(), Ok(WorkerCommand::SetTranslationEnabled(false))));
    }

    #[test]
    fn disabled_translation_ignores_a_late_worker_result() {
        let mut controller = CaptureController::new();
        controller.snapshot.source_text = "こんにちは".to_string();

        controller.apply_worker_event_at(
            WorkerEvent::Translation {
                turn_id: 1,
                revision: 1,
                source: "こんにちは".to_string(),
                translation: "Hello".to_string(),
            },
            Instant::now(),
            1_000,
        );

        assert!(controller.snapshot.translation_text.is_empty());
    }

    #[test]
    fn disconnected_translation_worker_reports_the_current_revision() {
        let (translation_tx, translation_rx) = translation_mailbox();
        let (event_tx, event_rx) = mpsc::sync_channel(1);
        drop(translation_rx);

        queue_translation(
            &translation_tx,
            TranslationRequest { turn_id: 1, revision: 7, source: "字幕".to_string() },
            &event_tx,
        );

        assert!(matches!(
            event_rx.try_recv(),
            Ok(WorkerEvent::TranslationError { revision: Some(7), message })
                if message == "Translation worker stopped; the current caption was kept"
        ));
    }

    #[test]
    fn stop_does_not_join_a_recognition_worker_still_initializing() {
        let (command_tx, _command_rx) = mpsc::sync_channel(1);
        let (_event_tx, event_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(0);
        let stop_requested = Arc::new(AtomicBool::new(false));
        let worker = thread::spawn(move || {
            let _ = release_rx.recv();
        });
        let controller = CaptureController {
            snapshot: CaptureSnapshot { status: CaptureStatus::Capturing, ..Default::default() },
            caption_expires_at: None,
            command_tx: Some(command_tx),
            event_rx: Some(event_rx),
            worker: Some(worker),
            worker_stop_requested: Some(stop_requested.clone()),
            translation_enabled: false,
            current_caption_turn_id: None,
            current_caption_revision: 0,
            awaiting_translation_revision: None,
            recognition_in_progress: false,
            companion_route: super::desktop_pipeline_route(),
            companion_server: None,
        };
        let (stopped_tx, stopped_rx) = mpsc::sync_channel(1);
        let stopper = thread::spawn(move || {
            let mut controller = controller;
            controller.stop();
            let _ = stopped_tx.send(controller);
        });

        let immediate = stopped_rx.recv_timeout(Duration::from_millis(250));
        let returned_without_joining = immediate.is_ok();
        let _ = release_tx.send(());
        let mut controller = immediate.unwrap_or_else(|_| {
            stopped_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("stop must return after the simulated initialization finishes")
        });
        stopper.join().expect("stopper thread must not panic");

        assert!(
            returned_without_joining,
            "stop blocked while the recognition worker was initializing"
        );
        assert!(stop_requested.load(Ordering::Acquire));
        assert_eq!(controller.snapshot.status, CaptureStatus::Stopping);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !controller.reap_finished_worker() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(controller.worker.is_none());
        assert_eq!(controller.snapshot.status, CaptureStatus::Idle);
    }

    #[test]
    fn caption_updates_keep_only_the_most_recent_bounded_utf8_text() {
        let mut caption = "前".repeat(MAX_CAPTION_CHARACTERS);
        apply_caption_update(&mut caption, "新しい字幕", CaptionUpdateMode::Append);

        assert_eq!(caption.chars().count(), 2_048);
        assert!(caption.ends_with("新しい字幕"));
        assert_eq!(caption.chars().next(), Some('前'));
    }

    #[test]
    fn repeated_greeting_stays_in_the_new_turn_instead_of_collapsing_to_its_tail() {
        let mut caption = String::new();
        let mut turn_id = None;
        apply_turn_caption_update(
            &mut caption,
            &mut turn_id,
            "turn-1",
            "こんにちは。",
            CaptionUpdateMode::Replace,
        );
        apply_turn_caption_update(
            &mut caption,
            &mut turn_id,
            "turn-2",
            "こんにちは",
            CaptionUpdateMode::Replace,
        );
        apply_turn_caption_update(
            &mut caption,
            &mut turn_id,
            "turn-2",
            "聞こえますか？",
            CaptionUpdateMode::Append,
        );

        assert_eq!(caption, "こんにちは聞こえますか？");
        assert_eq!(turn_id.as_deref(), Some("turn-2"));
    }

    #[test]
    fn replace_caption_discards_previous_text_before_applying_limit() {
        let mut caption = "古い字幕".to_string();
        apply_caption_update(&mut caption, "新しい字幕", CaptionUpdateMode::Replace);

        assert_eq!(caption, "新しい字幕");
    }

    #[test]
    fn microphone_level_event_updates_the_live_snapshot() {
        let mut snapshot = CaptureSnapshot::default();
        snapshot.apply_worker_event(WorkerEvent::Rms(Some(-18.5)));

        assert_eq!(snapshot.last_rms_dbfs, Some(-18.5));
    }

    #[test]
    fn translation_updates_only_the_matching_recognition() {
        let mut snapshot = CaptureSnapshot::default();
        snapshot.apply_worker_event(WorkerEvent::Caption {
            turn_id: 1,
            revision: 1,
            source: "こんにちは。".to_string(),
            update_mode: CaptionUpdateMode::Replace,
            is_final: true,
        });
        snapshot.apply_worker_event(WorkerEvent::Translation {
            turn_id: 1,
            revision: 1,
            source: "古い字幕".to_string(),
            translation: "Old".to_string(),
        });
        assert!(snapshot.translation_text.is_empty());
        snapshot.apply_worker_event(WorkerEvent::Translation {
            turn_id: 1,
            revision: 1,
            source: "こんにちは。".to_string(),
            translation: "Hello.".to_string(),
        });
        assert_eq!(snapshot.translation_text, "Hello.");
    }

    #[test]
    fn recognition_events_continue_to_publish_after_more_than_one_minute() {
        let mut controller = CaptureController::new();
        let started_at = Instant::now();
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 1,
                source: "最初の字幕".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: false,
            },
            started_at,
            5_000,
        );
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 2,
                source: "一分後の字幕".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: false,
            },
            started_at + Duration::from_secs(61),
            5_000,
        );

        assert_eq!(controller.snapshot.source_text, "一分後の字幕");
        assert_eq!(controller.caption_expires_at, Some(started_at + Duration::from_secs(66)));
    }

    #[test]
    fn recognition_error_releases_an_unfinished_caption_for_normal_expiry() {
        let mut controller = CaptureController::new();
        let partial_at = Instant::now();
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 1,
                source: "認識中".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: false,
            },
            partial_at,
            100,
        );
        controller.apply_worker_event_at(
            WorkerEvent::Error("fixture failure".to_string()),
            partial_at + Duration::from_millis(50),
            100,
        );

        assert!(!controller.recognition_in_progress);
        assert!(controller.expire_caption_at(partial_at + Duration::from_millis(100)));
        assert!(controller.snapshot.source_text.is_empty());
    }

    #[test]
    fn recognition_never_disappears_between_partial_final_and_translation() {
        let mut controller = CaptureController::new();
        controller.translation_enabled = true;
        let partial_at = Instant::now();
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 1,
                source: "こんにちは".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: false,
            },
            partial_at,
            100,
        );
        assert_eq!(controller.snapshot.source_text, "こんにちは");
        assert!(controller.recognition_in_progress);

        let after_partial_timeout = partial_at + Duration::from_millis(200);
        assert!(!controller.expire_caption_at(after_partial_timeout));
        assert_eq!(controller.snapshot.source_text, "こんにちは");

        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 2,
                source: "こんにちは。".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: true,
            },
            after_partial_timeout,
            100,
        );
        assert_eq!(controller.snapshot.source_text, "こんにちは。");
        assert!(controller.snapshot.translation_text.is_empty());
        assert!(!controller.recognition_in_progress);
        assert!(!controller.expire_caption_at(after_partial_timeout + Duration::from_secs(1)));
        assert_eq!(controller.snapshot.source_text, "こんにちは。");

        controller.apply_worker_event_at(
            WorkerEvent::Translation {
                turn_id: 1,
                revision: 2,
                source: "こんにちは。".to_string(),
                translation: "Hello.".to_string(),
            },
            after_partial_timeout + Duration::from_millis(1_080),
            100,
        );
        assert_eq!(controller.snapshot.source_text, "こんにちは。");
        assert_eq!(controller.snapshot.translation_text, "Hello.");
    }

    #[test]
    fn new_recognition_preempts_a_held_translation_pair_immediately() {
        let mut controller = CaptureController::new();
        controller.translation_enabled = true;
        let finalized_at = Instant::now();
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 1,
                source: "こんにちは。".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: true,
            },
            finalized_at,
            1_000,
        );
        controller.apply_worker_event_at(
            WorkerEvent::Translation {
                turn_id: 1,
                revision: 1,
                source: "こんにちは。".to_string(),
                translation: "Hello.".to_string(),
            },
            finalized_at + Duration::from_secs(2),
            1_000,
        );
        assert_eq!(controller.snapshot.translation_text, "Hello.");

        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 2,
                revision: 2,
                source: "次の字幕".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: false,
            },
            finalized_at + Duration::from_secs(3),
            1_000,
        );

        assert_eq!(controller.snapshot.source_text, "次の字幕");
        assert!(controller.snapshot.translation_text.is_empty());
        assert!(controller.recognition_in_progress);
    }

    #[test]
    fn same_turn_partial_keeps_the_latest_live_translation_visible() {
        let mut controller = CaptureController::new();
        controller.translation_enabled = true;
        let now = Instant::now();
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 1,
                source: "今日は".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: false,
            },
            now,
            1_000,
        );
        controller.apply_worker_event_at(
            WorkerEvent::Translation {
                turn_id: 1,
                revision: 1,
                source: "今日は".to_string(),
                translation: "Today".to_string(),
            },
            now + Duration::from_millis(1),
            1_000,
        );
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 2,
                source: "今日は晴れです".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: false,
            },
            now + Duration::from_millis(2),
            1_000,
        );

        assert_eq!(controller.snapshot.source_text, "今日は晴れです");
        assert_eq!(controller.snapshot.translation_text, "Today");
    }

    #[test]
    fn translated_pair_expires_after_the_configured_hold() {
        let mut controller = CaptureController::new();
        controller.translation_enabled = true;
        let now = Instant::now();
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 1,
                source: "こんにちは。".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: true,
            },
            now,
            1_000,
        );
        controller.apply_worker_event_at(
            WorkerEvent::Translation {
                turn_id: 1,
                revision: 1,
                source: "こんにちは。".to_string(),
                translation: "Hello.".to_string(),
            },
            now + Duration::from_millis(10),
            1_000,
        );

        assert!(!controller.expire_caption_at(now + Duration::from_secs(3)));
        assert!(controller.expire_caption_at(now + Duration::from_millis(3_011)));
        assert!(controller.snapshot.source_text.is_empty());
        assert!(controller.snapshot.translation_text.is_empty());
    }

    #[test]
    fn stale_mobile_stage_caption_never_regresses_a_newer_revision() {
        let mut controller = CaptureController::new();
        let now = Instant::now();
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 12,
                source: "新しいASR".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: false,
            },
            now,
            1_000,
        );
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 11,
                source: "古いAzooKey".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: true,
            },
            now + Duration::from_millis(1),
            1_000,
        );

        assert_eq!(controller.current_caption_revision, 12);
        assert_eq!(controller.snapshot.source_text, "新しいASR");
    }

    #[test]
    fn stale_translation_for_identical_text_from_an_older_turn_is_ignored() {
        let mut controller = CaptureController::new();
        controller.translation_enabled = true;
        let now = Instant::now();
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 11,
                source: "はい。".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: true,
            },
            now,
            1_000,
        );
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 2,
                revision: 12,
                source: "はい。".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: true,
            },
            now + Duration::from_millis(1),
            1_000,
        );
        controller.apply_worker_event_at(
            WorkerEvent::Translation {
                turn_id: 1,
                revision: 11,
                source: "はい。".to_string(),
                translation: "Stale yes.".to_string(),
            },
            now + Duration::from_millis(2),
            1_000,
        );

        assert!(controller.snapshot.translation_text.is_empty());
        assert_eq!(controller.awaiting_translation_revision, Some(12));
    }

    #[test]
    fn mobile_azookey_uses_asr_surface_for_incremental_translation() {
        let (companion, _inbound_tx, outbound_rx) = CompanionHandle::test_channel();
        let (event_tx, event_rx) = mpsc::sync_channel(8);
        let routing = RoutingContext {
            route: PipelineRoute {
                asr: ExecutionDevice::Desktop,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Mobile,
            },
            companion: Some(&companion),
            session_id: Some("session-1"),
            event_tx: &event_tx,
            translation_tx: None,
            translation_enabled: true,
        };

        route_asr_output(
            &routing,
            RoutedStageOutput {
                turn_id: 4,
                revision: 9,
                text: "きょう".to_string(),
                display_text: "今日".to_string(),
                is_final: false,
            },
            true,
        )
        .expect("publish immediate ASR partial");

        assert!(matches!(
            event_rx.recv_timeout(Duration::from_millis(20)),
            Ok(WorkerEvent::Caption { source, is_final: false, .. }) if source == "今日"
        ));
        assert!(
            matches!(outbound_rx.recv_timeout(Duration::from_millis(20)), Ok(CompanionOutbound::Text(message))
                if message.contains("translation.request")
                    && message.contains("\"source_text\":\"今日\"")
                    && message.contains("\"is_final\":false"))
        );

        route_asr_output(
            &routing,
            RoutedStageOutput {
                turn_id: 4,
                revision: 10,
                text: "こんにちはきこえますか".to_string(),
                display_text: "こんにちは聞こえますか".to_string(),
                is_final: true,
            },
            true,
        )
        .expect("route finalized ASR");
        assert!(
            matches!(outbound_rx.recv_timeout(Duration::from_millis(20)), Ok(CompanionOutbound::Text(message)) if message.contains("こんにちはきこえますか"))
        );
    }

    #[test]
    fn mobile_translation_receives_partial_and_final_azookey_results() {
        let (companion, _inbound_tx, outbound_rx) = CompanionHandle::test_channel();
        let (event_tx, _event_rx) = mpsc::sync_channel(8);
        let routing = RoutingContext {
            route: PipelineRoute {
                asr: ExecutionDevice::Desktop,
                azookey: ExecutionDevice::Desktop,
                translation: ExecutionDevice::Mobile,
            },
            companion: Some(&companion),
            session_id: Some("session-1"),
            event_tx: &event_tx,
            translation_tx: None,
            translation_enabled: true,
        };

        route_azookey_output(
            &routing,
            RoutedStageOutput {
                turn_id: 4,
                revision: 9,
                text: "今日".to_string(),
                display_text: "今日".to_string(),
                is_final: false,
            },
        )
        .expect("publish AzooKey partial with translation");
        assert!(
            matches!(outbound_rx.recv_timeout(Duration::from_millis(20)), Ok(CompanionOutbound::Text(message))
                if message.contains("translation.request")
                    && message.contains("\"source_text\":\"今日\"")
                    && message.contains("\"is_final\":false"))
        );

        route_azookey_output(
            &routing,
            RoutedStageOutput {
                turn_id: 4,
                revision: 10,
                text: "今日。".to_string(),
                display_text: "今日。".to_string(),
                is_final: true,
            },
        )
        .expect("route finalized AzooKey");
        assert!(
            matches!(outbound_rx.recv_timeout(Duration::from_millis(20)), Ok(CompanionOutbound::Text(message))
                if message.contains("translation.request")
                    && message.contains("\"is_final\":true"))
        );
    }

    #[test]
    fn final_mobile_translation_is_drained_before_capture_stops() {
        let (companion, inbound_tx, outbound_rx) = CompanionHandle::test_channel();
        let (event_tx, event_rx) = mpsc::sync_channel(8);
        let routing = RoutingContext {
            route: PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Mobile,
            },
            companion: Some(&companion),
            session_id: Some("session-1"),
            event_tx: &event_tx,
            translation_tx: None,
            translation_enabled: true,
        };
        inbound_tx
            .send(CompanionInbound::StageResult(MobileStageResult {
                message_type: "translation.result".to_string(),
                session_id: "session-1".to_string(),
                turn_id: 4,
                revision: 9,
                text: "Hello.".to_string(),
                is_final: true,
            }))
            .expect("queue final translation");
        let mut caption_revision = 9;
        let mut source = "こんにちは。".to_string();

        drain_mobile_final_results_with_timeout(
            &routing,
            &companion,
            &mut caption_revision,
            &mut source,
            Duration::from_millis(20),
        )
        .expect("drain final translation");

        assert!(matches!(
            event_rx.recv_timeout(Duration::from_millis(20)),
            Ok(WorkerEvent::Translation {
                turn_id: 4,
                revision: 9,
                source,
                translation,
            }) if source == "こんにちは。" && translation == "Hello."
        ));
        drop(outbound_rx);
    }

    #[test]
    fn stale_or_wrong_session_final_result_does_not_end_mobile_drain() {
        let (companion, inbound_tx, outbound_rx) = CompanionHandle::test_channel();
        let (event_tx, event_rx) = mpsc::sync_channel(8);
        let routing = RoutingContext {
            route: PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Mobile,
            },
            companion: Some(&companion),
            session_id: Some("current-session"),
            event_tx: &event_tx,
            translation_tx: None,
            translation_enabled: true,
        };
        inbound_tx
            .send(CompanionInbound::StageResult(MobileStageResult {
                message_type: "translation.result".to_string(),
                session_id: "old-session".to_string(),
                turn_id: 3,
                revision: 12,
                text: "Wrong session".to_string(),
                is_final: true,
            }))
            .expect("queue wrong session result");
        inbound_tx
            .send(CompanionInbound::StageResult(MobileStageResult {
                message_type: "translation.result".to_string(),
                session_id: "current-session".to_string(),
                turn_id: 3,
                revision: 10,
                text: "Stale".to_string(),
                is_final: true,
            }))
            .expect("queue stale result");
        inbound_tx
            .send(CompanionInbound::StageResult(MobileStageResult {
                message_type: "translation.result".to_string(),
                session_id: "current-session".to_string(),
                turn_id: 3,
                revision: 11,
                text: "Current".to_string(),
                is_final: true,
            }))
            .expect("queue current result");
        let mut caption_revision = 11;
        let mut source = "最新".to_string();

        drain_mobile_final_results_with_timeout(
            &routing,
            &companion,
            &mut caption_revision,
            &mut source,
            Duration::from_millis(20),
        )
        .expect("ignore stale final results");

        assert!(matches!(
            event_rx.recv_timeout(Duration::from_millis(20)),
            Ok(WorkerEvent::Translation { revision: 11, translation, .. })
                if translation == "Current"
        ));
        assert!(event_rx.try_recv().is_err());
        drop(outbound_rx);
    }

    #[test]
    fn disabled_translation_drains_final_mobile_azookey_result() {
        let (companion, inbound_tx, outbound_rx) = CompanionHandle::test_channel();
        let (event_tx, event_rx) = mpsc::sync_channel(8);
        let routing = RoutingContext {
            route: PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Mobile,
            },
            companion: Some(&companion),
            session_id: Some("session-1"),
            event_tx: &event_tx,
            translation_tx: None,
            translation_enabled: false,
        };
        inbound_tx
            .send(CompanionInbound::StageResult(MobileStageResult {
                message_type: "azookey.result".to_string(),
                session_id: "session-1".to_string(),
                turn_id: 5,
                revision: 13,
                text: "今日は晴れ".to_string(),
                is_final: true,
            }))
            .expect("queue final AzooKey result");
        let mut caption_revision = 13;
        let mut source = "きょうははれ".to_string();

        drain_mobile_final_results_with_timeout(
            &routing,
            &companion,
            &mut caption_revision,
            &mut source,
            Duration::from_millis(20),
        )
        .expect("drain final AzooKey result");

        assert_eq!(source, "今日は晴れ");
        assert!(matches!(
            event_rx.recv_timeout(Duration::from_millis(20)),
            Ok(WorkerEvent::Caption {
                turn_id: 5,
                revision: 13,
                source,
                is_final: true,
                ..
            }) if source == "今日は晴れ"
        ));
        assert!(event_rx.try_recv().is_err());
        drop(outbound_rx);
    }

    #[test]
    fn mobile_final_drain_reports_disconnect() {
        let (companion, inbound_tx, outbound_rx) = CompanionHandle::test_channel();
        let (event_tx, event_rx) = mpsc::sync_channel(8);
        let routing = RoutingContext {
            route: PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Mobile,
            },
            companion: Some(&companion),
            session_id: Some("session-1"),
            event_tx: &event_tx,
            translation_tx: None,
            translation_enabled: true,
        };
        inbound_tx
            .send(CompanionInbound::Disconnected { session_id: "session-1".to_string() })
            .expect("queue disconnect");
        let mut caption_revision = 1;
        let mut source = "途中".to_string();

        assert_eq!(
            drain_mobile_final_results_with_timeout(
                &routing,
                &companion,
                &mut caption_revision,
                &mut source,
                Duration::from_millis(20),
            )
            .expect_err("disconnect must fail final drain"),
            "mobile companion disconnected before final output"
        );
        drop(event_rx);
        drop(outbound_rx);
    }

    #[test]
    fn mobile_disconnect_is_scoped_to_authenticated_session() {
        assert!(disconnected_current_session("session-1", Some("session-1")));
        assert!(!disconnected_current_session("stale-session", Some("session-1")));
        assert!(!disconnected_current_session("session-1", None));
    }

    #[test]
    fn mobile_final_drain_has_a_bounded_timeout() {
        let (companion, inbound_tx, outbound_rx) = CompanionHandle::test_channel();
        let (event_tx, event_rx) = mpsc::sync_channel(8);
        let routing = RoutingContext {
            route: PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Mobile,
            },
            companion: Some(&companion),
            session_id: Some("session-1"),
            event_tx: &event_tx,
            translation_tx: None,
            translation_enabled: true,
        };
        let mut caption_revision = 1;
        let mut source = "途中".to_string();

        assert_eq!(
            drain_mobile_final_results_with_timeout(
                &routing,
                &companion,
                &mut caption_revision,
                &mut source,
                Duration::from_millis(1),
            )
            .expect_err("missing final result must time out"),
            "mobile companion did not return translation.result within 1 ms"
        );
        drop(inbound_tx);
        drop(event_rx);
        drop(outbound_rx);
    }

    #[test]
    fn stale_translation_never_replaces_newer_recognition() {
        let mut controller = CaptureController::new();
        controller.translation_enabled = true;
        let now = Instant::now();
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 1,
                revision: 1,
                source: "古い字幕".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: true,
            },
            now,
            1_000,
        );
        controller.apply_worker_event_at(
            WorkerEvent::Caption {
                turn_id: 2,
                revision: 2,
                source: "新しい字幕".to_string(),
                update_mode: CaptionUpdateMode::Replace,
                is_final: true,
            },
            now + Duration::from_millis(1),
            1_000,
        );
        controller.apply_worker_event_at(
            WorkerEvent::Translation {
                turn_id: 1,
                revision: 1,
                source: "古い字幕".to_string(),
                translation: "Old caption".to_string(),
            },
            now + Duration::from_millis(2),
            1_000,
        );

        assert_eq!(controller.snapshot.source_text, "新しい字幕");
        assert!(controller.snapshot.translation_text.is_empty());
        assert_eq!(controller.awaiting_translation_revision, Some(2));
    }
}
