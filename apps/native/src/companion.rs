//! Authenticated, bounded LAN transport for the Flutter companion.

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use getrandom::fill as fill_random;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use rust_lib_kotoba_beacon_companion::api::simple::{
    decode_discovery_request, decode_mobile_browser_source_status, decode_mobile_route_request,
    decode_mobile_stage_result, decode_pair_request, decode_session_configuration,
    encode_browser_source_caption, encode_discovery_response, encode_route_configuration,
    encode_session_ready, MobileCapabilities, MobileStageResult, PipelineRoute,
};
use tungstenite::{accept, Error as WebSocketError, Message, WebSocket};

pub const COMPANION_PORT: u16 = 18_183;
pub const COMPANION_DISCOVERY_PORT: u16 = 18_184;
const OUTBOUND_CAPACITY: usize = 64;
const INBOUND_CAPACITY: usize = 64;
const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(8);
const MODEL_PREPARATION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const IO_POLL_INTERVAL: Duration = Duration::from_millis(8);
const PAIRING_TOKEN_BYTES: usize = 16;
const MAX_PCM_FRAME_BYTES: usize = 4_096;
const MAX_DISCOVERY_DATAGRAM_BYTES: usize = 1_024;
const COMPANION_SERVICE_TYPE: &str = "_kotobabeacon._tcp.local.";
const COMPANION_SERVICE_INSTANCE: &str = "Kotoba Beacon Native";
const COMPANION_SERVICE_HOSTNAME: &str = "kotoba-beacon.local.";
const PAIRING_URL_SCHEME: &str = "kotobabeacon";
const PAIRING_URL_HOST: &str = "pair";
const PAIRING_QR_MODULE_PX: u32 = 6;
const PAIRING_QR_QUIET_MODULES: u32 = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompanionConnectionSnapshot {
    pub endpoint: String,
    pub pairing_token: String,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub session_id: Option<String>,
    pub route: PipelineRoute,
    pub capabilities: Option<MobileCapabilities>,
    pub browser_source_enabled: bool,
    pub browser_source_url: Option<String>,
    pub last_error: Option<String>,
}

impl CompanionConnectionSnapshot {
    fn disconnected_at(pairing_token: String, route: PipelineRoute, host: &str, port: u16) -> Self {
        Self {
            endpoint: format!("ws://{host}:{port}/companion"),
            pairing_token,
            device_id: None,
            device_name: None,
            session_id: None,
            route,
            capabilities: None,
            browser_source_enabled: false,
            browser_source_url: None,
            last_error: None,
        }
    }
}

/// Camera-readable custom URL that opens the installed companion app.
pub fn companion_pairing_link(endpoint: &str, pairing_token: &str) -> String {
    format!(
        "{PAIRING_URL_SCHEME}://{PAIRING_URL_HOST}?endpoint={}&token={}",
        percent_encode_query(endpoint),
        percent_encode_query(pairing_token),
    )
}

/// RGBA QR pixels for [companion_pairing_link], including a quiet zone.
pub fn companion_pairing_qr_rgba(link: &str) -> Result<(u32, u32, Vec<u8>), String> {
    let code = qrcode::QrCode::new(link.as_bytes())
        .map_err(|error| format!("could not encode companion pairing QR: {error}"))?;
    let width =
        u32::try_from(code.width()).map_err(|_| "companion pairing QR is too large".to_string())?;
    let modules = width.saturating_add(PAIRING_QR_QUIET_MODULES.saturating_mul(2));
    let size = modules.saturating_mul(PAIRING_QR_MODULE_PX);
    let pixel_count = usize::try_from(size.saturating_mul(size).saturating_mul(4))
        .map_err(|_| "companion pairing QR is too large".to_string())?;
    let mut pixels = vec![255_u8; pixel_count];
    code.to_colors().iter().enumerate().for_each(|(index, color)| {
        if *color != qrcode::Color::Dark {
            return;
        }
        let module_width = code.width();
        let Ok(module_x) = u32::try_from(index % module_width) else {
            return;
        };
        let Ok(module_y) = u32::try_from(index / module_width) else {
            return;
        };
        fill_qr_module(&mut pixels, size, module_x, module_y);
    });
    Ok((size, size, pixels))
}

fn percent_encode_query(value: &str) -> String {
    value.bytes().fold(String::new(), |mut encoded, byte| {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push('%');
                encoded.push_str(&format!("{byte:02X}"));
            }
        }
        encoded
    })
}

