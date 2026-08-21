//! Microphone + Parapper sidecar capture controller.

use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use caption_bridge_audio::{
    is_permission_denied_error, is_recoverable_stream_error, list_input_devices, AudioCapture,
    AudioCaptureConfig, AudioError, InputDevice,
};
use caption_bridge_parapper::{
    serialize_client_frame, AudioParameters, ClientFrame, ParapperClientOptions, PROTOCOL_VERSION,
};
use caption_bridge_sidecar::{
    parapper_args, ChildSupervisor, ReadyCheck, SidecarSpec, SupervisorError,
};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{client, Message, WebSocket};

use crate::domain::{
    missing_sidecar_message, parapper_runtime_dir, resolve_parapper_binary, CaptureStatus,
    NATIVE_PARAPPER_PORT, PARAPPER_BINARY_NAME,
};

const PARAPPER_VAD_INTERVAL_MS: u32 = 32;
const PARAPPER_VAD_THRESHOLD: f32 = 0.5;
const READY_ATTEMPTS: u32 = 300;
const POLL_TIMEOUT: Duration = Duration::from_millis(40);
const CONNECT_RETRY: Duration = Duration::from_millis(200);
const MICROPHONE_PERMISSION_MESSAGE: &str = "マイクの使用が許可されていません。システム設定 → プライバシーとセキュリティ → マイクから「Kotoba Beacon Native」にアクセスを許可してください。Kotoba Beacon Native を一度終了してから設定を変更してください。";
const DEVICE_NOT_FOUND_MESSAGE: &str = "指定されたマイクが見つかりません";

/// Snapshot the Live tab can render without owning capture threads.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureSnapshot {
    pub status: CaptureStatus,
    pub devices: Vec<InputDevice>,
    pub selected_device_id: Option<String>,
    pub source_text: String,
    pub translation_text: String,
    pub last_error: Option<String>,
    pub last_rms_dbfs: Option<f32>,
    pub sidecar_ready: bool,
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
            sidecar_ready: false,
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
}

enum WorkerCommand {
    Stop,
}

enum WorkerEvent {
    Status(CaptureStatus),
    Caption { source: String, translation: String },
    Rms(Option<f32>),
    Error(String),
    SidecarReady(bool),
}

/// Owns device list + optional capture worker.
struct ParapperSupervisor {
    inner: ChildSupervisor,
}

impl ParapperSupervisor {
    fn stop(&mut self) -> Result<(), SupervisorError> {
        self.inner.stop()
    }
}

impl Drop for ParapperSupervisor {
    fn drop(&mut self) {
        let _ = self.inner.stop();
    }
}

pub struct CaptureController {
    snapshot: CaptureSnapshot,
    command_tx: Option<Sender<WorkerCommand>>,
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

    #[cfg(feature = "gpui")]
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

    #[cfg(feature = "gpui")]
    pub fn select_device(&mut self, id: &str) {
        if self.snapshot.devices.iter().any(|device| device.id == id) {
            self.snapshot.selected_device_id = Some(id.to_string());
        }
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

    #[cfg(feature = "gpui")]
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
        let binary = resolve_parapper_binary()?;
        let device_id = self.snapshot.selected_device_id.clone();
        let (command_tx, command_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop);
        let handle = thread::Builder::new()
            .name("native-capture".to_string())
            .spawn(move || {
                run_capture_worker(binary, device_id, command_rx, event_tx, stop_for_thread);
            })
            .map_err(|error| format!("could not start capture thread: {error}"))?;
        self.command_tx = Some(command_tx);
        self.event_rx = Some(event_rx);
        self.worker = Some(handle);
        self.snapshot.status = CaptureStatus::Capturing;
        self.snapshot.last_error = None;
        let _ = stop;
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.command_tx.take() {
            let _ = tx.send(WorkerCommand::Stop);
        }
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
        self.event_rx = None;
        if self.snapshot.status == CaptureStatus::Capturing {
            self.snapshot.status = CaptureStatus::Idle;
        }
        self.snapshot.sidecar_ready = false;
    }
}

