use crate::verifier::{VerificationCacheKey, VerificationResult};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard};

/// Privacy-safe operational counters for the verification cache.
///
/// The snapshot deliberately contains no prompts, candidate text, context, or
/// key hashes, so it is safe to expose in diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerificationCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub entries: usize,
    pub capacity: usize,
}

/// A bounded, process-local LRU cache of verifier results.
///
/// All state, including counters and recency, is protected by one mutex. This
/// keeps a hit and its LRU promotion atomic relative to inserts and evictions.
/// A poisoned mutex is recovered instead of making caption conversion fail;
/// none of the operations performed while holding it can violate memory
/// safety, and serving a cache miss would be preferable to a process panic.
#[derive(Debug)]
pub struct VerificationCache {
    capacity: usize,
    inner: Mutex<CacheInner>,
}

#[derive(Debug, Default)]
struct CacheInner {
    entries: HashMap<VerificationCacheKey, VerificationResult>,
    /// Least recently used at the front, most recently used at the back.
    recency: VecDeque<VerificationCacheKey>,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl VerificationCache {
    pub fn new(capacity: usize) -> Self {
        Self { capacity, inner: Mutex::new(CacheInner::default()) }
    }

    pub fn get(&self, key: &VerificationCacheKey) -> Option<VerificationResult> {
        let mut inner = self.lock_inner();
        let result = inner.entries.get(key).cloned();
        if result.is_some() {
            inner.hits = inner.hits.saturating_add(1);
            promote(&mut inner.recency, key);
        } else {
            inner.misses = inner.misses.saturating_add(1);
        }
        result
    }

    pub fn insert(&self, result: VerificationResult) {
        if self.capacity == 0 {
            return;
        }

        let key = result.cache_key.clone();
        let mut inner = self.lock_inner();
        if inner.entries.insert(key.clone(), result).is_some() {
            promote(&mut inner.recency, &key);
            return;
        }

        inner.recency.push_back(key);
        if inner.entries.len() > self.capacity {
            let oldest = inner.recency.pop_front().expect("a non-empty cache has an LRU entry");
            inner.entries.remove(&oldest);
            inner.evictions = inner.evictions.saturating_add(1);
        }
    }

    pub fn stats(&self) -> VerificationCacheStats {
        let inner = self.lock_inner();
        VerificationCacheStats {
            hits: inner.hits,
            misses: inner.misses,
            evictions: inner.evictions,
            entries: inner.entries.len(),
            capacity: self.capacity,
        }
    }

    fn lock_inner(&self) -> MutexGuard<'_, CacheInner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn promote(recency: &mut VecDeque<VerificationCacheKey>, key: &VerificationCacheKey) {
    // The dictionary cache measured linear VecDeque promotion at 139.7 s for
    // the corpus versus 36.2 s with index-linked O(1) eviction. Verification
    // lookup is intentionally limited to exact-final retries, not 400 ms
    // interim captions: the ignored capacity-1024 worst-case benchmark below
    // measured 8.8 µs per hit in a debug build. Keep the simpler queue here
    // unless call frequency or capacity changes enough to invalidate that data.
    if let Some(position) = recency.iter().position(|entry| entry == key) {
        recency.remove(position);
    }
    recency.push_back(key.clone());
}

#[cfg(test)]
mod tests {
    use super::{VerificationCache, VerificationCacheStats};
    use crate::verifier::{
        Draft, SessionContext, VerificationCacheKey, VerificationResult, VerificationState,
        VerifierSession,
    };
    use crate::viterbi::CandidatePath;
    use crate::{convert_with_dictionary, AzooKeyDictionary, ConversionOptions, DictionaryPaths};
    use std::sync::Arc;
    use std::thread;

    fn key(seed: u64) -> VerificationCacheKey {
        VerificationCacheKey {
            model_revision: format!("model-{seed}"),
            tokenizer_revision: format!("tokenizer-{seed}"),
            inference_config_revision: format!("inference-{seed}"),
            prompt_hash: seed,
            input_bytes_hash: seed + 1,
            left_context_hash: seed + 2,
            right_context_hash: seed + 3,
            dictionary_revision: seed + 4,
            candidate_path_hash: seed + 5,
            constraint_hash: seed + 6,
            protocol_version: u16::try_from(seed).expect("test seed fits u16"),
        }
    }

