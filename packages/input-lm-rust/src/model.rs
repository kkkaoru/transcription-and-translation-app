//! Kneser-Ney smoothed n-gram model.
//!
//! Ported from `EfficientNGram` in
//! `submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/Inference.swift`.

use crate::codec::{
    decode_key, decode_value, point_prefix, predictive_prefix, KEY_VALUE_DELIMITER,
};
use crate::trie::NgramTrie;

/// Model hyperparameters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NgramParams {
    /// Order of the model. azooKey ships `n = 5`.
    pub n: usize,
    /// Kneser-Ney discount. azooKey ships `d = 0.75`.
    pub d: f64,
    /// Token count of the tokenizer backing the model.
    pub vocab_size: usize,
    /// Token used to left-pad a context shorter than `n - 1`.
    ///
    /// For `input_n5_lm_v1` this is `<s>` = 2. Note that 0 is `[UNK]`, so
    /// leaving this at zero would silently pad with unknown tokens.
    pub start_token_id: usize,
}

impl Default for NgramParams {
    fn default() -> Self {
        Self { n: 5, d: 0.75, vocab_size: 6000, start_token_id: 2 }
    }
}

/// Reads the single value stored under an exact key, or 0 when absent.
pub fn lookup_value<T: NgramTrie>(trie: &T, key: &[usize]) -> u32 {
    let prefix = point_prefix(key);
    for entry in trie.predictive_search(&prefix) {
        if entry.len() < prefix.len() {
            continue;
        }
        if let Some(value) = decode_value(&entry[prefix.len()..]) {
            return value;
        }
    }
    0
}

/// Reads every one-token continuation of `key`, plus their total.
///
/// The returned vector is indexed by token id and is `vocab_size` long.
pub fn lookup_continuations<T: NgramTrie>(
    trie: &T,
    key: &[usize],
    vocab_size: usize,
) -> (Vec<u32>, u32) {
    let prefix = predictive_prefix(key);
    let mut values = vec![0u32; vocab_size];
    let mut sum: u32 = 0;
    for entry in trie.predictive_search(&prefix) {
        if entry.len() < prefix.len() {
            continue;
        }
        let suffix = &entry[prefix.len()..];
        // Two digits of token, the delimiter, then the value.
        if suffix.len() < 3 {
            continue;
        }
        if suffix[2] != KEY_VALUE_DELIMITER {
            continue;
        }
        let Some(value) = decode_value(&suffix[3..]) else {
            continue;
        };
        let word = decode_key(suffix[0], suffix[1]);
        if word < values.len() {
            values[word] = value;
            sum = sum.saturating_add(value);
        }
    }
    (values, sum)
}

/// One lower-order term of the interpolated back-off chain.
struct PlfItem {
    u_xbc_abc: Vec<u32>,
    u_xbx_ab: u32,
    r_xbx_ab: u32,
}

/// A Kneser-Ney model over four tries.
///
/// The trie names mirror the upstream files: `c_abc`, `u_abx`, `u_xbc`, `r_xbx`.
pub struct EfficientNGram<T: NgramTrie> {
    params: NgramParams,
    c_abc: T,
    u_abx: T,
    u_xbc: T,
    r_xbx: T,
}

impl<T: NgramTrie> EfficientNGram<T> {
    /// Builds a model from its four tries.
    pub fn new(params: NgramParams, c_abc: T, u_abx: T, u_xbc: T, r_xbx: T) -> Self {
        Self { params, c_abc, u_abx, u_xbc, r_xbx }
    }

    /// The hyperparameters this model was built with.
    pub fn params(&self) -> NgramParams {
        self.params
    }

