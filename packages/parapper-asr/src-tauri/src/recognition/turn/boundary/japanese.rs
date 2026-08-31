use std::{ops::Range, path::Path};

use anyhow::{Context, Result};
use caption_bridge_japanese_text::{
    MorphFeatureHead, comma_separated_feature_field, is_japanese_kana_text,
};
use tauri::AppHandle;
use vibrato_rkyv::{Dictionary, LoadMode, Tokenizer};

use super::{audio_window::audio_window_for_boundary, sample_end_for_char_end_or_ratio};
use crate::{
    model::{japanese_morph_dictionary_paths_from_root, models_root},
    recognition::{
        segmentation::vad::engine::VadResult,
        transcription::asr::engine::AsrTranscript,
        turn::{GrammarBoundaryClass, TurnBoundaryCandidate},
    },
};

pub(crate) struct JapaneseMorphAnalyzer {
    tokenizer: Tokenizer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct JapaneseMorphToken {
    pub(super) surface: String,
    pub(super) char_range: Range<usize>,
    pub(super) feature: String,
}

impl JapaneseMorphAnalyzer {
    pub(crate) fn from_dictionary_path(path: &Path) -> Result<Self> {
        let dict = Dictionary::from_path(path, LoadMode::TrustCache)
            .with_context(|| format!("Failed to read Vibrato dictionary: {}", path.display()))?;
        Ok(Self { tokenizer: Tokenizer::new(dict) })
    }

    pub(super) fn analyze(&self, text: &str) -> Vec<JapaneseMorphToken> {
        let mut worker = self.tokenizer.new_worker();
        worker.reset_sentence(text);
        worker.tokenize();
        (0..worker.num_tokens())
            .map(|index| {
                let token = worker.token(index);
                JapaneseMorphToken {
                    surface: token.surface().to_string(),
                    char_range: token.range_char(),
                    feature: token.feature().to_string(),
                }
            })
            .collect()
    }

    pub(crate) fn hiragana_text(&self, text: &str) -> String {
        hiragana_text_from_morph_tokens(text, &self.analyze(text))
    }
}

/// `UniDic` CWJ's `kana` field (F[20]) is the reading of the surface form, not
/// the lemma. That distinction keeps inflected words such as `行った` as
/// `いった`, rather than incorrectly reverting them to `いく`.
pub(crate) fn hiragana_text_from_morph_tokens(
    source: &str,
    morph_tokens: &[JapaneseMorphToken],
) -> String {
    let mut result = String::with_capacity(source.len());
    let mut cursor = 0;

    for token in morph_tokens {
        let Some(token_source) = source_char_range(source, token.char_range.clone()) else {
            return source.to_string();
        };
        if token.char_range.start < cursor {
            return source.to_string();
        }
        let Some(prefix) = source_char_range(source, cursor..token.char_range.start) else {
            return source.to_string();
        };
        result.push_str(prefix);
        result.push_str(
            &surface_hiragana_reading(&token.feature).unwrap_or_else(|| token_source.to_string()),
        );
        cursor = token.char_range.end;
    }

    let Some(suffix) = source_char_range(source, cursor..source.chars().count()) else {
        return source.to_string();
    };
    result.push_str(suffix);
    result
}

fn source_char_range(source: &str, range: Range<usize>) -> Option<&str> {
    if range.start > range.end {
        return None;
    }
    let start = byte_index_for_char_offset(source, range.start)?;
    let end = byte_index_for_char_offset(source, range.end)?;
    Some(&source[start..end])
}

fn byte_index_for_char_offset(source: &str, offset: usize) -> Option<usize> {
    if offset == source.chars().count() {
        return Some(source.len());
    }
    source.char_indices().nth(offset).map(|(index, _)| index)
}

fn surface_hiragana_reading(feature: &str) -> Option<String> {
    const UNIDIC_SURFACE_KANA_FIELD: usize = 20;
    let kana = comma_separated_feature_field(feature, UNIDIC_SURFACE_KANA_FIELD)?;
    (kana != "*" && is_japanese_kana_text(kana)).then(|| katakana_to_hiragana(kana))
}

fn katakana_to_hiragana(kana: &str) -> String {
    kana.chars()
        .map(|character| match character {
            '\u{30a1}'..='\u{30f6}' => char::from_u32(u32::from(character) - 0x60)
                .expect("katakana offset always maps to hiragana"),
            _ => character,
        })
        .collect()
}

pub(crate) fn load_japanese_morph_analyzer(handle: &AppHandle) -> Option<JapaneseMorphAnalyzer> {
    let root = match models_root(handle) {
        Ok(root) => root,
        Err(err) => {
            log::warn!("Failed to resolve model root for Japanese boundary analyzer: {err}");
            return None;
        }
    };
    let mut last_error = None;
    for path in
        japanese_morph_dictionary_paths_from_root(&root).into_iter().filter(|path| path.is_file())
    {
        match JapaneseMorphAnalyzer::from_dictionary_path(&path) {
            Ok(analyzer) => return Some(analyzer),
            Err(err) => {
                last_error = Some((path, err));
            }
        }
    }
    if let Some((path, err)) = last_error {
        log::warn!(
            "Failed to initialize Japanese boundary analyzer from {}: {err}",
            path.display()
        );
    }
    None
}

pub(super) fn japanese_morph_candidates(
    transcript: &AsrTranscript,
    audio_len: usize,
    vad_results: &[VadResult],
    morph_tokens: &[JapaneseMorphToken],
) -> Vec<TurnBoundaryCandidate> {
    let text_len = transcript.text.chars().count();
    morph_tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| {
            let class =
                japanese_morph_boundary_class(token, morph_tokens.get(index + 1), text_len)?;
            let char_end = token.char_range.end;
            let sample_end = sample_end_for_char_end_or_ratio(transcript, char_end, audio_len);
            let audio_window = audio_window_for_boundary(audio_len, vad_results, sample_end);
            Some(TurnBoundaryCandidate {
                char_end,
                sample_end,
                prefix_audio_end: audio_window.prefix_audio_end,
                suffix_audio_start: audio_window.suffix_audio_start,
                class,
            })
        })
        .collect()
}

