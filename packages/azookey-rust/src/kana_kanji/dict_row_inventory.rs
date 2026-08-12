//! Dictionary-row inventory + table-driven conversion regression for the
//! CID-prune / soft-prune backlog.
//!
//! These fixtures separate "missing quality row" from "rows exist but ranking
//! / prune loses the path" before further Viterbi retunes. Inventory checks
//! must stay green; conversion cases that currently lose at top-1 are still
//! asserted via n-best membership so the deficit stays visible without
//! blocking the suite.

use crate::dictionary::{is_postposition_cid, AzooKeyDictionary, DictionaryEntry, DictionaryPaths};
use crate::{convert_with_dictionary, ConversionOptions};

#[derive(Debug, Clone, Copy)]
struct RequiredSurface {
    reading: &'static str,
    surface: &'static str,
    /// Human tag for the report (`動詞連用` / `名詞` / `後置機能語` …).
    note: &'static str,
}

/// Exact-reading rows that must exist for the advisor's focus set.
const REQUIRED_SURFACES: &[RequiredSurface] = &[
    // かいて / 書いて vs 買い手
    RequiredSurface { reading: "かいて", surface: "書いて", note: "verb te-form" },
    RequiredSurface { reading: "かいて", surface: "買い手", note: "noun distractor" },
    // はし / はじ
    RequiredSurface { reading: "はし", surface: "橋", note: "bridge" },
    RequiredSurface { reading: "はし", surface: "端", note: "edge (hashi)" },
    RequiredSurface { reading: "はし", surface: "箸", note: "chopsticks distractor" },
    RequiredSurface { reading: "はじ", surface: "端", note: "edge (haji)" },
    // あつい / ひ / ひな
    RequiredSurface { reading: "あつい", surface: "暑い", note: "weather-hot" },
    RequiredSurface { reading: "あつい", surface: "熱い", note: "temperature-hot" },
    RequiredSurface { reading: "ひ", surface: "日", note: "day" },
    RequiredSurface { reading: "ひな", surface: "雛", note: "chick compound" },
    // copula / joshi-jodoushi suffixes
    RequiredSurface { reading: "なので", surface: "なので", note: "copula suffix" },
    RequiredSurface { reading: "なのに", surface: "なのに", note: "copula suffix" },
    RequiredSurface { reading: "なら", surface: "なら", note: "copula suffix" },
    RequiredSurface { reading: "なのだ", surface: "なのだ", note: "copula suffix" },
    RequiredSurface { reading: "なのです", surface: "なのです", note: "copula suffix" },
];

/// Readings whose full row dump is printed into the inventory summary.
const INVENTORY_READINGS: &[&str] = &[
    "かいて",
    "はし",
    "はじ",
    "はしのはじ",
    "あつい",
    "ひ",
    "ひな",
    "あついひ",
    "あついひなのに",
    "なので",
    "なのに",
    "なら",
    "なのだ",
    "なのです",
];

#[derive(Debug, Clone, Copy)]
struct ConversionCase {
    input: &'static str,
    expected: &'static str,
    /// Expected text must appear at or before this 1-based n-best rank.
    max_rank: usize,
    /// Inventory evidence used when diagnosing a miss.
    inventory_hint: &'static str,
}

/// Table-driven conversion regression for the advisor focus set.
const CONVERSION_CASES: &[ConversionCase] = &[
    ConversionCase {
        input: "かいて",
        expected: "書いて",
        max_rank: 1,
        inventory_hint: "かいて has 書いて + 買い手 rows; DEFAULT_CID demotion ranks 書いて first",
    },
    ConversionCase {
        input: "はし",
        expected: "橋",
        // Bare はし currently prefers 箸; soft-prune / ranking backlog.
        max_rank: 8,
        inventory_hint: "はし has 橋/端/箸 rows; no missing quality row",
    },
    ConversionCase {
        input: "はじ",
        expected: "端",
        // Bare はじ currently prefers 恥.
        max_rank: 8,
        inventory_hint: "はじ has 端 rows; no missing quality row",
    },
    ConversionCase {
        input: "はしのはじ",
        expected: "橋の端",
        max_rank: 1,
        inventory_hint: "no compound はしのはじ row; 橋+の+端 must win by ranking",
    },
    ConversionCase {
        input: "はしのはじからものがおちてます",
        expected: "橋の端から物が落ちてます",
        max_rank: 1,
        inventory_hint: "full sentence already phrase-neutral under default beam",
    },
    ConversionCase {
        input: "あつい",
        expected: "暑い",
        max_rank: 1,
        inventory_hint: "あつい has 暑い/熱い rows",
    },
    ConversionCase {
        input: "ひな",
        expected: "雛",
        max_rank: 1,
        inventory_hint: "ひな has 雛; bare form must not split to 日な",
    },
    ConversionCase {
        input: "あついひ",
        expected: "暑い日",
        max_rank: 1,
        inventory_hint: "no あついひ compound; 暑い+日 rows exist → ranking/identity",
    },
    ConversionCase {
        input: "あついひなのに",
        expected: "暑い日なのに",
        max_rank: 1,
        inventory_hint: "なのに Postposition keeps 日 under CID-aware prune",
    },
    ConversionCase {
        input: "なので",
        expected: "なので",
        max_rank: 1,
        inventory_hint: "なので identity Postposition rows",
    },
    ConversionCase {
        input: "なのに",
        expected: "なのに",
        max_rank: 1,
        inventory_hint: "なのに identity Postposition rows",
    },
    ConversionCase {
        input: "なら",
        expected: "なら",
        max_rank: 1,
        inventory_hint: "なら identity Postposition rows",
    },
    ConversionCase {
        input: "なのだ",
        expected: "なのだ",
        max_rank: 1,
        inventory_hint: "なのだ identity Postposition rows",
    },
    ConversionCase {
        input: "なのです",
        expected: "なのです",
        max_rank: 1,
        inventory_hint: "なのです identity Postposition rows",
    },
];

