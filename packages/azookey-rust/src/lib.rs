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
#[path = "kana_kanji/verification_cache.rs"]
mod verification_cache;
#[path = "kana_kanji/verifier.rs"]
mod verifier;
#[path = "kana_kanji/viterbi.rs"]
mod viterbi;

pub use dictionary::{AzooKeyDictionary, DictionaryEntry, DictionaryPaths};
pub use verification_cache::{VerificationCache, VerificationCacheStats};
pub use verifier::{
    Draft, DraftVerifier, SessionContext, VerificationCacheKey, VerificationResult,
    VerificationState, VerifierCapabilities, VerifierError, VerifierSession,
};
pub use viterbi::{
    build_lattice, convert_kana_to_kanji, convert_kana_to_kanji_with_dictionary,
    convert_kana_to_kanji_with_paths, convert_with_dictionary, convert_with_verifier,
    convert_with_verifier_with_limit, search, BytePrefixConstraint, CandidatePath,
    ConstrainedSearchRequest, ConversionCandidate, ConversionLattice, ConversionOptions,
    ConversionRequest, ConversionWithVerification, DictionaryEntryId, EdgeHandle, EdgeOrigin,
    LatticeEdge, PrecedingContext, UnknownPolicy, Utf8BytePrefixConstraint,
    VerifierConversionOptions, VerifierPolicy,
};

#[cfg(test)]
#[path = "kana_kanji/accuracy_corpus.rs"]
mod accuracy_corpus;

#[cfg(test)]
#[path = "kana_kanji/adversarial_corpus.rs"]
mod adversarial_corpus;

#[cfg(test)]
#[path = "kana_kanji/dict_row_inventory.rs"]
mod dict_row_inventory;
