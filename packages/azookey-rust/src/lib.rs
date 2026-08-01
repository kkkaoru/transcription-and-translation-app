//! Rust implementation of the AzooKey kana-kanji conversion boundary.
//!
//! The module intentionally has no UI dependency.  It accepts the default
//! AzooKey LOUDS dictionary layout (`louds/*.louds`, `*.loudschars2`,
//! `*.loudstxt3`, `mm.binary`, and `cb/*.binary`) as well as a small TSV
//! dictionary useful for development and test fixtures.

#[path = "kana_kanji/dictionary.rs"]
mod dictionary;
#[path = "kana_kanji/normalization.rs"]
mod normalization;
#[path = "kana_kanji/viterbi.rs"]
mod viterbi;

pub use dictionary::{AzooKeyDictionary, DictionaryEntry, DictionaryPaths};
pub use viterbi::{
    convert_kana_to_kanji, convert_kana_to_kanji_with_dictionary, convert_kana_to_kanji_with_paths,
    convert_with_dictionary, ConversionCandidate, ConversionOptions,
};