fn load_official_dictionary() -> AzooKeyDictionary {
    let root = crate::dictionary::test_system_dictionary_path();
    AzooKeyDictionary::from_paths(&DictionaryPaths { system: Some(root), user: None, memory: None })
        .expect("official AzooKey dictionary should load")
}

fn cid_word_type_label(cid: u16) -> &'static str {
    // Mirror `dictionary::word_type` labels for inventory printing only.
    let cid_usize = usize::from(cid);
    if cid == 0 || cid == 1316 {
        return "Boundary";
    }
    if matches!(cid_usize, 6 | 557..=560 | 1315) {
        return "Preposition";
    }
    if matches!(
        cid_usize,
        1..=5
            | 9
            | 11..=52
            | 555..=556
            | 1281..=1282
            | 1283..=1296
            | 1306..=1309
            | 1314
            | 561..=867
    ) {
        return "ContentWord";
    }
    "Postposition"
}

fn entry_word_type_label(entry: &DictionaryEntry) -> String {
    let left = cid_word_type_label(entry.lcid);
    let right = cid_word_type_label(entry.rcid);
    if left == right {
        left.to_string()
    } else {
        format!("{left}/{right}")
    }
}

fn format_entry_row(entry: &DictionaryEntry) -> String {
    format!(
        "surface={:?} reading={:?} value={:.3} lcid={} rcid={} mid={} word_type={} postposition_lcid={} postposition_rcid={}",
        entry.surface,
        entry.reading,
        entry.value,
        entry.lcid,
        entry.rcid,
        entry.mid,
        entry_word_type_label(entry),
        is_postposition_cid(entry.lcid),
        is_postposition_cid(entry.rcid),
    )
}

fn lookup_sorted(dictionary: &AzooKeyDictionary, reading: &str) -> Vec<DictionaryEntry> {
    let mut entries = dictionary.lookup_exact(reading).unwrap_or_default();
    entries.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));
    entries
}

fn classify_conversion_failure(
    dictionary: &AzooKeyDictionary,
    case: &ConversionCase,
    actual_top: &str,
    texts: &[&str],
) -> String {
    // Heuristic: missing required piece surfaces → missing-quality-row;
    // otherwise rows exist and the lattice chose poorly → prune/ranking.
    let mut missing_pieces = Vec::new();
    for required in REQUIRED_SURFACES {
        if case.expected.contains(required.surface)
            && !lookup_sorted(dictionary, required.reading)
                .iter()
                .any(|entry| entry.surface == required.surface)
        {
            missing_pieces
                .push(format!("{}/{} ({})", required.reading, required.surface, required.note));
        }
    }
    if !missing_pieces.is_empty() {
        return format!(
            "missing-quality-row ({}); top={actual_top:?}; hint={}",
            missing_pieces.join(", "),
            case.inventory_hint
        );
    }
    if lookup_sorted(dictionary, case.input).is_empty()
        && !texts.iter().any(|text| *text == case.expected)
    {
        return format!(
            "prune/ranking (no compound row for {:?}; piece rows present; top={actual_top:?}; hint={})",
            case.input, case.inventory_hint
        );
    }
    format!(
        "prune/ranking (expected beyond max_rank {} or absent; top={actual_top:?}; hint={})",
        case.max_rank, case.inventory_hint
    )
}