    /// Interpolated Kneser-Ney probability of one token.
    fn predict(
        &self,
        next_word: usize,
        c_abx_ab: u32,
        u_abx_ab: u32,
        c_abc_abc: u32,
        plf_items: &[PlfItem],
    ) -> f64 {
        let d = self.params.d;
        let (alpha, gamma) = if c_abx_ab != 0 {
            let denominator = f64::from(c_abx_ab);
            (
                (f64::from(c_abc_abc) - d).max(0.0) / denominator,
                d * f64::from(u_abx_ab) / denominator,
            )
        } else {
            (0.0, 1.0)
        };

        let mut plf = 0.0;
        let mut coef = 1.0;
        for item in plf_items {
            let (lower_alpha, lower_gamma) = if item.u_xbx_ab > 0 {
                let denominator = f64::from(item.u_xbx_ab);
                let count = item.u_xbc_abc.get(next_word).copied().unwrap_or(0);
                (
                    (f64::from(count) - d).max(0.0) / denominator,
                    d * f64::from(item.r_xbx_ab) / denominator,
                )
            } else {
                (0.0, 1.0)
            };
            plf += lower_alpha * coef;
            coef *= lower_gamma;
        }
        plf += coef / self.params.vocab_size as f64;

        alpha + gamma * plf
    }

