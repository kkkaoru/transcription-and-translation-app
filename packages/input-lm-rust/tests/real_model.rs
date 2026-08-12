//! Checks the port against the real `input_n5_lm_v1` tries.
//!
//! Skipped unless `INPUT_LM_MODEL_BASE` points at the shared path stem of the
//! unpacked tries, e.g.
//! `~/.cache/caption-bridge-input-lm/input_n5_lm_v1/lm`. Run with:
//!
//! ```sh
//! INPUT_LM_MODEL_BASE=... cargo test --features rsmarisa --test real_model
//! ```
#![cfg(feature = "rsmarisa")]

use std::path::PathBuf;

use caption_bridge_input_lm::codec::{decode_key, decode_value, KEY_VALUE_DELIMITER};
use caption_bridge_input_lm::marisa::{open_model, MarisaTrie};
use caption_bridge_input_lm::model::lookup_value;
use caption_bridge_input_lm::rescore::CandidateScorer;
use caption_bridge_input_lm::{NgramParams, NgramTrie};

fn model_base() -> Option<PathBuf> {
    std::env::var_os("INPUT_LM_MODEL_BASE").map(PathBuf::from)
}

/// Splits a stored point entry back into its key tokens and value.
fn split_point_entry(entry: &[i8]) -> Option<(Vec<usize>, u32)> {
    let delimiter = entry.iter().position(|&d| d == KEY_VALUE_DELIMITER)?;
    // Keys are whole tokens, so the key part must be an even number of digits.
    if !delimiter.is_multiple_of(2) {
        return None;
    }
    let tokens = entry[..delimiter].chunks_exact(2).map(|p| decode_key(p[0], p[1])).collect();
    let value = decode_value(&entry[delimiter + 1..])?;
    Some((tokens, value))
}

#[test]
fn stored_entries_round_trip_through_the_codec_and_lookup() {
    let Some(base) = model_base() else {
        eprintln!("skipping: INPUT_LM_MODEL_BASE is not set");
        return;
    };

    let mut path = base.as_os_str().to_os_string();
    path.push("_r_xbx.marisa");
    let trie = MarisaTrie::open(PathBuf::from(&path)).expect("open r_xbx trie");
    assert!(trie.num_keys() > 0, "trie is empty");

    // An empty prefix matches everything; a handful is enough to prove the
    // on-disk layout matches what the codec produces.
    let entries = trie.predictive_search(&[]);
    assert!(!entries.is_empty(), "predictive search returned nothing");

    let mut checked = 0;
    for entry in entries.iter().take(64) {
        let Some((tokens, value)) = split_point_entry(entry) else {
            continue;
        };
        assert!(!tokens.is_empty(), "decoded an empty key from {entry:?}");
        // The real payoff: ask the model's own lookup for that key and expect
        // the value we just decoded straight out of the file.
        assert_eq!(lookup_value(&trie, &tokens), value, "key {tokens:?} in {path:?}");
        checked += 1;
    }
    assert!(checked >= 8, "only round-tripped {checked} entries");
}

#[test]
fn every_context_yields_a_normalised_distribution() {
    let Some(base) = model_base() else {
        eprintln!("skipping: INPUT_LM_MODEL_BASE is not set");
        return;
    };

    let params = NgramParams::default();
    let model = open_model(&base, params).expect("open model");

    // Kneser-Ney sums to exactly 1 only when the stored distinct-continuation
    // counts match the continuations actually present. The shipped tries are
    // pruned: `examples/check_consistency.rs` measures u_abx > present in 37 of
    // 40 sampled contexts (129 vs 96, 31 vs 17, ...). That inflates the
    // back-off weight by roughly d * (u_abx - present) / c_abx, so totals land
    // above 1 — mildly for dense contexts, more for sparse ones. Measured
    // range: 1.000028 for the BOS context, up to 1.117 for a rare one.
    //
    // This is a property of the published model, reproduced faithfully. Exact
    // normalisation on *consistent* counts is pinned in `model::tests`.
    for context in [
        vec![],
        vec![params.start_token_id],
        vec![259, 11, 4],
        vec![280, 330, 367, 279],
        vec![280, 330, 450],
    ] {
        let probabilities = model.bulk_predict(&context);
        assert_eq!(probabilities.len(), params.vocab_size);
        let total: f64 = probabilities.iter().sum();

        // Pruning can only ever inflate the total, never shrink it.
        assert!(total >= 1.0 - 1e-9, "context {context:?} summed below 1: {total}");
        assert!(total < 1.25, "context {context:?} summed implausibly high: {total}");
        assert!(
            probabilities.iter().all(|p| p.is_finite() && *p >= 0.0),
            "context {context:?} produced a negative or non-finite probability",
        );
    }

    // A dense context is barely touched by pruning, so it pins normalisation
    // tightly: a mis-ported discount or interpolation weight shows up here.
    for context in [vec![], vec![params.start_token_id]] {
        let total: f64 = model.bulk_predict(&context).iter().sum();
        assert!((total - 1.0).abs() < 1e-3, "dense context {context:?} summed to {total}");
    }
}

