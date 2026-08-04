//! Dev probe: inspect AzooKey dictionary entries for specific readings.
//!
//! Run with:
//! ```sh
//! AZOOKEY_DICTIONARY_ROOT=../../submodules/azooKey_dictionary_storage/Dictionary \
//!   cargo run --example probe_dict -- [reading ...]
//! ```
//!
//! With no arguments, probes a default set of readings from the accuracy
//! corpus failures.  Each line shows the surface, CID/MID metadata, value
//! (log-probability-like; higher is better), and whether the surface is a
//! raw-ruby identity row.

use caption_bridge_azookey_rust::{
    convert_with_dictionary, AzooKeyDictionary, ConversionOptions, DictionaryPaths,
};
use std::path::PathBuf;

fn main() {
    let root = std::env::var_os("AZOOKEY_DICTIONARY_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../../submodules/azooKey_dictionary_storage/Dictionary"));
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(root),
        ..DictionaryPaths::default()
    })
    .expect("dictionary should load");

    let readings: Vec<String> = if std::env::args().len() == 1 {
        [
            // kana-should-win failures
            "いただきます",
            "ください",
            "さます",
            "ます",
            "はん",
            "より",
            // kanji-should-win failures
            "おつかれさまでした",
            "ふります",
            "がくせい",
            // already-fixed (must not regress)
            "とても",
            "すーぷはのみたい",
            // numeric failures
            "よっか",
            "ついたち",
            // partial readings for context
            "いただく",
            "くださる",
            "さめる",
            "ふる",
            "がく",
            "せい",
            "おつかれ",
            "さま",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    } else {
        std::env::args().skip(1).collect()
    };

    for reading in &readings {
        let entries = dictionary.lookup_exact(reading).unwrap_or_default();
        println!("\n=== {:?} ({}) ===", reading, entries.len());
        if entries.is_empty() {
            println!("  (no entries)");
        }
        // Sort by value descending so the best candidate is visible first.
        let mut sorted = entries.clone();
        sorted.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));
        for entry in &sorted {
            let script_tag = if entry.surface == entry.reading {
                "IDENTITY"
            } else if entry.raw_ruby_identity {
                "RUBY-ID"
            } else if entry.surface.chars().any(|c| {
                let code = c as u32;
                (0x3400..=0x4dbf).contains(&code)
                    || (0x4e00..=0x9fff).contains(&code)
                    || (0xf900..=0xfaff).contains(&code)
            }) {
                "KANJI"
            } else if entry.surface.chars().any(|c| {
                let code = c as u32;
                (0x30a0..=0x30ff).contains(&code) || c == 'ー'
            }) {
                "KATAKANA"
            } else {
                "OTHER"
            };
            println!(
                "  {:<12} value={:>8.3} lcid={:<5} rcid={:<5} mid={:<4} surface={:?} raw_ruby_identity={}",
                script_tag,
                entry.value,
                entry.lcid,
                entry.rcid,
                entry.mid,
                entry.surface,
                entry.raw_ruby_identity,
            );
        }
        println!("  --- Viterbi n-best ---");
        for (index, candidate) in convert_with_dictionary(
            reading,
            &dictionary,
            ConversionOptions::default(),
        )
        .iter()
        .take(8)
        .enumerate()
        {
            println!(
                "  {:>2}. score={:>9.3} text={:?} trailing={:?}",
                index + 1,
                candidate.score,
                candidate.text,
                candidate.trailing,
            );
        }
    }
}
