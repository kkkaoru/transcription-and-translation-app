//! Empirical measurement: can the published LM discriminate between hiragana
//! ASR candidates when they are normalized to katakana before scoring?
//!
//! The published `input_n5_lm_v1` model was trained on katakana/romaji-flavored
//! data. Raw hiragana token ids have zero counts in the tries, so feeding raw
//! hiragana yields a uniform distribution. This example measures whether
//! normalizing hiragana to katakana before tokenizing — the same normalization
//! azooKey applies for direct kana input — maps to token ids the model has
//! counts for, and whether the resulting LM scores can discriminate between
//! ASR confusion candidates.
//!
//! ```sh
//! cargo run --release --features rsmarisa --example rescore_measure -- \
//!   ~/.cache/caption-bridge-input-lm/input_n5_lm_v1/lm
//! ```

#![cfg(feature = "rsmarisa")]

use caption_bridge_input_lm::marisa::open_model;
use caption_bridge_input_lm::rescore::{
    hiragana_to_katakana, AsrConfusionRules, CandidateScorer, LmScorer, Rescorer,
};
use caption_bridge_input_lm::tokenizer::ZenzTokenizer;
use caption_bridge_input_lm::NgramParams;

fn main() {
    let base = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: rescore_measure <trie-base-path>");
        std::process::exit(2);
    });

    let params = NgramParams::default();
    let model = match open_model(&base, params) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("failed to open model at {base}: {e}");
            std::process::exit(1);
        }
    };

    let tokenizer = match ZenzTokenizer::from_submodule() {
        Some(t) => t,
        None => {
            eprintln!("failed to load tokenizer from submodule");
            std::process::exit(1);
        }
    };

    let scorer = LmScorer::new(model, tokenizer);

    // --- Direct comparison: raw hiragana vs katakana-normalized scoring ---
    println!("=== Direct comparison: candidate pairs ===\n");

    let test_pairs = [
        ("おはよございます", "おはようございます"),
        ("きてください", "きってください"),
        ("しちまった", "いちまった"),
    ];

    for (shorter, longer) in &test_pairs {
        let kata_shorter = hiragana_to_katakana(shorter);
        let kata_longer = hiragana_to_katakana(longer);

        let score_shorter = scorer.score(shorter);
        let score_longer = scorer.score(longer);

        println!("Pair: {shorter} vs {longer}");
        println!("  Katakana: {kata_shorter} vs {kata_longer}");
        println!("  LM score (katakana-normalized): {score_shorter:.6} vs {score_longer:.6}");
        let diff = (score_longer - score_shorter).abs();
        println!("  Difference: {diff:.6}");
        if diff > 0.001 {
            println!("  RESULT: LM DISCRIMINATES between these candidates");
        } else {
            println!("  RESULT: LM does NOT discriminate between these candidates");
        }
        println!();
    }

    // --- End-to-end rescoring ---
    println!("=== End-to-end rescoring with ASR confusion rules ===\n");

    let rules = AsrConfusionRules::default();
    let rescorer = Rescorer::new(scorer, rules);

    let hypotheses = [
        "おはよございます", // missing long vowel う
        "きてください",     // missing gemination っ
        "しちまった",       // し→い acoustic confusion
        "かいとうしました", // か→が voicing confusion
    ];

    for hypothesis in &hypotheses {
        let ranked = rescorer.rescore(hypothesis);

        println!("Hypothesis: {hypothesis}");
        println!("  Katakana: {}", hiragana_to_katakana(hypothesis));
        println!("  Candidates: {}", ranked.len());

        for (i, c) in ranked.iter().take(5).enumerate() {
            println!(
                "  #{}: {:<20} lm={:.4}  cost={:.2}  combined={:.4}",
                i + 1,
                c.text,
                c.lm_score,
                c.confusion_cost,
                c.combined_score
            );
        }

        let original = ranked.iter().find(|c| c.text == *hypothesis);
        let best = ranked.first();
        if let (Some(orig), Some(best)) = (original, best) {
            let lm_diff = (best.lm_score - orig.lm_score).abs();
            let combined_diff = (best.combined_score - orig.combined_score).abs();
            println!("  LM score difference:       {lm_diff:.6}");
            println!("  Combined score difference: {combined_diff:.6}");
            if lm_diff > 0.001 {
                println!("  RESULT: LM DISCRIMINATES (lm_diff > 0.001)");
            } else {
                println!("  RESULT: LM does NOT discriminate (lm_diff <= 0.001)");
            }
        }
        println!();
    }
}
