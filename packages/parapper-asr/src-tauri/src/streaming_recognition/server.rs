use std::{
    collections::HashMap,
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, TryRecvError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use tauri::AppHandle;
use tungstenite::{
    Message, WebSocket,
    handshake::server::{ErrorResponse, Request, Response},
    http::StatusCode,
};
use uuid::Uuid;

use super::{
    backend::{
        AppRecognitionBackend, BackendStartError, NetworkOutputMode, RecognitionBackend,
        StartedRecognitionSession,
    },
    protocol::{
        ErrorCode, PROTOCOL_VERSION, ProtocolAction, ProtocolError, ServerMessage, SessionProtocol,
    },
};
#[cfg(any(test, feature = "smoke-server"))]
use crate::delivery::RecognizedTextOutput;
use crate::{
    audio::ASR_SAMPLE_RATE,
    config::AsrLanguage,
    recognition::{
        BoundedInputSendError, BoundedInputSender, RecognitionShutdownResult,
        RecognitionStreamEvent, RunningInputSource,
    },
};

const READ_POLL_INTERVAL: Duration = Duration::from_millis(20);
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const CLOSE_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_QUEUED_AUDIO_SAMPLES: usize = ASR_SAMPLE_RATE as usize * 2;
const MAX_CORRELATION_VALUE_CHARS: usize = 256;
const RECOGNITION_PATH: &str = "/ws/recognition";

#[derive(Debug, Clone, PartialEq, Eq)]
#[expect(clippy::struct_field_names, reason = "wire correlation fields use the shared *_id schema")]
struct ConnectionCorrelation {
    request_id: String,
    session_id: Option<String>,
    agent_id: Option<String>,
    parent_agent_id: Option<String>,
}

impl ConnectionCorrelation {
    fn from_request(request: &Request) -> Self {
        Self {
            request_id: header_value(request, "x-request-id")
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            session_id: header_value(request, "x-session-id"),
            agent_id: header_value(request, "x-agent-id"),
            parent_agent_id: header_value(request, "x-parent-agent-id"),
        }
    }

    fn for_session(&self, session_id: &str) -> Self {
        Self {
            session_id: self.session_id.clone().or_else(|| Some(session_id.to_string())),
            ..self.clone()
        }
    }
}

fn header_value(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().chars().take(MAX_CORRELATION_VALUE_CHARS).collect::<String>())
        .filter(|value| !value.is_empty())
}

fn request_start_event(
    correlation: &ConnectionCorrelation,
    peer: Option<SocketAddr>,
) -> serde_json::Value {
    serde_json::json!({
        "event": "http_request_start",
        "request_id": correlation.request_id,
        "session_id": correlation.session_id,
        "agent_id": correlation.agent_id,
        "parent_agent_id": correlation.parent_agent_id,
        "method": "GET",
        "path": RECOGNITION_PATH,
        "peer": peer,
        "outcome": "started",
    })
}

fn request_end_event(
    correlation: &ConnectionCorrelation,
    peer: Option<SocketAddr>,
    status: Option<u16>,
    reason: &str,
    elapsed: Duration,
) -> serde_json::Value {
    let failed = status.is_none_or(|status| status >= 400)
        || !matches!(reason, "done" | "cancelled" | "client_disconnected");
    serde_json::json!({
        "event": "http_request_end",
        "request_id": correlation.request_id,
        "session_id": correlation.session_id,
        "agent_id": correlation.agent_id,
        "parent_agent_id": correlation.parent_agent_id,
        "method": "GET",
        "path": RECOGNITION_PATH,
        "peer": peer,
        "status": status,
        "outcome": if failed { "failed" } else { "completed" },
        "reason": reason,
        "duration_ms": u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
    })
}

fn connection_event(
    event: &str,
    correlation: &ConnectionCorrelation,
    peer: Option<SocketAddr>,
) -> serde_json::Value {
    serde_json::json!({
        "event": event,
        "request_id": correlation.request_id,
        "session_id": correlation.session_id,
        "agent_id": correlation.agent_id,
        "parent_agent_id": correlation.parent_agent_id,
        "path": RECOGNITION_PATH,
        "peer": peer,
    })
}

#[derive(Debug, Clone)]
pub(crate) struct StreamingRecognitionServerConfig {
    pub(crate) bind_addr: SocketAddr,
    pub(crate) api_key: Option<String>,
    pub(crate) output_mode: NetworkOutputMode,
}

