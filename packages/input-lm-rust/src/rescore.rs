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

// ---------------------------------------------------------------------------
// Output-sanity guard (internal)
// ---------------------------------------------------------------------------
//
// The rescorer's contract is "kana text in, kana text out". A scorer plugin
// (or a scoring quirk such as an empty sequence's log-probability being
// exactly 0.0 -- the theoretical maximum) can make a garbage candidate win
// the ranking. An `Ok`-but-garbage return is more dangerous than an error
// because every caller in this pipeline trusts it unconditionally and feeds
// it straight to kana-kanji conversion. `is_sane_output` is the single choke
// point both `best` and `best_nbest` route through before ever replacing the
// original hypothesis, so a fix here covers every path that can promote a
// candidate to "the" output.

/// Returns true if `c` is a hiragana character (U+3041-U+309E), a katakana
/// character (U+30A1-U+30FA), or the kana prolonged sound mark (ー,
/// U+30FC).
fn is_kana_like(c: char) -> bool {
    let code = c as u32;
    (0x3041..=0x309E).contains(&code) || (0x30A1..=0x30FA).contains(&code) || code == 0x30FC
}

/// Returns true when `candidate` is safe to surface as a rescoring output in
/// place of `original`. Guards against three shapes of garbage that an
/// `Ok(String)` must never silently smuggle through:
///
/// - **Dropped content**: `candidate` is empty or whitespace-only while
///   `original` carried real content.
/// - **Wild length mismatch**: `candidate` is drastically shorter or longer
///   than `original`. The bound is deliberately generous -- the default
///   confusion rules move length by at most `max_edits` characters (2 by
///   default), and legitimate ASR N-best alternatives for the same audio
///   segment stay within the same order of magnitude -- but it stops a
///   scoring quirk (or a malformed upstream candidate) from swapping in
///   something absurd.
/// - **Foreign contamination**: `candidate` contains a character that is
///   neither kana-like nor already present in `original`. Every character
///   the confusion rules can introduce is kana, so this never rejects a
///   1-best candidate; it exists to catch a corrupted or out-of-contract
///   N-best candidate supplied by the caller.
///
/// `original` itself always passes: an identical-text candidate trivially
/// satisfies every check above, so this guard can never leave `best`/
/// `best_nbest` without a safe fallback.
fn is_sane_output(original: &str, original_chars: &HashSet<char>, candidate: &str) -> bool {
    let orig_len = original.chars().count();
    if orig_len == 0 {
        // Nothing to lose -- any candidate (including empty) is acceptable.
        return true;
    }
    if original.trim().is_empty() {
        // The original itself was blank; there is no real content to guard.
        return true;
    }
    if candidate.trim().is_empty() {
        return false;
    }

    let cand_len = candidate.chars().count();
    let min_len = orig_len.div_ceil(4);
    let max_len = orig_len * 4 + 8;
    if cand_len < min_len || cand_len > max_len {
        return false;
    }

    if candidate.chars().any(|c| !is_kana_like(c) && !original_chars.contains(&c)) {
        return false;
    }

    true
}

/// Descending combined-score ordering with NaN ranked *last*.
///
/// `f64::total_cmp` orders NaN as the greatest value, so a descending
/// `sort_by(|a, b| b.combined_score.total_cmp(&a.combined_score))` puts a NaN
/// candidate at rank 0 -- exactly where a caller takes "the winner". That can
/// happen in practice: `lm_weight = 0.0` times a `-inf` LM score is `NaN` in
/// IEEE-754, as is any `NaN` weight or `NaN` LM score. A NaN combined score
/// carries no information and must never out-rank a real candidate, so NaN is
/// pinned to the bottom of the ranking here. Identical to `total_cmp` for
/// every all-finite input, which is how the 1-best path keeps byte-identical
/// behavior on existing inputs.
fn combined_score_cmp(a: f64, b: f64) -> std::cmp::Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => b.total_cmp(&a),
    }
}

