//! ASR-specific rescoring stage for kana N-best candidates.
//!
//! Sits between ASR output and kana-kanji conversion. Generates correction
//! candidates using ASR-specific acoustic confusion rules (not the keyboard-typo
//! error model the published `input_n5_lm_v1` model shipped with), scores them
//! with a pluggable language model, and re-ranks them.
//!
//! ## Hiragana to katakana normalization
//!
//! The published model was trained on katakana/romaji-flavored data. Hiragana
//! token ids have zero counts in the tries, so feeding raw hiragana yields a
//! uniform distribution that cannot discriminate between candidates (measured
//! empirically; see `examples/rescore_measure.rs`). However, normalizing
//! hiragana to katakana before tokenizing maps to token ids the model *does*
//! have counts for. [`LmScorer`] therefore normalizes all input to katakana
//! before scoring, and the rescoring pipeline keeps the original hiragana text
//! for downstream kana-kanji conversion.
//!
//! ## Scoring formula
//!
//! The combined score for each candidate is:
//!
//! ```text
//! combined_score = lm_weight * lm_score - confusion_weight * confusion_cost
//! ```
//!
//! Where `lm_score` is the log-probability of the katakana-normalized candidate
//! under the language model, and `confusion_cost` is the acoustic edit cost of
//! generating the candidate from the original hypothesis. Higher combined
//! score is better.
//!
//! ## Parameter calibration (measured, not assumed)
//!
//! [`examples/rescore_sweep.rs`] sweeps `lm_weight`, `confusion_weight`, and
//! `overcorrection_margin` against the real model over a fixed hiragana eval
//! set (5 rule-covered repairs + 9 correct-form holds). The shipped defaults
//! (`1.0 / 1.0 / 0.0`) score 9/14 combined: they fix the one high-frequency
//! long-vowel rescue (`おはよございます` → `おはようございます`) but also
//! overcorrect the correct geminated `きってください` → `きてください`. Every
//! combination with `overcorrection_margin >= 2.0` reclaims that hold and
//! scores 10/14 without losing the lone repair. No combination fixes more than
//! one repair, because the LM is direction-biased: it rewards the shorter /
//! more-frequent form and therefore cannot add length back except on
//! frequency-rescue pairs. Recommendation: wire the rescorer in with a positive
//! `overcorrection_margin` (>= 2.0) and weights near `1.0 / 1.0`.

use std::collections::HashSet;

use crate::model::EfficientNGram;
use crate::tokenizer::ZenzTokenizer;
use crate::trie::NgramTrie;

// ---------------------------------------------------------------------------
// Hiragana / katakana conversion
// ---------------------------------------------------------------------------

/// Converts hiragana to katakana by adding 0x60 to each codepoint in the
/// U+3041 to U+309E range. Non-hiragana characters pass through unchanged.
pub fn hiragana_to_katakana(s: &str) -> String {
    s.chars()
        .map(|c| {
            let code = c as u32;
            if (0x3041..=0x309E).contains(&code) {
                char::from_u32(code + 0x60).unwrap_or(c)
            } else {
                c
            }
        })
        .collect()
}