impl CaptureSnapshot {
    #[cfg(any(feature = "gpui", test))]
    fn apply_worker_event(&mut self, event: WorkerEvent) {
        match event {
            WorkerEvent::Status(status) => self.status = status,
            WorkerEvent::Caption { source, translation } => {
                self.source_text = source;
                self.translation_text = translation;
            }
            WorkerEvent::Rms(rms) => self.last_rms_dbfs = rms,
            WorkerEvent::Error(error) => {
                self.last_error = Some(error);
                self.status = CaptureStatus::Error;
            }
            WorkerEvent::SidecarReady(ready) => self.sidecar_ready = ready,
        }
    }
}

impl Drop for CaptureController {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_capture_worker(
    binary: PathBuf,
    device_id: Option<String>,
    command_rx: Receiver<WorkerCommand>,
    event_tx: Sender<WorkerEvent>,
    stop: Arc<AtomicBool>,
) {
    if let Err(error) = run_capture_inner(binary, device_id, &command_rx, &event_tx, &stop) {
        let _ = event_tx.send(WorkerEvent::Error(error));
    }
    let _ = event_tx.send(WorkerEvent::Status(CaptureStatus::Idle));
}

fn run_capture_inner(
    binary: PathBuf,
    device_id: Option<String>,
    command_rx: &Receiver<WorkerCommand>,
    event_tx: &Sender<WorkerEvent>,
    stop: &AtomicBool,
) -> Result<(), String> {
    let mut supervisor = spawn_parapper(binary)?;
    let _ = event_tx.send(WorkerEvent::SidecarReady(true));
    let mut client = connect_parapper()?;
    let mut capture = AudioCapture::new(AudioCaptureConfig::default())
        .map_err(|error| format!("マイク初期化に失敗しました: {error}"))?;
    capture.start(device_id.as_deref()).map_err(format_audio_start_error)?;
    let _ = event_tx.send(WorkerEvent::Status(CaptureStatus::Capturing));

    let mut caption_session = CaptionSessionLike::new();
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match command_rx.recv_timeout(POLL_TIMEOUT) {
            Ok(WorkerCommand::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        let frames = std::iter::from_fn(|| Some(capture.try_next_frame()));
        drain_audio_frames(frames, |bytes| {
            client
                .send_pcm16(bytes)
                .map_err(|error| format!("Parapper へ音声を送れません: {error}"))
        })?;
        let _ = event_tx.send(WorkerEvent::Rms(capture.stats().last_input_rms_dbfs));
        drain_parapper(&mut client, &mut caption_session, event_tx)?;
    }

    let _ = client.stop();
    let _ = capture.stop();
    let _ = supervisor.stop();
    Ok(())
}

fn format_audio_start_error(error: AudioError) -> String {
    if is_permission_denied_error(&error) {
        MICROPHONE_PERMISSION_MESSAGE.to_string()
    } else {
        match error {
            AudioError::DeviceNotFound(id) => format!("{DEVICE_NOT_FOUND_MESSAGE}: {id}"),
            AudioError::NoInputDevice => "マイクが検出されませんでした".to_string(),
            other => format!("マイク開始に失敗しました: {other}"),
        }
    }
}

fn format_audio_read_error(error: AudioError) -> String {
    if is_permission_denied_error(&error) {
        MICROPHONE_PERMISSION_MESSAGE.to_string()
    } else {
        format!("マイク読み取りに失敗しました: {error}")
    }
}

fn spawn_parapper(binary: PathBuf) -> Result<ParapperSupervisor, String> {
    let runtime_dir = parapper_runtime_dir()?;
    spawn_parapper_at(binary, runtime_dir, NATIVE_PARAPPER_PORT, READY_ATTEMPTS)
}

fn spawn_parapper_at(
    binary: PathBuf,
    runtime_dir: PathBuf,
    port: u16,
    ready_attempts: u32,
) -> Result<ParapperSupervisor, String> {
    if !binary.is_file() {
        return Err(missing_sidecar_message());
    }
    ensure_loopback_port_available(port)?;
    let argv = parapper_args(port, PARAPPER_VAD_INTERVAL_MS, PARAPPER_VAD_THRESHOLD, false);
    let spec = parapper_sidecar_spec(binary, runtime_dir, argv, port);
    let mut supervisor = ParapperSupervisor { inner: ChildSupervisor::new(spec) };
    supervisor.inner.start().map_err(format_supervisor_error)?;
    supervisor.inner.wait_until_ready(ready_attempts).map_err(format_supervisor_error)?;
    Ok(supervisor)
}

fn ensure_loopback_port_available(port: u16) -> Result<(), String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|error| {
        format!(
            "Parapper port {port} is already occupied; stop the stale listener before starting capture: {error}"
        )
    })?;
    drop(listener);
    Ok(())
}