fn japanese_morph_boundary_class(
    token: &JapaneseMorphToken,
    next: Option<&JapaneseMorphToken>,
    text_len: usize,
) -> Option<GrammarBoundaryClass> {
    let feature = token.feature.as_str();
    let is_terminal_token = token.char_range.end >= text_len;

    if matches!(token.surface.as_str(), "。" | "！" | "？" | "!" | "?") {
        return Some(GrammarBoundaryClass::StrongEnd);
    }
    if has_pos(feature, "補助記号", "句点") {
        return Some(GrammarBoundaryClass::StrongEnd);
    }
    if has_pos(feature, "補助記号", "読点") {
        return is_terminal_token.then_some(GrammarBoundaryClass::ClauseWeak);
    }
    if has_pos(feature, "助詞", "終助詞") {
        return Some(GrammarBoundaryClass::StrongEnd);
    }
    if has_any_pos2(feature, "助詞", &["格助詞", "係助詞", "副助詞", "準体助詞"]) {
        return is_terminal_token.then_some(GrammarBoundaryClass::Reject);
    }
    if has_pos(feature, "助詞", "接続助詞") {
        return is_terminal_token.then_some(GrammarBoundaryClass::ClauseWeak);
    }
    if has_any_pos1(feature, &["動詞", "形容詞", "助動詞"]) {
        if has_any_cform(feature, &["未然形", "連用形", "仮定形"]) {
            return is_terminal_token.then_some(GrammarBoundaryClass::Reject);
        }
        if has_cform(feature, "連体形") {
            return if is_terminal_token || next.is_some_and(token_can_continue_after_predicate) {
                is_terminal_token.then_some(GrammarBoundaryClass::Reject)
            } else {
                Some(GrammarBoundaryClass::PredicateEnd)
            };
        }
        if has_any_cform(feature, &["終止形", "命令形", "意志推量形"]) {
            return if is_terminal_token || !next.is_some_and(token_can_continue_after_predicate) {
                Some(GrammarBoundaryClass::PredicateEnd)
            } else {
                None
            };
        }
    }
    if has_any_pos1(feature, &["名詞", "代名詞"]) {
        return is_terminal_token.then_some(GrammarBoundaryClass::NormalEnd);
    }
    if has_pos1(feature, "接尾辞") && is_nominal_suffix(feature) {
        return is_terminal_token.then_some(GrammarBoundaryClass::NormalEnd);
    }
    if has_pos1(feature, "形状詞") {
        return is_terminal_token.then_some(GrammarBoundaryClass::NormalEnd);
    }
    // Fixed greetings often sit alone before a same-breath continuation
    // (こんにちはきこえますか). Treating them as NormalEnd finalizes the turn at
    // turn-check silence and drops the continuation onto a new turn id. Keep the
    // turn open (ClauseWeak) so completion ASR can still see the whole phrase;
    // genuine end-of-speech still closes via the silence timeout path.
    if is_fixed_greeting_surface(token.surface.as_str()) {
        return is_terminal_token.then_some(GrammarBoundaryClass::ClauseWeak);
    }
    if has_pos1(feature, "感動詞") {
        return if matches!(token.surface.as_str(), "はい" | "うん" | "ええ" | "いいえ") {
            Some(GrammarBoundaryClass::StrongEnd)
        } else {
            // Other interjections are weak ends for the same reason as greetings:
            // a short pause must not seal the turn before trailing speech arrives.
            is_terminal_token.then_some(GrammarBoundaryClass::ClauseWeak)
        };
    }
    if has_any_pos1(feature, &["接頭辞", "連体詞"]) {
        return is_terminal_token.then_some(GrammarBoundaryClass::Reject);
    }
    None
}