/// Converts katakana to hiragana by subtracting 0x60 from each codepoint in the
/// U+30A1 to U+30FE range. Non-katakana characters pass through unchanged.
pub fn katakana_to_hiragana(s: &str) -> String {
    s.chars()
        .map(|c| {
            let code = c as u32;
            if (0x30A1..=0x30FE).contains(&code) {
                char::from_u32(code - 0x60).unwrap_or(c)
            } else {
                c
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Candidate types
// ---------------------------------------------------------------------------

/// A candidate correction generated from an ASR hypothesis.
#[derive(Debug, Clone, PartialEq)]
pub struct RescoreCandidate {
    /// The candidate text in hiragana (for downstream kana-kanji conversion).
    pub text: String,
    /// The acoustic confusion cost of generating this candidate from the
    /// original hypothesis. Zero means the candidate is identical to the
    /// original. Lower is better.
    pub confusion_cost: f64,
}

/// A candidate with its scores attached, produced by [`Rescorer::rescore`].
#[derive(Debug, Clone, PartialEq)]
pub struct RankedCandidate {
    /// The candidate text in hiragana.
    pub text: String,
    /// The language model score (log-probability; higher is more natural).
    pub lm_score: f64,
    /// The confusion cost of generating this candidate (lower is better).
    pub confusion_cost: f64,
    /// The combined score: `lm_weight * lm_score - confusion_weight * confusion_cost`.
    /// Higher is better.
    pub combined_score: f64,
}

// ---------------------------------------------------------------------------
// N-best candidate types
// ---------------------------------------------------------------------------

/// An ASR N-best hypothesis with its acoustic/decoder score, ready for LM
/// re-ranking via [`Rescorer::rerank_nbest`].
///
/// Unlike the 1-best path (where [`AsrConfusionRules`] generates correction
/// candidates from a single hypothesis), the N-best path re-ranks candidates
/// that the ASR decoder already produced. No edit-distance candidates are
/// generated, so `confusion_cost` is always zero for these candidates and the
/// combined score reduces to `acoustic_score + lm_weight * lm_score`.
///
/// The acoustic score is the ASR decoder's log-probability for the hypothesis
/// (higher is better). The LM score is the kana-language-model log-probability
/// from the plugged-in [`CandidateScorer`]. Combining them keeps the acoustic
/// evidence in the loop — the LM alone must not override a strongly preferred
/// ASR hypothesis, which is also enforced by the overcorrection gate in
/// [`Rescorer::best_nbest`].
#[derive(Debug, Clone, PartialEq)]
pub struct NbestCandidate {
    /// The candidate text in hiragana (for downstream kana-kanji conversion).
    pub text: String,
    /// The ASR acoustic/decoder score (log-probability; higher is better).
    pub acoustic_score: f64,
}

/// An N-best candidate with its LM and combined scores attached, produced by
/// [`Rescorer::rerank_nbest`].
#[derive(Debug, Clone, PartialEq)]
pub struct RankedNbestCandidate {
    /// The candidate text in hiragana.
    pub text: String,
    /// The original ASR acoustic/decoder score.
    pub acoustic_score: f64,
    /// The language model score (log-probability; higher is more natural).
    pub lm_score: f64,
    /// The combined score: `acoustic_score + lm_weight * lm_score`.
    /// Higher is better.
    pub combined_score: f64,
}

// ---------------------------------------------------------------------------
// ASR confusion rules
// ---------------------------------------------------------------------------

/// ASR-specific acoustic confusion rules for candidate generation.
///
/// Unlike the keyboard-typo error model the published model shipped with
/// (which uses QWERTY adjacency or iOS flick input groups), these rules model
/// acoustic confusions that occur in speech recognition:
///
/// - **Voiced/unvoiced consonant substitution**: か to が, た to だ, etc.
/// - **Acoustically similar mora substitution**: し to い, ち to し, etc.
/// - **Long vowel insertion/deletion**: おはよ to おはよう (missing う)
/// - **Gemination (っ) insertion/deletion**: きて to きって (missing っ)
///
/// Each operation has an associated cost. The candidate generation is a
/// bounded edit-distance search: at each position, each applicable operation
/// produces a new candidate.
#[derive(Debug, Clone)]
pub struct AsrConfusionRules {
    /// Cost of substituting a consonant with its voiced/unvoiced equivalent.
    pub voicing_cost: f64,
    /// Cost of substituting acoustically similar moras.
    pub mora_substitution_cost: f64,
    /// Cost of inserting a long vowel.
    pub long_vowel_insert_cost: f64,
    /// Cost of deleting a long vowel.
    pub long_vowel_delete_cost: f64,
    /// Cost of inserting a gemination (っ).
    pub gemination_insert_cost: f64,
    /// Cost of deleting a gemination (っ).
    pub gemination_delete_cost: f64,
    /// Maximum number of edits from the original hypothesis.
    pub max_edits: usize,
}

impl Default for AsrConfusionRules {
    fn default() -> Self {
        Self {
            voicing_cost: 1.0,
            mora_substitution_cost: 1.5,
            long_vowel_insert_cost: 0.8,
            long_vowel_delete_cost: 0.8,
            gemination_insert_cost: 0.9,
            gemination_delete_cost: 0.9,
            max_edits: 1,
        }
    }
}

impl AsrConfusionRules {
    /// Generates correction candidates for `hypothesis`.
    ///
    /// The original hypothesis is always included with cost 0. All other
    /// candidates are generated by applying the confusion rules at each
    /// position, up to `max_edits` edits away. Candidates are deduplicated
    /// by text, keeping the lowest cost.
    pub fn generate(&self, hypothesis: &str) -> Vec<RescoreCandidate> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut candidates: Vec<RescoreCandidate> = Vec::new();

        // The original is always a candidate.
        candidates.push(RescoreCandidate { text: hypothesis.to_string(), confusion_cost: 0.0 });
        seen.insert(hypothesis.to_string());

        // Edit-1 candidates.
        let edit_1 = self.edit_1_candidates(hypothesis);
        for c in edit_1 {
            if seen.insert(c.text.clone()) {
                candidates.push(c);
            }
        }

        // Edit-2 candidates (if enabled).
        if self.max_edits >= 2 {
            let edit_1_only: Vec<RescoreCandidate> =
                candidates.iter().filter(|c| c.text != hypothesis).cloned().collect();
            for parent in &edit_1_only {
                let edit_2 = self.edit_1_candidates(&parent.text);
                for c in edit_2 {
                    let total_cost = parent.confusion_cost + c.confusion_cost;
                    if seen.insert(c.text.clone()) {
                        candidates
                            .push(RescoreCandidate { text: c.text, confusion_cost: total_cost });
                    }
                }
            }
        }

        candidates
    }

    /// Generates all single-edit candidates from `text`.
    fn edit_1_candidates(&self, text: &str) -> Vec<RescoreCandidate> {
        let mut out = Vec::new();
        let chars: Vec<char> = text.chars().collect();

        // --- Substitutions: voicing, semi-voicing, similar mora ---
        for (i, &ch) in chars.iter().enumerate() {
            if let Some(replacement) = voicing_pair(ch) {
                out.push(RescoreCandidate {
                    text: substitute_char(&chars, i, replacement),
                    confusion_cost: self.voicing_cost,
                });
            }
            if let Some(replacement) = semi_voicing_pair(ch) {
                out.push(RescoreCandidate {
                    text: substitute_char(&chars, i, replacement),
                    confusion_cost: self.voicing_cost,
                });
            }
            for &replacement in similar_moras(ch) {
                out.push(RescoreCandidate {
                    text: substitute_char(&chars, i, replacement),
                    confusion_cost: self.mora_substitution_cost,
                });
            }
        }

        // --- Insertions: long vowel, gemination ---
        for i in 0..=chars.len() {
            // Long vowel insertion: insert the extending vowel after position i-1.
            if i > 0 {
                if let Some(vowel) = long_vowel_for(chars[i - 1]) {
                    out.push(RescoreCandidate {
                        text: insert_char(&chars, i, vowel),
                        confusion_cost: self.long_vowel_insert_cost,
                    });
                }
            }
            // Gemination insertion: insert っ before certain consonants.
            if i < chars.len() && can_geminate(chars[i]) {
                out.push(RescoreCandidate {
                    text: insert_char(&chars, i, 'っ'),
                    confusion_cost: self.gemination_insert_cost,
                });
            }
        }

        // --- Deletions: long vowel, gemination ---
        for (i, &ch) in chars.iter().enumerate() {
            // Long vowel deletion: remove a vowel that extends the previous one.
            if i > 0 && is_long_vowel(chars[i - 1], ch) {
                out.push(RescoreCandidate {
                    text: delete_char(&chars, i),
                    confusion_cost: self.long_vowel_delete_cost,
                });
            }
            // Gemination deletion: remove っ.
            if ch == 'っ' {
                out.push(RescoreCandidate {
                    text: delete_char(&chars, i),
                    confusion_cost: self.gemination_delete_cost,
                });
            }
        }

        out
    }
}

// ---------------------------------------------------------------------------
// Pluggable scorer
// ---------------------------------------------------------------------------

/// Pluggable scoring interface for candidate ranking.
///
/// The default implementation, [`LmScorer`], uses [`EfficientNGram`] to score
/// the naturalness of a kana string. Because the published model was trained
/// on katakana/romaji-flavored data, the scorer normalizes hiragana to
/// katakana before tokenizing. A better-suited LM can be dropped in by
/// implementing this trait.
pub trait CandidateScorer {
    /// Returns a score representing the naturalness of the kana string.
    /// Higher is better.
    fn score(&self, text: &str) -> f64;
}

/// Language-model-based scorer that normalizes hiragana to katakana before
/// tokenizing and scoring.
///
/// Because the published `input_n5_lm_v1` was trained on katakana/romaji data,
/// feeding raw hiragana yields uniform, non-discriminating distributions.
/// Normalizing to katakana first maps to token ids the model actually has
/// counts for.
///
/// The score is the total log-probability of the sequence:
///
/// ```text
/// score(text) = sum of log P(token[i] | token[0..i-1])
/// ```
///
/// where tokens are produced by encoding the katakana-normalized text with
/// the GPT-2 byte-level BPE tokenizer. Higher (less negative) is better.
pub struct LmScorer<T: NgramTrie> {
    model: EfficientNGram<T>,
    tokenizer: ZenzTokenizer,
}

impl<T: NgramTrie> LmScorer<T> {
    /// Creates a scorer from a model and tokenizer.
    pub fn new(model: EfficientNGram<T>, tokenizer: ZenzTokenizer) -> Self {
        Self { model, tokenizer }
    }

    /// Computes the log-probability of the sequence `text` (normalized to
    /// katakana) under the language model.
    fn sequence_log_prob(&self, text: &str) -> f64 {
        let katakana = hiragana_to_katakana(text);
        let tokens = self.tokenizer.encode_slow(&katakana);

        if tokens.is_empty() {
            return 0.0;
        }

        let mut log_prob = 0.0;
        for i in 0..tokens.len() {
            let context = &tokens[..i];
            let probs = self.model.bulk_predict(context);
            let prob = probs.get(tokens[i]).copied().unwrap_or(0.0);
            if prob > 0.0 {
                log_prob += prob.ln();
            } else {
                // Floor: log of a very small probability for zero-prob tokens.
                log_prob -= 20.0;
            }
        }
        log_prob
    }

    /// The underlying model.
    pub fn model(&self) -> &EfficientNGram<T> {
        &self.model
    }

    /// The underlying tokenizer.
    pub fn tokenizer(&self) -> &ZenzTokenizer {
        &self.tokenizer
    }
}

impl<T: NgramTrie> CandidateScorer for LmScorer<T> {
    fn score(&self, text: &str) -> f64 {
        self.sequence_log_prob(text)
    }
}

// ---------------------------------------------------------------------------
// Rescorer
// ---------------------------------------------------------------------------

/// The rescoring stage.
///
/// Combines ASR confusion rules with a pluggable scorer to re-rank kana
/// N-best candidates from ASR output.
///
/// # Example
///
/// ```
/// use caption_bridge_input_lm::rescore::{
///     AsrConfusionRules, CandidateScorer, Rescorer,
/// };
///
/// // A mock scorer that prefers the long-vowel-corrected candidate.
/// struct PreferringScorer;
/// impl CandidateScorer for PreferringScorer {
///     fn score(&self, text: &str) -> f64 {
///         match text {
///             "おはようございます" => -10.0,
///             "おはよございます" => -20.0,
///             _ => -30.0,
///         }
///     }
/// }
///
/// let rescorer = Rescorer::new(PreferringScorer, AsrConfusionRules::default());
/// let best = rescorer.best("おはよございます");
/// assert_eq!(best, "おはようございます");
/// ```
pub struct Rescorer<S: CandidateScorer> {
    scorer: S,
    rules: AsrConfusionRules,
    lm_weight: f64,
    confusion_weight: f64,
    overcorrection_margin: f64,
}

impl<S: CandidateScorer> Rescorer<S> {
    /// Creates a rescorer with default weights.
    pub fn new(scorer: S, rules: AsrConfusionRules) -> Self {
        Self { scorer, rules, lm_weight: 1.0, confusion_weight: 1.0, overcorrection_margin: 0.0 }
    }

    /// Sets the LM weight. The combined score is
    /// `lm_weight * lm_score - confusion_weight * confusion_cost`.
    pub fn with_lm_weight(mut self, w: f64) -> Self {
        self.lm_weight = w;
        self
    }

    /// Sets the confusion weight.
    pub fn with_confusion_weight(mut self, w: f64) -> Self {
        self.confusion_weight = w;
        self
    }

    /// Sets the overcorrection prevention margin. Only replace the original
    /// hypothesis if the best candidate's combined score exceeds the
    /// original's by at least this margin.
    pub fn with_overcorrection_margin(mut self, m: f64) -> Self {
        self.overcorrection_margin = m;
        self
    }

    /// Re-scores all candidates and returns them ranked best-first.
    pub fn rescore(&self, hypothesis: &str) -> Vec<RankedCandidate> {
        let candidates = self.rules.generate(hypothesis);
        let mut ranked: Vec<RankedCandidate> = candidates
            .iter()
            .map(|c| {
                let lm_score = self.scorer.score(&c.text);
                let combined = self.lm_weight * lm_score - self.confusion_weight * c.confusion_cost;
                RankedCandidate {
                    text: c.text.clone(),
                    lm_score,
                    confusion_cost: c.confusion_cost,
                    combined_score: combined,
                }
            })
            .collect();
        ranked.sort_by(|a, b| b.combined_score.total_cmp(&a.combined_score));
        ranked
    }

    /// Returns the best candidate, applying the overcorrection gate.
    ///
    /// If no candidate's combined score exceeds the original hypothesis's
    /// by at least `overcorrection_margin`, the original is returned.
    pub fn best(&self, hypothesis: &str) -> String {
        let ranked = self.rescore(hypothesis);
        if ranked.is_empty() {
            return hypothesis.to_string();
        }

        let original_score = ranked.iter().find(|c| c.text == hypothesis).map(|c| c.combined_score);

        if let Some(original_score) = original_score {
            let best = &ranked[0];
            if best.combined_score - original_score >= self.overcorrection_margin {
                best.text.clone()
            } else {
                hypothesis.to_string()
            }
        } else {
            ranked[0].text.clone()
        }
    }

    // -----------------------------------------------------------------------
    // N-best re-ranking
    // -----------------------------------------------------------------------

    /// Re-ranks ASR N-best candidates by combining acoustic and LM scores.
    ///
    /// The combined score for each candidate is:
    ///
    /// ```text
    /// combined_score = acoustic_score + lm_weight * lm_score
    /// ```
    ///
    /// No confusion candidates are generated — the ASR decoder already
    /// produced these hypotheses, so `confusion_weight` and `confusion_cost`
    /// do not apply. Candidates are returned sorted by combined score,
    /// descending.
    ///
    /// # Example
    ///
    /// ```
    /// use caption_bridge_input_lm::rescore::{
    ///     AsrConfusionRules, CandidateScorer, NbestCandidate, Rescorer,
    /// };
    ///
    /// struct PreferringScorer;
    /// impl CandidateScorer for PreferringScorer {
    ///     fn score(&self, text: &str) -> f64 {
    ///         match text {
    ///             "おはようございます" => -10.0,
    ///             "おはよございます" => -20.0,
    ///             _ => -30.0,
    ///         }
    ///     }
    /// }
    ///
    /// let rescorer = Rescorer::new(PreferringScorer, AsrConfusionRules::default());
    /// let candidates = vec![
    ///     NbestCandidate { text: "おはよございます".into(), acoustic_score: -3.2 },
    ///     NbestCandidate { text: "おはようございます".into(), acoustic_score: -3.4 },
    /// ];
    /// let best = rescorer.best_nbest(&candidates);
    /// assert_eq!(best, "おはようございます");
    /// ```
    pub fn rerank_nbest(&self, candidates: &[NbestCandidate]) -> Vec<RankedNbestCandidate> {
        let mut ranked: Vec<RankedNbestCandidate> = candidates
            .iter()
            .map(|c| {
                let lm_score = self.scorer.score(&c.text);
                let combined = c.acoustic_score + self.lm_weight * lm_score;
                RankedNbestCandidate {
                    text: c.text.clone(),
                    acoustic_score: c.acoustic_score,
                    lm_score,
                    combined_score: combined,
                }
            })
            .collect();
        ranked.sort_by(|a, b| b.combined_score.total_cmp(&a.combined_score));
        ranked
    }

    /// Returns the best N-best candidate, applying the overcorrection gate.
    ///
    /// The "original" is the candidate with the highest acoustic score — the
    /// one ASR would have chosen without LM rescoring. If the top combined-score
    /// candidate does not exceed the original's combined score by at least
    /// `overcorrection_margin`, the original is returned. This prevents the LM
    /// from overriding a strongly preferred ASR hypothesis unless the LM
    /// evidence is clear.
    ///
    /// Returns an empty string when `candidates` is empty.
    pub fn best_nbest(&self, candidates: &[NbestCandidate]) -> String {
        if candidates.is_empty() {
            return String::new();
        }

        // The ASR 1-best: the candidate with the highest acoustic score.
        let original_idx = candidates
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.acoustic_score.total_cmp(&b.acoustic_score))
            .map(|(i, _)| i)
            .expect("at least one candidate");
        let original_text = &candidates[original_idx].text;

        let ranked = self.rerank_nbest(candidates);

        // Find the original's combined score in the ranked list.
        let original_score = ranked
            .iter()
            .find(|r| r.text == *original_text)
            .map(|r| r.combined_score)
            .unwrap_or(f64::MIN);

        if ranked[0].combined_score - original_score >= self.overcorrection_margin {
            ranked[0].text.clone()
        } else {
            original_text.clone()
        }
    }
}

// ---------------------------------------------------------------------------
// Confusion rule data (internal)
// ---------------------------------------------------------------------------

/// Returns the voiced counterpart of an unvoiced mora, or vice versa.
fn voicing_pair(ch: char) -> Option<char> {
    match ch {
        'か' => Some('が'),
        'き' => Some('ぎ'),
        'く' => Some('ぐ'),
        'け' => Some('げ'),
        'こ' => Some('ご'),
        'さ' => Some('ざ'),
        'し' => Some('じ'),
        'す' => Some('ず'),
        'せ' => Some('ぜ'),
        'そ' => Some('ぞ'),
        'た' => Some('だ'),
        'ち' => Some('ぢ'),
        'つ' => Some('づ'),
        'て' => Some('で'),
        'と' => Some('ど'),
        'は' => Some('ば'),
        'ひ' => Some('び'),
        'ふ' => Some('ぶ'),
        'へ' => Some('べ'),
        'ほ' => Some('ぼ'),
        'が' => Some('か'),
        'ぎ' => Some('き'),
        'ぐ' => Some('く'),
        'げ' => Some('け'),
        'ご' => Some('こ'),
        'ざ' => Some('さ'),
        'じ' => Some('し'),
        'ず' => Some('す'),
        'ぜ' => Some('せ'),
        'ぞ' => Some('そ'),
        'だ' => Some('た'),
        'ぢ' => Some('ち'),
        'づ' => Some('つ'),
        'で' => Some('て'),
        'ど' => Some('と'),
        'ば' => Some('は'),
        'び' => Some('ひ'),
        'ぶ' => Some('ふ'),
        'べ' => Some('へ'),
        'ぼ' => Some('ほ'),
        _ => None,
    }
}

/// Returns the semi-voiced (handakuon) counterpart of a mora, or vice versa.
fn semi_voicing_pair(ch: char) -> Option<char> {
    match ch {
        'は' => Some('ぱ'),
        'ひ' => Some('ぴ'),
        'ふ' => Some('ぷ'),
        'へ' => Some('ぺ'),
        'ほ' => Some('ぽ'),
        'ぱ' => Some('は'),
        'ぴ' => Some('ひ'),
        'ぷ' => Some('ふ'),
        'ぺ' => Some('へ'),
        'ぽ' => Some('ほ'),
        _ => None,
    }
}

/// Returns acoustically similar moras for `ch`.
///
/// These model ASR-specific acoustic confusions that are NOT already covered
/// by the voiced/unvoiced or semi-voiced substitution rules.
fn similar_moras(ch: char) -> &'static [char] {
    match ch {
        'し' => &['い'],       // しち -> いち
        'い' => &['し', 'り'], // いち -> しち, り->い confusion
        'ち' => &['し', 'つ'], // ち->し, ち->つ
        'り' => &['い'],       // り->い
        'る' => &['う', 'ろ'], // る->う, る->ろ
        'う' => &['る'],       // う->る
        'む' => &['ん'],       // む->ん
        'ん' => &['む'],       // ん->む
        'な' => &['ら', 'だ'], // な->ら, な->だ
        'ら' => &['な'],       // ら->な
        'お' => &['う'],       // お->う (acoustic, not long-vowel insertion)
        _ => &[],
    }
}

/// Returns the extending vowel for a long vowel after `ch`, if any.
///
/// In Japanese, long vowels are formed by inserting a specific vowel:
/// - o-ending moras are extended with う (e.g., おはよう)
/// - e-ending moras are extended with い (e.g., せんせい)
/// - u-ending moras are extended with う
/// - a-ending moras are extended with あ
/// - i-ending moras are extended with い
fn long_vowel_for(ch: char) -> Option<char> {
    let vowel = mora_vowel(ch)?;
    match vowel {
        'あ' => Some('あ'),
        'い' => Some('い'),
        'う' => Some('う'),
        'え' => Some('い'), // え is extended with い
        'お' => Some('う'), // お is extended with う
        _ => None,
    }
}

/// Returns true if `ch` is a long-vowel extension of `prev`.
fn is_long_vowel(prev: char, ch: char) -> bool {
    long_vowel_for(prev) == Some(ch)
}

/// Returns the vowel of a mora, or None for non-mora characters.
fn mora_vowel(ch: char) -> Option<char> {
    match ch {
        // Vowels
        'あ' => Some('あ'),
        'い' => Some('い'),
        'う' => Some('う'),
        'え' => Some('え'),
        'お' => Some('お'),
        // k
        'か' => Some('あ'),
        'き' => Some('い'),
        'く' => Some('う'),
        'け' => Some('え'),
        'こ' => Some('お'),
        'が' => Some('あ'),
        'ぎ' => Some('い'),
        'ぐ' => Some('う'),
        'げ' => Some('え'),
        'ご' => Some('お'),
        // s
        'さ' => Some('あ'),
        'し' => Some('い'),
        'す' => Some('う'),
        'せ' => Some('え'),
        'そ' => Some('お'),
        'ざ' => Some('あ'),
        'じ' => Some('い'),
        'ず' => Some('う'),
        'ぜ' => Some('え'),
        'ぞ' => Some('お'),
        // t
        'た' => Some('あ'),
        'ち' => Some('い'),
        'つ' => Some('う'),
        'て' => Some('え'),
        'と' => Some('お'),
        'だ' => Some('あ'),
        'ぢ' => Some('い'),
        'づ' => Some('う'),
        'で' => Some('え'),
        'ど' => Some('お'),
        // n
        'な' => Some('あ'),
        'に' => Some('い'),
        'ぬ' => Some('う'),
        'ね' => Some('え'),
        'の' => Some('お'),
        // h
        'は' => Some('あ'),
        'ひ' => Some('い'),
        'ふ' => Some('う'),
        'へ' => Some('え'),
        'ほ' => Some('お'),
        'ば' => Some('あ'),
        'び' => Some('い'),
        'ぶ' => Some('う'),
        'べ' => Some('え'),
        'ぼ' => Some('お'),
        'ぱ' => Some('あ'),
        'ぴ' => Some('い'),
        'ぷ' => Some('う'),
        'ぺ' => Some('え'),
        'ぽ' => Some('お'),
        // m
        'ま' => Some('あ'),
        'み' => Some('い'),
        'む' => Some('う'),
        'め' => Some('え'),
        'も' => Some('お'),
        // y
        'や' => Some('あ'),
        'ゆ' => Some('う'),
        'よ' => Some('お'),
        // r
        'ら' => Some('あ'),
        'り' => Some('い'),
        'る' => Some('う'),
        'れ' => Some('え'),
        'ろ' => Some('お'),
        // w
        'わ' => Some('あ'),
        'を' => Some('お'),
        // final n
        'ん' => Some('ん'),
        _ => None,
    }
}

/// Returns true if a gemination (っ) can be inserted before `ch`.
///
/// Gemination occurs before unvoiced consonant moras: k, s, t, h, p rows.
fn can_geminate(ch: char) -> bool {
    matches!(
        ch,
        'か' | 'き'
            | 'く'
            | 'け'
            | 'こ'
            | 'さ'
            | 'し'
            | 'す'
            | 'せ'
            | 'そ'
            | 'た'
            | 'ち'
            | 'つ'
            | 'て'
            | 'と'
            | 'は'
            | 'ひ'
            | 'ふ'
            | 'へ'
            | 'ほ'
            | 'ぱ'
            | 'ぴ'
            | 'ぷ'
            | 'ぺ'
            | 'ぽ'
    )
}

// --- String operations on char vectors ---

fn substitute_char(chars: &[char], i: usize, replacement: char) -> String {
    let mut result: Vec<char> = chars.to_vec();
    result[i] = replacement;
    result.iter().collect()
}

fn insert_char(chars: &[char], i: usize, ch: char) -> String {
    let mut result: Vec<char> = chars[..i].to_vec();
    result.push(ch);
    result.extend_from_slice(&chars[i..]);
    result.iter().collect()
}

fn delete_char(chars: &[char], i: usize) -> String {
    let mut result: Vec<char> = chars[..i].to_vec();
    result.extend_from_slice(&chars[i + 1..]);
    result.iter().collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EfficientNGram, NgramParams};
    use crate::trie::MemoryTrie;
    use std::collections::HashMap;

    // --- Hiragana/katakana conversion ---

    #[test]
    fn hiragana_round_trips_to_katakana_and_back() {
        let hiragana = "あしたのてんきははれ";
        let katakana = hiragana_to_katakana(hiragana);
        assert_eq!(katakana, "アシタノテンキハハレ");
        assert_eq!(katakana_to_hiragana(&katakana), hiragana);
    }

    #[test]
    fn non_kana_characters_pass_through_conversion() {
        assert_eq!(hiragana_to_katakana("abc123"), "abc123");
        assert_eq!(katakana_to_hiragana("ABC"), "ABC");
    }

    #[test]
    fn empty_string_converts_to_empty() {
        assert_eq!(hiragana_to_katakana(""), "");
        assert_eq!(katakana_to_hiragana(""), "");
    }

    #[test]
    fn dakuten_handakuten_round_trip() {
        assert_eq!(hiragana_to_katakana("がぱ"), "ガパ");
        assert_eq!(katakana_to_hiragana("ガパ"), "がぱ");
    }

    // --- Confusion rule: candidate generation ---

    #[test]
    fn voicing_substitution_generates_voiced_counterpart() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("かいとう");
        let texts: Vec<&str> = candidates.iter().map(|c| c.text.as_str()).collect();
        assert!(texts.contains(&"がいとう"), "voicing か->が missing from {texts:?}");
        assert!(texts.contains(&"かいどう"), "voicing と->ど missing from {texts:?}");
    }

    #[test]
    fn voicing_substitution_works_both_directions() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("がいとう");
        let texts: Vec<&str> = candidates.iter().map(|c| c.text.as_str()).collect();
        assert!(texts.contains(&"かいとう"), "voicing が->か missing from {texts:?}");
    }

    #[test]
    fn semi_voicing_substitution_generates_handakuon() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("はな");
        let texts: Vec<&str> = candidates.iter().map(|c| c.text.as_str()).collect();
        assert!(texts.contains(&"ぱな"), "semi-voicing は->ぱ missing from {texts:?}");
    }

    #[test]
    fn similar_mora_substitution_generates_acoustic_pairs() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("しち");
        let texts: Vec<&str> = candidates.iter().map(|c| c.text.as_str()).collect();
        assert!(texts.contains(&"いち"), "し->い substitution missing from {texts:?}");
    }

    #[test]
    fn long_vowel_insertion_generates_extending_vowel() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("おはよ");
        let texts: Vec<&str> = candidates.iter().map(|c| c.text.as_str()).collect();
        assert!(texts.contains(&"おはよう"), "long vowel う insertion missing from {texts:?}");
    }

    #[test]
    fn long_vowel_deletion_removes_extending_vowel() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("おはよう");
        let texts: Vec<&str> = candidates.iter().map(|c| c.text.as_str()).collect();
        assert!(texts.contains(&"おはよ"), "long vowel う deletion missing from {texts:?}");
    }

    #[test]
    fn gemination_insertion_generates_small_tu() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("きて");
        let texts: Vec<&str> = candidates.iter().map(|c| c.text.as_str()).collect();
        assert!(texts.contains(&"きって"), "gemination っ insertion missing from {texts:?}");
    }

    #[test]
    fn gemination_deletion_removes_small_tu() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("きって");
        let texts: Vec<&str> = candidates.iter().map(|c| c.text.as_str()).collect();
        assert!(texts.contains(&"きて"), "gemination っ deletion missing from {texts:?}");
    }

    #[test]
    fn original_hypothesis_is_always_included() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("おはようございます");
        assert!(candidates
            .iter()
            .any(|c| c.text == "おはようございます" && c.confusion_cost == 0.0));
    }

    #[test]
    fn empty_input_yields_single_candidate() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].text, "");
        assert_eq!(candidates[0].confusion_cost, 0.0);
    }

    #[test]
    fn single_char_generates_expected_candidates() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("か");
        let texts: Vec<&str> = candidates.iter().map(|c| c.text.as_str()).collect();
        // Original
        assert!(texts.contains(&"か"));
        // Voicing: か -> が
        assert!(texts.contains(&"が"));
        // Long vowel insertion: か + あ (a-ending)
        assert!(texts.contains(&"かあ"));
    }

    #[test]
    fn candidates_are_deduplicated() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("はは");
        let texts: Vec<&str> = candidates.iter().map(|c| c.text.as_str()).collect();
        // Each candidate text should appear exactly once.
        let mut sorted = texts.clone();
        sorted.sort();
        let dedup_count = sorted.iter().collect::<std::collections::HashSet<_>>().len();
        assert_eq!(dedup_count, texts.len(), "duplicate texts in {texts:?}");
    }

    #[test]
    fn max_edits_two_generates_more_candidates() {
        let rules_1 = AsrConfusionRules::default();
        let rules_2 = AsrConfusionRules { max_edits: 2, ..Default::default() };
        let c1 = rules_1.generate("かさ");
        let c2 = rules_2.generate("かさ");
        assert!(c2.len() > c1.len(), "max_edits=2 should generate more candidates");
    }

    #[test]
    fn confusion_costs_are_associated_correctly() {
        let rules = AsrConfusionRules::default();
        let candidates = rules.generate("か");
        let ga = candidates.iter().find(|c| c.text == "が").unwrap();
        assert_eq!(ga.confusion_cost, rules.voicing_cost);
    }

    // --- Scoring/ranking with mock scorer ---

    /// A mock scorer that returns scores from a lookup table.
    struct MockScorer {
        scores: HashMap<String, f64>,
    }

    impl CandidateScorer for MockScorer {
        fn score(&self, text: &str) -> f64 {
            self.scores.get(text).copied().unwrap_or(-100.0)
        }
    }

    /// A scorer that always returns the same value (for tie tests).
    struct ConstantScorer(f64);

    impl CandidateScorer for ConstantScorer {
        fn score(&self, _text: &str) -> f64 {
            self.0
        }
    }

    #[test]
    fn rescore_ranks_by_combined_score() {
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -10.0);
        scores.insert("おはよございます".to_string(), -20.0);
        let scorer = MockScorer { scores };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let ranked = rescorer.rescore("おはよございます");
        assert!(!ranked.is_empty());
        // The best candidate has the highest combined score.
        assert!(ranked[0].combined_score >= ranked[ranked.len() - 1].combined_score);
    }

    #[test]
    fn best_returns_corrected_candidate_when_lm_prefers_it() {
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -10.0);
        scores.insert("おはよございます".to_string(), -20.0);
        let scorer = MockScorer { scores };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let best = rescorer.best("おはよございます");
        assert_eq!(best, "おはようございます");
    }

    #[test]
    fn best_returns_original_when_overcorrection_margin_blocks_replacement() {
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -10.0);
        scores.insert("おはよございます".to_string(), -20.0);
        let scorer = MockScorer { scores };
        let rules = AsrConfusionRules::default();
        // The corrected candidate wins on combined score:
        //   corrected  = 1.0 * (-10.0) - 1.0 * 0.8 = -10.8
        //   original   = 1.0 * (-20.0) - 1.0 * 0.0 = -20.0
        // But the margin of 10.0 blocks it (difference 9.2 < 10.0).
        let rescorer = Rescorer::new(scorer, rules).with_overcorrection_margin(10.0);
        let best = rescorer.best("おはよございます");
        assert_eq!(best, "おはよございます");
    }

    #[test]
    fn tie_prefers_original_when_all_scores_are_equal() {
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let best = rescorer.best("おはようございます");
        // All candidates have the same lm_score; the original has cost 0,
        // so it has the highest combined score.
        assert_eq!(best, "おはようございます");
    }

    #[test]
    fn empty_input_returns_original() {
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        assert_eq!(rescorer.best(""), "");
        let ranked = rescorer.rescore("");
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].text, "");
    }

    #[test]
    fn single_candidate_input_returns_itself() {
        // A single-char string with no applicable confusion rules.
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let best = rescorer.best("ん");
        assert_eq!(best, "ん");
    }

    #[test]
    fn all_equal_scores_keeps_original() {
        let scorer = ConstantScorer(-5.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let ranked = rescorer.rescore("かさ");
        // The original has cost 0, so it should rank first.
        assert_eq!(ranked[0].text, "かさ");
        assert_eq!(ranked[0].confusion_cost, 0.0);
    }

    #[test]
    fn lm_weight_and_confusion_weight_affect_ranking() {
        // With high confusion weight, the original (cost 0) wins even if the
        // LM prefers the correction.
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -10.0);
        scores.insert("おはよございます".to_string(), -15.0);
        let scorer = MockScorer { scores };
        let rules = AsrConfusionRules::default();
        let rescorer = Rescorer::new(scorer, rules).with_lm_weight(1.0).with_confusion_weight(10.0);
        let best = rescorer.best("おはよございます");
        // LM diff = 5.0, confusion cost = 0.8 * 10 = 8.0
        // Original combined = 1.0 * (-15.0) - 10.0 * 0 = -15.0
        // Corrected combined = 1.0 * (-10.0) - 10.0 * 0.8 = -18.0
        // Original wins.
        assert_eq!(best, "おはよございます");
    }

    // --- N-best re-ranking ---

    #[test]
    fn rerank_nbest_sorts_by_combined_score_descending() {
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -10.0);
        scores.insert("おはよございます".to_string(), -20.0);
        let scorer = MockScorer { scores };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());

        let candidates = vec![
            NbestCandidate { text: "おはよございます".into(), acoustic_score: -3.2 },
            NbestCandidate { text: "おはようございます".into(), acoustic_score: -3.4 },
        ];
        let ranked = rescorer.rerank_nbest(&candidates);
        assert_eq!(ranked.len(), 2);
        // Combined: おはよう = -3.4 + 1.0 * (-10.0) = -13.4
        //           おはよ   = -3.2 + 1.0 * (-20.0) = -23.2
        assert_eq!(ranked[0].text, "おはようございます");
        assert_eq!(ranked[1].text, "おはよございます");
        assert!(ranked[0].combined_score > ranked[1].combined_score);
    }

    #[test]
    fn rerank_nbest_preserves_acoustic_and_lm_scores() {
        let mut scores = HashMap::new();
        scores.insert("かいしゃ".to_string(), -5.0);
        let scorer = MockScorer { scores };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());

        let candidates = vec![NbestCandidate { text: "かいしゃ".into(), acoustic_score: -2.0 }];
        let ranked = rescorer.rerank_nbest(&candidates);
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].acoustic_score, -2.0);
        assert_eq!(ranked[0].lm_score, -5.0);
        // combined = -2.0 + 1.0 * (-5.0) = -7.0
        assert_eq!(ranked[0].combined_score, -7.0);
    }

    #[test]
    fn best_nbest_returns_lm_preferred_candidate() {
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -10.0);
        scores.insert("おはよございます".to_string(), -20.0);
        let scorer = MockScorer { scores };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());

        let candidates = vec![
            NbestCandidate { text: "おはよございます".into(), acoustic_score: -3.2 },
            NbestCandidate { text: "おはようございます".into(), acoustic_score: -3.4 },
        ];
        // Combined: おはよう = -13.4, おはよ = -23.2, diff = 9.8 >= 0.0 (default margin)
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "おはようございます");
    }

    #[test]
    fn best_nbest_returns_acoustic_top_when_margin_blocks_replacement() {
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -10.0);
        scores.insert("おはよございます".to_string(), -12.0);
        let scorer = MockScorer { scores };
        // Combined: おはよう = -3.4 + 1.0 * (-10.0) = -13.4
        //           おはよ   = -3.2 + 1.0 * (-12.0) = -15.2
        // diff = 1.8 < 10.0 margin → keep the acoustic top (おはよございます)
        let rescorer =
            Rescorer::new(scorer, AsrConfusionRules::default()).with_overcorrection_margin(10.0);

        let candidates = vec![
            NbestCandidate { text: "おはよございます".into(), acoustic_score: -3.2 },
            NbestCandidate { text: "おはようございます".into(), acoustic_score: -3.4 },
        ];
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "おはよございます");
    }

    #[test]
    fn best_nbest_returns_acoustic_top_when_lm_is_neutral() {
        // When the LM scores all candidates equally, the acoustic top wins
        // regardless of the margin (it has the highest combined score).
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());

        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -2.0 },
            NbestCandidate { text: "がいしゃ".into(), acoustic_score: -3.0 },
        ];
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "かいしゃ");
    }

    #[test]
    fn best_nbest_empty_candidates_returns_empty_string() {
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        assert_eq!(rescorer.best_nbest(&[]), "");
    }

    #[test]
    fn best_nbest_single_candidate_returns_it() {
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let candidates =
            vec![NbestCandidate { text: "こんにちは".into(), acoustic_score: -1.5 }];
        assert_eq!(rescorer.best_nbest(&candidates), "こんにちは");
    }

    #[test]
    fn best_nbest_lm_weight_changes_which_candidate_wins() {
        // With a low lm_weight, the acoustic top wins; with a high one, the
        // LM-preferred candidate wins.
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -10.0);
        scores.insert("おはよございます".to_string(), -11.0);
        let candidates = vec![
            NbestCandidate { text: "おはよございます".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "おはようございます".into(), acoustic_score: -5.0 },
        ];

        // lm_weight = 0.5: combined おはよ = -3.0 + 0.5*(-11) = -8.5
        //                 おはよう = -5.0 + 0.5*(-10) = -10.0 → おはよ wins
        let scorer_low = MockScorer { scores: scores.clone() };
        let rescorer_low = Rescorer::new(scorer_low, AsrConfusionRules::default())
            .with_lm_weight(0.5)
            .with_overcorrection_margin(0.0);
        assert_eq!(rescorer_low.best_nbest(&candidates), "おはよございます");

        // lm_weight = 5.0: combined おはよ = -3.0 + 5.0*(-11) = -58.0
        //                  おはよう = -5.0 + 5.0*(-10) = -55.0 → おはよう wins
        let scorer_high = MockScorer { scores };
        let rescorer_high = Rescorer::new(scorer_high, AsrConfusionRules::default())
            .with_lm_weight(5.0)
            .with_overcorrection_margin(0.0);
        assert_eq!(rescorer_high.best_nbest(&candidates), "おはようございます");
    }

    #[test]
    fn best_nbest_ties_in_combined_score_keep_acoustic_top() {
        // When the top two candidates have identical combined scores, the
        // overcorrection gate (diff = 0 < margin) keeps the acoustic top.
        let scorer = ConstantScorer(-10.0);
        let rescorer =
            Rescorer::new(scorer, AsrConfusionRules::default()).with_overcorrection_margin(0.0);
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "がいしゃ".into(), acoustic_score: -3.0 },
        ];
        // Both have combined = -3.0 + 1.0 * (-10.0) = -13.0.
        // The acoustic top is whichever comes first in the max_by tie-break
        // (Rust's max_by returns the LAST equal element, so "がいしゃ" at
        // index 1 is the acoustic top). But both have the same combined
        // score, so the gate keeps the acoustic top.
        let best = rescorer.best_nbest(&candidates);
        // The result must be one of the tied candidates.
        assert!(best == "かいしゃ" || best == "がいしゃ", "got {best}");
    }

    #[test]
    fn rerank_nbest_with_lm_weight_applies_weight_to_lm_score() {
        let mut scores = HashMap::new();
        scores.insert("あ".to_string(), -10.0);
        scores.insert("い".to_string(), -5.0);
        let scorer = MockScorer { scores };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default()).with_lm_weight(2.0);

        let candidates = vec![
            NbestCandidate { text: "あ".into(), acoustic_score: -1.0 },
            NbestCandidate { text: "い".into(), acoustic_score: -3.0 },
        ];
        let ranked = rescorer.rerank_nbest(&candidates);
        // combined あ = -1.0 + 2.0 * (-10.0) = -21.0
        // combined い = -3.0 + 2.0 * (-5.0)  = -13.0
        assert_eq!(ranked[0].text, "い");
        assert_eq!(ranked[0].combined_score, -13.0);
        assert_eq!(ranked[1].text, "あ");
        assert_eq!(ranked[1].combined_score, -21.0);
    }
    // --- LmScorer edge branches (pinned without the real model) ---

    #[test]
    fn lm_scorer_empty_text_scores_zero() {
        // sequence_log_prob returns 0.0 for empty token sequences. The empty
        // branch is otherwise only reachable via the gated real-model suite.
        let Some(tokenizer) = crate::tokenizer::ZenzTokenizer::from_submodule() else {
            eprintln!("skipping: submodule tokenizer assets not present");
            return;
        };
        let model = EfficientNGram::new(
            NgramParams { n: 2, d: 0.5, vocab_size: 4, start_token_id: 2 },
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
        );
        let scorer = LmScorer::new(model, tokenizer);
        assert_eq!(scorer.score(""), 0.0);
    }

    #[test]
    fn lm_scorer_zero_prob_token_hits_the_log_floor() {
        // A token id beyond the model's vocab_size (277 > 3 here) makes
        // `probs.get(token)` return None -> the -20.0 floor fires instead of
        // ln(0). This pins the else branch of sequence_log_prob without needing
        // the 120 MB tries.
        let Some(tokenizer) = crate::tokenizer::ZenzTokenizer::from_submodule() else {
            eprintln!("skipping: submodule tokenizer assets not present");
            return;
        };
        let model = EfficientNGram::new(
            NgramParams { n: 2, d: 0.5, vocab_size: 4, start_token_id: 2 },
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
        );
        let scorer = LmScorer::new(model, tokenizer);
        // あ encodes to id 277; the model only knows ids 0..=3, so every token
        // in this sequence takes the zero-probability floor.
        let score = scorer.score("あ");
        assert!(score < -10.0, "expected the log floor, got {score}");
    }

    #[test]
    fn lm_scorer_positive_probability_accumulates_log_prob() {
        // The `prob > 0.0` branch: with a model whose vocab covers every token
        // id the tokenizer emits (uniform floor 1/vocab_size > 0), each token
        // accumulates ln(prob). ア encodes to an id below 6000, so
        // `probs.get(id)` returns the uniform floor and never the zero branch.
        let Some(tokenizer) = crate::tokenizer::ZenzTokenizer::from_submodule() else {
            eprintln!("skipping: submodule tokenizer assets not present");
            return;
        };
        let model = EfficientNGram::new(
            NgramParams { n: 1, d: 0.5, vocab_size: 6000, start_token_id: 2 },
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
        );
        let scorer = LmScorer::new(model, tokenizer);
        let score = scorer.score("ア");
        // n=1 means the only mass is the uniform floor 1/6000 per token:
        // score = tokens * ln(1/6000). One ア = E3 82 A2 = 3 byte-chars -> 3
        // tokens, so expect approximately 3 * ln(1/6000) ≈ -26.
        assert!(score < 0.0 && score > -40.0, "expected the uniform-floor sum, got {score}");
    }

    #[test]
    fn lm_scorer_exposes_its_model_and_tokenizer() {
        // Pins the `model()` / `tokenizer()` accessors which are otherwise
        // dead in the test suite.
        let Some(tokenizer) = crate::tokenizer::ZenzTokenizer::from_submodule() else {
            eprintln!("skipping: submodule tokenizer assets not present");
            return;
        };
        let model = EfficientNGram::new(
            NgramParams { n: 2, d: 0.5, vocab_size: 4, start_token_id: 2 },
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
        );
        let scorer = LmScorer::new(model, tokenizer);
        let _ = scorer.model();
        let _ = scorer.tokenizer();
    }

    // --- Overcorrection gate exact-boundary ---

    #[test]
    fn best_replaces_when_the_candidate_beats_the_original_by_exactly_the_margin() {
        // combined(original) = -10.0, combined(candidate) = -10.0 - 0.8 + 5.0
        // = -5.8, so candidate - original = 4.2 exactly. The gate is `>=`
        // margin, so a diff of exactly 4.2 with margin 4.2 must replace.
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -5.0);
        scores.insert("おはよございます".to_string(), -10.0);
        let scorer = MockScorer { scores };
        let rules = AsrConfusionRules::default();
        // cost of long-vowel insertion = 0.8, so combined diff =
        // (-5.0 - 0.8) - (-10.0) = 4.2
        let rescorer = Rescorer::new(scorer, rules).with_overcorrection_margin(4.2);
        let best = rescorer.best("おはよございます");
        assert_eq!(best, "おはようございます");
    }

    #[test]
    fn best_keeps_original_just_below_the_margin() {
        // Same as above but margin 4.3 (epsilon above 4.2), so the gate must
        // reject and return the original.
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -5.0);
        scores.insert("おはよございます".to_string(), -10.0);
        let scorer = MockScorer { scores };
        let rules = AsrConfusionRules::default();
        let rescorer = Rescorer::new(scorer, rules).with_overcorrection_margin(4.3);
        let best = rescorer.best("おはよございます");
        assert_eq!(best, "おはよございます");
    }

    // --- max_edits cutoff ---

    #[test]
    fn max_edits_of_zero_matches_edit_one_candidate_set() {
        // The `max_edits` field only gates the *second* edit pass. With 0 it
        // still emits all single-edit candidates, so the honest assertion is
        // that 0 and 1 produce the same set (and 2 strictly more).
        let rules_0 = AsrConfusionRules { max_edits: 0, ..AsrConfusionRules::default() };
        let rules_1 = AsrConfusionRules { max_edits: 1, ..AsrConfusionRules::default() };
        let c0 = rules_0.generate("かいとう");
        let c1 = rules_1.generate("かいとう");
        assert_eq!(c0, c1, "max_edits=0 must equal max_edits=1 (no second pass)");
    }

    #[test]
    fn max_edits_beyond_two_does_not_expand_the_candidate_set() {
        // max_edits >= 2 builds the two-edit closure by expanding every
        // single-edit candidate exactly once; setting it to 3 must produce the
        // same set as 2 (the generator has no third-level expansion).
        let rules_2 = AsrConfusionRules { max_edits: 2, ..AsrConfusionRules::default() };
        let rules_3 = AsrConfusionRules { max_edits: 3, ..AsrConfusionRules::default() };
        let c2 = rules_2.generate("かさ");
        let c3 = rules_3.generate("かさ");
        assert_eq!(c2, c3, "max_edits=3 must equal max_edits=2");
    }

    #[test]
    fn edit_two_closure_accumulates_costs() {
        // A two-edit candidate's total cost must be the sum of both edits.
        // か -> が (voicing 1.0) then が's long vowel あ (0.8): が → があ, cost 1.8.
        let rules = AsrConfusionRules { max_edits: 2, ..AsrConfusionRules::default() };
        let candidates = rules.generate("か");
        let target = candidates.iter().find(|c| c.text == "があ").expect("two-edit candidate");
        assert_eq!(target.confusion_cost, rules.voicing_cost + rules.long_vowel_insert_cost);
    }
    // --- Data-table arm coverage (table-driven over every entry) ---

    #[test]
    fn voicing_pair_maps_every_row_in_both_directions() {
        // Every `Some` arm of voicing_pair, in the same two-column layout as
        // the source. Walking the full mapping pins the voiced/unvoiced data
        // the generator relies on and covers every match arm in one pass.
        let rows: &[(char, char)] = &[
            ('か', 'が'),
            ('き', 'ぎ'),
            ('く', 'ぐ'),
            ('け', 'げ'),
            ('こ', 'ご'),
            ('さ', 'ざ'),
            ('し', 'じ'),
            ('す', 'ず'),
            ('せ', 'ぜ'),
            ('そ', 'ぞ'),
            ('た', 'だ'),
            ('ち', 'ぢ'),
            ('つ', 'づ'),
            ('て', 'で'),
            ('と', 'ど'),
            ('は', 'ば'),
            ('ひ', 'び'),
            ('ふ', 'ぶ'),
            ('へ', 'べ'),
            ('ほ', 'ぼ'),
            ('が', 'か'),
            ('ぎ', 'き'),
            ('ぐ', 'く'),
            ('げ', 'け'),
            ('ご', 'こ'),
            ('ざ', 'さ'),
            ('じ', 'し'),
            ('ず', 'す'),
            ('ぜ', 'せ'),
            ('ぞ', 'そ'),
            ('だ', 'た'),
            ('ぢ', 'ち'),
            ('づ', 'つ'),
            ('で', 'て'),
            ('ど', 'と'),
            ('ば', 'は'),
            ('び', 'ひ'),
            ('ぶ', 'ふ'),
            ('べ', 'へ'),
            ('ぼ', 'ほ'),
        ];
        for &(unvoiced, voiced) in rows {
            assert_eq!(voicing_pair(unvoiced), Some(voiced), "{unvoiced} -> {voiced}");
            assert_eq!(voicing_pair(voiced), Some(unvoiced), "{voiced} -> {unvoiced}");
        }
        assert_eq!(voicing_pair('ゐ'), None);
    }

    #[test]
    fn semi_voicing_pair_maps_every_row_in_both_directions() {
        let rows: &[(char, char)] = &[
            ('は', 'ぱ'),
            ('ひ', 'ぴ'),
            ('ふ', 'ぷ'),
            ('へ', 'ぺ'),
            ('ほ', 'ぽ'),
            ('ぱ', 'は'),
            ('ぴ', 'ひ'),
            ('ぷ', 'ふ'),
            ('ぺ', 'へ'),
            ('ぽ', 'ほ'),
        ];
        for &(plain, handakuon) in rows {
            assert_eq!(semi_voicing_pair(plain), Some(handakuon), "{plain} -> {handakuon}");
            assert_eq!(semi_voicing_pair(handakuon), Some(plain), "{handakuon} -> {plain}");
        }
        assert_eq!(semi_voicing_pair('か'), None);
    }

    #[test]
    fn similar_moras_walks_every_acoustic_pair() {
        // The exact `::similar_moras` tables, asserted verbatim so a swapped
        // or dropped arm shows up as a live behavioral failure.
        let rows: &[(char, &[char])] = &[
            ('し', &['い']),
            ('い', &['し', 'り']),
            ('ち', &['し', 'つ']),
            ('り', &['い']),
            ('る', &['う', 'ろ']),
            ('う', &['る']),
            ('む', &['ん']),
            ('ん', &['む']),
            ('な', &['ら', 'だ']),
            ('ら', &['な']),
            ('お', &['う']),
        ];
        for &(ch, expected) in rows {
            assert_eq!(similar_moras(ch), expected, "similar moras for {ch}");
        }
        assert!(similar_moras('あ').is_empty());
        assert!(similar_moras('漢').is_empty());
    }

    #[test]
    fn mora_vowel_walks_the_full_gojuon_mapping() {
        // Every `Some` arm of mora_vowel, row by row as written in the source:
        // the five bare vowels, then each consonant row (k/g/s/z/t/d/n/h/b/p/m
        // /y/r/w) in /a i u e o/ order, plus the special final ん.
        let rows: &[(char, char)] = &[
            ('あ', 'あ'),
            ('い', 'い'),
            ('う', 'う'),
            ('え', 'え'),
            ('お', 'お'),
            ('か', 'あ'),
            ('き', 'い'),
            ('く', 'う'),
            ('け', 'え'),
            ('こ', 'お'),
            ('が', 'あ'),
            ('ぎ', 'い'),
            ('ぐ', 'う'),
            ('げ', 'え'),
            ('ご', 'お'),
            ('さ', 'あ'),
            ('し', 'い'),
            ('す', 'う'),
            ('せ', 'え'),
            ('そ', 'お'),
            ('ざ', 'あ'),
            ('じ', 'い'),
            ('ず', 'う'),
            ('ぜ', 'え'),
            ('ぞ', 'お'),
            ('た', 'あ'),
            ('ち', 'い'),
            ('つ', 'う'),
            ('て', 'え'),
            ('と', 'お'),
            ('だ', 'あ'),
            ('ぢ', 'い'),
            ('づ', 'う'),
            ('で', 'え'),
            ('ど', 'お'),
            ('な', 'あ'),
            ('に', 'い'),
            ('ぬ', 'う'),
            ('ね', 'え'),
            ('の', 'お'),
            ('は', 'あ'),
            ('ひ', 'い'),
            ('ふ', 'う'),
            ('へ', 'え'),
            ('ほ', 'お'),
            ('ば', 'あ'),
            ('び', 'い'),
            ('ぶ', 'う'),
            ('べ', 'え'),
            ('ぼ', 'お'),
            ('ぱ', 'あ'),
            ('ぴ', 'い'),
            ('ぷ', 'う'),
            ('ぺ', 'え'),
            ('ぽ', 'お'),
            ('ま', 'あ'),
            ('み', 'い'),
            ('む', 'う'),
            ('め', 'え'),
            ('も', 'お'),
            ('や', 'あ'),
            ('ゆ', 'う'),
            ('よ', 'お'),
            ('ら', 'あ'),
            ('り', 'い'),
            ('る', 'う'),
            ('れ', 'え'),
            ('ろ', 'お'),
            ('わ', 'あ'),
            ('を', 'お'),
            ('ん', 'ん'),
        ];
        for &(mora, vowel) in rows {
            assert_eq!(mora_vowel(mora), Some(vowel), "vowel of {mora}");
        }
        assert_eq!(mora_vowel('ー'), None);
        assert_eq!(mora_vowel('っ'), None);
    }

    #[test]
    fn can_geminate_accepts_only_the_unvoiced_consonant_rows() {
        // The `matches!` table: every k/s/t/h + p row syllable permits an
        // inserted っ. Voiced rows, vowels, and non-mora characters do not.
        let geminatable: &[char] = &[
            'か', 'き', 'く', 'け', 'こ', 'さ', 'し', 'す', 'せ', 'そ', 'た', 'ち', 'つ', 'て',
            'と', 'は', 'ひ', 'ふ', 'へ', 'ほ', 'ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ',
        ];
        for &ch in geminatable {
            assert!(can_geminate(ch), "expected {ch} to allow gemination");
        }
        for ch in ['が', 'ざ', 'だ', 'ば', 'あ', 'ん', 'ー', '漢'] {
            assert!(!can_geminate(ch), "did not expect {ch} to allow gemination");
        }
    }
}
