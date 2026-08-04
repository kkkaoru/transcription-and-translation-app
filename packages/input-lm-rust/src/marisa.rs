//! [`NgramTrie`] backed by a real MARISA trie file.
//!
//! Gated behind the off-by-default `rsmarisa` feature so the core crate stays
//! dependency-free. `rsmarisa` is a pure-Rust port of marisa-trie, so this
//! pulls in no C++ toolchain — which is what keeps a future wasm build viable.

use std::io;
use std::path::Path;

use rsmarisa::{Agent, Trie};

use crate::model::{EfficientNGram, NgramParams};
use crate::trie::NgramTrie;

/// The four tries [`EfficientNGram`] reads, in the order [`open_model`] loads them.
pub const TRIE_SUFFIXES: [&str; 4] = ["_c_abc", "_u_abx", "_u_xbc", "_r_xbx"];

fn to_bytes(digits: &[i8]) -> Vec<u8> {
    digits.iter().map(|&digit| digit as u8).collect()
}

fn to_digits(bytes: &[u8]) -> Vec<i8> {
    bytes.iter().map(|&byte| byte as i8).collect()
}

/// A memory-mapped MARISA trie.
pub struct MarisaTrie {
    trie: Trie,
}

impl MarisaTrie {
    /// Memory-maps the trie stored at `path`.
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref();
        let path_str = path.to_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, format!("non-UTF-8 path: {path:?}"))
        })?;
        let mut trie = Trie::new();
        trie.mmap(path_str)?;
        Ok(Self { trie })
    }

    /// Number of keys in the trie.
    pub fn num_keys(&self) -> usize {
        self.trie.num_keys()
    }
}

impl NgramTrie for MarisaTrie {
    fn predictive_search(&self, prefix: &[i8]) -> Vec<Vec<i8>> {
        // `Agent::set_query_bytes` stores a raw pointer into `query` rather
        // than copying it, so `query` MUST outlive every search call below.
        // Inlining it as `set_query_bytes(&to_bytes(prefix))` drops the
        // temporary at the end of that statement and silently yields no
        // matches — the empty prefix is the only case that appears to work,
        // because empty input stores a null pointer instead.
        let query = to_bytes(prefix);
        let mut agent = Agent::new();
        agent.set_query_bytes(&query);
        let mut results = Vec::new();
        while self.trie.predictive_search(&mut agent) {
            results.push(to_digits(agent.key().as_bytes()));
        }
        drop(query);
        results
    }
}

/// Loads the four tries named `{base}_c_abc.marisa` and friends.
///
/// `base` is the path stem shared by the files, e.g. `.../input_n5_lm_v1/lm`.
pub fn open_model(
    base: impl AsRef<Path>,
    params: NgramParams,
) -> io::Result<EfficientNGram<MarisaTrie>> {
    let base = base.as_ref();
    let open = |suffix: &str| -> io::Result<MarisaTrie> {
        let mut path = base.as_os_str().to_os_string();
        path.push(suffix);
        path.push(".marisa");
        MarisaTrie::open(Path::new(&path))
    };
    Ok(EfficientNGram::new(
        params,
        open(TRIE_SUFFIXES[0])?,
        open(TRIE_SUFFIXES[1])?,
        open(TRIE_SUFFIXES[2])?,
        open(TRIE_SUFFIXES[3])?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digit_and_byte_conversions_round_trip_across_the_whole_range() {
        let digits: Vec<i8> = (i8::MIN..=i8::MAX).collect();
        assert_eq!(to_digits(&to_bytes(&digits)), digits);
    }

    #[test]
    fn the_negative_delimiters_survive_the_byte_round_trip() {
        use crate::codec::{KEY_VALUE_DELIMITER, PREDICTIVE_DELIMITER};
        let digits = [KEY_VALUE_DELIMITER, PREDICTIVE_DELIMITER, 1, 126];
        assert_eq!(to_digits(&to_bytes(&digits)), digits);
    }

    #[test]
    fn opening_a_missing_trie_is_an_error_not_a_panic() {
        assert!(MarisaTrie::open("/nonexistent/definitely-not-here.marisa").is_err());
    }

    #[test]
    fn the_suffixes_match_the_upstream_file_names() {
        assert_eq!(TRIE_SUFFIXES, ["_c_abc", "_u_abx", "_u_xbc", "_r_xbx"]);
    }
}