pub(crate) struct StreamingRecognitionServer {
    local_addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl StreamingRecognitionServer {
    pub(crate) fn start(
        handle: AppHandle,
        config: StreamingRecognitionServerConfig,
    ) -> Result<Self> {
        Self::start_with_backend(config, AppRecognitionBackend::new(handle))
    }

    fn start_with_backend(
        config: StreamingRecognitionServerConfig,
        backend: Arc<dyn RecognitionBackend>,
    ) -> Result<Self> {
        let listener = TcpListener::bind(config.bind_addr)
            .with_context(|| format!("failed to bind {}", config.bind_addr))?;
        listener
            .set_nonblocking(true)
            .context("failed to configure nonblocking recognition listener")?;
        let local_addr = listener.local_addr()?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = shutdown.clone();
        let join_handle = thread::Builder::new()
            .name("parapper-streaming-recognition-server".to_string())
            .spawn(move || run_accept_loop(&listener, &config, &backend, &worker_shutdown))
            .context("failed to spawn streaming recognition listener")?;
        Ok(Self { local_addr, shutdown, join_handle: Some(join_handle) })
    }

    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub(crate) fn stop(mut self) {
        self.stop_inner();
    }

    fn stop_inner(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        if let Some(join_handle) = self.join_handle.take()
            && let Err(error) = join_handle.join()
        {
            log::warn!("Streaming recognition server thread panicked: {error:?}");
        }
    }
}

impl Drop for StreamingRecognitionServer {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

fn run_accept_loop(
    listener: &TcpListener,
    config: &StreamingRecognitionServerConfig,
    backend: &Arc<dyn RecognitionBackend>,
    shutdown: &Arc<AtomicBool>,
) {
    let mut connections = Vec::new();
    while !shutdown.load(Ordering::Acquire) {
        reap_finished_connections(&mut connections);
        match listener.accept() {
            Ok((stream, _)) => {
                let connection_config = config.clone();
                let connection_backend = backend.clone();
                let connection_shutdown = shutdown.clone();
                match thread::Builder::new()
                    .name("parapper-streaming-recognition-connection".to_string())
                    .spawn(move || {
                        handle_connection(
                            stream,
                            &connection_config,
                            &connection_backend,
                            &connection_shutdown,
                        );
                    }) {
                    Ok(handle) => connections.push(handle),
                    Err(error) => log::warn!("Failed to spawn recognition connection: {error}"),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(error) => {
                log::warn!("Streaming recognition accept failed: {error}");
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
        }
    }
    for connection in connections {
        join_connection(connection);
    }
}

fn reap_finished_connections(connections: &mut Vec<JoinHandle<()>>) {
    let mut index = 0;
    while index < connections.len() {
        if connections[index].is_finished() {
            join_connection(connections.swap_remove(index));
        } else {
            index += 1;
        }
    }
}

fn join_connection(connection: JoinHandle<()>) {
    if let Err(error) = connection.join() {
        log::warn!("Streaming recognition connection thread panicked: {error:?}");
    }
}

#[allow(clippy::result_large_err)]
fn handle_connection(
    stream: TcpStream,
    config: &StreamingRecognitionServerConfig,
    backend: &Arc<dyn RecognitionBackend>,
    shutdown: &AtomicBool,
) {
    if stream.set_nonblocking(false).is_err()
        || stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(WRITE_TIMEOUT)).is_err()
    {
        return;
    }
    let peer = stream.peer_addr().ok();
    let request_started = Instant::now();
    let api_key = config.api_key.clone();
    let handshake_correlation = Arc::new(std::sync::Mutex::new(None));
    let rejection_status = Arc::new(std::sync::Mutex::new(None));
    let callback_correlation = handshake_correlation.clone();
    let callback_rejection_status = rejection_status.clone();
    let mut websocket = match tungstenite::accept_hdr(stream, move |request: &Request, response| {
        let candidate = ConnectionCorrelation::from_request(request);
        log::info!("{}", request_start_event(&candidate, peer));
        *callback_correlation.lock().expect("handshake correlation lock") = Some(candidate);
        let result = validate_upgrade(request, response, api_key.as_deref());
        if let Err(error) = &result {
            *callback_rejection_status.lock().expect("rejection status lock") =
                Some(error.status());
        }
        result
    }) {
        Ok(websocket) => websocket,
        Err(error) => {
            let correlation = handshake_correlation
                .lock()
                .expect("handshake correlation lock")
                .clone()
                .unwrap_or_else(|| ConnectionCorrelation {
                    request_id: Uuid::new_v4().to_string(),
                    session_id: None,
                    agent_id: None,
                    parent_agent_id: None,
                });
            let status = rejection_status
                .lock()
                .expect("rejection status lock")
                .map(|status| status.as_u16());
            log::debug!("Streaming recognition upgrade rejected: {error}");
            log::info!(
                "{}",
                request_end_event(
                    &correlation,
                    peer,
                    status,
                    "upgrade_rejected",
                    request_started.elapsed(),
                )
            );
            return;
        }
    };
    let correlation =
        handshake_correlation.lock().expect("handshake correlation lock").clone().unwrap_or_else(
            || ConnectionCorrelation {
                request_id: Uuid::new_v4().to_string(),
                session_id: None,
                agent_id: None,
                parent_agent_id: None,
            },
        );
    if websocket.get_ref().set_read_timeout(Some(READ_POLL_INTERVAL)).is_err() {
        log::info!(
            "{}",
            request_end_event(
                &correlation,
                peer,
                None,
                "socket_setup_failed",
                request_started.elapsed(),
            )
        );
        return;
    }
    log::info!("{}", connection_event("recognition_connection_start", &correlation, peer));
    let (reason, session_id) =
        run_session(&mut websocket, config.output_mode, backend, shutdown, peer, &correlation);
    finish_close_handshake(&mut websocket);
    log::info!("{}", connection_event("recognition_connection_end", &correlation, peer));
    let correlation = session_id
        .as_deref()
        .map(|session_id| correlation.for_session(session_id))
        .unwrap_or(correlation);
    log::info!(
        "{}",
        request_end_event(&correlation, peer, Some(101), reason, request_started.elapsed(),)
    );
}

fn finish_close_handshake(websocket: &mut WebSocket<TcpStream>) {
    let _ = websocket.close(None);
    let _ = websocket.get_ref().set_read_timeout(Some(CLOSE_DRAIN_TIMEOUT));
    loop {
        match websocket.read() {
            Ok(Message::Close(_))
            | Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                break;
            }
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                break;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

#[expect(
    clippy::result_large_err,
    reason = "tungstenite callback requires this response error type"
)]
fn validate_upgrade(
    request: &Request,
    response: Response,
    api_key: Option<&str>,
) -> Result<Response, ErrorResponse> {
    if request.uri().path() != "/ws/recognition" {
        return Err(http_error(StatusCode::NOT_FOUND, "WebSocket endpoint not found"));
    }
    if let Some(api_key) = api_key {
        let authorized = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            == Some(api_key);
        if !authorized {
            return Err(http_error(StatusCode::UNAUTHORIZED, "Invalid or missing API key"));
        }
    }
    Ok(response)
}

fn http_error(status: StatusCode, message: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_string()));
    *response.status_mut() = status;
    response
}

struct ActiveConnectionSession {
    session_id: String,
    input_sender: Option<BoundedInputSender>,
    recognition: StartedRecognitionSession,
    drain_receiver: Option<Receiver<RecognitionShutdownResult>>,
    drain_join: Option<JoinHandle<()>>,
    /// Last protocol cursor emitted for each logical turn.  Recognition work
    /// is asynchronous, so a stale interim can otherwise arrive after the
    /// final and make clients regress their caption.
    emitted_outputs: HashMap<(u64, u64), EmittedOutputCursor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EmittedOutputCursor {
    revision: u64,
    output_sequence: u64,
    segment_id: u64,
    is_final: bool,
}

fn output_cursor(
    output: &crate::recognition::control::input::RecognitionStreamOutput,
) -> ((u64, u64), EmittedOutputCursor) {
    let source = &output.output.meta.source;
    (
        (source.turn_session_id, source.turn_id),
        EmittedOutputCursor {
            revision: source.turn_revision,
            output_sequence: source.output_sequence,
            segment_id: source.segment_id,
            is_final: output.output.meta.is_final,
        },
    )
}

fn compare_output_cursor(
    candidate: EmittedOutputCursor,
    current: EmittedOutputCursor,
) -> std::cmp::Ordering {
    candidate
        .revision
        .cmp(&current.revision)
        .then_with(|| candidate.output_sequence.cmp(&current.output_sequence))
        .then_with(|| candidate.segment_id.cmp(&current.segment_id))
}

/// Return whether an output should be sent to the protocol client and record
/// it when accepted.  A final at the same turn cursor upgrades a partial, but
/// an older/equal partial can never reopen a finalized turn.
fn accept_output(
    emitted: &mut HashMap<(u64, u64), EmittedOutputCursor>,
    output: &crate::recognition::control::input::RecognitionStreamOutput,
) -> bool {
    let (key, candidate) = output_cursor(output);
    let Some(current) = emitted.get(&key).copied() else {
        emitted.insert(key, candidate);
        return true;
    };
    if current.is_final && !candidate.is_final {
        return false;
    }
    let ordering = compare_output_cursor(candidate, current);
    let accepted =
        ordering.is_gt() || (ordering.is_eq() && candidate.is_final && !current.is_final);
    if accepted {
        emitted.insert(key, candidate);
    }
    accepted
}

fn run_session(
    websocket: &mut WebSocket<TcpStream>,
    output_mode: NetworkOutputMode,
    backend: &Arc<dyn RecognitionBackend>,
    shutdown: &AtomicBool,
    peer: Option<SocketAddr>,
    correlation: &ConnectionCorrelation,
) -> (&'static str, Option<String>) {
    let started = Instant::now();
    let result = run_session_loop(websocket, output_mode, backend, shutdown, peer, correlation);
    if let Some(session_id) = result.1.as_deref() {
        let session_correlation = correlation.for_session(session_id);
        log::info!(
            "{}",
            session_end_event(&session_correlation, peer, result.0, started.elapsed())
        );
    }
    result
}

#[expect(clippy::too_many_lines, reason = "protocol event loop keeps state transitions together")]
fn run_session_loop(
    websocket: &mut WebSocket<TcpStream>,
    output_mode: NetworkOutputMode,
    backend: &Arc<dyn RecognitionBackend>,
    shutdown: &AtomicBool,
    peer: Option<SocketAddr>,
    correlation: &ConnectionCorrelation,
) -> (&'static str, Option<String>) {
    let mut protocol = SessionProtocol::new();
    let mut active: Option<ActiveConnectionSession> = None;
    let mut logged_session_id: Option<String> = None;

    loop {
        if let Some(session) = active.as_mut()
            && send_pending_events(websocket, session, correlation).is_err()
        {
            cancel_recognition_in_background(session);
            return ("send_failed", logged_session_id);
        }
        if let Some(result) = active.as_mut().and_then(poll_drain_result) {
            let mut session = active.take().expect("polled active session");
            join_drain_thread(&mut session);
            if send_pending_events(websocket, &mut session, correlation).is_err() {
                return ("send_failed", logged_session_id);
            }
            let reason = match result {
                RecognitionShutdownResult::Completed => {
                    if protocol.mark_done().is_err() {
                        return ("protocol_error", logged_session_id);
                    }
                    let _ = send_message(
                        websocket,
                        &ServerMessage::SessionDone {
                            version: PROTOCOL_VERSION,
                            session_id: session.session_id,
                        },
                    );
                    "done"
                }
                RecognitionShutdownResult::TimedOut => {
                    let _ = send_message(
                        websocket,
                        &ServerMessage::error(
                            Some(&session.session_id),
                            ErrorCode::DrainTimeout,
                            "recognition drain exceeded its time limit",
                        ),
                    );
                    "drain_timeout"
                }
                RecognitionShutdownResult::Cancelled => {
                    let _ = send_message(
                        websocket,
                        &ServerMessage::error(
                            Some(&session.session_id),
                            ErrorCode::RecognitionFailed,
                            "recognition drain was cancelled",
                        ),
                    );
                    "drain_cancelled"
                }
            };
            return (reason, logged_session_id);
        }
        if shutdown.load(Ordering::Acquire) {
            if let Some(session) = active.as_mut() {
                session.input_sender.take();
                if let Some(mut active_recognition) = session.recognition.active.take() {
                    active_recognition.cancel();
                }
                join_drain_thread(session);
                let _ = send_pending_events(websocket, session, correlation);
                let _ = send_message(
                    websocket,
                    &ServerMessage::error(
                        Some(&session.session_id),
                        ErrorCode::ServerStopping,
                        "Parapper is stopping",
                    ),
                );
            }
            return ("server_stopping", logged_session_id);
        }

        match websocket.read() {
            Ok(Message::Text(text)) => {
                let action = match protocol.on_text(text.as_str()) {
                    Ok(action) => action,
                    Err(error) => {
                        send_protocol_error(websocket, active.as_ref(), &error);
                        cancel_active(&mut active);
                        return ("protocol_error", logged_session_id);
                    }
                };
                match action {
                    ProtocolAction::Start { session_id, audio, partial_window_asr_enabled } => {
                        logged_session_id = Some(session_id.clone());
                        let session_correlation = correlation.for_session(&session_id);
                        let (input_sender, source) = RunningInputSource::bounded_channel(
                            audio.sample_rate,
                            MAX_QUEUED_AUDIO_SAMPLES,
                        );
                        match backend.start(
                            &session_id,
                            source,
                            output_mode,
                            partial_window_asr_enabled,
                        ) {
                            Ok(recognition) => {
                                active = Some(ActiveConnectionSession {
                                    session_id: session_id.clone(),
                                    input_sender: Some(input_sender),
                                    recognition,
                                    drain_receiver: None,
                                    drain_join: None,
                                    emitted_outputs: HashMap::new(),
                                });
                                log::info!("{}", session_start_event(&session_correlation, peer));
                                if send_message(websocket, &ServerMessage::ready(&session_id))
                                    .is_err()
                                {
                                    cancel_active(&mut active);
                                    return ("send_failed", logged_session_id);
                                }
                            }
                            Err(error) => {
                                let (code, message) = backend_error(error);
                                let _ = send_message(
                                    websocket,
                                    &ServerMessage::error(Some(&session_id), code, message),
                                );
                                return ("start_failed", logged_session_id);
                            }
                        }
                    }
                    ProtocolAction::GracefulStop => {
                        if let Some(session) = active.as_mut() {
                            session.input_sender.take();
                            begin_graceful_stop(session);
                        }
                    }
                    ProtocolAction::Cancel => {
                        if let Some(mut session) = active.take() {
                            session.input_sender.take();
                            cancel_recognition_in_background(&mut session);
                            let _ = send_message(
                                websocket,
                                &ServerMessage::SessionCancelled {
                                    version: PROTOCOL_VERSION,
                                    session_id: session.session_id,
                                },
                            );
                        }
                        return ("cancelled", logged_session_id);
                    }
                    ProtocolAction::Pong { request_id } => {
                        if send_message(
                            websocket,
                            &ServerMessage::Pong { version: PROTOCOL_VERSION, request_id },
                        )
                        .is_err()
                        {
                            cancel_active(&mut active);
                            return ("send_failed", logged_session_id);
                        }
                    }
                    ProtocolAction::Audio { .. } => {}
                    #[cfg(test)]
                    ProtocolAction::None => {}
                }
            }
            Ok(Message::Binary(bytes)) => {
                if let Err(error) = protocol.on_binary(bytes.len()) {
                    send_protocol_error(websocket, active.as_ref(), &error);
                    cancel_active(&mut active);
                    return ("protocol_error", logged_session_id);
                }
                let Some(session) = active.as_ref() else {
                    return ("connection_error", logged_session_id);
                };
                let Some(input_sender) = session.input_sender.as_ref() else {
                    return ("connection_error", logged_session_id);
                };
                match input_sender.try_send(pcm_s16le_to_f32(&bytes)) {
                    Ok(()) => {}
                    Err(BoundedInputSendError::Overrun) => {
                        let _ = send_message(
                            websocket,
                            &ServerMessage::error(
                                Some(&session.session_id),
                                ErrorCode::AudioQueueOverrun,
                                "audio input exceeded the processing queue limit",
                            ),
                        );
                        cancel_active(&mut active);
                        return ("audio_queue_overrun", logged_session_id);
                    }
                    Err(BoundedInputSendError::Disconnected) => {
                        let _ = send_message(
                            websocket,
                            &ServerMessage::error(
                                Some(&session.session_id),
                                ErrorCode::RecognitionFailed,
                                "recognition input worker disconnected",
                            ),
                        );
                        cancel_active(&mut active);
                        return ("input_disconnected", logged_session_id);
                    }
                }
            }
            Ok(Message::Close(_))
            | Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                cancel_active(&mut active);
                return ("client_disconnected", logged_session_id);
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(_) => {
                cancel_active(&mut active);
                return ("connection_error", logged_session_id);
            }
        }
    }
}

fn backend_error(error: BackendStartError) -> (ErrorCode, &'static str) {
    match error {
        BackendStartError::Busy => {
            (ErrorCode::RecognitionBusy, "another recognition session is active")
        }
        BackendStartError::ModelUnavailable => {
            (ErrorCode::ModelUnavailable, "recognition model is unavailable")
        }
    }
}

fn cancel_active(active: &mut Option<ActiveConnectionSession>) {
    if let Some(mut session) = active.take() {
        session.input_sender.take();
        cancel_recognition_in_background(&mut session);
    }
}

fn cancel_recognition_in_background(session: &mut ActiveConnectionSession) {
    let Some(mut active) = session.recognition.active.take() else {
        return;
    };
    if let Err(error) = thread::Builder::new()
        .name("parapper-recognition-cancel".to_string())
        .spawn(move || active.cancel())
    {
        log::warn!("Failed to spawn recognition cancellation: {error}");
    }
}

fn begin_graceful_stop(session: &mut ActiveConnectionSession) {
    let Some(mut active) = session.recognition.active.take() else {
        return;
    };
    let (sender, receiver) = mpsc::channel();
    session.drain_receiver = Some(receiver);
    let spawn =
        thread::Builder::new().name("parapper-recognition-drain".to_string()).spawn(move || {
            let _ = sender.send(active.stop());
        });
    match spawn {
        Ok(handle) => session.drain_join = Some(handle),
        Err(error) => {
            log::warn!("Failed to spawn recognition drain: {error}");
            let (fallback_sender, fallback_receiver) = mpsc::channel();
            let _ = fallback_sender.send(RecognitionShutdownResult::Cancelled);
            session.drain_receiver = Some(fallback_receiver);
        }
    }
}

fn join_drain_thread(session: &mut ActiveConnectionSession) {
    if let Some(handle) = session.drain_join.take()
        && let Err(error) = handle.join()
    {
        log::warn!("Recognition drain thread panicked: {error:?}");
    }
}

fn poll_drain_result(session: &mut ActiveConnectionSession) -> Option<RecognitionShutdownResult> {
    let receiver = session.drain_receiver.as_ref()?;
    match receiver.try_recv() {
        Ok(result) => Some(result),
        Err(TryRecvError::Empty) => None,
        Err(TryRecvError::Disconnected) => Some(RecognitionShutdownResult::Cancelled),
    }
}

fn send_pending_events(
    websocket: &mut WebSocket<TcpStream>,
    session: &mut ActiveConnectionSession,
    correlation: &ConnectionCorrelation,
) -> Result<(), tungstenite::Error> {
    let session_correlation = correlation.for_session(&session.session_id);
    while let Ok(event) = session.recognition.event_receiver.try_recv() {
        match event {
            RecognitionStreamEvent::SpeechStarted => {
                log::info!("{}", turn_start_event(&session_correlation));
                send_message(
                    websocket,
                    &ServerMessage::SpeechStarted {
                        version: PROTOCOL_VERSION,
                        session_id: session.session_id.clone(),
                    },
                )?;
            }
            RecognitionStreamEvent::SegmentClosed { segment_id } => {
                send_message(
                    websocket,
                    &ServerMessage::SegmentClosed {
                        version: PROTOCOL_VERSION,
                        session_id: session.session_id.clone(),
                        segment_id,
                    },
                )?;
            }
            RecognitionStreamEvent::Output(output) => {
                if !accept_output(&mut session.emitted_outputs, &output) {
                    log::debug!("{}", turn_skip_event(&session_correlation, &output));
                    continue;
                }
                if output.output.meta.is_final {
                    log::info!("{}", turn_end_event(&session_correlation, &output));
                }
                send_message(websocket, &message_from_output(&session.session_id, output))?;
            }
            RecognitionStreamEvent::PartialWindow(output) => {
                // Partial-window hypotheses have their own output cursor and
                // are intentionally not fed through the canonical output
                // deduplicator.  A normal interim/final output may arrive for
                // the same segment without invalidating this side channel.
                send_message(
                    websocket,
                    &message_from_partial_window_output(&session.session_id, output),
                )?;
            }
        }
    }
    Ok(())
}

fn message_from_output(
    session_id: &str,
    stream_output: crate::recognition::control::input::RecognitionStreamOutput,
) -> ServerMessage {
    let crate::recognition::control::input::RecognitionStreamOutput {
        output,
        source_text,
        azookey_input_text,
    } = stream_output;
    let source = &output.meta.source;
    let source_asr_model = serde_json::to_value(output.source_asr_model)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    let source_language = source_language_code(output.source_language).to_string();
    let elapsed_ms = u64::try_from(output.elapsed_millis).unwrap_or(u64::MAX);
    let latency = output.caption_latency;
    if output.meta.is_final {
        let audio_duration_ms =
            u64::try_from(output.phrase.len()).unwrap_or(u64::MAX).saturating_mul(1_000)
                / u64::from(ASR_SAMPLE_RATE);
        ServerMessage::TurnFinal {
            version: PROTOCOL_VERSION,
            session_id: session_id.to_string(),
            turn_session_id: source.turn_session_id,
            turn_id: source.turn_id,
            revision: source.turn_revision,
            output_sequence: source.output_sequence,
            segment_id: source.segment_id,
            previous_segment_id: source.previous_segment_id,
            text: output.text,
            source_text,
            azookey_input_text,
            source_asr_model,
            source_language,
            detected_language: output.detected_language,
            audio_duration_ms,
            elapsed_ms,
            speech_start_at: latency.speech_start_at,
            asr_dispatch_at: latency.asr_dispatch_at,
            first_partial_at: latency.first_partial_at,
            asr_final_at: latency.asr_final_at,
        }
    } else {
        ServerMessage::TurnPartial {
            version: PROTOCOL_VERSION,
            session_id: session_id.to_string(),
            turn_session_id: source.turn_session_id,
            turn_id: source.turn_id,
            revision: source.turn_revision,
            output_sequence: source.output_sequence,
            segment_id: source.segment_id,
            previous_segment_id: source.previous_segment_id,
            text: output.text,
            source_text,
            azookey_input_text,
            source_asr_model,
            source_language,
            detected_language: output.detected_language,
            elapsed_ms,
            speech_start_at: latency.speech_start_at,
            asr_dispatch_at: latency.asr_dispatch_at,
            first_partial_at: latency.first_partial_at,
            asr_final_at: latency.asr_final_at,
        }
    }
}

fn message_from_partial_window_output(
    session_id: &str,
    stream_output: crate::recognition::control::input::RecognitionStreamOutput,
) -> ServerMessage {
    let crate::recognition::control::input::RecognitionStreamOutput {
        output,
        source_text,
        azookey_input_text,
    } = stream_output;
    let source = &output.meta.source;
    let source_asr_model = serde_json::to_value(output.source_asr_model)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    ServerMessage::TurnPartialWindow {
        version: PROTOCOL_VERSION,
        session_id: session_id.to_string(),
        turn_session_id: source.turn_session_id,
        turn_id: source.turn_id,
        revision: source.turn_revision,
        output_sequence: source.output_sequence,
        segment_id: source.segment_id,
        previous_segment_id: source.previous_segment_id,
        text: output.text,
        source_text,
        azookey_input_text,
        source_asr_model,
        source_language: source_language_code(output.source_language).to_string(),
        detected_language: output.detected_language,
        elapsed_ms: u64::try_from(output.elapsed_millis).unwrap_or(u64::MAX),
        speech_start_at: output.caption_latency.speech_start_at,
        asr_dispatch_at: output.caption_latency.asr_dispatch_at,
        first_partial_at: output.caption_latency.first_partial_at,
        asr_final_at: output.caption_latency.asr_final_at,
    }
}

fn source_language_code(language: AsrLanguage) -> &'static str {
    match language {
        AsrLanguage::Japanese => "ja",
        AsrLanguage::English => "en",
        AsrLanguage::EuropeanMultilingual | AsrLanguage::Multilingual => "mul",
    }
}

/// Structured JSON lifecycle payloads for operators. The logger prefix is
/// intentionally kept outside these values so tests and downstream adapters can
/// validate the event payload independently of the selected log target.
fn session_start_event(
    correlation: &ConnectionCorrelation,
    peer: Option<SocketAddr>,
) -> serde_json::Value {
    serde_json::json!({
        "event": "recognition_session_start",
        "request_id": correlation.request_id,
        "session_id": correlation.session_id,
        "agent_id": correlation.agent_id,
        "parent_agent_id": correlation.parent_agent_id,
        "peer": peer,
    })
}

fn session_end_event(
    correlation: &ConnectionCorrelation,
    peer: Option<SocketAddr>,
    reason: &str,
    elapsed: Duration,
) -> serde_json::Value {
    serde_json::json!({
        "event": "recognition_session_end",
        "request_id": correlation.request_id,
        "session_id": correlation.session_id,
        "agent_id": correlation.agent_id,
        "parent_agent_id": correlation.parent_agent_id,
        "peer": peer,
        "reason": reason,
        "elapsed_ms": u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
    })
}

fn turn_start_event(correlation: &ConnectionCorrelation) -> serde_json::Value {
    serde_json::json!({
        "event": "recognition_turn_start",
        "request_id": correlation.request_id,
        "session_id": correlation.session_id,
        "agent_id": correlation.agent_id,
        "parent_agent_id": correlation.parent_agent_id,
    })
}

fn turn_end_event(
    correlation: &ConnectionCorrelation,
    stream_output: &crate::recognition::control::input::RecognitionStreamOutput,
) -> serde_json::Value {
    let source = &stream_output.output.meta.source;
    let audio_duration_ms =
        u64::try_from(stream_output.output.phrase.len()).unwrap_or(u64::MAX).saturating_mul(1_000)
            / u64::from(ASR_SAMPLE_RATE);
    serde_json::json!({
        "event": "recognition_turn_end",
        "request_id": correlation.request_id,
        "session_id": correlation.session_id,
        "agent_id": correlation.agent_id,
        "parent_agent_id": correlation.parent_agent_id,
        "turn_session_id": source.turn_session_id,
        "turn_id": source.turn_id,
        "revision": source.turn_revision,
        "output_sequence": source.output_sequence,
        "segment_id": source.segment_id,
        "previous_segment_id": source.previous_segment_id,
        "audio_duration_ms": audio_duration_ms,
        "elapsed_ms": u64::try_from(stream_output.output.elapsed_millis).unwrap_or(u64::MAX),
    })
}

fn turn_skip_event(
    correlation: &ConnectionCorrelation,
    stream_output: &crate::recognition::control::input::RecognitionStreamOutput,
) -> serde_json::Value {
    let source = &stream_output.output.meta.source;
    serde_json::json!({
        "event": "recognition_turn_skip",
        "request_id": correlation.request_id,
        "session_id": correlation.session_id,
        "agent_id": correlation.agent_id,
        "parent_agent_id": correlation.parent_agent_id,
        "turn_session_id": source.turn_session_id,
        "turn_id": source.turn_id,
        "revision": source.turn_revision,
        "output_sequence": source.output_sequence,
        "segment_id": source.segment_id,
        "is_final": stream_output.output.meta.is_final,
        "reason": "stale_output",
    })
}

fn send_protocol_error(
    websocket: &mut WebSocket<TcpStream>,
    active: Option<&ActiveConnectionSession>,
    error: &ProtocolError,
) {
    let _ = send_message(
        websocket,
        &ServerMessage::error(
            active.map(|session| session.session_id.as_str()),
            error.code,
            error.message.clone(),
        ),
    );
}

fn send_message(
    websocket: &mut WebSocket<TcpStream>,
    message: &ServerMessage,
) -> Result<(), tungstenite::Error> {
    let text = serde_json::to_string(message).unwrap_or_else(|_| {
        r#"{"version":1,"type":"error","session_id":null,"code":"recognition_failed","message":"response serialization failed","fatal":true}"#.to_string()
    });
    websocket.send(Message::Text(text.into()))
}

fn pcm_s16le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32_768.0)
        .collect()
}

