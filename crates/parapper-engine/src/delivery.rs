pub(crate) use crate::recognition::control::events::RecognitionSourceMeta;

use crate::{
    config::{AsrLanguage, AsrModel},
    recognition::{
        control::events::{RecognizedTextUpdateMode, TurnCaptionLatency},
        transcription::route::RecognitionRoute,
    },
};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecognizedTextMeta {
    pub(crate) id: String,
    pub(crate) is_final: bool,
    pub(crate) update_mode: RecognizedTextUpdateMode,
    pub(crate) source: RecognitionSourceMeta,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RecognizedTextOutput {
    pub(crate) phrase: Arc<[f32]>,
    pub(crate) text: String,
    pub(crate) source_asr_model: AsrModel,
    pub(crate) source_language: AsrLanguage,
    pub(crate) detected_language: Option<String>,
    pub(crate) meta: RecognizedTextMeta,
    pub(crate) elapsed_millis: u128,
    pub(crate) caption_latency: TurnCaptionLatency,
}

impl RecognizedTextOutput {
    pub(crate) fn new(
        phrase: Vec<f32>,
        text: String,
        source_asr_model: AsrModel,
        source_language: AsrLanguage,
        detected_language: Option<String>,
        meta: RecognizedTextMeta,
        elapsed_millis: u128,
    ) -> Self {
        Self {
            phrase: phrase.into(),
            text,
            source_asr_model,
            source_language,
            detected_language,
            meta,
            elapsed_millis,
            caption_latency: TurnCaptionLatency::default(),
        }
    }

    pub(crate) fn from_route(
        phrase: Vec<f32>,
        text: String,
        route: RecognitionRoute,
        detected_language: Option<String>,
        meta: RecognizedTextMeta,
        elapsed_millis: u128,
    ) -> Self {
        Self::new(
            phrase,
            text,
            route.model,
            route.language,
            detected_language,
            meta,
            elapsed_millis,
        )
    }
}

pub(crate) fn join_turn_segments(segments: &[String], language: AsrLanguage) -> String {
    let mut text = String::new();
    for segment in
        segments.iter().map(|segment| segment.trim()).filter(|segment| !segment.is_empty())
    {
        if !text.is_empty() && language != AsrLanguage::Japanese {
            text.push(' ');
        }
        text.push_str(segment);
    }
    text
}

pub(crate) fn continuing_turn_text(text: &str) -> String {
    let text = text.trim().trim_end_matches("...");
    if text.is_empty() { String::new() } else { format!("{text}...") }
}

pub(crate) fn finalize_turn_text(text: &str, language: AsrLanguage) -> String {
    let text = text.trim().trim_end_matches("...");
    if language != AsrLanguage::Japanese
        || text.is_empty()
        || text.chars().last().is_some_and(|character| matches!(character, '。' | '！' | '？'))
    {
        text.to_string()
    } else {
        format!("{text}。")
    }
}

impl RecognizedTextMeta {
    pub(crate) fn replace_turn_output(
        id: String,
        source: RecognitionSourceMeta,
        is_final: bool,
    ) -> Self {
        Self { id, is_final, update_mode: RecognizedTextUpdateMode::Replace, source }
    }
}
