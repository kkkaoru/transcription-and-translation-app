//! Microphone capture connected to the in-process Parapper engine.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use caption_bridge_audio::{
    is_permission_denied_error, is_recoverable_stream_error, list_input_devices, AudioCapture,
    AudioCaptureConfig, AudioError, InputDevice,
};
use parapper_engine::{CaptionUpdateMode, EngineConfig, EngineEvent, ParapperEngine};

use crate::domain::{parapper_runtime_dir, CaptureStatus};

const PARAPPER_VAD_INTERVAL_MS: u32 = 32;
const POLL_TIMEOUT: Duration = Duration::from_millis(16);
const COMMAND_QUEUE_CAPACITY: usize = 1;
const EVENT_QUEUE_CAPACITY: usize = 64;
const MICROPHONE_PERMISSION_MESSAGE: &str = "マイクの使用が許可されていません。システム設定 → プライバシーとセキュリティ → マイクから「Kotoba Beacon Native」にアクセスを許可してください。Kotoba Beacon Native を一度終了してから設定を変更してください。";
const DEVICE_NOT_FOUND_MESSAGE: &str = "指定されたマイクが見つかりません";

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
    pub fn displayed_source_text(&self) -> &str {
        if self.source_text.is_empty() {
            "字幕はまだありません"
        } else {
            &self.source_text
        }
    }

    fn apply_worker_event(&mut self, event: WorkerEvent) {
        match event {
            WorkerEvent::Status(status) => self.status = status,
            WorkerEvent::Caption { source, update_mode } => match update_mode {
                CaptionUpdateMode::Append => self.source_text.push_str(&source),
                CaptionUpdateMode::Replace => self.source_text = source,
            },
            WorkerEvent::Rms(rms) => self.last_rms_dbfs = rms,
            WorkerEvent::Error(error) => {
                self.last_error = Some(error);
                self.status = CaptureStatus::Error;
            }
            WorkerEvent::EngineReady(ready) => self.engine_ready = ready,
        }
    }
}

enum WorkerCommand {
    Stop,
}

enum WorkerEvent {
    Status(CaptureStatus),
    Caption { source: String, update_mode: CaptionUpdateMode },
    Rms(Option<f32>),
    Error(String),
    EngineReady(bool),
}

pub struct CaptureController {
    snapshot: CaptureSnapshot,
    command_tx: Option<SyncSender<WorkerCommand>>,
    event_rx: Option<Receiver<WorkerEvent>>,
    worker: Option<JoinHandle<()>>,
}

