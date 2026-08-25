//! Microphone capture connected to in-process recognition and translation workers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use caption_bridge_audio::{
    is_permission_denied_error, is_recoverable_stream_error, list_input_devices, AudioCapture,
    AudioCaptureConfig, AudioError, InputDevice,
};
use parapper_engine::{
    CaptionUpdateMode, EngineConfig, EngineEvent, LocalTranslator, ParapperEngine,
};

use crate::domain::{parapper_runtime_dir, CaptureStatus};
use crate::hot_path::{normalize_pcm16_into, NATIVE_PCM_FRAME_SAMPLES};

const PARAPPER_VAD_INTERVAL_MS: u32 = 32;
const POLL_TIMEOUT: Duration = Duration::from_millis(16);
const RMS_PUBLISH_INTERVAL: Duration = Duration::from_millis(100);
const COMMAND_QUEUE_CAPACITY: usize = 1;
const EVENT_QUEUE_CAPACITY: usize = 64;
const TRANSLATION_QUEUE_CAPACITY: usize = 1;
const TRANSLATOR_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const DEVICE_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const MICROPHONE_PERMISSION_MESSAGE: &str = "Microphone access is not permitted";
const DEVICE_NOT_FOUND_MESSAGE: &str = "The selected microphone was not found";
const MAX_CAPTION_CHARACTERS: usize = 2_048;

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
            WorkerEvent::Caption { source, update_mode } => {
                self.translation_text.clear();
                apply_caption_update(&mut self.source_text, &source, update_mode);
            }
            WorkerEvent::Translation { source, translation } => {
                if self.source_text == source {
                    self.translation_text = translation;
                }
            }
            WorkerEvent::Rms(rms) => self.last_rms_dbfs = rms,
            WorkerEvent::Error(error) => {
                self.last_error = Some(error);
                self.status = CaptureStatus::Error;
            }
            WorkerEvent::TranslationError(error) => self.last_error = Some(error),
            WorkerEvent::EngineReady(ready) => self.engine_ready = ready,
        }
    }
}

enum WorkerCommand {
    Stop,
    ResetCaption,
}

enum WorkerEvent {
    Status(CaptureStatus),
    Caption { source: String, update_mode: CaptionUpdateMode },
    Translation { source: String, translation: String },
    TranslationError(String),
    Rms(Option<f32>),
    Error(String),
    EngineReady(bool),
}

struct TranslationWorker {
    sender: SyncSender<String>,
    handle: JoinHandle<()>,
}

pub struct CaptureController {
    snapshot: CaptureSnapshot,
    caption_expires_at: Option<Instant>,
    last_device_refresh: Instant,
    command_tx: Option<SyncSender<WorkerCommand>>,
    event_rx: Option<Receiver<WorkerEvent>>,
    worker: Option<JoinHandle<()>>,
    worker_stop_requested: Option<Arc<AtomicBool>>,
}

impl CaptureController {
    pub fn new() -> Self {
        let mut controller = Self {
            snapshot: CaptureSnapshot::default(),
            caption_expires_at: None,
            last_device_refresh: Instant::now(),
            command_tx: None,
            event_rx: None,
            worker: None,
            worker_stop_requested: None,
        };
        controller.refresh_devices();
        controller
    }

    pub fn snapshot(&self) -> &CaptureSnapshot {
        &self.snapshot
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
        self.last_device_refresh = Instant::now();
        changed
    }

    pub fn select_device(&mut self, id: &str) {
        if self.snapshot.devices.iter().any(|device| device.id == id) {
            self.snapshot.selected_device_id = Some(id.to_string());
        }
    }

