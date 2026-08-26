//! Authenticated, bounded LAN transport for the Flutter companion.

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use getrandom::fill as fill_random;
use rust_lib_kotoba_beacon_companion::api::simple::{
    decode_mobile_route_request, decode_mobile_stage_result, decode_pair_request,
    decode_session_configuration, encode_route_configuration, encode_session_ready,
    MobileCapabilities, MobileStageResult, PipelineRoute,
};
use tungstenite::{accept, Error as WebSocketError, Message, WebSocket};

pub const COMPANION_PORT: u16 = 18_183;
const OUTBOUND_CAPACITY: usize = 64;
const INBOUND_CAPACITY: usize = 64;
const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(8);
const MODEL_PREPARATION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const IO_POLL_INTERVAL: Duration = Duration::from_millis(8);
const PAIRING_TOKEN_BYTES: usize = 16;
const MAX_PCM_FRAME_BYTES: usize = 4_096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompanionConnectionSnapshot {
    pub endpoint: String,
    pub pairing_token: String,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub session_id: Option<String>,
    pub route: PipelineRoute,
    pub capabilities: Option<MobileCapabilities>,
    pub last_error: Option<String>,
}

impl CompanionConnectionSnapshot {
    fn disconnected(pairing_token: String, route: PipelineRoute) -> Self {
        Self {
            endpoint: format!("ws://{}:{COMPANION_PORT}/companion", discover_lan_address()),
            pairing_token,
            device_id: None,
            device_name: None,
            session_id: None,
            route,
            capabilities: None,
            last_error: None,
        }
    }
}

#[derive(Debug)]
pub enum CompanionInbound {
    StageResult(MobileStageResult),
    Disconnected,
}

pub(crate) enum CompanionOutbound {
    Text(String),
    Audio(Vec<u8>),
    Disconnect,
}