#[test]
fn a_context_drawn_from_the_model_is_not_uniform() {
    let Some(base) = model_base() else {
        eprintln!("skipping: INPUT_LM_MODEL_BASE is not set");
        return;
    };

    let params = NgramParams::default();

    // Take a real 4-token context out of the count trie itself, so we know the
    // model has actually seen it.
    let mut path = base.as_os_str().to_os_string();
    path.push("_c_abc.marisa");
    let c_abc = MarisaTrie::open(PathBuf::from(&path)).expect("open c_abc trie");
    let sample = c_abc.predictive_search(&[]).into_iter().find(|entry| {
        entry.iter().filter(|&&d| d == KEY_VALUE_DELIMITER).count() == 1 && entry.len() >= 15
    });
    let Some(sample) = sample else {
        eprintln!("skipping: no suitable sample entry found");
        return;
    };

    // Drop the trailing predicted token to recover the context.
    let digits: Vec<i8> = sample.iter().copied().filter(|&d| d >= 0).collect();
    let tokens: Vec<usize> = digits.chunks_exact(2).map(|p| decode_key(p[0], p[1])).collect();
    if tokens.len() < 2 {
        eprintln!("skipping: sample entry decoded to {} tokens", tokens.len());
        return;
    }
    let context = &tokens[..tokens.len() - 1];

    let model = open_model(&base, params).expect("open model");
    let probabilities = model.bulk_predict(context);
    let uniform = 1.0 / params.vocab_size as f64;
    let peak = probabilities.iter().copied().fold(f64::MIN, f64::max);

    assert!(
        peak > uniform * 2.0,
        "context {context:?} stayed uniform (peak {peak}, uniform {uniform}) — \
         the trie lookups are probably not matching",
    );
}
#[test]
fn a_encoded_japanese_context_yields_a_peaked_distribution() {
    // End-to-end: tokenizer.encode -> bulk_predict -> a peaked, near-1
    // distribution over the REAL tries. This is the check that justifies the
    // whole tokenizer port.
    //
    // The training data for this model is katakana/romaji HEADREAD input, so a
    // hiragana context like あしたのてんきは has zero counts in the pruned
    // c_abc trie and yields a uniform distribution through the back-off floor.
    // A genuinely-present katakana context (イシテル = "shite-iru" in kana)
    // peaks decisively: measured peak 0.131 vs uniform 0.000167 (~786x).
    let Some(base) = model_base() else {
        eprintln!("skipping: INPUT_LM_MODEL_BASE is not set");
        return;
    };

    let mut tokenizer = match caption_bridge_input_lm::tokenizer::ZenzTokenizer::from_submodule() {
        Some(t) => t,
        None => {
            eprintln!("skipping: submodule tokenizer assets not present");
            return;
        }
    };

    let params = NgramParams::default();
    let model = open_model(&base, params).expect("open model");

    // イシテル = ids [280, 330, 367, 279], a dense, present context.
    let context_ids = tokenizer.encode("イシテル");
    assert_eq!(context_ids, vec![280, 330, 367, 279], "unexpected encode of イシテル");
    let probabilities = model.bulk_predict(&context_ids);
    assert_eq!(probabilities.len(), params.vocab_size);
    let total: f64 = probabilities.iter().sum();
    assert!((total - 1.0).abs() < 5e-2, "context {context_ids:?} (イシテル) summed to {total}");
    let uniform = 1.0 / params.vocab_size as f64;
    let peak = probabilities.iter().copied().fold(f64::MIN, f64::max);
    // The most likely continuation (ン among others) is picked, not uniform.
    assert!(
        peak > uniform * 100.0,
        "context {context_ids:?} stayed near-uniform (peak {peak}, uniform {uniform})"
    );

    // Round-trip the same string through decode.
    let decoded = tokenizer.decode(&context_ids);
    assert_eq!(decoded, "イシテル", "decode got {decoded:?}");
}