    pub fn poll(&mut self, caption_timeout_ms: u64) -> bool {
        let mut changed = false;
        if self.last_device_refresh.elapsed() >= DEVICE_REFRESH_INTERVAL {
            changed = self.refresh_devices();
        }
        let Some(receiver) = self.event_rx.as_ref() else {
            return self.expire_caption() || changed;
        };
        while let Ok(event) = receiver.try_recv() {
            if matches!(event, WorkerEvent::Caption { .. }) {
                self.caption_expires_at =
                    Some(Instant::now() + Duration::from_millis(caption_timeout_ms));
            }
            self.snapshot.apply_worker_event(event);
            changed = true;
        }
        changed |= self.expire_caption();
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
        let models_root = parapper_runtime_dir()?.join("models");
        let device_id = self.snapshot.selected_device_id.clone();
        let (command_tx, command_rx) = mpsc::sync_channel(COMMAND_QUEUE_CAPACITY);
        let (event_tx, event_rx) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let stop_requested = Arc::new(AtomicBool::new(false));
        let worker_stop_requested = stop_requested.clone();
        let handle = thread::Builder::new()
            .name("native-recognition".to_string())
            .spawn(move || {
                run_capture_worker(
                    models_root,
                    device_id,
                    translation_enabled,
                    command_rx,
                    event_tx,
                    worker_stop_requested,
                )
            })
            .map_err(|error| format!("could not start recognition thread: {error}"))?;
        self.command_tx = Some(command_tx);
        self.event_rx = Some(event_rx);
        self.worker = Some(handle);
        self.worker_stop_requested = Some(stop_requested);
        self.snapshot.status = CaptureStatus::Capturing;
        self.snapshot.last_error = None;
        self.snapshot.source_text.clear();
        self.snapshot.translation_text.clear();
        self.caption_expires_at = None;
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

    fn expire_caption(&mut self) -> bool {
        if !self.caption_expires_at.is_some_and(|deadline| Instant::now() >= deadline) {
            return false;
        }
        self.snapshot.source_text.clear();
        self.snapshot.translation_text.clear();
        self.caption_expires_at = None;
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
    models_root: std::path::PathBuf,
    device_id: Option<String>,
    translation_enabled: bool,
    command_rx: Receiver<WorkerCommand>,
    event_tx: SyncSender<WorkerEvent>,
    stop_requested: Arc<AtomicBool>,
) {
    if let Err(error) = run_capture_inner(
        models_root,
        device_id,
        translation_enabled,
        &command_rx,
        &event_tx,
        &stop_requested,
    ) {
        let _ = event_tx.send(WorkerEvent::Error(error));
    }
    let _ = event_tx.send(WorkerEvent::EngineReady(false));
    let _ = event_tx.send(WorkerEvent::Status(CaptureStatus::Idle));
}

fn run_capture_inner(
    models_root: std::path::PathBuf,
    device_id: Option<String>,
    translation_enabled: bool,
    command_rx: &Receiver<WorkerCommand>,
    event_tx: &SyncSender<WorkerEvent>,
    stop_requested: &AtomicBool,
) -> Result<(), String> {
    if stop_requested.load(Ordering::Acquire) {
        return Ok(());
    }
    let config = EngineConfig::new(models_root.clone());
    let mut translation_worker =
        start_translation_worker(translation_enabled, models_root, event_tx.clone())?;
    let mut engine = ParapperEngine::load(&config)
        .map_err(|error| format!("Could not initialize speech recognition: {error:#}"))?;
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
    let mut normalized_samples = Vec::with_capacity(NATIVE_PCM_FRAME_SAMPLES);
    let mut last_rms_publish = Instant::now() - RMS_PUBLISH_INTERVAL;

    loop {
        if stop_requested.load(Ordering::Acquire) {
            break;
        }
        match command_rx.recv_timeout(POLL_TIMEOUT) {
            Ok(WorkerCommand::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(WorkerCommand::ResetCaption) => recognition_text.clear(),
            Err(RecvTimeoutError::Timeout) => {}
        }
        loop {
            match capture.try_next_frame() {
                Ok(Some(frame)) => {
                    normalize_pcm16_into(&frame, &mut normalized_samples);
                    let events = engine
                        .push_audio(&normalized_samples)
                        .map_err(|error| format!("Speech recognition failed: {error:#}"))?;
                    publish_engine_events(
                        events,
                        event_tx,
                        translation_worker.as_ref().map(|worker| &worker.sender),
                        &mut recognition_text,
                    );
                }
                Ok(None) => break,
                Err(error) if is_recoverable_stream_error(&error) => continue,
                Err(error) => return Err(format_audio_read_error(error)),
            }
        }
        publish_engine_events(
            engine.tick(),
            event_tx,
            translation_worker.as_ref().map(|worker| &worker.sender),
            &mut recognition_text,
        );
        if last_rms_publish.elapsed() >= RMS_PUBLISH_INTERVAL {
            let _ = event_tx.try_send(WorkerEvent::Rms(capture.stats().last_input_rms_dbfs));
            last_rms_publish = Instant::now();
        }
    }

    let _ = capture.stop();
    let (_, events) = engine.shutdown();
    publish_engine_events(
        events,
        event_tx,
        translation_worker.as_ref().map(|worker| &worker.sender),
        &mut recognition_text,
    );
    if let Some(worker) = translation_worker.take() {
        drop(worker.sender);
        let _ = worker.handle.join();
    }
    Ok(())
}

fn start_translation_worker(
    enabled: bool,
    models_root: std::path::PathBuf,
    event_tx: SyncSender<WorkerEvent>,
) -> Result<Option<TranslationWorker>, String> {
    if !enabled {
        return Ok(None);
    }
    let (sender, receiver) = mpsc::sync_channel(TRANSLATION_QUEUE_CAPACITY);
    let handle = thread::Builder::new()
        .name("native-translation".to_string())
        .spawn(move || run_translation_worker(models_root, receiver, event_tx))
        .map_err(|error| format!("could not start translation thread: {error}"))?;
    Ok(Some(TranslationWorker { sender, handle }))
}

fn run_translation_worker(
    models_root: std::path::PathBuf,
    receiver: Receiver<String>,
    event_tx: SyncSender<WorkerEvent>,
) {
    let mut translator = None;
    loop {
        let source = match receiver.recv_timeout(TRANSLATOR_IDLE_TIMEOUT) {
            Ok(source) => source,
            Err(RecvTimeoutError::Timeout) => {
                translator = None;
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if translator.is_none() {
            match LocalTranslator::load(&models_root) {
                Ok(loaded) => translator = Some(loaded),
                Err(error) => {
                    let _ = event_tx.send(WorkerEvent::TranslationError(format!(
                        "Local translation model is unavailable: {error:#}"
                    )));
                    continue;
                }
            }
        }
        let Some(translator) = translator.as_mut() else {
            continue;
        };
        match translator.translate_ja_to_en(&source) {
            Ok(translation) => {
                let _ = event_tx.send(WorkerEvent::Translation { source, translation });
            }
            Err(error) => {
                let _ = event_tx
                    .send(WorkerEvent::TranslationError(format!("Translation failed: {error:#}")));
            }
        }
    }
}

fn native_audio_config() -> AudioCaptureConfig {
    AudioCaptureConfig { chunk_ms: PARAPPER_VAD_INTERVAL_MS, ..AudioCaptureConfig::default() }
}

fn publish_engine_events(
    events: Vec<EngineEvent>,
    event_tx: &SyncSender<WorkerEvent>,
    translation_tx: Option<&SyncSender<String>>,
    recognition_text: &mut String,
) {
    for event in events {
        if let EngineEvent::Caption { text, is_final, update_mode, .. } = event {
            apply_caption_update(recognition_text, &text, update_mode);
            let _ = event_tx.send(WorkerEvent::Caption { source: text, update_mode });
            if is_final {
                if let Some(sender) = translation_tx {
                    let _ = sender.try_send(recognition_text.clone());
                }
            }
        }
    }
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

    use super::{
        apply_caption_update, CaptionUpdateMode, CaptureController, CaptureSnapshot, CaptureStatus,
        WorkerEvent, MAX_CAPTION_CHARACTERS,
    };

    #[test]
    fn expired_caption_clears_recognition_and_translation() {
        let mut controller = CaptureController::new();
        controller.snapshot.source_text = "こんにちは。".to_string();
        controller.snapshot.translation_text = "Hello.".to_string();
        controller.caption_expires_at = Some(Instant::now() - Duration::from_millis(1));
        assert!(controller.expire_caption());
        assert!(controller.snapshot.source_text.is_empty());
        assert!(controller.snapshot.translation_text.is_empty());
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
            last_device_refresh: Instant::now(),
            command_tx: Some(command_tx),
            event_rx: Some(event_rx),
            worker: Some(worker),
            worker_stop_requested: Some(stop_requested.clone()),
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
    fn replace_caption_discards_previous_text_before_applying_limit() {
        let mut caption = "古い字幕".to_string();
        apply_caption_update(&mut caption, "新しい字幕", CaptionUpdateMode::Replace);

        assert_eq!(caption, "新しい字幕");
    }

    #[test]
    fn translation_updates_only_the_matching_recognition() {
        let mut snapshot = CaptureSnapshot::default();
        snapshot.apply_worker_event(WorkerEvent::Caption {
            source: "こんにちは。".to_string(),
            update_mode: CaptionUpdateMode::Replace,
        });
        snapshot.apply_worker_event(WorkerEvent::Translation {
            source: "古い字幕".to_string(),
            translation: "Old".to_string(),
        });
        assert!(snapshot.translation_text.is_empty());
        snapshot.apply_worker_event(WorkerEvent::Translation {
            source: "こんにちは。".to_string(),
            translation: "Hello.".to_string(),
        });
        assert_eq!(snapshot.translation_text, "Hello.");
    }
}