fn parapper_sidecar_spec(
    binary: PathBuf,
    runtime_dir: PathBuf,
    argv: Vec<String>,
    port: u16,
) -> SidecarSpec {
    SidecarSpec::new(
        PARAPPER_BINARY_NAME,
        binary.to_string_lossy().into_owned(),
        argv,
        port,
        Some(ReadyCheck::Tcp { host: "127.0.0.1".to_string(), port }),
    )
    .with_env([("PARAPPER_RUNTIME_DIR", runtime_dir.to_string_lossy().as_ref())])
}

fn format_supervisor_error(error: SupervisorError) -> String {
    match error {
        SupervisorError::Spawn { program, source } => {
            if source.kind() == ErrorKind::NotFound {
                missing_sidecar_message()
            } else {
                format!("sidecar `{program}` の起動に失敗しました: {source}")
            }
        }
        other => format!(
            "Parapper sidecar (`{PARAPPER_BINARY_NAME}`) を port {NATIVE_PARAPPER_PORT} で準備できません: {other}"
        ),
    }
}

fn connect_parapper() -> Result<NonblockingParapper, String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut last_error = "接続できませんでした".to_string();
    while Instant::now() < deadline {
        match NonblockingParapper::connect() {
            Ok(client) => return Ok(client),
            Err(error) => last_error = error,
        }
        thread::sleep(CONNECT_RETRY);
    }
    Err(format!(
        "ws://127.0.0.1:{NATIVE_PARAPPER_PORT}/ws/recognition に接続できません ({last_error})"
    ))
}

struct NonblockingParapper {
    socket: WebSocket<MaybeTlsStream<std::net::TcpStream>>,
    session_id: String,
}

impl NonblockingParapper {
    fn connect() -> Result<Self, String> {
        Self::connect_to(NATIVE_PARAPPER_PORT, unique_session_id())
    }

    fn connect_to(port: u16, session_id: String) -> Result<Self, String> {
        let options = ParapperClientOptions::for_port(port, session_id);
        let url: tungstenite::http::Uri =
            options.url.parse().map_err(|error| format!("invalid recognition URL: {error}"))?;
        let stream =
            std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|error| error.to_string())?;
        let (mut socket, _) =
            client(url, MaybeTlsStream::Plain(stream)).map_err(|error| error.to_string())?;
        if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
            stream.set_nonblocking(true).map_err(|error| error.to_string())?;
        }
        let start = ClientFrame::SessionStart {
            version: PROTOCOL_VERSION,
            session_id: options.session_id.clone(),
            audio: AudioParameters::pcm16(false),
        };
        socket
            .send(Message::Text(
                serialize_client_frame(&start).map_err(|error| error.to_string())?.into(),
            ))
            .map_err(|error| error.to_string())?;
        Ok(Self { socket, session_id: options.session_id })
    }

    fn send_pcm16(&mut self, frame: &[u8]) -> Result<(), String> {
        self.socket.send(Message::Binary(frame.to_vec().into())).map_err(|error| error.to_string())
    }

    fn try_next_json(&mut self) -> Result<Option<String>, String> {
        match self.socket.read() {
            Ok(Message::Text(text)) => Ok(Some(text.to_string())),
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(error)) if error.kind() == ErrorKind::WouldBlock => Ok(None),
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                Ok(None)
            }
            Err(error) => Err(error.to_string()),
        }
    }

    fn stop(&mut self) -> Result<(), String> {
        let stop = ClientFrame::SessionStop {
            version: PROTOCOL_VERSION,
            session_id: self.session_id.clone(),
        };
        self.socket
            .send(Message::Text(
                serialize_client_frame(&stop).map_err(|error| error.to_string())?.into(),
            ))
            .map_err(|error| error.to_string())
    }
}

fn drain_parapper(
    client: &mut NonblockingParapper,
    caption_session: &mut CaptionSessionLike,
    event_tx: &Sender<WorkerEvent>,
) -> Result<(), String> {
    while let Some(json) = client.try_next_json()? {
        if let Some((source, translation)) = caption_from_server_json(&json, caption_session) {
            let _ = event_tx.send(WorkerEvent::Caption { source, translation });
        }
    }
    Ok(())
}

