use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};

use crate::config::{LocalTranslationModel, TranslationLanguage};
use crate::lfm2_onnx_translation_engine::LocalTranslationEngine;
use crate::quickmt_translation_engine::QuickMtJaEnEngine;

const LFM2_MODEL_DIR: &str = "lfm2-350m-enjp-mt-onnx-q4";
const CHRF_MAX_CHARACTER_ORDER: usize = 6;
const F_SCORE_BETA_SQUARED: f64 = 4.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslationComparisonBackend {
    QuickMtInt8,
    Lfm2Q4,
}

pub struct TranslationComparisonEngine {
    engine: ComparisonEngine,
}

enum ComparisonEngine {
    QuickMt(QuickMtJaEnEngine),
    Lfm2(Box<LocalTranslationEngine>),
}

impl TranslationComparisonEngine {
    pub fn load(models_root: &Path, backend: TranslationComparisonBackend) -> Result<Self> {
        let engine = match backend {
            TranslationComparisonBackend::QuickMtInt8 => {
                ComparisonEngine::QuickMt(QuickMtJaEnEngine::load(models_root)?)
            }
            TranslationComparisonBackend::Lfm2Q4 => {
                let model_dir = models_root.join(LFM2_MODEL_DIR);
                let engine =
                    LocalTranslationEngine::load(&model_dir, LocalTranslationModel::Lfm2Q4)
                        .with_context(|| {
                            format!(
                                "could not load comparison LFM2 model from {}",
                                model_dir.display()
                            )
                        })?;
                ComparisonEngine::Lfm2(Box::new(engine))
            }
        };
        Ok(Self { engine })
    }

    pub fn translate_ja_to_en(&mut self, text: &str) -> Result<String> {
        match &mut self.engine {
            ComparisonEngine::QuickMt(engine) => engine.translate(text),
            ComparisonEngine::Lfm2(engine) => {
                engine.translate(TranslationLanguage::Ja, TranslationLanguage::En, text)
            }
        }
    }
}

pub fn chrf2_score(candidate: &str, reference: &str) -> f64 {
    let candidate = normalized_characters(candidate);
    let reference = normalized_characters(reference);
    if candidate.is_empty() || reference.is_empty() {
        return if candidate.is_empty() && reference.is_empty() { 100.0 } else { 0.0 };
    }
    let scores = (1..=CHRF_MAX_CHARACTER_ORDER)
        .filter_map(|order| character_ngram_precision_recall(&candidate, &reference, order))
        .collect::<Vec<_>>();
    if scores.is_empty() {
        return 0.0;
    }
    let precision = scores.iter().map(|score| score.0).sum::<f64>() / scores.len() as f64;
    let recall = scores.iter().map(|score| score.1).sum::<f64>() / scores.len() as f64;
    if precision == 0.0 || recall == 0.0 {
        return 0.0;
    }
    let score = (1.0 + F_SCORE_BETA_SQUARED) * precision * recall
        / (F_SCORE_BETA_SQUARED * precision + recall);
    score * 100.0
}

fn normalized_characters(text: &str) -> Vec<char> {
    text.chars().flat_map(char::to_lowercase).filter(|value| !value.is_whitespace()).collect()
}

fn character_ngram_precision_recall(
    candidate: &[char],
    reference: &[char],
    order: usize,
) -> Option<(f64, f64)> {
    if candidate.len() < order || reference.len() < order {
        return None;
    }
    let candidate_counts = character_ngram_counts(candidate, order);
    let reference_counts = character_ngram_counts(reference, order);
    let candidate_total = candidate_counts.values().sum::<usize>();
    let reference_total = reference_counts.values().sum::<usize>();
    let overlap = candidate_counts
        .iter()
        .map(|(ngram, count)| (*count).min(reference_counts.get(ngram).copied().unwrap_or(0)))
        .sum::<usize>();
    Some((overlap as f64 / candidate_total as f64, overlap as f64 / reference_total as f64))
}

fn character_ngram_counts(characters: &[char], order: usize) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for window in characters.windows(order) {
        *counts.entry(window.iter().collect()).or_insert(0) += 1;
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::{TranslationComparisonBackend, chrf2_score};

    #[test]
    fn identical_translation_has_full_character_score() {
        assert_eq!(chrf2_score("Hello world", "hello world"), 100.0);
    }

    #[test]
    fn unrelated_translation_has_zero_character_score() {
        assert_eq!(chrf2_score("abc", "XYZ"), 0.0);
    }

    #[test]
    fn partial_translation_has_bounded_character_score() {
        let score = chrf2_score("translation", "translated");
        assert!(score > 0.0);
        assert!(score < 100.0);
    }

    #[test]
    fn empty_translation_scores_only_against_empty_reference() {
        assert_eq!(chrf2_score("", ""), 100.0);
        assert_eq!(chrf2_score("", "caption"), 0.0);
    }

    #[test]
    fn comparison_backend_distinguishes_runtime_implementations() {
        assert_ne!(TranslationComparisonBackend::QuickMtInt8, TranslationComparisonBackend::Lfm2Q4);
    }
}