    fn result(cache_key: VerificationCacheKey, text: &str) -> VerificationResult {
        VerificationResult {
            state: VerificationState::Verified,
            candidate_path: CandidatePath {
                edge_handles: vec![1],
                text: text.to_string(),
                score: -1.0,
                trailing: None,
            },
            prefix_constraint: None,
            cache_key,
        }
    }

    #[test]
    fn identical_key_hits_and_records_privacy_safe_counters() {
        let cache = VerificationCache::new(2);
        let cache_key = key(1);
        let expected = result(cache_key.clone(), "変換");
        cache.insert(expected.clone());

        assert_eq!(cache.get(&cache_key), Some(expected.clone()));
        assert_eq!(cache.get(&cache_key), Some(expected));
        assert_eq!(
            cache.stats(),
            VerificationCacheStats { hits: 2, misses: 0, evictions: 0, entries: 1, capacity: 2 }
        );
    }

    #[test]
    fn changing_each_cache_key_element_is_a_miss() {
        let cache = VerificationCache::new(1);
        let original = key(10);
        cache.insert(result(original.clone(), "基準"));

        let mut variants = Vec::new();
        let mut changed = original.clone();
        changed.model_revision.push_str("-changed");
        variants.push(changed);
        let mut changed = original.clone();
        changed.tokenizer_revision.push_str("-changed");
        variants.push(changed);
        let mut changed = original.clone();
        changed.inference_config_revision.push_str("-changed");
        variants.push(changed);
        let mut changed = original.clone();
        changed.prompt_hash += 1;
        variants.push(changed);
        let mut changed = original.clone();
        changed.input_bytes_hash += 1;
        variants.push(changed);
        let mut changed = original.clone();
        changed.left_context_hash += 1;
        variants.push(changed);
        let mut changed = original.clone();
        changed.right_context_hash += 1;
        variants.push(changed);
        let mut changed = original.clone();
        changed.dictionary_revision += 1;
        variants.push(changed);
        let mut changed = original.clone();
        changed.candidate_path_hash += 1;
        variants.push(changed);
        let mut changed = original.clone();
        changed.constraint_hash += 1;
        variants.push(changed);
        let mut changed = original;
        changed.protocol_version += 1;
        variants.push(changed);

        for variant in &variants {
            assert_eq!(cache.get(variant), None);
        }
        assert_eq!(cache.stats().misses, variants.len() as u64);
    }

    #[test]
    fn evicts_the_least_recently_used_entry() {
        let cache = VerificationCache::new(2);
        let first = key(1);
        let second = key(2);
        let third = key(3);
        cache.insert(result(first.clone(), "一"));
        cache.insert(result(second.clone(), "二"));
        assert!(cache.get(&first).is_some());

        cache.insert(result(third.clone(), "三"));

        assert!(cache.get(&second).is_none());
        assert!(cache.get(&first).is_some());
        assert!(cache.get(&third).is_some());
        assert_eq!(cache.stats().evictions, 1);
    }

    #[test]
    fn zero_capacity_is_always_a_miss() {
        let cache = VerificationCache::new(0);
        let cache_key = key(1);
        cache.insert(result(cache_key.clone(), "保存しない"));

        assert!(cache.get(&cache_key).is_none());
        assert_eq!(
            cache.stats(),
            VerificationCacheStats { hits: 0, misses: 1, evictions: 0, entries: 0, capacity: 0 }
        );
    }

