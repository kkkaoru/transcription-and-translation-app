//! Honest parameter sweep for the rescoring stage against the real model.
//!
//! The published `input_n5_lm_v1` `Rescorer` has three tunable parameters:
//! `lm_weight`, `confusion_weight`, and `overcorrection_margin`. This example
//! measures — rather than assumes — how each combination behaves on a fixed
//! hiragana ASR-style evaluation set, and reports corrections vs
//! overcorrections. The goal is to answer: are the shipped defaults
//! (`1.0 / 1.0 / 0.0`) already the best balance?
//!
//! ## Method
//!
//! For every eval case the candidate list is generated **once** and each
//! candidate's `lm_score` is computed **once**. Every parameter combination is
//! then evaluated by pure arithmetic over those collected features, using
//! exactly the same combined-score formula and the same overcorrection gate as
//! [`Rescorer::best`]:
//!
//! ```text
//! combined = lm_weight * lm_score - confusion_weight * confusion_cost
//! ```
//!
//! Scoring each candidate list a single time keeps the sweep cheap (the LM
//! scoring dominates cost), while still reproducing the live decision exactly.
//!
//! ## Eval set
//!
//! Each case is `(label, hypothesis, expected)`. A case is **repair** when
//! `expected != hypothesis` (the ASR hypothesis carries a rule-covered acoustic
//! defect the rescoring stage *should* fix), and **hold** when
//! `expected == hypothesis` (the hypothesis is already correct and the stage
//! *must not* change it — changing it would be an overcorrection).
//!
//! ```sh
//! cargo run --release --features rsmarisa --example rescore_sweep -- \
//!   ~/.cache/caption-bridge-input-lm/input_n5_lm_v1/lm
//! ```
//!
//! The printed table shows, per parameter combo: repairs fixed, holds kept,
//! holds overcorrected, and a combined score (`repairs_fixed + holds_kept`).
//! The best combined score is the honest optimum over this eval set.

use caption_bridge_input_lm::marisa::open_model;
use caption_bridge_input_lm::rescore::{AsrConfusionRules, CandidateScorer, LmScorer, Rescorer};
use caption_bridge_input_lm::tokenizer::ZenzTokenizer;
use caption_bridge_input_lm::NgramParams;

/// A single eval case: the ASR hypothesis, the desired final selection, and a
/// human label for readability.
struct Case {
    label: &'static str,
    hypothesis: &'static str,
    expected: &'static str,
}

impl Case {
    fn is_repair(&self) -> bool {
        self.expected != self.hypothesis
    }
}

/// The per-candidate features collected once per case, then reused across the
/// whole sweep. Mirror of `RankedCandidate` but decoupled from the sweep.
struct Feat {
    text: String,
    lm: f64,
    cost: f64,
}