pub fn caption_from_server_json(
    json: &str,
    caption_session: &mut CaptionSessionLike,
) -> Option<(String, String)> {
    caption_session.ingest(json)
}

pub struct CaptionSessionLike {
    session: caption_bridge_session::CaptionSession,
    last_source_text: String,
    last_translation_text: String,
}

impl CaptionSessionLike {
    pub fn new() -> Self {
        Self {
            session: caption_bridge_session::CaptionSession::native(),
            last_source_text: String::new(),
            last_translation_text: String::new(),
        }
    }

    fn ingest(&mut self, json: &str) -> Option<(String, String)> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        if self.session.ingest_parapper_json(json, now).is_err() {
            return None;
        }
        let live = self.session.live_caption();
        let source = live.source_text.clone();
        let translation = live.translation_text.clone();
        if source == self.last_source_text && translation == self.last_translation_text {
            None
        } else {
            self.last_source_text = source.clone();
            self.last_translation_text = translation.clone();
            Some((source, translation))
        }
    }
}

fn drain_audio_frames<I, S>(frames: I, mut send_pcm16: S) -> Result<(), String>
where
    I: IntoIterator<Item = Result<Option<Vec<i16>>, AudioError>>,
    S: FnMut(&[u8]) -> Result<(), String>,
{
    for result in frames {
        match result {
            Ok(Some(frame)) => send_pcm16(&i16_to_le_bytes(&frame))?,
            Ok(None) => break,
            Err(error) if is_recoverable_stream_error(&error) => continue,
            Err(error) => return Err(format_audio_read_error(error)),
        }
    }
    Ok(())
}

fn i16_to_le_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    bytes.extend(samples.iter().flat_map(|sample| sample.to_le_bytes()));
    bytes
}