/// Deterministic recognition double used by unit tests and by the
/// `smoke-server` feature's standalone diagnostics process
/// (`diagnostics/src/bin/streaming_recognition_smoke_server.rs`,
/// driven by the Python `parapper_client` end-to-end test). No ASR model is
/// loaded: the first audio chunk in a session produces `speech.started` plus
/// one fixed `turn.partial`, and a graceful stop produces one fixed
/// `turn.final`; cancel produces neither.
#[cfg(any(test, feature = "smoke-server"))]
pub(crate) struct FakeBackend {
    active: Arc<AtomicBool>,
    starts: std::sync::atomic::AtomicUsize,
    drain_input: bool,
    stop_delay: Duration,
    stop_result: RecognitionShutdownResult,
}

#[cfg(any(test, feature = "smoke-server"))]
impl FakeBackend {
    pub(crate) fn new(drain_input: bool) -> Arc<Self> {
        Arc::new(Self {
            active: Arc::new(AtomicBool::new(false)),
            starts: std::sync::atomic::AtomicUsize::new(0),
            drain_input,
            stop_delay: Duration::ZERO,
            stop_result: RecognitionShutdownResult::Completed,
        })
    }

    #[cfg(test)]
    fn with_stop(
        drain_input: bool,
        stop_delay: Duration,
        stop_result: RecognitionShutdownResult,
    ) -> Arc<Self> {
        Arc::new(Self {
            active: Arc::new(AtomicBool::new(false)),
            starts: std::sync::atomic::AtomicUsize::new(0),
            drain_input,
            stop_delay,
            stop_result,
        })
    }
}