    /// Probability of every token in the vocabulary following `context`.
    ///
    /// `context` is truncated to its last `n - 1` tokens, or left-padded with
    /// [`NgramParams::start_token_id`] when it is shorter.
    pub fn bulk_predict(&self, context: &[usize]) -> Vec<f64> {
        let wanted = self.params.n.saturating_sub(1);
        let ab: Vec<usize> = if context.len() >= wanted {
            context[context.len() - wanted..].to_vec()
        } else {
            let mut padded = vec![self.params.start_token_id; wanted - context.len()];
            padded.extend_from_slice(context);
            padded
        };

        let vocab_size = self.params.vocab_size;
        let u_abx_ab = lookup_value(&self.u_abx, &ab);
        let (c_abc_abc, c_abx_ab) = lookup_continuations(&self.c_abc, &ab, vocab_size);

        let mut plf_items = Vec::with_capacity(wanted.saturating_sub(1));
        for i in 1..wanted {
            let tail = &ab[i..];
            let r_xbx_ab = lookup_value(&self.r_xbx, tail);
            let (u_xbc_abc, u_xbx_ab) = lookup_continuations(&self.u_xbc, tail, vocab_size);
            plf_items.push(PlfItem { u_xbc_abc, u_xbx_ab, r_xbx_ab });
        }

        (0..self.params.vocab_size)
            .map(|word| self.predict(word, c_abx_ab, u_abx_ab, c_abc_abc[word], &plf_items))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trie::MemoryTrie;

    const EPS: f64 = 1e-12;

    fn toy_params() -> NgramParams {
        NgramParams { n: 3, d: 0.5, vocab_size: 4, start_token_id: 0 }
    }

    fn empty_model() -> EfficientNGram<MemoryTrie> {
        EfficientNGram::new(
            toy_params(),
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
        )
    }

    /// Hand-checkable model over context `[1, 2]`.
    ///
    /// c_abc: [1,2]->3 = 4, [1,2]->1 = 4   (so c_abx_ab = 8)
    /// u_abx: [1,2] = 2
    /// u_xbc: [2]->3 = 1, [2]->1 = 1       (so u_xbx_ab = 2)
    /// r_xbx: [2] = 1
    fn toy_model() -> EfficientNGram<MemoryTrie> {
        let mut c_abc = MemoryTrie::new();
        c_abc.insert_predictive(&[1, 2, 3], 4);
        c_abc.insert_predictive(&[1, 2, 1], 4);

        let mut u_abx = MemoryTrie::new();
        u_abx.insert_point(&[1, 2], 2);

        let mut u_xbc = MemoryTrie::new();
        u_xbc.insert_predictive(&[2, 3], 1);
        u_xbc.insert_predictive(&[2, 1], 1);

        let mut r_xbx = MemoryTrie::new();
        r_xbx.insert_point(&[2], 1);

        EfficientNGram::new(toy_params(), c_abc, u_abx, u_xbc, r_xbx)
    }

    #[test]
    fn returns_one_probability_per_vocabulary_entry() {
        assert_eq!(empty_model().bulk_predict(&[1, 2]).len(), 4);
    }

    #[test]
    fn empty_tries_fall_back_to_the_uniform_distribution() {
        // Both zero branches fire: alpha = 0, gamma = 1 at every level, so the
        // whole mass is the uniform 1/vocab_size floor.
        let probabilities = empty_model().bulk_predict(&[1, 2]);
        for probability in probabilities {
            assert!((probability - 0.25).abs() < EPS, "got {probability}");
        }
    }

    #[test]
    fn scores_a_seen_continuation_by_hand() {
        // alpha = (4 - 0.5) / 8       = 0.4375
        // gamma = 0.5 * 2 / 8         = 0.125
        // lower alpha = (1 - 0.5) / 2 = 0.25
        // lower gamma = 0.5 * 1 / 2   = 0.25
        // plf = 0.25 + 0.25 / 4       = 0.3125
        // p   = 0.4375 + 0.125 * 0.3125
        let expected = 0.4375 + 0.125 * 0.3125;
        let got = toy_model().bulk_predict(&[1, 2])[3];
        assert!((got - expected).abs() < EPS, "expected {expected}, got {got}");
    }

    #[test]
    fn scores_an_unseen_continuation_by_hand() {
        // Both discounted numerators clamp to zero, leaving only the floor:
        // p = gamma * (coef / vocab_size) = 0.125 * (0.25 / 4)
        let expected = 0.125 * (0.25 / 4.0);
        let got = toy_model().bulk_predict(&[1, 2])[0];
        assert!((got - expected).abs() < EPS, "expected {expected}, got {got}");
    }

    #[test]
    fn a_seen_continuation_outranks_an_unseen_one() {
        let probabilities = toy_model().bulk_predict(&[1, 2]);
        assert!(probabilities[3] > probabilities[0]);
        assert!(probabilities[1] > probabilities[0]);
    }

    #[test]
    fn a_longer_context_is_truncated_to_its_final_tokens() {
        let model = toy_model();
        // n = 3, so only the trailing [1, 2] can matter.
        assert_eq!(model.bulk_predict(&[9, 9, 9, 1, 2]), model.bulk_predict(&[1, 2]));
    }

    #[test]
    fn a_short_context_is_left_padded_with_the_start_token() {
        let mut c_abc = MemoryTrie::new();
        // Reachable only when [] is padded to [start, start] == [0, 0].
        c_abc.insert_predictive(&[0, 0, 2], 6);
        let model = EfficientNGram::new(
            toy_params(),
            c_abc,
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
        );

        let padded = model.bulk_predict(&[]);
        assert!(padded[2] > padded[1], "padding did not reach the [0, 0] entry");
        // Stating it the other way: an explicit [0, 0] context agrees.
        assert_eq!(padded, model.bulk_predict(&[0, 0]));
    }

    #[test]
    fn an_unknown_context_still_yields_the_uniform_floor() {
        let probabilities = toy_model().bulk_predict(&[5, 5]);
        for probability in probabilities {
            assert!((probability - 0.25).abs() < EPS, "got {probability}");
        }
    }

    #[test]
    fn missing_lower_order_counts_collapse_that_level_to_pass_through() {
        // c_abc is populated but u_xbc/r_xbx are not, so the lower level takes
        // its zero branch: alpha = 0, gamma = 1, leaving plf = 1 / vocab_size.
        let mut c_abc = MemoryTrie::new();
        c_abc.insert_predictive(&[1, 2, 3], 4);
        c_abc.insert_predictive(&[1, 2, 1], 4);
        let mut u_abx = MemoryTrie::new();
        u_abx.insert_point(&[1, 2], 2);

        let model =
            EfficientNGram::new(toy_params(), c_abc, u_abx, MemoryTrie::new(), MemoryTrie::new());
        let expected = 0.4375 + 0.125 * 0.25;
        let got = model.bulk_predict(&[1, 2])[3];
        assert!((got - expected).abs() < EPS, "expected {expected}, got {got}");
    }

    #[test]
    fn consistent_counts_sum_to_exactly_one() {
        // Kneser-Ney is a proper distribution when the stored distinct-
        // continuation counts agree with the continuations actually present:
        // u_abx == |{w : c(abw) > 0}| and r_xbx == |{w : u_xbc(bw) > 0}|.
        // This pins the discount and both interpolation weights at once — get
        // any of them wrong and the total drifts off 1.
        let mut c_abc = MemoryTrie::new();
        c_abc.insert_predictive(&[1, 2, 1], 3);
        c_abc.insert_predictive(&[1, 2, 3], 5);
        let mut u_abx = MemoryTrie::new();
        u_abx.insert_point(&[1, 2], 2); // two distinct continuations

        let mut u_xbc = MemoryTrie::new();
        u_xbc.insert_predictive(&[2, 1], 1);
        u_xbc.insert_predictive(&[2, 3], 1);
        let mut r_xbx = MemoryTrie::new();
        r_xbx.insert_point(&[2], 2); // two distinct continuations

        let model = EfficientNGram::new(toy_params(), c_abc, u_abx, u_xbc, r_xbx);
        let total: f64 = model.bulk_predict(&[1, 2]).iter().sum();
        assert!((total - 1.0).abs() < EPS, "summed to {total}");
    }

    #[test]
    fn an_inflated_distinct_count_pushes_the_total_above_one() {
        // This is the shape of the shipped input_n5_lm_v1 tries: c_abc was
        // pruned, so u_abx reports more distinct continuations than survive.
        // The result is a slightly over-weighted back-off and a total above 1.
        let mut c_abc = MemoryTrie::new();
        c_abc.insert_predictive(&[1, 2, 1], 3);
        c_abc.insert_predictive(&[1, 2, 3], 5);
        let mut u_abx = MemoryTrie::new();
        u_abx.insert_point(&[1, 2], 6); // claims 6, only 2 survive

        let mut u_xbc = MemoryTrie::new();
        u_xbc.insert_predictive(&[2, 1], 1);
        u_xbc.insert_predictive(&[2, 3], 1);
        let mut r_xbx = MemoryTrie::new();
        r_xbx.insert_point(&[2], 2);

        let model = EfficientNGram::new(toy_params(), c_abc, u_abx, u_xbc, r_xbx);
        let total: f64 = model.bulk_predict(&[1, 2]).iter().sum();
        assert!(total > 1.0, "expected an inflated total, got {total}");
    }

    #[test]
    fn default_params_match_the_shipped_azookey_configuration() {
        let params = NgramParams::default();
        assert_eq!(params.n, 5);
        assert!((params.d - 0.75).abs() < EPS);
        assert_eq!(params.vocab_size, 6000);
        // <s> in the shipped GPT2 tokenizer; 0 would be [UNK].
        assert_eq!(params.start_token_id, 2);
    }

    #[test]
    fn a_five_gram_context_builds_three_backoff_levels() {
        // n = 5 means ab has 4 tokens and the loop runs for i = 1, 2, 3.
        let params = NgramParams { n: 5, d: 0.75, vocab_size: 3, start_token_id: 0 };
        let model = EfficientNGram::new(
            params,
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
            MemoryTrie::new(),
        );
        let probabilities = model.bulk_predict(&[1, 2, 3, 4]);
        assert_eq!(probabilities.len(), 3);
        // Every level takes its zero branch, so the floor is still uniform.
        for probability in probabilities {
            assert!((probability - 1.0 / 3.0).abs() < EPS, "got {probability}");
        }
    }
}
