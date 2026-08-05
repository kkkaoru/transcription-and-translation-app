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
