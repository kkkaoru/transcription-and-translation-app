//! Protocol, queue, and synchronous WebSocket transport for Parapper recognition.
//!
//! This crate runs with Rust 1.88 and is intentionally independent of any GUI
//! framework. The protocol module is pure and can be used without opening a
//! socket.
#![forbid(unsafe_code)]

pub mod client;
pub mod protocol;
pub mod queue;

pub use client::{recognition_url, ParapperClient, ParapperClientError, ParapperClientOptions};
pub use protocol::{
    parse_server_frame, serialize_client_frame, validate_audio_frame, AudioParameters, ClientFrame,
    ProtocolError, ServerEvent, TurnOutput, MAX_AUDIO_FRAME_BYTES, PROTOCOL_VERSION,
};
pub use queue::{Clock, OutputQueue, QueueDecision, QueueStats, SystemClock};
