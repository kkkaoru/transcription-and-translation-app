use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct RecognitionSourceMeta {
    pub turn_session_id: u64,
    pub turn_id: u64,
    pub turn_revision: u64,
    pub output_sequence: u64,
    pub segment_id: u64,
    pub previous_segment_id: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TurnCaptionLatency {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speech_start_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asr_dispatch_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_partial_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asr_final_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecognizedTextUpdateMode {
    Append,
    Replace,
}