fn token_can_continue_after_predicate(token: &JapaneseMorphToken) -> bool {
    let feature = token.feature.as_str();
    matches!(token.surface.as_str(), "、" | "," | "ので" | "けど" | "から" | "し")
        || has_pos(feature, "補助記号", "読点")
        || has_pos(feature, "助詞", "接続助詞")
        || has_pos(feature, "助詞", "終助詞")
        || has_any_pos1(feature, &["名詞", "代名詞", "接尾辞"])
}

fn is_fixed_greeting_surface(surface: &str) -> bool {
    matches!(
        surface,
        "こんにちは"
            | "こんばんは"
            | "おはようございます"
            | "おはよう"
            | "さようなら"
            | "こんにちはー"
            | "こんばんはー"
    )
}

fn has_pos(feature: &str, pos1: &str, pos2: &str) -> bool {
    feature_pos1(feature).is_some_and(|field| field == pos1)
        && feature_pos2(feature).is_some_and(|field| field == pos2)
}

pub(super) fn has_pos1(feature: &str, pos1: &str) -> bool {
    feature_pos1(feature).is_some_and(|field| field == pos1)
}

fn has_any_pos1(feature: &str, pos1_values: &[&str]) -> bool {
    pos1_values.iter().any(|pos1| has_pos1(feature, pos1))
}

fn has_any_pos2(feature: &str, pos1: &str, pos2_values: &[&str]) -> bool {
    pos2_values.iter().any(|pos2| has_pos(feature, pos1, pos2))
}

fn has_cform(feature: &str, cform: &str) -> bool {
    feature.contains(cform)
}

fn has_any_cform(feature: &str, cforms: &[&str]) -> bool {
    cforms.iter().any(|cform| has_cform(feature, cform))
}

pub(super) fn is_nominal_suffix(feature: &str) -> bool {
    feature_pos2(feature).is_some_and(|field| field.starts_with("名詞的") || field.contains("名詞"))
}

fn feature_pos1(feature: &str) -> Option<&str> {
    let pos1 = MorphFeatureHead::parse(feature).pos1;
    (!pos1.is_empty()).then_some(pos1)
}

fn feature_pos2(feature: &str) -> Option<&str> {
    let pos2 = MorphFeatureHead::parse(feature).pos2;
    (!pos2.is_empty()).then_some(pos2)
}
