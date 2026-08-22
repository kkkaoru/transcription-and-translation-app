//! Caption payload types used by display algorithms.
//!
//! This is a display-layer subset of the TypeScript `CaptionPayload`. It does
//! not model IPC, ASR latency, or merge.

/// User-facing caption phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptionStage {
    Source,
    Translation,
}

/// Caption row identity used by layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptionRowKey {
    Source,
    Translation,
    Prediction,
}

/// Display-layer caption surface.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptionPayload {
    pub id: String,
    pub source_text: String,
    pub azookey_input_text: Option<String>,
    pub translation_text: String,
    pub source_language: String,
    pub target_language: String,
    pub started_at: i64,
    pub received_at: i64,
    pub stage: Option<CaptionStage>,
    pub sequence: Option<i64>,
    pub is_final: Option<bool>,
    pub provisional: Option<bool>,
    pub capture_generation: Option<i64>,
    pub sentence_end_offsets: Option<Vec<usize>>,
    pub soft_break_offsets: Option<Vec<usize>>,
}

impl CaptionPayload {
    /// True when `is_final` is explicitly `true`.
    pub fn is_final_true(&self) -> bool {
        self.is_final == Some(true)
    }

    /// True when `provisional` is explicitly `true`.
    pub fn is_provisional(&self) -> bool {
        self.provisional == Some(true)
    }

    /// True when either source or translation has non-whitespace text.
    pub fn has_visible_text(&self) -> bool {
        !self.source_text.trim().is_empty() || !self.translation_text.trim().is_empty()
    }
}