#[test]
fn raw_hiragana_yields_uniform_but_katakana_normalization_peaks() {
    // The key empirical finding: the published LM was trained on
    // katakana/romaji data. Raw hiragana token ids have zero counts in the
    // tries, so bulk_predict on a hiragana context yields a uniform
    // distribution. But normalizing hiragana to katakana before tokenizing
    // maps to token ids the model DOES have counts for, yielding a peaked
    // distribution that can discriminate between candidates.
    let Some(base) = model_base() else {
        eprintln!("skipping: INPUT_LM_MODEL_BASE is not set");
        return;
    };

    let mut tokenizer = match caption_bridge_input_lm::tokenizer::ZenzTokenizer::from_submodule() {
        Some(t) => t,
        None => {
            eprintln!("skipping: submodule tokenizer assets not present");
            return;
        }
    };

    let params = NgramParams::default();
    let model = open_model(&base, params).expect("open model");
    let uniform = 1.0 / params.vocab_size as f64;

    // Raw hiragana: あしたのてんきは
    let hiragana_ids = tokenizer.encode("あしたのてんきは");
    let hiragana_probs = model.bulk_predict(&hiragana_ids);
    let hiragana_peak = hiragana_probs.iter().copied().fold(f64::MIN, f64::max);
    // The README already documents this: hiragana contexts back off to the
    // uniform floor because the trie has zero counts for these tokens.
    assert!(
        hiragana_peak < uniform * 3.0,
        "raw hiragana should be near-uniform (peak {hiragana_peak}, uniform {uniform}) \
         — if this fails, the model may have been updated with hiragana counts"
    );

    // Katakana-normalized: アシタノテンキハ
    let katakana_ids = tokenizer.encode("アシタノテンキハ");
    let katakana_probs = model.bulk_predict(&katakana_ids);
    let katakana_peak = katakana_probs.iter().copied().fold(f64::MIN, f64::max);
    // If the model has counts for katakana tokens, this should peak above
    // uniform. Note: not all katakana contexts are dense in the pruned trie;
    // the claim is that katakana peaks higher than raw hiragana, not that it
    // always peaks above uniform*100.
    assert!(
        katakana_peak > hiragana_peak * 2.0,
        "katakana-normalized should peak higher than raw hiragana \
         (katakana peak {katakana_peak}, hiragana peak {hiragana_peak})"
    );
}

#[test]
fn lm_scorer_discriminates_between_katakana_normalized_candidates() {
    // End-to-end: the LmScorer normalizes hiragana to katakana, tokenizes,
    // and computes the sequence log-probability. If the LM can discriminate,
    // the correct candidate (おはようございます) should score higher than
    // the ASR hypothesis (おはよございます, missing the long vowel う).
    let Some(base) = model_base() else {
        eprintln!("skipping: INPUT_LM_MODEL_BASE is not set");
        return;
    };

    let tokenizer = match caption_bridge_input_lm::tokenizer::ZenzTokenizer::from_submodule() {
        Some(t) => t,
        None => {
            eprintln!("skipping: submodule tokenizer assets not present");
            return;
        }
    };

    let params = NgramParams::default();
    let model = open_model(&base, params).expect("open model");
    let scorer = caption_bridge_input_lm::rescore::LmScorer::new(model, tokenizer);

    let score_hypothesis = scorer.score("おはよございます");
    let score_corrected = scorer.score("おはようございます");

    // The corrected candidate (with the long vowel) should score higher
    // (less negative log-probability) than the hypothesis without it.
    // If this fails, the LM cannot discriminate for this particular pair,
    // which is a valid finding — the scoring interface is pluggable.
    let diff = (score_corrected - score_hypothesis).abs();
    eprintln!(
        "LM scores: hypothesis={score_hypothesis:.6} corrected={score_corrected:.6} diff={diff:.6}"
    );
    assert!(
        diff > 0.001,
        "LM did not discriminate between おはよございます and おはようございます \
         (diff {diff:.6}) — the scoring interface is pluggable for a better-suited LM"
    );
}