fn main() {
    let base = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: rescore_sweep <trie-base-path>");
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
    let rules = AsrConfusionRules::default();
    // ------- Evaluation set ------------------------------------------------
    // Repair targets: the hypothesis carries a rule-covered defect (dropped
    // long vowel, or a voicing flip toward a less-common form) and the expected
    // selection is the more-natural long/common form.
    //
    // Holds: the hypothesis is already correct and common; the stage must not
    // change it. These include deliberately precarious ones (correct geminated
    // きってください, correct voiced-consonant がいこくご) that probe
    // overcorrection resistance where the LM might be tempted.
    let cases: Vec<Case> = vec![
        // --- repairs ---
        Case {
            label: "repair: dropped long vowel",
            hypothesis: "おはよございます",
            expected: "おはようございます",
        },
        Case {
            label: "repair: dropped long vowel", hypothesis: "せんせ", expected: "せんせい"
        },
        Case {
            label: "repair: dropped long vowel", hypothesis: "おはよ", expected: "おはよう"
        },
        Case {
            label: "repair: voicing toward common",
            hypothesis: "がいしゃ",
            expected: "かいしゃ",
        },
        Case {
            label: "repair: voicing toward common",
            hypothesis: "がいとうした",
            expected: "かいとうした",
        },
        // --- holds ---
        Case {
            label: "hold: correct long vowel",
            hypothesis: "おはようございます",
            expected: "おはようございます",
        },
        Case {
            label: "hold: correct せんせい", hypothesis: "せんせい", expected: "せんせい"
        },
        Case {
            label: "hold: correct bare きて",
            hypothesis: "きてください",
            expected: "きてください",
        },
        Case {
            label: "hold: correct geminated きって",
            hypothesis: "きってください",
            expected: "きってください",
        },
        Case {
            label: "hold: correct unvoiced かいとう",
            hypothesis: "かいとうしました",
            expected: "かいとうしました",
        },
        Case {
            label: "hold: correct しちまった",
            hypothesis: "しちまった",
            expected: "しちまった",
        },
        Case {
            label: "hold: correct こんばんは",
            hypothesis: "こんばんは",
            expected: "こんばんは",
        },
        Case {
            label: "hold: correct ありがとう",
            hypothesis: "ありがとうございます",
            expected: "ありがとうございます",
        },
        Case {
            label: "hold: correct voicing がいこくご",
            hypothesis: "がいこくご",
            expected: "がいこくご",
        },
    ];

    // ------- Collect features once ----------------------------------------
    let mut collected: Vec<(usize, Vec<Feat>)> = Vec::new();
    for (i, case) in cases.iter().enumerate() {
        let candidates = rules.generate(case.hypothesis);
        let feats: Vec<Feat> = candidates
            .iter()
            .map(|c| Feat {
                text: c.text.clone(),
                lm: scorer.score(&c.text),
                cost: c.confusion_cost,
            })
            .collect();
        collected.push((i, feats));
    }

    // ------- Cross-check: replicated best() matches Rescorer::best ---------
    // Guard against drift between the sweep's arithmetic and the real gate.
    let rescorer = Rescorer::new(scorer, rules.clone());
    for (i, feats) in &collected {
        let case = &cases[*i];
        let replicated = best_from_feats(feats, 1.0, 1.0, 0.0);
        let live = rescorer.best(case.hypothesis);
        assert_eq!(
            replicated, live,
            "sweep replication diverged from Rescorer::best for {}",
            case.hypothesis
        );
    }

    // ------- Sweep ---------------------------------------------------------
    let lm_weights = [0.5, 1.0, 1.5, 2.0];
    let confusion_weights = [0.5, 1.0, 1.5, 2.0];
    let margins = [0.0, 0.5, 1.0, 2.0];

    let n_repairs = cases.iter().filter(|c| c.is_repair()).count();
    let n_holds = cases.iter().filter(|c| !c.is_repair()).count();

    println!("Eval set: {} repairs, {} holds\n", n_repairs, n_holds);
    println!(
        "{:>6} {:>6} {:>6} | {:>8} {:>8} {:>8} | {:>8}",
        "lm_w", "conf_w", "margin", "repairs", "holds", "overcorr", "combined"
    );

    let mut best_combined = 0;
    let mut best_combo = (0.0, 0.0, 0.0);
    for &lm_w in &lm_weights {
        for &conf_w in &confusion_weights {
            for &margin in &margins {
                let repairs_fixed = count_repairs(&collected, &cases, lm_w, conf_w, margin);
                let holds_kept = count_holds(&collected, &cases, lm_w, conf_w, margin);
                let overcorrected = n_holds - holds_kept;
                let combined = repairs_fixed + holds_kept;
                println!(
                    "{:>6.1} {:>6.1} {:>6.1} | {:>8} {:>8} {:>8} | {:>8}",
                    lm_w, conf_w, margin, repairs_fixed, holds_kept, overcorrected, combined
                );
                if combined > best_combined {
                    best_combined = combined;
                    best_combo = (lm_w, conf_w, margin);
                }
            }
        }
    }

    println!(
        "\nBest combined={best_combined} at lm_w={:.1} conf_w={:.1} margin={:.1}",
        best_combo.0, best_combo.1, best_combo.2
    );
    println!(
        "Default (lm_w=1.0 conf_w=1.0 margin=0.0) combined={}",
        sweep_combined(&collected, &cases)
    );

    // ------- Per-case detail for the default and the best combo -------------
    for (name, (lm_w, conf_w, margin)) in [("DEFAULT", (1.0, 1.0, 0.0)), ("BEST", best_combo)] {
        println!("\n--- per-case {name} lm_w={lm_w:.1} conf_w={conf_w:.1} margin={margin:.1} ---");
        for (i, feats) in &collected {
            let case = &cases[*i];
            let best = best_from_feats(feats, lm_w, conf_w, margin);
            let verdict = if case.is_repair() {
                if best == case.expected {
                    "REPAIRED"
                } else if best == case.hypothesis {
                    "kept (repair missed)"
                } else {
                    "chaos"
                }
            } else if best == case.hypothesis {
                "held"
            } else {
                "OVERCORRECTED"
            };
            println!(
                "{:>14} | {:<36} vs {:<36} -> {:<36} [{verdict}]",
                case.label, case.hypothesis, case.expected, best
            );
        }
    }

    // ------- LM discrimination diagnostic ----------------------------------
    // How far apart are the hypothesis and the intended correction in LM
    // score? A repair only fires when the corrected candidate's win over the
    // hypothesis and cost combination clears the gate, so this shows whether
    // the shipped model even has the counts to tell the two apart.
    println!("\n--- LM discrimination per repair case ---");
    for (i, feats) in &collected {
        let case = &cases[*i];
        if !case.is_repair() {
            continue;
        }
        let lm_hyp =
            feats.iter().find(|f| f.text == case.hypothesis).map(|f| f.lm).unwrap_or(f64::NAN);
        let lm_exp =
            feats.iter().find(|f| f.text == case.expected).map(|f| f.lm).unwrap_or(f64::NAN);
        println!(
            "{:>14} | hyp={:<24} lm={:+9.4} | exp={:<24} lm={:+9.4} | diff={:+.4}",
            case.label,
            case.hypothesis,
            lm_hyp,
            case.expected,
            lm_exp,
            lm_exp - lm_hyp
        );
    }
}