#[test]
fn dict_row_inventory_required_surfaces_exist() {
    let dictionary = load_official_dictionary();
    let mut missing = Vec::new();
    let mut summary = Vec::new();

    for reading in INVENTORY_READINGS {
        let entries = lookup_sorted(&dictionary, reading);
        summary.push(format!("=== {reading:?} ({} rows) ===", entries.len()));
        if entries.is_empty() {
            summary.push("  (no exact compound / reading row)".to_string());
        }
        for entry in &entries {
            // Cap noisy dumps (ひ has dozens of rows) to the top value hits
            // plus any required surfaces for this reading.
            let is_required = REQUIRED_SURFACES
                .iter()
                .any(|required| required.reading == *reading && required.surface == entry.surface);
            let rank_among =
                entries.iter().position(|candidate| candidate.surface == entry.surface);
            let keep = is_required
                || rank_among.is_some_and(|index| index < 12)
                || is_postposition_cid(entry.lcid)
                || is_postposition_cid(entry.rcid);
            if keep {
                summary.push(format!("  {}", format_entry_row(entry)));
            }
        }
    }

    for required in REQUIRED_SURFACES {
        let entries = lookup_sorted(&dictionary, required.reading);
        let hit = entries.iter().find(|entry| entry.surface == required.surface);
        match hit {
            Some(entry) => {
                summary.push(format!(
                    "REQUIRED ok: {} → {} | {}",
                    required.reading,
                    required.surface,
                    format_entry_row(entry)
                ));
            }
            None => {
                missing.push(format!(
                    "{:?}/{:?} ({})",
                    required.reading, required.surface, required.note
                ));
            }
        }
    }

    eprintln!("\n=== AzooKey dict-row inventory (key rows) ===\n{}", summary.join("\n"));

    assert!(
        missing.is_empty(),
        "missing required dictionary surfaces (missing-quality-row):\n  {}",
        missing.join("\n  ")
    );
}

#[test]
fn dict_row_inventory_copula_suffixes_are_postposition() {
    let dictionary = load_official_dictionary();
    let suffixes = ["なので", "なのに", "なら", "なのだ", "なのです"];
    let mut failures = Vec::new();
    for reading in suffixes {
        let entries = lookup_sorted(&dictionary, reading);
        let identity = entries.iter().filter(|entry| entry.surface == reading).collect::<Vec<_>>();
        if identity.is_empty() {
            failures.push(format!("{reading}: missing identity row"));
            continue;
        }
        let any_postposition = identity
            .iter()
            .any(|entry| is_postposition_cid(entry.lcid) || is_postposition_cid(entry.rcid));
        if !any_postposition {
            failures.push(format!(
                "{reading}: identity rows lack Postposition CID: {}",
                identity
                    .iter()
                    .map(|entry| format_entry_row(entry))
                    .collect::<Vec<_>>()
                    .join(" | ")
            ));
        }
    }
    assert!(failures.is_empty(), "copula suffix inventory failures:\n  {}", failures.join("\n  "));
}

#[test]
fn conversion_regression_table_for_advisor_focus() {
    let dictionary = load_official_dictionary();
    let mut failures = Vec::new();
    let mut ranking_gaps = Vec::new();

    for case in CONVERSION_CASES {
        let candidates = convert_with_dictionary(
            case.input,
            &dictionary,
            ConversionOptions { n_best: 16, ..ConversionOptions::default() },
        );
        let texts = candidates.iter().map(|candidate| candidate.text.as_str()).collect::<Vec<_>>();
        let actual_top = texts.first().copied().unwrap_or("");
        let rank = texts.iter().position(|text| *text == case.expected).map(|index| index + 1);

        match rank {
            Some(found) if found <= case.max_rank => {
                if found > 1 {
                    ranking_gaps.push(format!(
                        "{:?} -> {:?} at rank {found} (max {}); top={actual_top:?}; class=prune/ranking; {}",
                        case.input, case.expected, case.max_rank, case.inventory_hint
                    ));
                }
            }
            Some(found) => {
                failures.push(format!(
                    "{:?} -> {:?} at rank {found} > max {}; top={actual_top:?}; class={}",
                    case.input,
                    case.expected,
                    case.max_rank,
                    classify_conversion_failure(&dictionary, case, actual_top, &texts)
                ));
            }
            None => {
                failures.push(format!(
                    "{:?} -> {:?} absent from top-16; top={actual_top:?}; class={}",
                    case.input,
                    case.expected,
                    classify_conversion_failure(&dictionary, case, actual_top, &texts)
                ));
            }
        }
    }

    if !ranking_gaps.is_empty() {
        eprintln!(
            "\n=== Ranking gaps (still within max_rank; soft-prune backlog) ===\n  {}",
            ranking_gaps.join("\n  ")
        );
    }

    assert!(
        failures.is_empty(),
        "{} conversion regression failures:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
}