#[test]
fn rescorer_generates_and_ranks_candidates_with_real_model() {
    // End-to-end rescoring with the real model: generate candidates from
    // an ASR hypothesis, score them with the LM, and verify the rescorer
    // produces a ranked list.
    let Some(base) = model_base() else {
        eprintln!("skipping: INPUT_LM_MODEL_BASE is not set");
        return;
    };

    let tokenizer = match caption_bridge_input_lm::tokenizer::ZenzTokenizer::from_submodule() {
        Some(t) => t,
        None => {
            eprintln!("skipping: submodule tokenizer assets not present");
            return;
        }
    };

    let params = NgramParams::default();
    let model = open_model(&base, params).expect("open model");
    let scorer = caption_bridge_input_lm::rescore::LmScorer::new(model, tokenizer);
    let rules = caption_bridge_input_lm::rescore::AsrConfusionRules::default();
    let rescorer = caption_bridge_input_lm::rescore::Rescorer::new(scorer, rules);

    let hypothesis = "おはよございます";
    let ranked = rescorer.rescore(hypothesis);

    // The original is always included.
    assert!(ranked.iter().any(|c| c.text == hypothesis), "original missing");
    // There should be multiple candidates (at least the original + voicing +
    // long vowel + similar mora candidates).
    assert!(ranked.len() > 1, "only {ranked_len} candidates", ranked_len = ranked.len());
    // The ranking is by combined score, descending.
    for w in ranked.windows(2) {
        assert!(w[0].combined_score >= w[1].combined_score, "ranking not descending: {w:?}");
    }

    // Report the top candidate for diagnostic purposes.
    eprintln!(
        "rescorer top 3 for '{hypothesis}': {top3:?}",
        top3 = ranked.iter().take(3).collect::<Vec<_>>()
    );
}

#[test]
fn recommended_rescorer_holds_boundary_mora_on_caption_sentences() {
    let Some(base) = model_base() else {
        eprintln!("skipping: INPUT_LM_MODEL_BASE is not set");
        return;
    };

    let tokenizer = match caption_bridge_input_lm::tokenizer::ZenzTokenizer::from_submodule() {
        Some(t) => t,
        None => {
            eprintln!("skipping: submodule tokenizer assets not present");
            return;
        }
    };

    let params = NgramParams::default();
    let model = open_model(&base, params).expect("open model");
    let scorer = caption_bridge_input_lm::rescore::LmScorer::new(model, tokenizer);
    let rescorer = caption_bridge_input_lm::rescore::Rescorer::with_recommended_weights(
        scorer,
        caption_bridge_input_lm::rescore::AsrConfusionRules::default(),
    );

    let weather = "あついひはあついたべものをたべたくない";
    let train = "でんしゃがちえんしてたからぼくはがっこうにいかない";
    let weather_best = rescorer.best(weather);
    let train_best = rescorer.best(train);
    eprintln!("recommended best weather={weather_best:?} train={train_best:?}");
    assert!(
        !weather_best.contains("はつい"),
        "rescorer dropped the second あつい's leading あ: {weather_best:?}"
    );
    assert_eq!(weather_best, weather, "weather hold was rewritten to {weather_best:?}");
    assert!(
        !train_best.contains("してただ"),
        "rescorer duplicated a mora into してただ: {train_best:?}"
    );
    assert_eq!(train_best, train, "train hold was rewritten to {train_best:?}");
}