fn fill_qr_module(pixels: &mut [u8], size: u32, module_x: u32, module_y: u32) {
    let origin_x =
        module_x.saturating_add(PAIRING_QR_QUIET_MODULES).saturating_mul(PAIRING_QR_MODULE_PX);
    let origin_y =
        module_y.saturating_add(PAIRING_QR_QUIET_MODULES).saturating_mul(PAIRING_QR_MODULE_PX);
    let module_area = PAIRING_QR_MODULE_PX.saturating_mul(PAIRING_QR_MODULE_PX);
    (0..module_area).for_each(|offset| {
        let dx = offset % PAIRING_QR_MODULE_PX;
        let dy = offset / PAIRING_QR_MODULE_PX;
        let pixel_x = origin_x.saturating_add(dx);
        let pixel_y = origin_y.saturating_add(dy);
        let Some(pixel_index) = pixel_y
            .saturating_mul(size)
            .saturating_add(pixel_x)
            .saturating_mul(4)
            .try_into()
            .ok()
            .filter(|index: &usize| index.saturating_add(3) < pixels.len())
        else {
            return;
        };
        pixels[pixel_index] = 0;
        pixels[pixel_index + 1] = 0;
        pixels[pixel_index + 2] = 0;
        pixels[pixel_index + 3] = 255;
    });
}