/// Replicates [`Rescorer::best`] over already-collected features.
fn best_from_feats(feats: &[Feat], lm_w: f64, conf_w: f64, margin: f64) -> String {
    if feats.is_empty() {
        return String::new();
    }
    let combined: Vec<(usize, f64)> =
        feats.iter().enumerate().map(|(idx, f)| (idx, lm_w * f.lm - conf_w * f.cost)).collect();
    let mut order: Vec<usize> = (0..combined.len()).collect();
    order.sort_by(|&a, &b| combined[b].1.total_cmp(&combined[a].1));
    let best_idx = order[0];
    // The original hypothesis is always the first generated candidate.
    let original_combined = combined[0].1;
    if combined[best_idx].1 - original_combined >= margin {
        feats[best_idx].text.clone()
    } else {
        feats[0].text.clone()
    }
}

/// Counts repair cases whose best selection equals the expected correction.
fn count_repairs(
    collected: &[(usize, Vec<Feat>)],
    cases: &[Case],
    lm_w: f64,
    conf_w: f64,
    margin: f64,
) -> usize {
    collected
        .iter()
        .filter(|(i, feats)| {
            let case = &cases[*i];
            case.is_repair() && best_from_feats(feats, lm_w, conf_w, margin) == case.expected
        })
        .count()
}

/// Counts hold cases whose best selection stays the original hypothesis.
fn count_holds(
    collected: &[(usize, Vec<Feat>)],
    cases: &[Case],
    lm_w: f64,
    conf_w: f64,
    margin: f64,
) -> usize {
    collected
        .iter()
        .filter(|(i, feats)| {
            let case = &cases[*i];
            !case.is_repair() && best_from_feats(feats, lm_w, conf_w, margin) == case.hypothesis
        })
        .count()
}

/// Computes the default-weights combined score for the report line.
fn sweep_combined(collected: &[(usize, Vec<Feat>)], cases: &[Case]) -> usize {
    count_repairs(collected, cases, 1.0, 1.0, 0.0) + count_holds(collected, cases, 1.0, 1.0, 0.0)
}
