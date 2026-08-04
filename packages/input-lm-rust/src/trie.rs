//! Trie access abstraction.
//!
//! The model only ever asks a trie for "every entry starting with this
//! prefix", which is exactly MARISA's predictive search. Keeping that behind a
//! trait lets the Kneser-Ney math be exercised without a 120 MB model file.

use crate::codec::{point_entry, predictive_entry};

/// Predictive-search access to a set of encoded entries.
pub trait NgramTrie {
    /// Returns every stored entry that begins with `prefix`.
    fn predictive_search(&self, prefix: &[i8]) -> Vec<Vec<i8>>;
}

/// In-memory trie used by tests and by callers assembling small models.
#[derive(Debug, Default, Clone)]
pub struct MemoryTrie {
    entries: Vec<Vec<i8>>,
}

impl MemoryTrie {
    /// Creates an empty trie.
    pub fn new() -> Self {
        Self::default()
    }

    /// Stores an already-encoded entry.
    pub fn insert_raw(&mut self, entry: Vec<i8>) {
        self.entries.push(entry);
    }

    /// Stores a point-lookup entry for `key`.
    pub fn insert_point(&mut self, key: &[usize], value: u32) {
        self.insert_raw(point_entry(key, value));
    }

    /// Stores a predictive entry for `key`.
    pub fn insert_predictive(&mut self, key: &[usize], value: u32) {
        self.insert_raw(predictive_entry(key, value));
    }

    /// Number of stored entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the trie holds no entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl NgramTrie for MemoryTrie {
    fn predictive_search(&self, prefix: &[i8]) -> Vec<Vec<i8>> {
        self.entries.iter().filter(|entry| entry.starts_with(prefix)).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{point_prefix, predictive_prefix};

    #[test]
    fn point_search_matches_only_the_exact_key() {
        let mut trie = MemoryTrie::new();
        trie.insert_point(&[1, 2], 10);
        trie.insert_point(&[1, 3], 20);

        assert_eq!(trie.predictive_search(&point_prefix(&[1, 2])).len(), 1);
        assert!(trie.predictive_search(&point_prefix(&[1, 4])).is_empty());
    }

    #[test]
    fn predictive_search_returns_every_continuation_of_a_prefix() {
        let mut trie = MemoryTrie::new();
        trie.insert_predictive(&[1, 2, 7], 10);
        trie.insert_predictive(&[1, 2, 8], 20);
        trie.insert_predictive(&[1, 9, 7], 30);

        assert_eq!(trie.predictive_search(&predictive_prefix(&[1, 2])).len(), 2);
        assert_eq!(trie.predictive_search(&predictive_prefix(&[1, 9])).len(), 1);
    }

    #[test]
    fn a_point_entry_is_not_visible_to_a_predictive_search() {
        // The two delimiters keep the two entry families apart.
        let mut trie = MemoryTrie::new();
        trie.insert_point(&[1, 2], 10);

        assert!(trie.predictive_search(&predictive_prefix(&[1])).is_empty());
    }

    #[test]
    fn reports_length_and_emptiness() {
        let mut trie = MemoryTrie::new();
        assert!(trie.is_empty());
        trie.insert_point(&[1], 1);
        assert_eq!(trie.len(), 1);
        assert!(!trie.is_empty());
    }
}