#[derive(Debug)]
pub enum CompanionInbound {
    StageResult(MobileStageResult),
    Disconnected { session_id: String },
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
        Self::start_on_ports(
            route,
            "0.0.0.0",
            COMPANION_PORT,
            COMPANION_DISCOVERY_PORT,
            &discover_lan_address(),
        )
        .map(|(server, _, _)| server)
    }

    fn start_on_ports(
        route: PipelineRoute,
        bind_host: &str,
        companion_port: u16,
        discovery_port: u16,
        advertised_host: &str,
    ) -> Result<(Self, u16, u16), String> {
        let listener = TcpListener::bind((bind_host, companion_port))
            .map_err(|error| format!("could not bind companion LAN port: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("could not configure companion LAN listener: {error}"))?;
        let companion_port = listener
            .local_addr()
            .map_err(|error| format!("could not read companion LAN port: {error}"))?
            .port();
        let discovery_socket = UdpSocket::bind((bind_host, discovery_port))
            .map_err(|error| format!("could not bind companion discovery port: {error}"))?;
        discovery_socket
            .set_nonblocking(true)
            .map_err(|error| format!("could not configure companion discovery socket: {error}"))?;
        let discovery_port = discovery_socket
            .local_addr()
            .map_err(|error| format!("could not read companion discovery port: {error}"))?
            .port();
        let pairing_token = generate_pairing_token()?;
        let endpoint = format!("ws://{advertised_host}:{companion_port}/companion");
        let bonjour = if bind_host == "0.0.0.0" {
            Some(start_bonjour(&endpoint, &pairing_token, advertised_host, companion_port)?)
        } else {
            None
        };
        let snapshot = Arc::new(Mutex::new(CompanionConnectionSnapshot::disconnected_at(
            pairing_token.clone(),
            route,
            advertised_host,
            companion_port,
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
                    discovery_socket,
                    ServerRuntime {
                        pairing_token,
                        outbound_rx,
                        inbound_tx,
                        snapshot: worker_snapshot,
                        stop_requested: worker_stop,
                        bonjour,
                    },
                )
            })
            .map_err(|error| format!("could not start companion LAN thread: {error}"))?;
        Ok((
            Self {
                outbound_tx,
                inbound_rx: Arc::new(Mutex::new(inbound_rx)),
                snapshot,
                stop_requested,
                worker: Some(worker),
            },
            companion_port,
            discovery_port,
        ))
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

    pub fn publish_browser_source_caption(
        &self,
        source: &str,
        translation: &str,
    ) -> Result<bool, String> {
        let session_id = {
            let state = self.snapshot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if !state.browser_source_enabled {
                return Ok(false);
            }
            state.session_id.clone()
        };
        let Some(session_id) = session_id else {
            return Ok(false);
        };
        let message =
            encode_browser_source_caption(session_id, source.to_string(), translation.to_string())?;
        self.outbound_tx
            .try_send(CompanionOutbound::Text(message))
            .map_err(format_outbound_error)?;
        Ok(true)
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

struct ServerRuntime {
    pairing_token: String,
    outbound_rx: Receiver<CompanionOutbound>,
    inbound_tx: SyncSender<CompanionInbound>,
    snapshot: Arc<Mutex<CompanionConnectionSnapshot>>,
    stop_requested: Arc<AtomicBool>,
    bonjour: Option<ServiceDaemon>,
}

fn run_server(listener: TcpListener, discovery_socket: UdpSocket, runtime: ServerRuntime) {
    while !runtime.stop_requested.load(Ordering::Acquire) {
        respond_to_discovery(&discovery_socket, &runtime.pairing_token, &runtime.snapshot);
        match listener.accept() {
            Ok((stream, _address)) => {
                if let Err(error) = serve_connection(
                    stream,
                    &runtime.pairing_token,
                    &runtime.outbound_rx,
                    &runtime.inbound_tx,
                    &runtime.snapshot,
                    &runtime.stop_requested,
                ) {
                    set_error(&runtime.snapshot, error);
                }
                let disconnected_session_id = runtime
                    .snapshot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .session_id
                    .clone();
                mark_disconnected(&runtime.snapshot);
                if let Some(session_id) = disconnected_session_id {
                    let _ =
                        runtime.inbound_tx.try_send(CompanionInbound::Disconnected { session_id });
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(IO_POLL_INTERVAL);
            }
            Err(error) => {
                set_error(&runtime.snapshot, format!("companion LAN accept failed: {error}"));
                thread::sleep(IO_POLL_INTERVAL);
            }
        }
    }
    if let Some(bonjour) = runtime.bonjour {
        let _ = bonjour.shutdown();
    }
}

fn start_bonjour(
    endpoint: &str,
    pairing_token: &str,
    advertised_host: &str,
    companion_port: u16,
) -> Result<ServiceDaemon, String> {
    let daemon = ServiceDaemon::new()
        .map_err(|error| format!("could not start companion Bonjour discovery: {error}"))?;
    let properties = [("endpoint", endpoint), ("token", pairing_token), ("version", "1")];
    let service = ServiceInfo::new(
        COMPANION_SERVICE_TYPE,
        COMPANION_SERVICE_INSTANCE,
        COMPANION_SERVICE_HOSTNAME,
        advertised_host,
        companion_port,
        &properties[..],
    )
    .map_err(|error| format!("could not describe companion Bonjour service: {error}"))?;
    daemon
        .register(service)
        .map_err(|error| format!("could not advertise companion Bonjour service: {error}"))?;
    Ok(daemon)
}

fn respond_to_discovery(
    socket: &UdpSocket,
    pairing_token: &str,
    snapshot: &Arc<Mutex<CompanionConnectionSnapshot>>,
) {
    let mut bytes = [0_u8; MAX_DISCOVERY_DATAGRAM_BYTES];
    let Ok((length, peer)) = socket.recv_from(&mut bytes) else {
        return;
    };
    let Ok(request) = std::str::from_utf8(&bytes[..length]) else {
        return;
    };
    let Ok(nonce) = decode_discovery_request(request.to_string()) else {
        return;
    };
    let endpoint =
        snapshot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).endpoint.clone();
    let Ok(response) = encode_discovery_response(nonce, endpoint, pairing_token.to_string()) else {
        return;
    };
    let _ = socket.send_to(response.as_bytes(), peer);
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
    if let Ok(status) = decode_mobile_browser_source_status(text.clone()) {
        let mut state = snapshot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.session_id.as_deref() != Some(status.session_id.as_str()) {
            return Err("mobile Browser Source status has the wrong session ID".to_string());
        }
        state.browser_source_enabled = status.enabled;
        state.browser_source_url = status.url;
        return Ok(());
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
    state.browser_source_enabled = false;
    state.browser_source_url = None;
}

fn set_error(snapshot: &Arc<Mutex<CompanionConnectionSnapshot>>, error: String) {
    let mut state = snapshot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.last_error = Some(error);
}

#[cfg(test)]
mod tests {
    use std::net::UdpSocket;
    use std::thread;
    use std::time::Duration;

    use super::{
        companion_pairing_link, companion_pairing_qr_rgba, constant_time_equal,
        generate_pairing_token, CompanionConnectionSnapshot, CompanionInbound, CompanionServer,
        COMPANION_PORT,
    };
    use rust_lib_kotoba_beacon_companion::api::simple::{
        decode_desktop_command, decode_discovery_response, default_pipeline_route,
        encode_discovery_request, encode_mobile_browser_source_status, encode_pair_request,
        encode_route_configuration, encode_route_request, encode_session_configure,
        encode_stage_result, DesktopCommand, ExecutionDevice, MobileCapabilities, PipelineRoute,
        ProcessingStage,
    };
    use tungstenite::{connect, Message};

    #[test]
    fn generated_pairing_token_is_high_entropy_hex() {
        let token = generate_pairing_token().expect("pairing token");
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn companion_pairing_link_percent_encodes_the_endpoint_and_token() {
        assert_eq!(
            companion_pairing_link(
                "ws://192.168.1.2:18183/companion",
                "0123456789abcdef0123456789abcdef",
            ),
            "kotobabeacon://pair?endpoint=ws%3A%2F%2F192.168.1.2%3A18183%2Fcompanion&token=0123456789abcdef0123456789abcdef",
        );
    }

    #[test]
    fn companion_pairing_qr_contains_dark_modules() {
        let (width, height, pixels) = companion_pairing_qr_rgba(
            "kotobabeacon://pair?endpoint=ws%3A%2F%2F192.168.1.2%3A18183%2Fcompanion&token=0123456789abcdef0123456789abcdef",
        )
        .expect("pairing QR");
        assert_eq!(width, height);
        assert!(width > 24);
        assert_eq!(pixels.len(), width as usize * height as usize * 4);
        assert!(pixels.chunks(4).any(|pixel| pixel == [0, 0, 0, 255]));
        assert!(pixels.chunks(4).any(|pixel| pixel == [255, 255, 255, 255]));
    }

    #[test]
    fn pairing_token_comparison_checks_every_byte() {
        assert!(constant_time_equal(b"0123456789abcdef", b"0123456789abcdef"));
        assert!(!constant_time_equal(b"0123456789abcdef", b"0123456789abcdee"));
        assert!(!constant_time_equal(b"short", b"different"));
    }

    #[test]
    fn disconnected_snapshot_has_no_session_identity() {
        let snapshot = CompanionConnectionSnapshot::disconnected_at(
            "secret".to_string(),
            PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Mobile,
            },
            "192.0.2.1",
            COMPANION_PORT,
        );
        assert!(snapshot.endpoint.starts_with("ws://"));
        assert!(snapshot.endpoint.ends_with(":18183/companion"));
        assert_eq!(snapshot.device_name, None);
        assert_eq!(snapshot.session_id, None);
    }

    #[test]
    fn authenticated_loopback_session_exchanges_revision_scoped_results() {
        let route = default_pipeline_route();
        let (server, companion_port, discovery_port) =
            CompanionServer::start_on_ports(route, "127.0.0.1", 0, 0, "127.0.0.1")
                .expect("start companion server");
        let handle = server.handle();
        let snapshot = server.snapshot();
        let discovery = UdpSocket::bind(("127.0.0.1", 0)).expect("bind discovery client");
        discovery.set_read_timeout(Some(Duration::from_secs(1))).expect("set discovery timeout");
        discovery
            .send_to(
                encode_discovery_request(77).expect("encode discovery request").as_bytes(),
                ("127.0.0.1", discovery_port),
            )
            .expect("send discovery request");
        let mut discovery_bytes = [0_u8; 1_024];
        let (length, _peer) =
            discovery.recv_from(&mut discovery_bytes).expect("discovery response");
        let discovered = decode_discovery_response(
            String::from_utf8(discovery_bytes[..length].to_vec())
                .expect("UTF-8 discovery response"),
        )
        .expect("decode discovery response");
        assert_eq!(discovered.nonce, 77);
        assert_eq!(discovered.endpoint, snapshot.endpoint);
        assert_eq!(discovered.token, snapshot.pairing_token);
        let (mut socket, _response) = connect(format!("ws://127.0.0.1:{companion_port}/companion"))
            .expect("connect companion client");
        socket
            .send(Message::Text(
                encode_pair_request(
                    snapshot.pairing_token.clone(),
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
                encode_mobile_browser_source_status(
                    "session-1".to_string(),
                    true,
                    Some("http://127.0.0.1:1522/".to_string()),
                )
                .expect("Mobile Browser Source status")
                .into(),
            ))
            .expect("send Mobile Browser Source status");
        thread::sleep(Duration::from_millis(25));
        assert!(server.snapshot().browser_source_enabled);
        assert_eq!(server.snapshot().browser_source_url.as_deref(), Some("http://127.0.0.1:1522/"));
        assert!(server
            .publish_browser_source_caption("こんにちは", "Hello")
            .expect("publish Browser Source caption"));
        assert_eq!(
            socket
                .read()
                .expect("Mobile Browser Source caption")
                .into_text()
                .map(|text| text.as_str().to_string())
                .map_err(|error| error.to_string())
                .and_then(decode_desktop_command)
                .expect("decode Mobile Browser Source caption"),
            DesktopCommand::UpdateBrowserSourceCaption {
                session_id: "session-1".to_string(),
                source_text: "こんにちは".to_string(),
                translation_text: "Hello".to_string(),
            }
        );
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
        let default_route = default_pipeline_route();
        server.set_route(default_route).expect("desktop route update");
        assert!(matches!(
            socket.read().expect("desktop route update"),
            Message::Text(text)
                if text.as_str()
                    == encode_route_configuration(default_route).expect("encode default route")
        ));
        assert_eq!(server.snapshot().route, default_route);
        socket.close(None).expect("close companion client");
    }
}