pub struct CompanionServer {
    outbound_tx: SyncSender<CompanionOutbound>,
    inbound_rx: Arc<Mutex<Receiver<CompanionInbound>>>,
    snapshot: Arc<Mutex<CompanionConnectionSnapshot>>,
    stop_requested: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct CompanionHandle {
    outbound_tx: SyncSender<CompanionOutbound>,
    inbound_rx: Arc<Mutex<Receiver<CompanionInbound>>>,
}

impl CompanionServer {
    pub fn start(route: PipelineRoute) -> Result<Self, String> {
        let listener = TcpListener::bind(("0.0.0.0", COMPANION_PORT))
            .map_err(|error| format!("could not bind companion LAN port: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("could not configure companion LAN listener: {error}"))?;
        let pairing_token = generate_pairing_token()?;
        let snapshot = Arc::new(Mutex::new(CompanionConnectionSnapshot::disconnected(
            pairing_token.clone(),
            route,
        )));
        let (outbound_tx, outbound_rx) = mpsc::sync_channel(OUTBOUND_CAPACITY);
        let (inbound_tx, inbound_rx) = mpsc::sync_channel(INBOUND_CAPACITY);
        let stop_requested = Arc::new(AtomicBool::new(false));
        let worker_snapshot = Arc::clone(&snapshot);
        let worker_stop = Arc::clone(&stop_requested);
        let worker = thread::Builder::new()
            .name("native-companion-lan".to_string())
            .spawn(move || {
                run_server(
                    listener,
                    pairing_token,
                    outbound_rx,
                    inbound_tx,
                    worker_snapshot,
                    worker_stop,
                )
            })
            .map_err(|error| format!("could not start companion LAN thread: {error}"))?;
        Ok(Self {
            outbound_tx,
            inbound_rx: Arc::new(Mutex::new(inbound_rx)),
            snapshot,
            stop_requested,
            worker: Some(worker),
        })
    }

    pub fn snapshot(&self) -> CompanionConnectionSnapshot {
        self.snapshot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    pub fn set_route(&self, route: PipelineRoute) -> Result<(), String> {
        let connected = {
            let mut state = self.snapshot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.route = route;
            state.session_id.is_some()
        };
        if !connected {
            return Ok(());
        }
        self.outbound_tx
            .try_send(CompanionOutbound::Text(encode_route_configuration(route)?))
            .map_err(format_outbound_error)
    }

    pub fn handle(&self) -> CompanionHandle {
        CompanionHandle {
            outbound_tx: self.outbound_tx.clone(),
            inbound_rx: Arc::clone(&self.inbound_rx),
        }
    }
}

impl CompanionHandle {
    #[cfg(test)]
    pub(crate) fn test_channel() -> (Self, SyncSender<CompanionInbound>, Receiver<CompanionOutbound>)
    {
        let (outbound_tx, outbound_rx) = mpsc::sync_channel(OUTBOUND_CAPACITY);
        let (inbound_tx, inbound_rx) = mpsc::sync_channel(INBOUND_CAPACITY);
        (
            Self { outbound_tx, inbound_rx: Arc::new(Mutex::new(inbound_rx)) },
            inbound_tx,
            outbound_rx,
        )
    }

    pub fn send_text(&self, text: String) -> Result<(), String> {
        self.outbound_tx.try_send(CompanionOutbound::Text(text)).map_err(format_outbound_error)
    }

    pub fn send_pcm16(&self, samples: &[i16]) -> Result<(), String> {
        let byte_length = samples.len().saturating_mul(2);
        if byte_length == 0 || byte_length > MAX_PCM_FRAME_BYTES {
            return Err(format!(
                "companion PCM frame must contain 1..={MAX_PCM_FRAME_BYTES} bytes"
            ));
        }
        let mut bytes = Vec::with_capacity(byte_length);
        samples.iter().for_each(|sample| bytes.extend_from_slice(&sample.to_le_bytes()));
        self.outbound_tx.try_send(CompanionOutbound::Audio(bytes)).map_err(format_outbound_error)
    }

    pub fn try_recv(&self) -> Option<CompanionInbound> {
        self.inbound_rx.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).try_recv().ok()
    }
}

impl Drop for CompanionServer {
    fn drop(&mut self) {
        self.stop_requested.store(true, Ordering::Release);
        let _ = self.outbound_tx.try_send(CompanionOutbound::Disconnect);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn run_server(
    listener: TcpListener,
    pairing_token: String,
    outbound_rx: Receiver<CompanionOutbound>,
    inbound_tx: SyncSender<CompanionInbound>,
    snapshot: Arc<Mutex<CompanionConnectionSnapshot>>,
    stop_requested: Arc<AtomicBool>,
) {
    while !stop_requested.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _address)) => {
                if let Err(error) = serve_connection(
                    stream,
                    &pairing_token,
                    &outbound_rx,
                    &inbound_tx,
                    &snapshot,
                    &stop_requested,
                ) {
                    set_error(&snapshot, error);
                }
                mark_disconnected(&snapshot);
                let _ = inbound_tx.try_send(CompanionInbound::Disconnected);
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(IO_POLL_INTERVAL);
            }
            Err(error) => {
                set_error(&snapshot, format!("companion LAN accept failed: {error}"));
                thread::sleep(IO_POLL_INTERVAL);
            }
        }
    }
}

fn serve_connection(
    stream: TcpStream,
    pairing_token: &str,
    outbound_rx: &Receiver<CompanionOutbound>,
    inbound_tx: &SyncSender<CompanionInbound>,
    snapshot: &Arc<Mutex<CompanionConnectionSnapshot>>,
    stop_requested: &AtomicBool,
) -> Result<(), String> {
    stream
        .set_nonblocking(false)
        .map_err(|error| format!("could not configure companion authentication socket: {error}"))?;
    stream
        .set_read_timeout(Some(AUTHENTICATION_TIMEOUT))
        .map_err(|error| format!("could not set companion authentication timeout: {error}"))?;
    let mut socket =
        accept(stream).map_err(|error| format!("companion handshake failed: {error}"))?;
    let pair_json = read_text(&mut socket)?;
    let pair = decode_pair_request(pair_json)?;
    if !constant_time_equal(pair.token.as_bytes(), pairing_token.as_bytes()) {
        return Err("companion authentication failed".to_string());
    }
    socket
        .get_mut()
        .set_read_timeout(Some(MODEL_PREPARATION_TIMEOUT))
        .map_err(|error| format!("could not set companion preparation timeout: {error}"))?;
    let configuration_json = read_text(&mut socket)?;
    let configuration = decode_session_configuration(configuration_json)?;
    if pair.device_id != configuration.capabilities.device_id {
        return Err("companion device identity changed during authentication".to_string());
    }
    let accepted_route = configuration.capabilities.constrain(configuration.route);
    if accepted_route != configuration.route {
        return Err("companion route requests an unavailable mobile stage".to_string());
    }
    socket
        .get_mut()
        .set_read_timeout(Some(IO_POLL_INTERVAL))
        .map_err(|error| format!("could not configure companion socket polling: {error}"))?;
    {
        let mut state = snapshot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.device_id = Some(pair.device_id);
        state.device_name = Some(pair.device_name);
        state.session_id = Some(configuration.session_id.clone());
        state.route = configuration.route;
        state.capabilities = Some(configuration.capabilities);
        state.last_error = None;
    }
    socket
        .send(Message::Text(
            encode_session_ready(configuration.session_id, configuration.route)?.into(),
        ))
        .map_err(|error| format!("could not acknowledge companion session: {error}"))?;

    while !stop_requested.load(Ordering::Acquire) {
        match outbound_rx.recv_timeout(IO_POLL_INTERVAL) {
            Ok(CompanionOutbound::Text(text)) => socket
                .send(Message::Text(text.into()))
                .map_err(|error| format!("could not send companion message: {error}"))?,
            Ok(CompanionOutbound::Audio(bytes)) => socket
                .send(Message::Binary(bytes.into()))
                .map_err(|error| format!("could not send companion audio: {error}"))?,
            Ok(CompanionOutbound::Disconnect) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                handle_mobile_text(&mut socket, text.to_string(), inbound_tx, snapshot)?;
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(payload)) => socket
                .send(Message::Pong(payload))
                .map_err(|error| format!("could not reply to companion ping: {error}"))?,
            Ok(_) => {}
            Err(WebSocketError::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(WebSocketError::ConnectionClosed | WebSocketError::AlreadyClosed) => break,
            Err(error) => return Err(format!("companion receive failed: {error}")),
        }
    }
    Ok(())
}

fn handle_mobile_text(
    socket: &mut WebSocket<TcpStream>,
    text: String,
    inbound_tx: &SyncSender<CompanionInbound>,
    snapshot: &Arc<Mutex<CompanionConnectionSnapshot>>,
) -> Result<(), String> {
    if let Ok(result) = decode_mobile_stage_result(text.clone()) {
        return match inbound_tx.try_send(CompanionInbound::StageResult(result)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err("companion result queue overrun".to_string()),
            Err(TrySendError::Disconnected(_)) => Ok(()),
        };
    }
    let requested = decode_mobile_route_request(text)?;
    let accepted = {
        let mut state = snapshot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let capabilities = state
            .capabilities
            .as_ref()
            .ok_or_else(|| "mobile capabilities are unavailable".to_string())?;
        let accepted = capabilities.constrain(requested);
        state.route = accepted;
        accepted
    };
    socket
        .send(Message::Text(encode_route_configuration(accepted)?.into()))
        .map_err(|error| format!("could not acknowledge companion route: {error}"))
}

fn read_text(socket: &mut WebSocket<TcpStream>) -> Result<String, String> {
    match socket.read() {
        Ok(Message::Text(text)) => Ok(text.to_string()),
        Ok(_) => Err("companion authentication requires a JSON text frame".to_string()),
        Err(error) => Err(format!("could not read companion authentication: {error}")),
    }
}

fn discover_lan_address() -> String {
    let address = UdpSocket::bind(("0.0.0.0", 0))
        .and_then(|socket| {
            socket.connect(("192.0.2.1", 9))?;
            socket.local_addr()
        })
        .ok()
        .map(|address| address.ip())
        .filter(|address| !address.is_loopback() && !address.is_unspecified());
    address.map_or_else(|| "<desktop-lan-ip>".to_string(), |address| address.to_string())
}

fn generate_pairing_token() -> Result<String, String> {
    let mut bytes = [0_u8; PAIRING_TOKEN_BYTES];
    fill_random(&mut bytes)
        .map_err(|error| format!("could not generate pairing token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter().zip(right).fold(0_u8, |difference, (a, b)| difference | (a ^ b)) == 0
}

fn format_outbound_error(error: TrySendError<CompanionOutbound>) -> String {
    match error {
        TrySendError::Full(_) => "companion output queue is full".to_string(),
        TrySendError::Disconnected(_) => "companion LAN worker stopped".to_string(),
    }
}

fn mark_disconnected(snapshot: &Arc<Mutex<CompanionConnectionSnapshot>>) {
    let mut state = snapshot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.device_id = None;
    state.device_name = None;
    state.session_id = None;
    state.capabilities = None;
}

fn set_error(snapshot: &Arc<Mutex<CompanionConnectionSnapshot>>, error: String) {
    let mut state = snapshot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.last_error = Some(error);
}

#[cfg(test)]
mod tests {
    use std::thread;
    use std::time::Duration;

    use super::{
        constant_time_equal, generate_pairing_token, CompanionConnectionSnapshot, CompanionInbound,
        CompanionServer, COMPANION_PORT,
    };
    use rust_lib_kotoba_beacon_companion::api::simple::{
        default_pipeline_route, encode_pair_request, encode_route_request,
        encode_session_configure, encode_stage_result, ExecutionDevice, MobileCapabilities,
        PipelineRoute, ProcessingStage,
    };
    use tungstenite::{connect, Message};

    #[test]
    fn generated_pairing_token_is_high_entropy_hex() {
        let token = generate_pairing_token().expect("pairing token");
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn pairing_token_comparison_checks_every_byte() {
        assert!(constant_time_equal(b"0123456789abcdef", b"0123456789abcdef"));
        assert!(!constant_time_equal(b"0123456789abcdef", b"0123456789abcdee"));
        assert!(!constant_time_equal(b"short", b"different"));
    }

    #[test]
    fn disconnected_snapshot_has_no_session_identity() {
        let snapshot = CompanionConnectionSnapshot::disconnected(
            "secret".to_string(),
            PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Mobile,
            },
        );
        assert!(snapshot.endpoint.starts_with("ws://"));
        assert!(snapshot.endpoint.ends_with(":18183/companion"));
        assert_eq!(snapshot.device_name, None);
        assert_eq!(snapshot.session_id, None);
    }

    #[test]
    fn authenticated_loopback_session_exchanges_revision_scoped_results() {
        let route = default_pipeline_route();
        let server = CompanionServer::start(route).expect("start companion server");
        let handle = server.handle();
        let snapshot = server.snapshot();
        let (mut socket, _response) = connect(format!("ws://127.0.0.1:{COMPANION_PORT}/companion"))
            .expect("connect companion client");
        socket
            .send(Message::Text(
                encode_pair_request(
                    snapshot.pairing_token,
                    "android-test-1".to_string(),
                    "test phone".to_string(),
                )
                .expect("pair request")
                .into(),
            ))
            .expect("send pair request");
        socket
            .send(Message::Text(
                encode_session_configure(
                    "session-1".to_string(),
                    route,
                    MobileCapabilities {
                        device_id: "android-test-1".to_string(),
                        device_name: "test phone".to_string(),
                        platform: "android".to_string(),
                        asr_available: true,
                        azookey_available: true,
                        translation_available: true,
                    },
                )
                .expect("session configuration")
                .into(),
            ))
            .expect("send session configuration");
        assert!(matches!(
            socket
                .read()
                .unwrap_or_else(|error| panic!("session ready failed: {error}; {:?}", server.snapshot())),
            Message::Text(text) if text.contains("session.ready")
        ));
        socket
            .send(Message::Text(
                encode_stage_result(
                    ProcessingStage::Asr,
                    "session-1".to_string(),
                    3,
                    7,
                    "こんにちは".to_string(),
                    false,
                )
                .expect("ASR result")
                .into(),
            ))
            .expect("send ASR result");
        thread::sleep(Duration::from_millis(25));
        assert!(matches!(
            handle.try_recv(),
            Some(CompanionInbound::StageResult(result))
                if result.turn_id == 3 && result.revision == 7 && result.text == "こんにちは"
        ));
        socket
            .send(Message::Text(
                encode_route_request(PipelineRoute {
                    asr: ExecutionDevice::Desktop,
                    azookey: ExecutionDevice::Mobile,
                    translation: ExecutionDevice::Desktop,
                })
                .expect("route request")
                .into(),
            ))
            .expect("send route request");
        assert!(matches!(
            socket.read().expect("route acknowledgement"),
            Message::Text(text) if text.contains("route.configure")
        ));
        assert_eq!(server.snapshot().device_id.as_deref(), Some("android-test-1"));
        assert_eq!(
            server.snapshot().capabilities.as_ref().map(|value| value.platform.as_str()),
            Some("android")
        );
        assert_eq!(
            server.snapshot().route,
            PipelineRoute {
                asr: ExecutionDevice::Desktop,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Desktop,
            }
        );
        socket.close(None).expect("close companion client");
    }
}