impl CaptureController {
    pub fn new() -> Self {
        let mut controller = Self {
            snapshot: CaptureSnapshot::default(),
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

    pub fn poll(&mut self) {
        let Some(receiver) = self.event_rx.as_ref() else {
            return;
        };
        while let Ok(event) = receiver.try_recv() {
            self.snapshot.apply_worker_event(event);
        }
        if self.snapshot.status != CaptureStatus::Capturing {
            if let Some(handle) = self.worker.take() {
                let _ = handle.join();
            }
            self.command_tx = None;
            self.event_rx = None;
        }
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.snapshot.status == CaptureStatus::Capturing {
            return Ok(());
        }
        let models_root = parapper_runtime_dir()?.join("models");
        let device_id = self.snapshot.selected_device_id.clone();
        let (command_tx, command_rx) = mpsc::sync_channel(COMMAND_QUEUE_CAPACITY);
        let (event_tx, event_rx) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let handle = thread::Builder::new()
            .name("native-recognition".to_string())
            .spawn(move || run_capture_worker(models_root, device_id, command_rx, event_tx))
            .map_err(|error| format!("could not start recognition thread: {error}"))?;
        self.command_tx = Some(command_tx);
        self.event_rx = Some(event_rx);
        self.worker = Some(handle);
        self.snapshot.status = CaptureStatus::Capturing;
        self.snapshot.last_error = None;
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
    command_rx: Receiver<WorkerCommand>,
    event_tx: SyncSender<WorkerEvent>,
) {
    if let Err(error) = run_capture_inner(models_root, device_id, &command_rx, &event_tx) {
        let _ = event_tx.send(WorkerEvent::Error(error));
    }
    let _ = event_tx.send(WorkerEvent::EngineReady(false));
    let _ = event_tx.send(WorkerEvent::Status(CaptureStatus::Idle));
}

fn run_capture_inner(
    models_root: std::path::PathBuf,
    device_id: Option<String>,
    command_rx: &Receiver<WorkerCommand>,
    event_tx: &SyncSender<WorkerEvent>,
) -> Result<(), String> {
    let config = EngineConfig::new(models_root);
    let mut engine = ParapperEngine::load(&config)
        .map_err(|error| format!("音声認識エンジンを初期化できません: {error:#}"))?;
    let _ = event_tx.send(WorkerEvent::EngineReady(true));

    let mut capture = AudioCapture::new(native_audio_config())
        .map_err(|error| format!("マイク初期化に失敗しました: {error}"))?;
    capture.start(device_id.as_deref()).map_err(format_audio_start_error)?;
    let _ = event_tx.send(WorkerEvent::Status(CaptureStatus::Capturing));

    loop {
        match command_rx.recv_timeout(POLL_TIMEOUT) {
            Ok(WorkerCommand::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        loop {
            match capture.try_next_frame() {
                Ok(Some(frame)) => {
                    let samples = pcm16_to_f32(&frame);
                    let events = engine
                        .push_audio(&samples)
                        .map_err(|error| format!("音声認識に失敗しました: {error:#}"))?;
                    publish_engine_events(events, event_tx);
                }
                Ok(None) => break,
                Err(error) if is_recoverable_stream_error(&error) => continue,
                Err(error) => return Err(format_audio_read_error(error)),
            }
        }
        publish_engine_events(engine.tick(), event_tx);
        let _ = event_tx.try_send(WorkerEvent::Rms(capture.stats().last_input_rms_dbfs));
    }

    let _ = capture.stop();
    let (_, events) = engine.shutdown();
    publish_engine_events(events, event_tx);
    Ok(())
}

fn native_audio_config() -> AudioCaptureConfig {
    AudioCaptureConfig { chunk_ms: PARAPPER_VAD_INTERVAL_MS, ..AudioCaptureConfig::default() }
}

fn pcm16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|sample| f32::from(*sample) / 32_768.0).collect()
}

fn publish_engine_events(events: Vec<EngineEvent>, event_tx: &SyncSender<WorkerEvent>) {
    for event in events {
        if let EngineEvent::Caption { text, update_mode, .. } = event {
            let _ = event_tx.send(WorkerEvent::Caption { source: text, update_mode });
        }
    }
}

fn format_audio_start_error(error: AudioError) -> String {
    if is_permission_denied_error(&error) {
        return MICROPHONE_PERMISSION_MESSAGE.to_string();
    }
    match error {
        AudioError::DeviceNotFound(id) => format!("{DEVICE_NOT_FOUND_MESSAGE}: {id}"),
        AudioError::NoInputDevice => "マイクが検出されませんでした".to_string(),
        other => format!("マイク開始に失敗しました: {other}"),
    }
}

fn format_audio_read_error(error: AudioError) -> String {
    if is_permission_denied_error(&error) {
        MICROPHONE_PERMISSION_MESSAGE.to_string()
    } else {
        format!("マイク読み取りに失敗しました: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::{pcm16_to_f32, CaptionUpdateMode, CaptureSnapshot, WorkerEvent};

    #[test]
    fn pcm16_conversion_preserves_full_scale_contract() {
        assert_eq!(pcm16_to_f32(&[-32_768, 0, 16_384, 32_767]), vec![-1.0, 0.0, 0.5, 0.9999695]);
    }

    #[test]
    fn engine_caption_updates_snapshot_without_protocol_json() {
        let mut snapshot = CaptureSnapshot::default();
        snapshot.apply_worker_event(WorkerEvent::Caption {
            source: "こんにちは。".to_string(),
            update_mode: CaptionUpdateMode::Replace,
        });
        assert_eq!(snapshot.source_text, "こんにちは。");
    }
}
