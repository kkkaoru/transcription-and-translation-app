//! Microphone capture connected to in-process recognition and translation workers.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
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

const PARAPPER_VAD_INTERVAL_MS: u32 = 32;
const POLL_TIMEOUT: Duration = Duration::from_millis(16);
const RMS_PUBLISH_INTERVAL: Duration = Duration::from_millis(100);
const COMMAND_QUEUE_CAPACITY: usize = 1;
const EVENT_QUEUE_CAPACITY: usize = 64;
const TRANSLATION_QUEUE_CAPACITY: usize = 1;
const TRANSLATOR_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const DEVICE_REFRESH_INTERVAL: Duration = Duration::from_secs(2);
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
        };
        controller.refresh_devices();
        controller
    }

    pub fn snapshot(&self) -> &CaptureSnapshot {
        &self.snapshot
    }

    pub fn refresh_devices(&mut self) {
        match list_input_devices() {
            Ok(devices) => self.apply_device_list(devices),
            Err(error) => {
                self.snapshot.last_error = Some(error.to_string());
                self.snapshot.status = CaptureStatus::Error;
            }
        }
    }

    pub fn select_device(&mut self, id: &str) {
        if self.snapshot.devices.iter().any(|device| device.id == id) {
            self.snapshot.selected_device_id = Some(id.to_string());
        }
    }

    pub fn poll(&mut self, caption_timeout_ms: u64) -> bool {
        let mut changed = false;
        if self.last_device_refresh.elapsed() >= DEVICE_REFRESH_INTERVAL {
            let previous_devices = self.snapshot.devices.clone();
            let previous_selection = self.snapshot.selected_device_id.clone();
            self.refresh_devices();
            changed = self.snapshot.devices != previous_devices
                || self.snapshot.selected_device_id != previous_selection;
            self.last_device_refresh = Instant::now();
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
        if self.snapshot.status != CaptureStatus::Capturing {
            if let Some(handle) = self.worker.take() {
                let _ = handle.join();
            }
            self.command_tx = None;
            self.event_rx = None;
        }
        changed
    }

    pub fn start(&mut self, translation_enabled: bool) -> Result<(), String> {
        if self.snapshot.status == CaptureStatus::Capturing {
            return Ok(());
        }
        let models_root = parapper_runtime_dir()?.join("models");
        let device_id = self.snapshot.selected_device_id.clone();
        let (command_tx, command_rx) = mpsc::sync_channel(COMMAND_QUEUE_CAPACITY);
        let (event_tx, event_rx) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let handle = thread::Builder::new()
            .name("native-recognition".to_string())
            .spawn(move || {
                run_capture_worker(
                    models_root,
                    device_id,
                    translation_enabled,
                    command_rx,
                    event_tx,
                )
            })
            .map_err(|error| format!("could not start recognition thread: {error}"))?;
        self.command_tx = Some(command_tx);
        self.event_rx = Some(event_rx);
        self.worker = Some(handle);
        self.snapshot.status = CaptureStatus::Capturing;
        self.snapshot.last_error = None;
        self.snapshot.source_text.clear();
        self.snapshot.translation_text.clear();
        self.caption_expires_at = None;
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(sender) = self.command_tx.take() {
            let _ = sender.send(WorkerCommand::Stop);
        }
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
        self.event_rx = None;
        self.snapshot.status = CaptureStatus::Idle;
        self.snapshot.engine_ready = false;
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
) {
    if let Err(error) =
        run_capture_inner(models_root, device_id, translation_enabled, &command_rx, &event_tx)
    {
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
) -> Result<(), String> {
    let config = EngineConfig::new(models_root.clone());
    let mut translation_worker =
        start_translation_worker(translation_enabled, models_root, event_tx.clone())?;
    let mut engine = ParapperEngine::load(&config)
        .map_err(|error| format!("Could not initialize speech recognition: {error:#}"))?;
    let _ = event_tx.send(WorkerEvent::EngineReady(true));

    let mut capture = AudioCapture::new(native_audio_config())
        .map_err(|error| format!("Could not initialize microphone: {error}"))?;
    capture.start(device_id.as_deref()).map_err(format_audio_start_error)?;
    let _ = event_tx.send(WorkerEvent::Status(CaptureStatus::Capturing));
    let mut recognition_text = String::new();
    let mut last_rms_publish = Instant::now() - RMS_PUBLISH_INTERVAL;

    loop {
        match command_rx.recv_timeout(POLL_TIMEOUT) {
            Ok(WorkerCommand::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(WorkerCommand::ResetCaption) => recognition_text.clear(),
            Err(RecvTimeoutError::Timeout) => {}
        }
        loop {
            match capture.try_next_frame() {
                Ok(Some(frame)) => {
                    let samples = pcm16_to_f32(&frame);
                    let events = engine
                        .push_audio(&samples)
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

fn pcm16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|sample| f32::from(*sample) / 32_768.0).collect()
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
    use std::time::{Duration, Instant};

    use super::{
        apply_caption_update, pcm16_to_f32, CaptionUpdateMode, CaptureController, CaptureSnapshot,
        WorkerEvent, MAX_CAPTION_CHARACTERS,
    };

    #[test]
    fn pcm16_conversion_preserves_full_scale_contract() {
        assert_eq!(pcm16_to_f32(&[-32_768, 0, 16_384, 32_767]), vec![-1.0, 0.0, 0.5, 0.9999695]);
    }

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
