//! Optional synchronous WebSocket client for Parapper recognition.

use std::net::TcpStream;

use tungstenite::{connect, stream::MaybeTlsStream, Message, WebSocket};

use crate::protocol::{
    parse_server_frame, serialize_client_frame, validate_audio_frame, AudioParameters, ClientFrame,
    ProtocolError, ServerEvent, MAX_AUDIO_FRAME_BYTES, PROTOCOL_VERSION,
};

#[derive(Debug, thiserror::Error)]
pub enum ParapperClientError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("WebSocket transport error: {0}")]
    WebSocket(#[from] tungstenite::Error),
    #[error("invalid WebSocket URL: {0}")]
    Url(#[from] tungstenite::http::uri::InvalidUri),
}

#[derive(Debug, Clone)]
pub struct ParapperClientOptions {
    pub url: String,
    pub session_id: String,
    pub partial_window_asr_enabled: bool,
}

impl ParapperClientOptions {
    pub fn for_port(port: u16, session_id: impl Into<String>) -> Self {
        Self {
            url: recognition_url(port),
            session_id: session_id.into(),
            partial_window_asr_enabled: false,
        }
    }
}

pub struct ParapperClient {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    session_id: String,
}

pub fn recognition_url(port: u16) -> String {
    format!("ws://127.0.0.1:{port}/ws/recognition")
}

impl ParapperClient {
    pub fn connect(options: ParapperClientOptions) -> Result<Self, ParapperClientError> {
        let url: tungstenite::http::Uri = options.url.parse()?;
        let (mut socket, _) = connect(url)?;
        let start = ClientFrame::SessionStart {
            version: PROTOCOL_VERSION,
            session_id: options.session_id.clone(),
            audio: AudioParameters::pcm16(options.partial_window_asr_enabled),
        };
        socket.send(Message::Text(serialize_client_frame(&start)?.into()))?;
        Ok(Self { socket, session_id: options.session_id })
    }

    pub fn send_pcm16(&mut self, frame: &[u8]) -> Result<(), ParapperClientError> {
        validate_audio_frame(frame)?;
        for chunk in frame.chunks(MAX_AUDIO_FRAME_BYTES) {
            self.socket.send(Message::Binary(chunk.to_vec().into()))?;
        }
        Ok(())
    }

    pub fn receive(&mut self) -> Result<ServerEvent, ParapperClientError> {
        loop {
            let message = self.socket.read()?;
            let Message::Text(text) = message else {
                continue;
            };
            let event = parse_server_frame(text.as_str())?;
            if event_session_id(&event).is_none_or(|id| id == self.session_id) {
                return Ok(event);
            }
        }
    }

    pub fn stop(&mut self) -> Result<(), ParapperClientError> {
        let stop = ClientFrame::SessionStop {
            version: PROTOCOL_VERSION,
            session_id: self.session_id.clone(),
        };
        self.socket.send(Message::Text(serialize_client_frame(&stop)?.into()))?;
        Ok(())
    }

    pub fn cancel(&mut self) -> Result<(), ParapperClientError> {
        let cancel = ClientFrame::SessionCancel {
            version: PROTOCOL_VERSION,
            session_id: self.session_id.clone(),
        };
        self.socket.send(Message::Text(serialize_client_frame(&cancel)?.into()))?;
        Ok(())
    }
}

fn event_session_id(event: &ServerEvent) -> Option<&str> {
    match event {
        ServerEvent::SessionReady { session_id, .. }
        | ServerEvent::SpeechStarted { session_id, .. }
        | ServerEvent::SegmentClosed { session_id, .. }
        | ServerEvent::SessionDone { session_id, .. }
        | ServerEvent::SessionCancelled { session_id, .. } => Some(session_id),
        ServerEvent::TurnPartial(output)
        | ServerEvent::TurnFinal(output)
        | ServerEvent::TurnPartialWindow(output) => Some(&output.session_id),
        ServerEvent::Error { session_id, .. } => session_id.as_deref(),
        ServerEvent::Pong { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_tauri_and_native_urls_from_ports() {
        assert_eq!(recognition_url(18_082), "ws://127.0.0.1:18082/ws/recognition");
        assert_eq!(recognition_url(18_182), "ws://127.0.0.1:18182/ws/recognition");
    }

    #[test]
    fn options_use_the_port_derived_url() {
        let options = ParapperClientOptions::for_port(18_182, "native");
        assert_eq!(options.url, "ws://127.0.0.1:18182/ws/recognition");
        assert_eq!(options.session_id, "native");
    }
}
