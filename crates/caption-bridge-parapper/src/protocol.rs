//! Pure JSON frame types for Parapper recognition protocol v1.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_AUDIO_FRAME_BYTES: usize = 3_200;
pub const SAMPLE_RATE: u32 = 16_000;
pub const CHANNELS: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientFrame {
    #[serde(rename = "session.start")]
    SessionStart { version: u32, session_id: String, audio: AudioParameters },
    #[serde(rename = "session.stop")]
    SessionStop { version: u32, session_id: String },
    #[serde(rename = "session.cancel")]
    SessionCancel { version: u32, session_id: String },
    #[serde(rename = "ping")]
    Ping { version: u32, request_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioParameters {
    pub encoding: String,
    pub sample_rate: u32,
    pub channels: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_window_asr_enabled: Option<bool>,
}

impl AudioParameters {
    pub fn pcm16(partial_window_asr_enabled: bool) -> Self {
        Self {
            encoding: "pcm_s16le".to_string(),
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            partial_window_asr_enabled: Some(partial_window_asr_enabled),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type")]
pub enum ServerEvent {
    #[serde(rename = "session.ready")]
    SessionReady {
        version: u32,
        session_id: String,
        #[serde(default)]
        capabilities: Option<serde_json::Value>,
    },
    #[serde(rename = "speech.started")]
    SpeechStarted { version: u32, session_id: String },
    #[serde(rename = "segment.closed")]
    SegmentClosed { version: u32, session_id: String, segment_id: u64 },
    #[serde(rename = "turn.partial")]
    TurnPartial(TurnOutput),
    #[serde(rename = "turn.final")]
    TurnFinal(TurnOutput),
    #[serde(rename = "turn.partial_window")]
    TurnPartialWindow(TurnOutput),
    #[serde(rename = "session.done")]
    SessionDone { version: u32, session_id: String },
    #[serde(rename = "session.cancelled")]
    SessionCancelled { version: u32, session_id: String },
    #[serde(rename = "pong")]
    Pong { version: u32, request_id: String },
    #[serde(rename = "error")]
    Error {
        version: u32,
        #[serde(default)]
        session_id: Option<String>,
        code: String,
        message: String,
        #[serde(default)]
        fatal: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnOutput {
    pub version: u32,
    pub session_id: String,
    pub turn_session_id: u64,
    pub turn_id: u64,
    pub revision: u64,
    #[serde(default)]
    pub output_sequence: u64,
    pub segment_id: u64,
    #[serde(default)]
    pub previous_segment_id: Option<u64>,
    pub text: String,
    #[serde(default)]
    pub source_text: Option<String>,
    #[serde(default)]
    pub azookey_input_text: Option<String>,
    #[serde(default)]
    pub source_asr_model: String,
    #[serde(default = "default_source_language")]
    pub source_language: String,
    #[serde(default)]
    pub detected_language: Option<String>,
    #[serde(default)]
    pub elapsed_ms: u64,
    #[serde(default)]
    pub audio_duration_ms: Option<u64>,
    #[serde(flatten)]
    pub latency: LatencyTimestamps,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LatencyTimestamps {
    #[serde(default)]
    pub speech_start_at: Option<u64>,
    #[serde(default)]
    pub asr_dispatch_at: Option<u64>,
    #[serde(default)]
    pub first_partial_at: Option<u64>,
    #[serde(default)]
    pub asr_final_at: Option<u64>,
    #[serde(default)]
    pub speech_start: Option<u64>,
    #[serde(default)]
    pub asr_dispatch: Option<u64>,
    #[serde(default)]
    pub first_partial: Option<u64>,
    #[serde(default)]
    pub final_at: Option<u64>,
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("invalid JSON frame: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported protocol version {0}")]
    UnsupportedVersion(u32),
    #[error("unknown or invalid server frame type")]
    InvalidFrame,
    #[error("session id must not be empty")]
    EmptySessionId,
    #[error("audio frame must be non-empty and have an even byte length")]
    InvalidAudioFrame,
    #[error("audio frame exceeds {MAX_AUDIO_FRAME_BYTES} bytes")]
    AudioFrameTooLarge,
}

pub fn serialize_client_frame(frame: &ClientFrame) -> Result<String, ProtocolError> {
    let version = match frame {
        ClientFrame::SessionStart { version, .. }
        | ClientFrame::SessionStop { version, .. }
        | ClientFrame::SessionCancel { version, .. }
        | ClientFrame::Ping { version, .. } => *version,
    };
    validate_version(version)?;
    let session_id = match frame {
        ClientFrame::SessionStart { session_id, .. }
        | ClientFrame::SessionStop { session_id, .. }
        | ClientFrame::SessionCancel { session_id, .. } => Some(session_id),
        ClientFrame::Ping { .. } => None,
    };
    if session_id.is_some_and(|value| value.trim().is_empty()) {
        return Err(ProtocolError::EmptySessionId);
    }
    serde_json::to_string(frame).map_err(ProtocolError::from)
}

pub fn parse_server_frame(frame: &str) -> Result<ServerEvent, ProtocolError> {
    let value: serde_json::Value = serde_json::from_str(frame)?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or(ProtocolError::InvalidFrame)?;
    let version =
        u32::try_from(version).map_err(|_| ProtocolError::UnsupportedVersion(u32::MAX))?;
    validate_version(version)?;
    let parsed: ServerEvent = serde_json::from_value(value)?;
    Ok(parsed)
}

pub fn validate_audio_frame(frame: &[u8]) -> Result<(), ProtocolError> {
    if frame.is_empty() || !frame.len().is_multiple_of(2) {
        return Err(ProtocolError::InvalidAudioFrame);
    }
    if frame.len() > MAX_AUDIO_FRAME_BYTES {
        return Err(ProtocolError::AudioFrameTooLarge);
    }
    Ok(())
}

fn validate_version(version: u32) -> Result<(), ProtocolError> {
    (version == PROTOCOL_VERSION).then_some(()).ok_or(ProtocolError::UnsupportedVersion(version))
}

fn default_source_language() -> String {
    "ja".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_representative_final_fixture() {
        let event = parse_server_frame(
            r#"{"version":1,"type":"turn.final","session_id":"fixture-session","turn_session_id":7,"turn_id":3,"revision":2,"output_sequence":2,"segment_id":8,"previous_segment_id":7,"text":"こんにちは。","source_asr_model":"reazonspeech_k2_v2","source_language":"ja","detected_language":null,"audio_duration_ms":1280,"elapsed_ms":96}"#,
        )
        .expect("fixture must parse");
        let ServerEvent::TurnFinal(output) = event else { panic!("expected final") };
        assert_eq!(output.text, "こんにちは。");
        assert_eq!(output.turn_id, 3);
        assert_eq!(output.audio_duration_ms, Some(1280));
    }

    #[test]
    fn parses_partial_and_control_frames() {
        let partial = parse_server_frame(
            r#"{"version":1,"type":"turn.partial","session_id":"s","turn_session_id":1,"turn_id":2,"revision":4,"segment_id":3,"text":"かな","source_text":"仮名"}"#,
        )
        .expect("partial must parse");
        assert!(matches!(partial, ServerEvent::TurnPartial(_)));
        let ready = parse_server_frame(
            r#"{"version":1,"type":"session.ready","session_id":"s","capabilities":{"partial":true}}"#,
        )
        .expect("ready must parse");
        assert!(matches!(ready, ServerEvent::SessionReady { .. }));
    }

    #[test]
    fn serializes_session_start_and_validates_audio() {
        let frame = ClientFrame::SessionStart {
            version: PROTOCOL_VERSION,
            session_id: "s".to_string(),
            audio: AudioParameters::pcm16(false),
        };
        let json = serialize_client_frame(&frame).expect("start must serialize");
        assert!(json.contains("session.start"));
        assert!(json.contains("16000"));
        assert!(validate_audio_frame(&[0, 1]).is_ok());
        assert!(matches!(validate_audio_frame(&[]), Err(ProtocolError::InvalidAudioFrame)));
        assert!(matches!(validate_audio_frame(&[0]), Err(ProtocolError::InvalidAudioFrame)));
        assert!(matches!(
            validate_audio_frame(&vec![0; 3_202]),
            Err(ProtocolError::AudioFrameTooLarge)
        ));
    }
}
