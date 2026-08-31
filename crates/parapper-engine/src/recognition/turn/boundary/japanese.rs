use std::{ops::Range, path::Path};

use anyhow::{Context, Result};
use caption_bridge_japanese_text::{
    MorphFeatureHead, comma_separated_feature_field, is_japanese_kana_text,
    katakana_to_hiragana_char,
};
use vibrato_rkyv::{Dictionary, LoadMode, Tokenizer};

use super::{audio_window::audio_window_for_boundary, sample_end_for_char_end_or_ratio};
use crate::{
    model::japanese_morph_dictionary_paths_from_root,
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

const UNIDIC_KANA_FIELD_INDEX: usize = 20;

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

    pub(crate) fn reading(&self, text: &str) -> String {
        canonical_reading(&self.analyze(text))
    }
}

fn canonical_reading(tokens: &[JapaneseMorphToken]) -> String {
    let mut reading = String::new();
    for token in tokens {
        let token_reading = comma_separated_feature_field(&token.feature, UNIDIC_KANA_FIELD_INDEX)
            .filter(|field| *field != "*" && is_japanese_kana_text(field))
            .unwrap_or(token.surface.as_str());
        reading.extend(token_reading.chars().map(katakana_to_hiragana_char));
    }
    reading
}

pub(crate) fn load_japanese_morph_analyzer(root: &Path) -> Option<JapaneseMorphAnalyzer> {
    let mut last_error = None;
    for path in
        japanese_morph_dictionary_paths_from_root(root).into_iter().filter(|path| path.is_file())
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
    // A greeting at the text end is a complete utterance once turn-check silence
    // has elapsed. Shorter same-breath pauses never reach this grammar check and
    // remain in the same segment, while a genuine pause must not keep the greeting
    // open long enough to absorb the next utterance.
    if is_fixed_greeting_surface(token.surface.as_str()) {
        return is_terminal_token.then_some(GrammarBoundaryClass::NormalEnd);
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

#[cfg(test)]
mod reading_tests {
    use super::{JapaneseMorphToken, canonical_reading};

    #[test]
    fn canonical_reading_uses_unidic_kana_instead_of_the_asr_surface() {
        let tokens = vec![
            JapaneseMorphToken {
                surface: "聞こえ".to_string(),
                char_range: 0..3,
                feature: "動詞,一般,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,キコエ".to_string(),
            },
            JapaneseMorphToken {
                surface: "ますか".to_string(),
                char_range: 3..6,
                feature: "助動詞,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,マスカ".to_string(),
            },
        ];

        assert_eq!(canonical_reading(&tokens), "きこえますか");
    }

    #[test]
    fn canonical_reading_preserves_numeric_counter_pronunciation() {
        let tokens = vec![
            JapaneseMorphToken {
                surface: "六十".to_string(),
                char_range: 0..2,
                feature: "名詞,数詞,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,ロクジュウ".to_string(),
            },
            JapaneseMorphToken {
                surface: "度".to_string(),
                char_range: 2..3,
                feature: "名詞,普通名詞,助数詞可能,*,*,*,ド,度,度,ド,度,ド,漢,*,*,*,*,*,\"B,B4WB7G9G\",体,ド,ド,ド,ド,0,C3,*,7407143582048768,26947"
                    .to_string(),
            },
        ];

        assert_eq!(canonical_reading(&tokens), "ろくじゅうど");
    }

    #[test]
    fn canonical_reading_handles_quoted_feature_fields_across_units() {
        let tokens = vec![
            JapaneseMorphToken {
                surface: "度".to_string(),
                char_range: 0..1,
                feature: "名詞,普通名詞,助数詞可能,*,*,*,ド,度,度,ド,度,ド,漢,*,*,*,*,*,\"B,B4WB7G9G\",体,ド"
                    .to_string(),
            },
            JapaneseMorphToken {
                surface: "℃".to_string(),
                char_range: 1..2,
                feature: "名詞,普通名詞,助数詞可能,*,*,*,ド,度,℃,ド,℃,ド,記号,*,*,*,*,*,\"B,B4WB7G9G\",体,ド"
                    .to_string(),
            },
            JapaneseMorphToken {
                surface: "円".to_string(),
                char_range: 2..3,
                feature: "名詞,普通名詞,助数詞可能,*,*,*,エン,円,円,エン,円,エン,漢,*,*,*,*,*,\"A,B,C\",体,エン"
                    .to_string(),
            },
        ];

        assert_eq!(canonical_reading(&tokens), "どどえん");
    }

    #[test]
    fn canonical_reading_rejects_non_kana_fields_after_schema_drift() {
        let tokens = vec![JapaneseMorphToken {
            surface: "温度".to_string(),
            char_range: 0..2,
            feature:
                "名詞,普通名詞,一般,*,*,*,オンド,温度,温度,オンド,温度,オンド,漢,*,*,*,*,*,*,体,体"
                    .to_string(),
        }];

        assert_eq!(canonical_reading(&tokens), "温度");
    }

    #[test]
    fn canonical_reading_preserves_unknown_tokens_without_a_kana_field() {
        let tokens = vec![JapaneseMorphToken {
            surface: "VRChat？".to_string(),
            char_range: 0..7,
            feature: "未知語,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*,*".to_string(),
        }];

        assert_eq!(canonical_reading(&tokens), "VRChat？");
    }
}