    #[test]
    fn dictionary_edit_changes_conversion_and_misses_verification_cache() {
        let suffix = format!(
            "caption-bridge-verification-reload-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        );
        let path = std::env::temp_dir().join(format!("{suffix}.tsv"));
        let paths = DictionaryPaths { user: Some(path.clone()), ..DictionaryPaths::default() };
        std::fs::write(&path, "かすたむてすと\t変更前\n")
            .expect("first custom dictionary should write");
        let first = AzooKeyDictionary::from_paths(&paths).expect("first dictionary should load");
        let first_text =
            convert_with_dictionary("かすたむてすと", &first, ConversionOptions::default())
                .into_iter()
                .next()
                .expect("first conversion should return a candidate")
                .text;
        assert_eq!(first_text, "変更前");

        let candidate = CandidatePath {
            edge_handles: vec![1],
            text: first_text.clone(),
            score: -1.0,
            trailing: None,
        };
        let draft = Draft::new("prompt", candidate);
        let first_session = VerifierSession {
            session_id: 1,
            context: SessionContext::new("かすたむてすと", first.revision(), "config-v1"),
            model_revision: "model-v1".to_string(),
            tokenizer_revision: "tokenizer-v1".to_string(),
            kv_reusable: true,
        };
        let first_key = VerificationCacheKey::for_draft(&first_session, &draft);
        let cache = VerificationCache::new(2);
        cache.insert(result(first_key.clone(), &first_text));
        assert!(cache.get(&first_key).is_some());

        std::fs::write(&path, "かすたむてすと\t変更後\n")
            .expect("same-size custom dictionary replacement should write");
        let reloaded =
            AzooKeyDictionary::from_paths(&paths).expect("updated dictionary should reload");
        let reloaded_text =
            convert_with_dictionary("かすたむてすと", &reloaded, ConversionOptions::default())
                .into_iter()
                .next()
                .expect("updated conversion should return a candidate")
                .text;
        assert_eq!(reloaded_text, "変更後");
        assert_ne!(first.revision(), reloaded.revision());

        let reloaded_session = VerifierSession {
            context: SessionContext::new("かすたむてすと", reloaded.revision(), "config-v1"),
            ..first_session
        };
        let reloaded_key = VerificationCacheKey::for_draft(&reloaded_session, &draft);
        assert_ne!(first_key.dictionary_revision, reloaded_key.dictionary_revision);
        assert!(cache.get(&reloaded_key).is_none());
        assert_eq!(cache.stats().misses, 1);

        std::fs::remove_file(path).expect("custom dictionary fixture should be removed");
    }

    #[test]
    fn supports_concurrent_inserts_and_hits() {
        let cache = Arc::new(VerificationCache::new(8));
        let workers = (1..=4)
            .map(|seed| {
                let cache = Arc::clone(&cache);
                thread::spawn(move || {
                    let cache_key = key(seed);
                    cache.insert(result(cache_key.clone(), "並行"));
                    assert!(cache.get(&cache_key).is_some());
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().expect("cache worker should not panic");
        }

        assert_eq!(cache.stats().hits, 4);
        assert_eq!(cache.stats().entries, 4);
    }

    #[test]
    #[ignore = "manual worst-case LRU promotion benchmark"]
    fn benchmark_linear_lru_at_final_caption_frequency() {
        use std::hint::black_box;
        use std::time::Instant;

        const CAPACITY: usize = 1_024;
        const LOOKUPS: usize = 10_000;
        let cache = VerificationCache::new(CAPACITY);
        let keys =
            (0..CAPACITY).map(|seed| key(seed as u64)).collect::<Vec<VerificationCacheKey>>();
        for cache_key in &keys {
            cache.insert(result(cache_key.clone(), "確定字幕"));
        }

        let started = Instant::now();
        // Repeated exact-final retries keep the same key most-recent, forcing
        // the current linear promotion to scan the full capacity each time.
        for _ in 0..LOOKUPS {
            black_box(cache.get(&keys[CAPACITY - 1]));
        }
        let elapsed = started.elapsed();
        eprintln!(
            "verification_cache capacity={CAPACITY} lookups={LOOKUPS} elapsed_us={} ns_per_lookup={}",
            elapsed.as_micros(),
            elapsed.as_nanos() / LOOKUPS as u128,
        );
        assert_eq!(cache.stats().hits, LOOKUPS as u64);
    }
}