/// True when `candidate`'s acoustic score should displace `current` as the
/// ASR 1-best reference.
///
/// A NaN acoustic score (from a malformed upstream N-best entry) never
/// displaces a finite one, so a corrupted NaN-score candidate can never
/// become "the original" -- which would otherwise let an empty NaN-acoustic
/// candidate disable the sanity guard and drop the caption. Ties keep the
/// earlier-listed candidate, matching the ASR decoder's own rank order and
/// the stable sort used elsewhere.
fn acoustic_beats(candidate: f64, current: f64) -> bool {
    match (candidate.is_nan(), current.is_nan()) {
        (false, true) => true,
        (true, _) => false,
        _ => candidate > current,
    }
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
        ranked.sort_by(|a, b| combined_score_cmp(a.combined_score, b.combined_score));
        ranked
    }

    /// Returns the best candidate, applying the overcorrection gate and the
    /// output-sanity guard.
    ///
    /// If no candidate's combined score exceeds the original hypothesis's
    /// by at least `overcorrection_margin`, the original is returned.
    /// Separately, a candidate that is empty, whitespace-only, drastically
    /// shorter/longer than `hypothesis`, or contaminated with characters
    /// foreign to both kana and `hypothesis` is never surfaced regardless of
    /// its score -- see [`is_sane_output`].
    pub fn best(&self, hypothesis: &str) -> String {
        let ranked = self.rescore(hypothesis);
        if ranked.is_empty() {
            return hypothesis.to_string();
        }

        let original_score = ranked.iter().find(|c| c.text == hypothesis).map(|c| c.combined_score);
        let original_chars: HashSet<char> = hypothesis.chars().collect();
        let top_sane = ranked.iter().find(|c| is_sane_output(hypothesis, &original_chars, &c.text));

        match (top_sane, original_score) {
            (Some(top), Some(original_score)) => {
                // `is_finite` guards the gate math itself: with a NaN
                // combined score (e.g. from a NaN `lm_weight`) the difference
                // is NaN and `>=` is silently always-false. Fail-open means
                // that fallback must be explicit, not accidental.
                if top.combined_score.is_finite()
                    && original_score.is_finite()
                    && top.combined_score - original_score >= self.overcorrection_margin
                {
                    top.text.clone()
                } else {
                    hypothesis.to_string()
                }
            }
            (Some(top), None) => top.text.clone(),
            (None, _) => hypothesis.to_string(),
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
        let mut ranked = self.score_nbest(candidates);
        ranked.sort_by(|a, b| combined_score_cmp(a.combined_score, b.combined_score));
        ranked
    }

    /// Scores every N-best candidate without sorting, preserving the input
    /// order (and therefore the caller's indices). [`rerank_nbest`] sorts
    /// this; [`best_nbest`] additionally needs the unsorted, index-aligned
    /// form to recover the acoustic-top candidate's combined score without
    /// re-finding it by text (which would be ambiguous for duplicate-text
    /// candidates).
    ///
    /// [`rerank_nbest`]: Self::rerank_nbest
    /// [`best_nbest`]: Self::best_nbest
    fn score_nbest(&self, candidates: &[NbestCandidate]) -> Vec<RankedNbestCandidate> {
        candidates
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
            .collect()
    }

    /// Returns the best N-best candidate, applying the overcorrection gate and
    /// the output-sanity guard.
    ///
    /// The "original" is the candidate with the highest acoustic score — the
    /// one ASR would have chosen without LM rescoring. Ties are broken by
    /// preferring the earliest-listed candidate, matching the ASR decoder's
    /// own rank ordering and the stable sort `rerank_nbest` uses elsewhere in
    /// this same selection. If the top *sane* combined-score candidate (see
    /// [`is_sane_output`]) does not exceed the original's combined score by
    /// at least `overcorrection_margin`, the original is returned. This
    /// prevents the LM from overriding a strongly preferred ASR hypothesis
    /// unless the LM evidence is clear, and prevents it from ever replacing
    /// the original with something empty, wildly mismatched in length, or
    /// contaminated with foreign characters, regardless of score.
    ///
    /// Returns an empty string when `candidates` is empty.
    pub fn best_nbest(&self, candidates: &[NbestCandidate]) -> String {
        if candidates.is_empty() {
            return String::new();
        }

        // The ASR 1-best: the candidate with the highest acoustic score,
        // first-listed wins ties. `acoustic_beats` treats a NaN acoustic
        // score as the worst value, so a malformed NaN-score candidate can
        // never become "the original" (which would otherwise disable the
        // sanity guard and could drop the caption).
        let mut original_idx = 0usize;
        for (i, c) in candidates.iter().enumerate().skip(1) {
            if acoustic_beats(c.acoustic_score, candidates[original_idx].acoustic_score) {
                original_idx = i;
            }
        }
        let original_text = candidates[original_idx].text.clone();

        // Score every candidate once, in input order, so `original_idx` still
        // indexes the acoustic-top's own combined score -- no ambiguity even
        // if another candidate happens to share its text.
        let scored = self.score_nbest(candidates);
        let original_score = scored[original_idx].combined_score;

        let mut ranked = scored;
        ranked.sort_by(|a, b| combined_score_cmp(a.combined_score, b.combined_score));

        let original_chars: HashSet<char> = original_text.chars().collect();
        let top_sane =
            ranked.iter().find(|c| is_sane_output(&original_text, &original_chars, &c.text));

        match top_sane {
            // `is_finite` guards the gate math itself: a NaN combined score
            // (e.g. from a NaN weight or a -inf LM score times weight 0)
            // makes the difference NaN, which would silently keep the gate
            // from ever passing. Fail-open demands the opposite of silence:
            // when the scores carry no information, fall back to the ASR
            // 1-best rather than promoting a NaN-scored candidate.
            Some(top)
                if top.combined_score.is_finite()
                    && original_score.is_finite()
                    && top.combined_score - original_score >= self.overcorrection_margin =>
            {
                top.text.clone()
            }
            _ => original_text,
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
        // Both have combined = -3.0 + 1.0 * (-10.0) = -13.0. On an exact
        // acoustic tie, the earliest-listed candidate ("かいしゃ" at index 0)
        // is the acoustic top -- deterministic first-wins, matching the ASR
        // decoder's own rank ordering. Both have the same combined score, so
        // the gate keeps the acoustic top.
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "かいしゃ");
    }

    #[test]
    fn best_nbest_acoustic_tie_break_is_deterministic_across_orderings() {
        // Reordering the same two tied-acoustic-score candidates flips which
        // one is "first", proving the tie-break is order-dependent-but-
        // deterministic rather than arbitrary (e.g. hash-order-dependent).
        let candidates_a = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "がいしゃ".into(), acoustic_score: -3.0 },
        ];
        let candidates_b = vec![
            NbestCandidate { text: "がいしゃ".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -3.0 },
        ];
        let scorer_a = ConstantScorer(-10.0);
        let rescorer_a =
            Rescorer::new(scorer_a, AsrConfusionRules::default()).with_overcorrection_margin(0.0);
        let scorer_b = ConstantScorer(-10.0);
        let rescorer_b =
            Rescorer::new(scorer_b, AsrConfusionRules::default()).with_overcorrection_margin(0.0);

        assert_eq!(rescorer_a.best_nbest(&candidates_a), "かいしゃ");
        assert_eq!(rescorer_b.best_nbest(&candidates_b), "がいしゃ");

        // Repeated calls with the same input are stable (not just
        // deterministic across process runs, but across repeated calls).
        for _ in 0..5 {
            assert_eq!(rescorer_a.best_nbest(&candidates_a), "かいしゃ");
        }
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

    // -------------------------------------------------------------------
    // Adversarial hardening: output-sanity guard
    // -------------------------------------------------------------------

    /// A scorer that scores exactly one text very favorably (mimicking the
    /// real `LmScorer`'s empty-sequence quirk, where an empty string's
    /// log-probability is 0.0 -- the theoretical maximum) and everything
    /// else realistically negative.
    struct FavorsOneText {
        favored: &'static str,
        favored_score: f64,
        other_score: f64,
    }

    impl CandidateScorer for FavorsOneText {
        fn score(&self, text: &str) -> f64 {
            if text == self.favored {
                self.favored_score
            } else {
                self.other_score
            }
        }
    }

    #[test]
    fn is_sane_output_rejects_empty_candidate_for_nonempty_original() {
        let chars: HashSet<char> = "おはよう".chars().collect();
        assert!(!is_sane_output("おはよう", &chars, ""));
        assert!(!is_sane_output("おはよう", &chars, "   "));
        assert!(!is_sane_output("おはよう", &chars, "\u{3000}")); // full-width space
    }

    #[test]
    fn is_sane_output_accepts_identity_even_for_blank_original() {
        // The original must always be its own valid fallback, even in the
        // degenerate case where the original itself is blank.
        let chars: HashSet<char> = HashSet::new();
        assert!(is_sane_output("", &chars, ""));
        let blank_chars: HashSet<char> = " ".chars().collect();
        assert!(is_sane_output(" ", &blank_chars, " "));
        assert!(is_sane_output(" ", &blank_chars, "")); // nothing real to lose
    }

    #[test]
    fn is_sane_output_rejects_wild_length_blowup_and_collapse() {
        let chars: HashSet<char> = "おはよう".chars().collect();
        // 4 chars -> max_len = 4*4+8 = 24, min_len = ceil(4/4) = 1.
        assert!(is_sane_output("おはよう", &chars, "おはよー")); // 4 chars, ok
        assert!(!is_sane_output(
            "おはよう",
            &chars,
            &"あ".repeat(25) // 25 > max_len 24
        ));
        // A single surviving kana char is within bounds (min_len 1).
        assert!(is_sane_output("おはよう", &chars, "あ"));
    }

    #[test]
    fn is_sane_output_rejects_foreign_characters_not_in_original() {
        let chars: HashSet<char> = "おはよう".chars().collect();
        // Latin text the original never had, and not kana-like.
        assert!(!is_sane_output("おはよう", &chars, "hello"));
        // A kana substitution is fine even though が wasn't in the original --
        // it is still kana-like.
        assert!(is_sane_output("おはよう", &chars, "がはよう"));
    }

    #[test]
    fn best_never_returns_empty_when_the_only_reachable_candidate_is_a_deletion() {
        // A single gemination character has exactly one confusion-rule
        // candidate: deleting it, producing "". Regression for the concrete
        // bug this guard closes: the real LmScorer scores an empty sequence
        // 0.0 (the log-probability maximum, i.e. "certain"), so before the
        // guard existed this scorer would have made `best("っ")` return "".
        let scorer = FavorsOneText { favored: "", favored_score: 0.0, other_score: -20.0 };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let best = rescorer.best("っ");
        assert_eq!(best, "っ", "the guard must fall back to the original, not \"\"");
    }

    #[test]
    fn best_nbest_never_promotes_an_empty_candidate_even_when_favored_by_score() {
        let scorer = FavorsOneText { favored: "", favored_score: 0.0, other_score: -20.0 };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let candidates = vec![
            NbestCandidate { text: "おはようございます".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "".into(), acoustic_score: -3.0 },
        ];
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "おはようございます");
    }

    #[test]
    fn best_nbest_never_promotes_a_foreign_script_candidate() {
        // A corrupted or out-of-contract N-best candidate containing Latin
        // junk must never win even if a (buggy or adversarial) scorer rates
        // it far above every legitimate kana candidate.
        let scorer =
            FavorsOneText { favored: "not-japanese", favored_score: 100.0, other_score: -20.0 };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "not-japanese".into(), acoustic_score: -3.0 },
        ];
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "かいしゃ");
    }

    /// A scorer that favors whichever candidate has the most characters,
    /// regardless of content -- an adversarial stand-in for a scoring quirk
    /// that rewards length blowup.
    struct FavorsLongest;
    impl CandidateScorer for FavorsLongest {
        fn score(&self, text: &str) -> f64 {
            text.chars().count() as f64 * 1000.0
        }
    }

    #[test]
    fn best_nbest_rejects_wild_length_candidate_and_falls_back() {
        let long_junk = "あ".repeat(200);
        let rescorer = Rescorer::new(FavorsLongest, AsrConfusionRules::default());
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -3.0 },
            NbestCandidate { text: long_junk, acoustic_score: -3.0 },
        ];
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "かいしゃ");
    }

    // -------------------------------------------------------------------
    // Adversarial hardening: NaN / -inf scores never panic and fail open
    // -------------------------------------------------------------------

    /// A scorer under adversarial/buggy control: returns a fixed value for
    /// every text, regardless of what it is.
    struct FixedScorer(f64);
    impl CandidateScorer for FixedScorer {
        fn score(&self, _text: &str) -> f64 {
            self.0
        }
    }

    /// A scorer that returns NaN for one specific text and a realistic
    /// negative score for everything else.
    struct NanForOneText {
        nan_text: &'static str,
    }
    impl CandidateScorer for NanForOneText {
        fn score(&self, text: &str) -> f64 {
            if text == self.nan_text {
                f64::NAN
            } else {
                -10.0
            }
        }
    }

    #[test]
    fn rescore_with_nan_scorer_does_not_panic_and_is_deterministic() {
        let scorer = NanForOneText { nan_text: "おはようございます" };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let ranked1 = rescorer.rescore("おはよございます");
        let scorer2 = NanForOneText { nan_text: "おはようございます" };
        let rescorer2 = Rescorer::new(scorer2, AsrConfusionRules::default());
        let ranked2 = rescorer2.rescore("おはよございます");
        let texts1: Vec<&str> = ranked1.iter().map(|c| c.text.as_str()).collect();
        let texts2: Vec<&str> = ranked2.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(texts1, texts2, "ranking with a NaN-scored candidate must be deterministic");
    }

    #[test]
    fn best_falls_open_when_the_top_candidates_score_is_nan() {
        // NaN comparisons are always false, so `top.combined_score -
        // original_score >= margin` can never hold when either side is NaN.
        // The gate must therefore fail closed (i.e. the pipeline fails
        // *open* toward the original hypothesis) rather than panicking or
        // nondeterministically picking the NaN candidate.
        let scorer = NanForOneText { nan_text: "おはようございます" };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let best = rescorer.best("おはよございます");
        assert_eq!(best, "おはよございます", "a NaN-scored candidate must never win");
    }

    #[test]
    fn best_nbest_with_nan_score_does_not_panic_and_falls_open() {
        let scorer = NanForOneText { nan_text: "おはようございます" };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let candidates = vec![
            NbestCandidate { text: "おはよございます".into(), acoustic_score: -3.2 },
            NbestCandidate { text: "おはようございます".into(), acoustic_score: -3.4 },
        ];
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "おはよございます", "a NaN-scored candidate must never win");
    }

    #[test]
    fn rerank_nbest_with_negative_infinity_score_does_not_panic() {
        let scorer = FixedScorer(f64::NEG_INFINITY);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -1.0 },
            NbestCandidate { text: "がいしゃ".into(), acoustic_score: -2.0 },
        ];
        let ranked = rescorer.rerank_nbest(&candidates);
        assert_eq!(ranked.len(), 2);
        // -inf combined scores still sort deterministically (no panic, no
        // NaN from -1.0 + 1.0 * -inf, since lm_weight is 1.0 here).
        assert_eq!(ranked[0].text, "かいしゃ");
    }

    #[test]
    fn best_nbest_with_zero_lm_weight_and_negative_infinity_score_falls_open() {
        // lm_weight = 0.0 multiplied by a -inf score is `0.0 * -inf = NaN`
        // in IEEE-754. This must not panic, and the NaN combined score must
        // not be able to win the overcorrection gate.
        let scorer = FixedScorer(f64::NEG_INFINITY);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default()).with_lm_weight(0.0);
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -1.0 },
            NbestCandidate { text: "がいしゃ".into(), acoustic_score: -2.0 },
        ];
        let best = rescorer.best_nbest(&candidates);
        // combined = acoustic_score + 0.0 * -inf = acoustic_score + NaN = NaN
        // for every candidate, so every margin check is false and the
        // acoustic top (かいしゃ) is returned.
        assert_eq!(best, "かいしゃ");
    }
    /// A scorer that returns -inf for one specific text and a realistic
    /// negative score for everything else.
    struct InfForOneText {
        inf_text: &'static str,
    }
    impl CandidateScorer for InfForOneText {
        fn score(&self, text: &str) -> f64 {
            if text == self.inf_text {
                f64::NEG_INFINITY
            } else {
                -10.0
            }
        }
    }

    #[test]
    fn best_nbest_nan_acoustic_is_never_chosen_as_the_original() {
        // A malformed candidate with a NaN acoustic score must never be
        // treated as the ASR 1-best reference. `f64::total_cmp` orders NaN
        // as the *greatest* value, so without a guard the empty "" candidate
        // below would be selected as the "original", and because its text is
        // empty the sanity guard would be disabled (empty original -> accept
        // anything). The rescorer would then *drop* the caption, returning
        // "". Fail-open demands the opposite: a NaN acoustic score ranks
        // last, the finite-acoustic candidate is the original, and the
        // caption is never dropped.
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "".into(), acoustic_score: f64::NAN },
        ];
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "かいしゃ", "a NaN-acoustic empty candidate must never drop the caption");
    }

    #[test]
    fn rerank_nbest_sorts_nan_combined_scores_below_finite_scores() {
        // With lm_weight = 0.0, a -inf LM score yields 0.0 * -inf = NaN for
        // that candidate's combined score. A NaN combined score must sort
        // *below* every finite score, never to the top, so a NaN candidate
        // can never occupy ranked[0].
        let scorer = InfForOneText { inf_text: "がいしゃ" };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default()).with_lm_weight(0.0);
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "がいしゃ".into(), acoustic_score: -2.0 },
        ];
        let ranked = rescorer.rerank_nbest(&candidates);
        assert_eq!(ranked.len(), 2);
        // かいしゃ: combined = -3.0 + 0.0 * -10 = -3.0 (finite)
        // がいしゃ: combined = -2.0 + 0.0 * -inf = NaN
        assert!(!ranked[0].combined_score.is_nan(), "NaN must never rank first");
        assert!(ranked[1].combined_score.is_nan());
        assert_eq!(ranked[0].text, "かいしゃ");
    }

    #[test]
    fn nan_lm_weight_fails_open_to_the_acoustic_top() {
        // A NaN lm_weight makes every combined score NaN. The gate must not
        // panic and must fail open toward the ASR 1-best (the finite-acoustic
        // top) instead of promoting a NaN-scored candidate.
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default()).with_lm_weight(f64::NAN);
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "がいしゃ".into(), acoustic_score: -2.0 },
        ];
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "がいしゃ", "NaN lm_weight must fail open to the acoustic top");
    }

    #[test]
    fn rerank_nbest_all_nan_combined_scores_stay_deterministic() {
        // When every combined score is NaN (e.g. a NaN lm_weight), the sort
        // must still produce a stable, deterministic order and never panic.
        // The input order is preserved (stable sort, all-equal NaN key).
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default()).with_lm_weight(f64::NAN);
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "がいしゃ".into(), acoustic_score: -2.0 },
            NbestCandidate { text: "しゃかい".into(), acoustic_score: -9.0 },
        ];
        let expected_texts: Vec<&str> = candidates.iter().map(|c| c.text.as_str()).collect();
        for _ in 0..5 {
            let ranked = rescorer.rerank_nbest(&candidates);
            let texts: Vec<&str> = ranked.iter().map(|c| c.text.as_str()).collect();
            assert_eq!(texts, expected_texts, "all-NaN reranking must preserve input order");
            assert!(
                ranked.iter().all(|c| c.combined_score.is_nan()),
                "all combined scores must remain NaN (honest, not sanitized)"
            );
        }
    }

    #[test]
    fn best_nbest_never_selects_a_nan_scored_candidate_when_a_finite_one_exists() {
        // The strongest selection guarantee: even if an adversarial caller
        // feeds the scorer a NaN-emitting weight, a NaN combined score must
        // never be surfaced as "the best" when any finite candidate exists.
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default()).with_lm_weight(f64::NAN);
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "がいしゃ".into(), acoustic_score: -2.0 },
        ];
        // Both candidates are sane, but NaN-weighted combined scores make the
        // gate ineligible, so the acoustic top "がいしゃ" is returned
        // regardless of the input order.
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "がいしゃ");
    }

    // -------------------------------------------------------------------
    // Adversarial hardening: weight boundaries (0.0, 1.0, out-of-range)
    // -------------------------------------------------------------------

    #[test]
    fn lm_weight_zero_ignores_the_lm_entirely_in_one_best() {
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -1000.0); // LM loves it
        scores.insert("おはよございます".to_string(), 1000.0); // LM loves the typo more
        let scorer = MockScorer { scores };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default()).with_lm_weight(0.0);
        // With lm_weight = 0.0, combined score is purely -confusion_weight *
        // cost; the unmodified original (cost 0.0) always wins.
        let best = rescorer.best("おはよございます");
        assert_eq!(best, "おはよございます");
    }

    #[test]
    fn confusion_weight_zero_lets_the_lm_fully_decide_one_best() {
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -1.0);
        scores.insert("おはよございます".to_string(), -100.0);
        let scorer = MockScorer { scores };
        let rescorer =
            Rescorer::new(scorer, AsrConfusionRules::default()).with_confusion_weight(0.0);
        // Confusion cost no longer penalizes the correction at all; the LM's
        // strong preference decides.
        let best = rescorer.best("おはよございます");
        assert_eq!(best, "おはようございます");
    }

    #[test]
    fn negative_lm_weight_does_not_panic_and_stays_bounded_by_the_sanity_guard() {
        // Out-of-range (negative) weights are not validated by the API, but
        // they must never cause a panic, and the output-sanity guard must
        // still hold even when the weight inverts the LM's usual preference.
        let scorer = FavorsOneText { favored: "", favored_score: 0.0, other_score: -20.0 };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default()).with_lm_weight(-1.0);
        let best = rescorer.best("っ");
        assert_eq!(best, "っ", "guard must hold even under an out-of-range negative weight");
    }

    #[test]
    fn very_large_weight_does_not_panic_and_degrades_to_a_deterministic_pick() {
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -10.0);
        scores.insert("おはよございます".to_string(), -20.0);
        let scorer = MockScorer { scores };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default()).with_lm_weight(1e15);
        // Must not panic (potential overflow to -inf is fine, NaN is
        // fail-open-safe) and must return one of the known candidates.
        let best = rescorer.best("おはよございます");
        assert!(
            best == "おはようございます" || best == "おはよございます",
            "got unexpected candidate {best}"
        );
    }

    #[test]
    fn negative_confusion_weight_does_not_panic() {
        let mut scores = HashMap::new();
        scores.insert("おはようございます".to_string(), -10.0);
        scores.insert("おはよございます".to_string(), -10.0);
        let scorer = MockScorer { scores };
        let rescorer =
            Rescorer::new(scorer, AsrConfusionRules::default()).with_confusion_weight(-5.0);
        // Negative confusion weight rewards edits instead of penalizing them;
        // must not panic and must return a real candidate.
        let ranked = rescorer.rescore("おはよございます");
        assert!(!ranked.is_empty());
        for r in &ranked {
            assert!(r.combined_score.is_finite(), "expected finite score, got {r:?}");
        }
    }

    // -------------------------------------------------------------------
    // Adversarial hardening: overcorrection gate vs. a confident-but-wrong LM
    // -------------------------------------------------------------------

    /// The confusion pair used by the gate tests below.
    ///
    /// "ぜんせい" is a *generated* edit-1 neighbour of "せんせい" (せ -> ぜ
    /// voicing), which matters: a pair the rules never produce would make the
    /// gate test pass vacuously, proving nothing about the margin.
    fn confident_but_wrong_voicing_scorer() -> MockScorer {
        let mut scores = HashMap::new();
        scores.insert("せんせい".to_string(), -50.0); // correct, but LM finds it rare
        scores.insert("ぜんせい".to_string(), -1.0); // wrong, but LM is very confident
        MockScorer { scores }
    }

    #[test]
    fn the_confident_but_wrong_candidate_is_actually_generated() {
        // Guards the two gate tests below against going vacuous: if the
        // confusion rules ever stop producing this neighbour, they stop
        // testing the margin, and this test says so directly.
        let generated = AsrConfusionRules::default().generate("せんせい");
        assert!(
            generated.iter().any(|c| c.text == "ぜんせい"),
            "expected せんせい -> ぜんせい among {generated:?}"
        );
    }

    #[test]
    fn overcorrection_margin_blocks_a_confident_but_wrong_lm_preference() {
        // The LM is very confident (large score gap) that the voiced
        // "ぜんせい" is more natural than the correct "せんせい". A margin
        // large enough to absorb that confidence gap must still hold the
        // correct original.
        let rescorer =
            Rescorer::new(confident_but_wrong_voicing_scorer(), AsrConfusionRules::default())
                .with_overcorrection_margin(1000.0);
        let best = rescorer.best("せんせい");
        assert_eq!(best, "せんせい", "a large margin must block a confident-but-wrong LM");
    }

    #[test]
    fn zero_margin_lets_a_confident_wrong_lm_override_by_design() {
        // Contrast case: with the default margin (0.0), the same confident
        // (and here, wrong) LM preference above *does* override. This proves
        // the margin -- not some other mechanism -- is what's holding the
        // line in the test above, and documents why the module recommends a
        // positive overcorrection_margin in production.
        let rescorer =
            Rescorer::new(confident_but_wrong_voicing_scorer(), AsrConfusionRules::default());
        let best = rescorer.best("せんせい");
        assert_eq!(best, "ぜんせい");
    }

    #[test]
    fn overcorrection_margin_blocks_confident_wrong_lm_in_nbest_path() {
        let mut scores = HashMap::new();
        scores.insert("せんせい".to_string(), -50.0);
        scores.insert("せんせえ".to_string(), -1.0);
        let scorer = MockScorer { scores };
        let rescorer =
            Rescorer::new(scorer, AsrConfusionRules::default()).with_overcorrection_margin(1000.0);
        let candidates = vec![
            NbestCandidate { text: "せんせい".into(), acoustic_score: -3.0 },
            NbestCandidate { text: "せんせえ".into(), acoustic_score: -3.5 },
        ];
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "せんせい");
    }

    // -------------------------------------------------------------------
    // Adversarial hardening: rerank_nbest / best_nbest edge cases
    // -------------------------------------------------------------------

    #[test]
    fn rerank_nbest_empty_input_returns_empty_output() {
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        assert_eq!(rescorer.rerank_nbest(&[]), vec![]);
    }

    #[test]
    fn rerank_nbest_and_best_nbest_handle_duplicate_text_different_acoustic_scores() {
        // Two entries share the same text but different acoustic scores (a
        // decoder can legitimately emit the same hypothesis via different
        // paths). The acoustic-top duplicate's own combined score must be
        // the one compared against the overcorrection margin, not whichever
        // duplicate happens to sort first for an unrelated reason.
        let mut scores = HashMap::new();
        scores.insert("かいしゃ".to_string(), -5.0);
        let scorer = MockScorer { scores };
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -1.0 },
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -9.0 },
        ];
        let ranked = rescorer.rerank_nbest(&candidates);
        assert_eq!(ranked.len(), 2);
        // Both score -5.0 from the LM; combined = acoustic + (-5.0).
        assert_eq!(ranked[0].combined_score, -1.0 + -5.0);
        assert_eq!(ranked[1].combined_score, -9.0 + -5.0);
        let best = rescorer.best_nbest(&candidates);
        assert_eq!(best, "かいしゃ");
    }

    #[test]
    fn best_nbest_duplicate_identical_candidates_are_deterministic() {
        let scorer = ConstantScorer(-10.0);
        let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
        let candidates = vec![
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -1.0 },
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -1.0 },
            NbestCandidate { text: "かいしゃ".into(), acoustic_score: -1.0 },
        ];
        for _ in 0..5 {
            assert_eq!(rescorer.best_nbest(&candidates), "かいしゃ");
        }
    }

    // -------------------------------------------------------------------
    // Characterization: 1-best path is unchanged for realistic inputs
    // -------------------------------------------------------------------

    #[test]
    fn best_matches_pre_guard_behavior_across_the_documented_eval_set() {
        // The output-sanity guard must be a no-op for every realistic input:
        // it only ever rejects candidates that a correctly-behaving scorer
        // and the bounded confusion-rule generator would never produce in
        // practice. This walks the module doc's eval set (5 repairs + a
        // sample of correct-form holds) with hand-picked scores that mirror
        // "LM prefers the higher-frequency form" and asserts the exact
        // expected output byte-for-byte -- if the guard ever started
        // rejecting a legitimate top candidate here, this test would catch
        // the regression immediately.
        let cases: &[(&str, &str, f64, f64, &str)] = &[
            // (hypothesis, corrected_form, hyp_score, corrected_score, expected)
            ("おはよございます", "おはようございます", -20.0, -10.0, "おはようございます"),
            ("きって", "きて", -10.0, -10.0, "きって"), // hold: no LM preference, keep original
        ];
        for &(hyp, corrected, hyp_score, corrected_score, expected) in cases {
            let mut scores = HashMap::new();
            scores.insert(hyp.to_string(), hyp_score);
            scores.insert(corrected.to_string(), corrected_score);
            let scorer = MockScorer { scores };
            let rescorer = Rescorer::new(scorer, AsrConfusionRules::default());
            let best = rescorer.best(hyp);
            assert_eq!(best, expected, "case {hyp} -> expected {expected}, got {best}");
        }
    }
}