#[cfg(any(test, feature = "smoke-server"))]
impl RecognitionBackend for FakeBackend {
    fn start(
        &self,
        _session_id: &str,
        source: RunningInputSource,
        _output_mode: NetworkOutputMode,
        _partial_window_asr_enabled: bool,
    ) -> Result<StartedRecognitionSession, BackendStartError> {
        if self.active.swap(true, Ordering::AcqRel) {
            return Err(BackendStartError::Busy);
        }
        self.starts.fetch_add(1, Ordering::AcqRel);
        let parts = source.into_parts();
        let (event_sender, event_receiver) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let worker_cancel = cancel.clone();
        let active = self.active.clone();
        let drain_input = self.drain_input;
        let join = thread::spawn(move || {
            let _lifetime = parts.lifetime;
            let mut voiced = false;
            while !worker_stop.load(Ordering::Acquire) {
                if !drain_input {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                match parts.receiver.recv_timeout(Duration::from_millis(2)) {
                    Ok(_chunk) if !voiced => {
                        voiced = true;
                        let _ = event_sender.send(RecognitionStreamEvent::SpeechStarted);
                        let _ = event_sender.send(RecognitionStreamEvent::Output(
                            crate::recognition::control::input::RecognitionStreamOutput::surface(
                                recognized_output(false),
                            ),
                        ));
                    }
                    Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            if !worker_cancel.load(Ordering::Acquire) {
                let _ = event_sender.send(RecognitionStreamEvent::Output(
                    crate::recognition::control::input::RecognitionStreamOutput::surface(
                        recognized_output(true),
                    ),
                ));
            }
            active.store(false, Ordering::Release);
        });
        Ok(StartedRecognitionSession {
            active: Some(Box::new(FakeActiveSession {
                stop,
                cancel,
                join: std::sync::Mutex::new(Some(join)),
                stop_delay: self.stop_delay,
                stop_result: self.stop_result,
            })),
            event_receiver,
        })
    }
}

#[cfg(any(test, feature = "smoke-server"))]
struct FakeActiveSession {
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    join: std::sync::Mutex<Option<JoinHandle<()>>>,
    stop_delay: Duration,
    stop_result: RecognitionShutdownResult,
}

#[cfg(any(test, feature = "smoke-server"))]
impl FakeActiveSession {
    fn finish(&self, cancel: bool) {
        self.cancel.store(cancel, Ordering::Release);
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.lock().unwrap().take() {
            let _ = join.join();
        }
    }
}

#[cfg(any(test, feature = "smoke-server"))]
impl crate::streaming_recognition::backend::ActiveRecognitionSession for FakeActiveSession {
    fn stop(&mut self) -> RecognitionShutdownResult {
        thread::sleep(self.stop_delay);
        self.finish(false);
        self.stop_result
    }

    fn cancel(&mut self) {
        thread::sleep(self.stop_delay);
        self.finish(true);
    }
}

#[cfg(any(test, feature = "smoke-server"))]
fn recognized_output(is_final: bool) -> RecognizedTextOutput {
    use crate::{
        config::{AsrLanguage, AsrModel},
        delivery::RecognizedTextMeta,
        recognition::control::events::RecognitionSourceMeta,
    };

    RecognizedTextOutput::new(
        vec![0.0; 20_480],
        "こんにちは。".to_string(),
        AsrModel::ReazonSpeechK2V2,
        AsrLanguage::Japanese,
        None,
        RecognizedTextMeta::replace_turn_output(
            "turn-3".to_string(),
            RecognitionSourceMeta {
                turn_session_id: 7,
                turn_id: 3,
                turn_revision: 2,
                output_sequence: 1,
                segment_id: 8,
                previous_segment_id: Some(7),
            },
            is_final,
        ),
        96,
    )
}

/// Starts a `/ws/recognition` listener backed by [`FakeBackend`]. Only
/// compiled with the `smoke-server` feature (off by default); never part of
/// the shipped application. See [`crate::smoke_server`].
#[cfg(feature = "smoke-server")]
impl StreamingRecognitionServer {
    pub(crate) fn start_smoke(bind_addr: SocketAddr, api_key: Option<String>) -> Result<Self> {
        Self::start_with_backend(
            StreamingRecognitionServerConfig {
                bind_addr,
                api_key,
                output_mode: NetworkOutputMode::WebSocketOnly,
            },
            FakeBackend::new(true),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use serde_json::{Value, json};
    use tungstenite::{Error, client::IntoClientRequest, connect, http::HeaderValue};

    use super::*;
    use crate::recognition::control::input::RecognitionStreamOutput;
    use crate::streaming_recognition::backend::ActiveRecognitionSession;
    use crate::streaming_recognition::protocol::MAX_AUDIO_FRAME_BYTES;

    fn start_test_server(
        backend: Arc<dyn RecognitionBackend>,
        api_key: Option<&str>,
    ) -> StreamingRecognitionServer {
        StreamingRecognitionServer::start_with_backend(
            StreamingRecognitionServerConfig {
                bind_addr: "127.0.0.1:0".parse().unwrap(),
                api_key: api_key.map(str::to_string),
                output_mode: NetworkOutputMode::WebSocketOnly,
            },
            backend,
        )
        .unwrap()
    }

    fn server_url(server: &StreamingRecognitionServer) -> String {
        format!("ws://{}/ws/recognition", server.local_addr())
    }

    fn start_message(session_id: &str) -> Message {
        Message::Text(
            format!(
                r#"{{"version":1,"type":"session.start","session_id":"{session_id}","audio":{{"encoding":"pcm_s16le","sample_rate":16000,"channels":1}}}}"#
            )
            .into(),
        )
    }

    fn read_json(
        socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
    ) -> Value {
        serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap()
    }

    #[test]
    fn protocol_cursor_keeps_same_turn_final_and_rejects_late_partial() {
        let mut emitted = HashMap::new();
        let partial = RecognitionStreamOutput {
            output: recognized_output(false),
            source_text: None,
            azookey_input_text: None,
        };
        let final_output = RecognitionStreamOutput {
            output: recognized_output(true),
            source_text: None,
            azookey_input_text: None,
        };

        assert!(accept_output(&mut emitted, &partial));
        assert!(accept_output(&mut emitted, &final_output));
        assert!(!accept_output(&mut emitted, &partial));
        assert!(!accept_output(&mut emitted, &final_output));
    }

    #[test]
    fn protocol_cursor_orders_revision_before_sequence_and_segment() {
        let mut emitted = HashMap::new();
        let make_output = |is_final: bool, revision: u64, output_sequence: u64| {
            let mut output = recognized_output(is_final);
            output.meta.source.turn_revision = revision;
            output.meta.source.output_sequence = output_sequence;
            RecognitionStreamOutput { output, source_text: None, azookey_input_text: None }
        };

        assert!(accept_output(&mut emitted, &make_output(false, 1, 5)));
        // A numerically larger sequence from an older revision is stale.
        assert!(!accept_output(&mut emitted, &make_output(false, 0, 99)));
        assert!(accept_output(&mut emitted, &make_output(false, 2, 1)));
        assert!(accept_output(&mut emitted, &make_output(true, 2, 2)));
        assert!(!accept_output(&mut emitted, &make_output(false, 2, 1)));
    }

    #[test]
    fn session_lifecycle_log_events_are_json_with_correlation_ids() {
        let peer: SocketAddr = "127.0.0.1:53012".parse().unwrap();
        let correlation = ConnectionCorrelation {
            request_id: "request-1".to_string(),
            session_id: Some("session-1".to_string()),
            agent_id: Some("agent-1".to_string()),
            parent_agent_id: Some("parent-1".to_string()),
        };
        assert_eq!(
            request_start_event(&correlation, Some(peer)),
            json!({
                "event": "http_request_start",
                "request_id": "request-1",
                "session_id": "session-1",
                "agent_id": "agent-1",
                "parent_agent_id": "parent-1",
                "method": "GET",
                "path": "/ws/recognition",
                "peer": "127.0.0.1:53012",
                "outcome": "started",
            })
        );
        assert_eq!(
            session_start_event(&correlation, Some(peer)),
            json!({
                "event": "recognition_session_start",
                "request_id": "request-1",
                "session_id": "session-1",
                "agent_id": "agent-1",
                "parent_agent_id": "parent-1",
                "peer": "127.0.0.1:53012",
            })
        );
        assert_eq!(
            turn_start_event(&correlation),
            json!({
                "event": "recognition_turn_start",
                "request_id": "request-1",
                "session_id": "session-1",
                "agent_id": "agent-1",
                "parent_agent_id": "parent-1",
            })
        );
        assert_eq!(
            session_end_event(&correlation, None, "done", Duration::from_millis(1_234)),
            json!({
                "event": "recognition_session_end",
                "request_id": "request-1",
                "session_id": "session-1",
                "agent_id": "agent-1",
                "parent_agent_id": "parent-1",
                "peer": null,
                "reason": "done",
                "elapsed_ms": 1_234,
            })
        );
        assert_eq!(
            request_end_event(
                &correlation,
                Some(peer),
                Some(101),
                "done",
                Duration::from_millis(1_234),
            )["outcome"],
            "completed"
        );
        assert_eq!(
            request_end_event(
                &correlation,
                Some(peer),
                None,
                "handshake_failed",
                Duration::from_millis(1),
            )["outcome"],
            "failed"
        );
        assert_eq!(
            request_end_event(
                &correlation,
                Some(peer),
                Some(101),
                "protocol_error",
                Duration::from_millis(1),
            )["outcome"],
            "failed"
        );

        let protocol_only = ConnectionCorrelation {
            request_id: "request-2".to_string(),
            session_id: None,
            agent_id: None,
            parent_agent_id: None,
        };
        assert_eq!(
            protocol_only.for_session("protocol-session").session_id.as_deref(),
            Some("protocol-session")
        );
        assert_eq!(
            correlation.for_session("protocol-session").session_id.as_deref(),
            Some("session-1")
        );
    }

    #[test]
    fn turn_log_events_carry_the_full_output_cursor_and_correlation() {
        let correlation = ConnectionCorrelation {
            request_id: "request-1".to_string(),
            session_id: Some("session-1".to_string()),
            agent_id: None,
            parent_agent_id: None,
        };
        let final_output = RecognitionStreamOutput {
            output: recognized_output(true),
            source_text: None,
            azookey_input_text: None,
        };
        assert_eq!(
            turn_end_event(&correlation, &final_output),
            json!({
                "event": "recognition_turn_end",
                "request_id": "request-1",
                "session_id": "session-1",
                "agent_id": null,
                "parent_agent_id": null,
                "turn_session_id": 7,
                "turn_id": 3,
                "revision": 2,
                "output_sequence": 1,
                "segment_id": 8,
                "previous_segment_id": 7,
                "audio_duration_ms": 1_280,
                "elapsed_ms": 96,
            })
        );

        let stale_output = RecognitionStreamOutput {
            output: recognized_output(false),
            source_text: None,
            azookey_input_text: None,
        };
        assert_eq!(
            turn_skip_event(&correlation, &stale_output),
            json!({
                "event": "recognition_turn_skip",
                "request_id": "request-1",
                "session_id": "session-1",
                "agent_id": null,
                "parent_agent_id": null,
                "turn_session_id": 7,
                "turn_id": 3,
                "revision": 2,
                "output_sequence": 1,
                "segment_id": 8,
                "is_final": false,
                "reason": "stale_output",
            })
        );
    }

    #[test]
    fn real_socket_start_audio_stop_returns_ready_speech_final_and_done_in_order() {
        let server = start_test_server(FakeBackend::new(true), None);
        let (mut socket, _) = connect(server_url(&server)).unwrap();

        socket.send(start_message("session-1")).unwrap();
        assert_eq!(read_json(&mut socket)["type"], "session.ready");
        socket.send(Message::Binary(vec![0; 1_024].into())).unwrap();
        assert_eq!(read_json(&mut socket)["type"], "speech.started");
        assert_eq!(read_json(&mut socket)["type"], "turn.partial");
        socket
            .send(Message::Text(
                r#"{"version":1,"type":"session.stop","session_id":"session-1"}"#.into(),
            ))
            .unwrap();

        let final_message = read_json(&mut socket);
        assert_eq!(final_message["type"], "turn.final");
        assert_eq!(final_message["turn_session_id"], 7);
        assert_eq!(final_message["source_asr_model"], "reazonspeech_k2_v2");
        assert_eq!(read_json(&mut socket)["type"], "session.done");
    }

    #[test]
    fn real_socket_rejects_audio_before_start_and_unknown_endpoint_without_fallback() {
        let server = start_test_server(FakeBackend::new(true), None);
        let (mut socket, _) = connect(server_url(&server)).unwrap();
        socket.send(Message::Binary(vec![0; 1_024].into())).unwrap();
        let error = read_json(&mut socket);
        assert_eq!(error["code"], "invalid_state");
        assert_eq!(error["fatal"], true);

        let unknown = server_url(&server).replace("/ws/recognition", "/api/input");
        match connect(unknown) {
            Err(Error::Http(response)) => assert_eq!(response.status(), StatusCode::NOT_FOUND),
            other => panic!("unknown endpoint must return 404, got {other:?}"),
        }
    }

    #[test]
    fn real_socket_authentication_and_global_busy_are_enforced_before_second_worker_start() {
        let backend = FakeBackend::new(true);
        let server = start_test_server(backend.clone(), Some("secret"));
        let url = server_url(&server);
        let mut bad_request = url.clone().into_client_request().unwrap();
        bad_request.headers_mut().insert("authorization", HeaderValue::from_static("Bearer wrong"));
        match connect(bad_request) {
            Err(Error::Http(response)) => assert_eq!(response.status(), StatusCode::UNAUTHORIZED),
            other => panic!("invalid key must return 401, got {other:?}"),
        }

        let mut request = url.into_client_request().unwrap();
        request.headers_mut().insert("authorization", HeaderValue::from_static("Bearer secret"));
        let (mut first, _) = connect(request.clone()).unwrap();
        first.send(start_message("first")).unwrap();
        assert_eq!(read_json(&mut first)["type"], "session.ready");
        let (mut second, _) = connect(request).unwrap();
        second.send(start_message("second")).unwrap();
        assert_eq!(read_json(&mut second)["code"], "recognition_busy");
        assert_eq!(backend.starts.load(Ordering::Acquire), 1);
        first
            .send(Message::Text(
                r#"{"version":1,"type":"session.cancel","session_id":"first"}"#.into(),
            ))
            .unwrap();
        assert_eq!(read_json(&mut first)["type"], "session.cancelled");
    }

    #[test]
    fn real_socket_reports_audio_queue_overrun_without_silent_drop() {
        let server = start_test_server(FakeBackend::new(false), None);
        let (mut socket, _) = connect(server_url(&server)).unwrap();
        socket.send(start_message("overrun")).unwrap();
        assert_eq!(read_json(&mut socket)["type"], "session.ready");

        for _ in 0..21 {
            socket.send(Message::Binary(vec![0; 3_200].into())).unwrap();
        }

        let error = read_json(&mut socket);
        assert_eq!(
            error,
            json!({
                "version": 1,
                "type": "error",
                "session_id": "overrun",
                "code": "audio_queue_overrun",
                "message": "audio input exceeded the processing queue limit",
                "fatal": true
            })
        );
    }

    #[test]
    fn real_socket_rejects_odd_and_over_100ms_audio_frames_before_queueing() {
        for (frame, expected_code) in [
            (vec![0; 1], "invalid_audio_frame"),
            (vec![0; MAX_AUDIO_FRAME_BYTES + 2], "audio_frame_too_large"),
        ] {
            let server = start_test_server(FakeBackend::new(true), None);
            let (mut socket, _) = connect(server_url(&server)).unwrap();
            socket.send(start_message("frame-limit")).unwrap();
            assert_eq!(read_json(&mut socket)["type"], "session.ready");
            socket.send(Message::Binary(frame.into())).unwrap();
            let error = read_json(&mut socket);
            assert_eq!(error["code"], expected_code);
            assert_eq!(error["fatal"], true);
        }
    }

    #[test]
    fn tcp_client_that_never_sends_upgrade_cannot_block_server_shutdown_forever() {
        let server = start_test_server(FakeBackend::new(true), None);
        let _stalled_client = TcpStream::connect(server.local_addr()).unwrap();
        thread::sleep(Duration::from_millis(50));
        let (finished_sender, finished_receiver) = mpsc::channel();
        thread::spawn(move || {
            server.stop();
            let _ = finished_sender.send(());
        });

        finished_receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("server stop must have a bounded handshake shutdown time");
    }

    #[test]
    fn delayed_http_upgrade_after_tcp_connect_is_not_rejected_as_would_block() {
        let server = start_test_server(FakeBackend::new(true), None);
        let mut stream = TcpStream::connect(server.local_addr()).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        thread::sleep(Duration::from_millis(50));
        let request = format!(
            "GET /ws/recognition HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
            server.local_addr()
        );
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = [0_u8; 512];
        let read = stream.read(&mut response).unwrap_or(0);
        let response = String::from_utf8_lossy(&response[..read]);

        assert!(response.starts_with("HTTP/1.1 101"), "delayed upgrade response was {response:?}");
    }

    #[test]
    fn real_socket_cancel_returns_cancelled_without_flushing_a_final_turn() {
        let server = start_test_server(FakeBackend::new(true), None);
        let (mut socket, _) = connect(server_url(&server)).unwrap();
        socket.send(start_message("cancelled")).unwrap();
        assert_eq!(read_json(&mut socket)["type"], "session.ready");
        socket
            .send(Message::Text(
                r#"{"version":1,"type":"session.cancel","session_id":"cancelled"}"#.into(),
            ))
            .unwrap();

        assert_eq!(read_json(&mut socket)["type"], "session.cancelled");
        match socket.read() {
            Err(Error::ConnectionClosed | Error::AlreadyClosed | Error::Protocol(_))
            | Ok(Message::Close(_)) => {}
            other => panic!("cancel must not flush another protocol message, got {other:?}"),
        }
    }

    #[test]
    fn draining_session_keeps_answering_ping_until_stop_completes() {
        let backend = FakeBackend::with_stop(
            true,
            Duration::from_millis(200),
            RecognitionShutdownResult::Completed,
        );
        let server = start_test_server(backend, None);
        let (mut socket, _) = connect(server_url(&server)).unwrap();
        socket.send(start_message("draining-ping")).unwrap();
        assert_eq!(read_json(&mut socket)["type"], "session.ready");
        socket
            .send(Message::Text(
                r#"{"version":1,"type":"session.stop","session_id":"draining-ping"}"#.into(),
            ))
            .unwrap();
        socket
            .send(Message::Text(
                r#"{"version":1,"type":"ping","request_id":"during-drain"}"#.into(),
            ))
            .unwrap();

        let mut pong = None;
        for _ in 0..4 {
            let message = read_json(&mut socket);
            if message["type"] == "pong" {
                pong = Some(message);
                break;
            }
        }
        assert_eq!(pong, Some(json!({"version": 1, "type": "pong", "request_id": "during-drain"})));
    }

    #[test]
    fn drain_timeout_sends_fatal_error_instead_of_session_done() {
        let backend =
            FakeBackend::with_stop(true, Duration::ZERO, RecognitionShutdownResult::TimedOut);
        let server = start_test_server(backend, None);
        let (mut socket, _) = connect(server_url(&server)).unwrap();
        socket.send(start_message("drain-timeout")).unwrap();
        assert_eq!(read_json(&mut socket)["type"], "session.ready");
        socket
            .send(Message::Text(
                r#"{"version":1,"type":"session.stop","session_id":"drain-timeout"}"#.into(),
            ))
            .unwrap();

        let mut messages = Vec::new();
        loop {
            let message = read_json(&mut socket);
            let terminal = message["type"] == "error";
            messages.push(message);
            if terminal {
                break;
            }
        }
        assert_eq!(messages.last().unwrap()["code"], "drain_timeout");
        assert!(messages.iter().all(|message| message["type"] != "session.done"));
    }

    #[test]
    fn session_cancel_ack_does_not_wait_for_slow_worker_join() {
        let backend = FakeBackend::with_stop(
            true,
            Duration::from_millis(500),
            RecognitionShutdownResult::Completed,
        );
        let server = start_test_server(backend, None);
        let (mut socket, _) = connect(server_url(&server)).unwrap();
        socket.send(start_message("slow-cancel")).unwrap();
        assert_eq!(read_json(&mut socket)["type"], "session.ready");
        let started_at = std::time::Instant::now();
        socket
            .send(Message::Text(
                r#"{"version":1,"type":"session.cancel","session_id":"slow-cancel"}"#.into(),
            ))
            .unwrap();

        assert_eq!(read_json(&mut socket)["type"], "session.cancelled");
        assert!(started_at.elapsed() < Duration::from_millis(250));
    }
}