fn unique_session_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("native-{now}")
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use caption_bridge_sidecar::{ChildSupervisor, SidecarSpec};
    use tungstenite::{accept, Message};

    use super::{
        caption_from_server_json, drain_audio_frames, drain_parapper, i16_to_le_bytes,
        parapper_sidecar_spec, spawn_parapper_at, CaptionSessionLike, CaptureSnapshot,
        NonblockingParapper, ParapperSupervisor,
    };

    #[test]
    fn caption_session_rejects_a_stale_partial_after_final() {
        let partial = r#"{"version":1,"type":"turn.partial","session_id":"live-session","turn_session_id":1,"turn_id":2,"revision":1,"output_sequence":1,"segment_id":3,"text":"こんにちは","source_language":"ja"}"#;
        let final_frame = r#"{"version":1,"type":"turn.final","session_id":"live-session","turn_session_id":1,"turn_id":2,"revision":2,"output_sequence":2,"segment_id":3,"text":"こんにちは。","source_language":"ja"}"#;
        let stale_partial = r#"{"version":1,"type":"turn.partial","session_id":"live-session","turn_session_id":1,"turn_id":2,"revision":1,"output_sequence":1,"segment_id":3,"text":"こんにちは","source_language":"ja"}"#;
        let mut session = CaptionSessionLike::new();

        assert_eq!(
            caption_from_server_json(partial, &mut session),
            Some(("こんにちは".to_string(), String::new()))
        );
        assert_eq!(
            caption_from_server_json(final_frame, &mut session),
            Some(("こんにちは。".to_string(), String::new()))
        );
        assert_eq!(caption_from_server_json(stale_partial, &mut session), None);
    }

    #[test]
    fn parapper_sidecar_spec_sets_runtime_directory() {
        let spec = parapper_sidecar_spec(
            "/tmp/kotoba-parapper".into(),
            "/tmp/native-parapper-runtime".into(),
            vec!["--headless".to_string()],
            18_182,
        );

        assert_eq!(
            spec.env,
            vec![("PARAPPER_RUNTIME_DIR".to_string(), "/tmp/native-parapper-runtime".to_string())]
        );
    }

    #[test]
    fn recoverable_audio_error_does_not_abort_frame_drain() {
        let frames = [
            Err(caption_bridge_audio::AudioError::FrameQueueFull),
            Ok(Some(vec![1_000, -1_000])),
            Ok(None),
        ];
        let mut sent = Vec::new();

        drain_audio_frames(frames, |bytes| {
            sent.push(bytes.to_vec());
            Ok(())
        })
        .expect("recoverable queue error must not abort capture");

        assert_eq!(sent, vec![vec![232, 3, 24, 252]]);
    }

    #[cfg(unix)]
    #[test]
    fn dropping_parapper_supervisor_terminates_child() {
        let spec = SidecarSpec::new(
            "test-child",
            "/bin/sh",
            vec!["-c".to_string(), "sleep 30".to_string()],
            0,
            None,
        );
        let mut inner = ChildSupervisor::new(spec);
        inner.start().expect("spawn test child");
        let pid = inner.child_pid().expect("test child pid");
        let supervisor = ParapperSupervisor { inner };

        drop(supervisor);

        let alive = std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .status()
            .expect("probe test child")
            .success();
        if alive {
            let _ = std::process::Command::new("/bin/kill").args(["-9", &pid.to_string()]).status();
        }
        assert!(!alive, "dropping the owner must terminate and reap the sidecar child");
    }

    #[cfg(unix)]
    #[test]
    fn occupied_port_fails_before_starting_a_fresh_sidecar() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind stale listener");
        let port = listener.local_addr().expect("stale listener address").port();
        let runtime_dir = std::env::temp_dir().join(format!("native-stale-port-{port}"));
        std::fs::create_dir_all(&runtime_dir).expect("runtime directory");

        let result =
            spawn_parapper_at(PathBuf::from("/usr/bin/true"), runtime_dir.clone(), port, 1);

        let error = match result {
            Ok(mut supervisor) => {
                let _ = supervisor.stop();
                panic!("occupied port must fail loudly");
            }
            Err(error) => error,
        };
        assert!(error.contains("already occupied"));
        assert!(error.contains(&port.to_string()));
        drop(listener);
        std::fs::remove_dir_all(runtime_dir).expect("remove runtime directory");
    }

    #[test]
    fn synthetic_pcm_server_caption_reaches_display_state() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind synthetic sidecar");
        let port = listener.local_addr().expect("synthetic sidecar address").port();
        let (audio_tx, audio_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept native client");
            let mut socket = accept(stream).expect("complete server handshake");
            let start = socket.read().expect("read session.start");
            assert!(start.is_text());
            assert!(start.to_text().expect("session.start text").contains("session.start"));
            let audio = socket.read().expect("read synthetic PCM");
            let Message::Binary(bytes) = audio else {
                panic!("expected binary PCM frame");
            };
            audio_tx.send(bytes.to_vec()).expect("report PCM bytes");
            socket
                .send(Message::Text(
                    r#"{"version":1,"type":"turn.partial","session_id":"synthetic-session","turn_session_id":1,"turn_id":1,"revision":1,"output_sequence":1,"segment_id":1,"text":"音声からの字幕","source_language":"ja"}"#
                        .into(),
                ))
                .expect("send synthetic transcript");
            socket.close(None).expect("close synthetic sidecar");
        });

        let mut client = NonblockingParapper::connect_to(port, "native-test-session".to_string())
            .expect("connect native transport");
        let pcm = i16_to_le_bytes(&[0, 1_000, -1_000, i16::MAX]);
        client.send_pcm16(&pcm).expect("send synthetic PCM");
        assert_eq!(
            audio_rx.recv_timeout(Duration::from_secs(2)).expect("server received PCM"),
            vec![0, 0, 232, 3, 24, 252, 255, 127]
        );

        let (event_tx, event_rx) = mpsc::channel();
        let mut caption_session = CaptionSessionLike::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut snapshot = CaptureSnapshot::default();
        while Instant::now() < deadline && snapshot.source_text.is_empty() {
            drain_parapper(&mut client, &mut caption_session, &event_tx)
                .expect("drain synthetic transcript");
            while let Ok(event) = event_rx.try_recv() {
                snapshot.apply_worker_event(event);
            }
            thread::yield_now();
        }

        server.join().expect("synthetic sidecar thread");
        assert_eq!(snapshot.source_text, "音声からの字幕");
        assert_eq!(snapshot.displayed_source_text(), "音声からの字幕");
    }
}
