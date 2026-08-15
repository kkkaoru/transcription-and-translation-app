use super::normalization::{is_boundary, to_hiragana, to_katakana};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

// Upstream `DicdataStore.midCount` is 502. MID 501 is the highest current
// index; `MIDData.totalCount` is an enum bookkeeping value, not matrix width.
const MID_COUNT: usize = 502;
const SHARD_SHIFT: usize = 11;
const LOCAL_MASK: usize = (1 << SHARD_SHIFT) - 1;
pub(crate) const DEFAULT_CID: u16 = 1285;
const BOS_CID: u16 = 0;
pub(crate) const DEFAULT_MID: u16 = 501;
/// AzooKey keeps BOS/EOS in the neutral meaning class.
pub(crate) const BOS_EOS_MID: u16 = 500;
const EOS_CID: u16 = 1316;
const CID_COUNT: usize = 1319;
const DEFAULT_CONNECTION_COST: f32 = -25.0;
const NEUTRAL_CONNECTION_COST: f32 = 0.0;
const BUILTIN_SURFACE_SCORE_BONUS: f32 = 1.5;
const DEFAULT_TSV_ENTRY_VALUE: f32 = -10.0;
/// Explicit two-column user rows are intentional and should beat ordinary
/// official alternatives while still participating in lattice context.
const DEFAULT_USER_TSV_ENTRY_VALUE: f32 = -1.0;
const BUILTIN_HIGH_FREQUENCY_VALUE: f32 = -5.0;
const BUILTIN_DEFAULT_VALUE: f32 = -10.0;
const CID_DEFAULT_RECORD: i32 = -1;
const CID_RECORD_BYTES: usize = 8;
const FLOAT32_BYTES: usize = 4;
const U16_BYTES: usize = 2;
const U32_BYTES: usize = 4;
const LOUDSTXT3_COUNT_BYTES: usize = U16_BYTES;
const LOUDSTXT3_OFFSET_BYTES: usize = U32_BYTES;
const LOUDSTXT3_ENTRY_BYTES: usize = 10;
const LOUDSTXT3_VALUE_OFFSET: usize = 6;
const SYSTEM_DICTIONARY_LENGTH_MARGIN: f32 = 2.0;
// AzooKey's `DicdataStore` drops low-quality system entries before building
// the lattice. Keeping those placeholder rows (often around -30) lets a
// short, unrelated surface beat a correct longer word in our Viterbi pass.
// The extra length-dependent margin mirrors upstream `shouldBeRemoved`:
// value must be at least `threshold + 2 / ruby_count`.
const SYSTEM_DICTIONARY_VALUE_THRESHOLD: f32 = -17.0;
const PORTABLE_DICTIONARY_MAGIC: &[u8; 8] = b"AZKDIC01";
const PORTABLE_DICTIONARY_HEADER_BYTES: usize = 12;
const PORTABLE_FILE_HEADER_BYTES: usize = U16_BYTES + U32_BYTES;
// The pinned archive is about 24 MiB unpacked. Bound raw input before parsing
// so a malformed Worker payload cannot retain an unexpectedly large Vec.
const PORTABLE_MAX_ARCHIVE_BYTES: usize = 32 * 1024 * 1024;
const PORTABLE_MAX_FILE_COUNT: usize = 4_096;
const PORTABLE_MAX_PATH_BYTES: usize = 1_024;
// `mm.binary` is the largest pinned member at roughly 1 MiB. Leave room for
// a format revision, while preventing one member from amplifying allocations.
const PORTABLE_MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
// A pinned loudstxt3 record tops out below 18 KiB with 2,048 entries.
const PORTABLE_MAX_LOUDSTXT3_RECORD_BYTES: usize = 64 * 1024;
const PORTABLE_MAX_LOUDSTXT3_RECORD_ENTRIES: usize = 4_096;
// `DictionaryEntry` owns its reading. Bound the combined repeated-reading,
// entry-struct, and surface allocation estimate before expanding one record.
const LOUDSTXT3_ENTRY_EXPANSION_BUDGET_BYTES: usize = 1024 * 1024;
const PORTABLE_LOUDS_FILE_COUNT: usize = 160;
const PORTABLE_LOUDS_TEXT_FILE_COUNT: usize = 422;
// A system lookup is driven by untrusted transcription text. Cache successful
// rows for repeated lattice work, but never retain arbitrary misses forever.
const SYSTEM_ENTRY_CACHE_MAX_ENTRIES: usize = 1_024;

#[derive(Debug, Clone, PartialEq)]
pub struct DictionaryEntry {
    pub reading: String,
    pub surface: String,
    pub lcid: u16,
    pub rcid: u16,
    pub mid: u16,
    /// True when the loudstxt3 row omitted its surface and the serialized
    /// ruby was retained as a Katakana identity surface. This is internal
    /// provenance used by the lattice; ordinary TSV/builtin/Katakana lexical
    /// rows remain false.
    pub raw_ruby_identity: bool,
    /// Explicit user dictionaries may intentionally emit acronyms that the
    /// system-dictionary transliteration guard rejects as noisy Latin.
    pub user_supplied: bool,
    /// AzooKey stores log-probability-like scores where a higher value is
    /// preferred (for example, -5 beats -15).
    pub value: f32,
}

impl DictionaryEntry {
    pub fn plain(reading: impl Into<String>, surface: impl Into<String>, value: f32) -> Self {
        Self {
            reading: reading.into(),
            surface: surface.into(),
            lcid: DEFAULT_CID,
            rcid: DEFAULT_CID,
            mid: DEFAULT_MID,
            raw_ruby_identity: false,
            user_supplied: false,
            value,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct DictionaryPaths {
    /// Root of `azooKey_dictionary_storage` (or its `Dictionary` subdirectory),
    /// containing `louds`, `mm.binary`, and `cb`. May also be a portable TSV.
    pub system: Option<PathBuf>,
    /// Upstream-compatible user dictionary directory (`user.louds` and
    /// `user<N>.loudstxt3`) or a TSV fixture.
    pub user: Option<PathBuf>,
    /// Upstream-compatible learning-memory directory (`memory.louds` and
    /// `memory<N>.loudstxt3`) or a TSV fixture.
    pub memory: Option<PathBuf>,
}

impl DictionaryPaths {
    /// Build paths from explicit roots, filling a missing system root from the
    /// process environment (`AZOOKEY_DICTIONARY_ROOT`) when available.
    pub fn with_defaults(mut self) -> Self {
        if self.system.is_none() {
            self.system = default_system_dictionary_path();
        } else if let Some(system) = self.system.take() {
            self.system = Some(resolve_system_dictionary_root(&system));
        }
        self
    }
}

/// Resolve `AZOOKEY_DICTIONARY_ROOT` (or empty) into a usable system dictionary
/// root. Accepts either the storage repo root or its `Dictionary` subdirectory.
pub fn default_system_dictionary_path() -> Option<PathBuf> {
    let raw = std::env::var("AZOOKEY_DICTIONARY_ROOT").ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let resolved = resolve_system_dictionary_root(Path::new(trimmed));
    if system_dictionary_present(&resolved) || resolved.is_file() {
        Some(resolved)
    } else {
        None
    }
}

/// Resolve the checked-in public dictionary required by Rust quality tests.
///
/// Production callers intentionally require an explicit environment variable
/// (or a supplied path), but the quality tests must never silently disappear
/// when a checkout omitted the dictionary submodule. Prefer the environment
/// when it points at a usable dictionary, then fall back to the repository's
/// pinned submodule. A missing dictionary is a test setup failure and panics
/// with an actionable message instead of turning the test into a false pass.
#[cfg(test)]
pub(crate) fn test_system_dictionary_path() -> PathBuf {
    if let Some(path) = default_system_dictionary_path() {
        return path;
    }
    let checked_in = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../submodules/azooKey_dictionary_storage/Dictionary");
    let resolved = resolve_system_dictionary_root(&checked_in);
    if system_dictionary_present(&resolved) {
        resolved
    } else {
        panic!(
            "official AzooKey dictionary is unavailable for quality tests; initialize {} or set AZOOKEY_DICTIONARY_ROOT",
            checked_in.display()
        );
    }
}

/// Map a user-supplied path onto the LOUDS dictionary root when possible.
///
/// Accepts:
/// - a TSV file
/// - `.../Dictionary` (contains `louds/charID.chid`)
/// - `.../azooKey_dictionary_storage` (auto-selects `Dictionary/`)
///
/// Relative paths that do not resolve from the process working directory are
/// additionally tried against the repository root (`CARGO_MANIFEST_DIR/../..`)
/// so that the workspace test gate's `submodules/...` form works regardless of
/// the cargo test binary's CWD. Absolute paths and paths that already resolve
/// from CWD are unaffected; an unresolvable path is returned as-is so the
/// caller can fall back to the built-in lexicon.
pub fn resolve_system_dictionary_root(path: &Path) -> PathBuf {
    if path.is_file() || system_dictionary_present(path) {
        return path.to_path_buf();
    }
    let nested = path.join("Dictionary");
    if system_dictionary_present(&nested) {
        return nested;
    }
    if !path.is_absolute() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let anchored = repo_root.join(path);
        if anchored.is_file() || system_dictionary_present(&anchored) {
            return anchored;
        }
        let nested_anchored = anchored.join("Dictionary");
        if system_dictionary_present(&nested_anchored) {
            return nested_anchored;
        }
    }
    path.to_path_buf()
}

fn system_dictionary_present(path: &Path) -> bool {
    path.join("louds").join("charID.chid").is_file() && path.join("mm.binary").is_file()
}

#[derive(Debug, Clone)]
pub struct AzooKeyDictionary {
    static_entries: Vec<DictionaryEntry>,
    system: Option<SystemDictionary>,
    user: Option<ExternalTrieDictionary>,
    memory: Option<ExternalTrieDictionary>,
}

impl Default for AzooKeyDictionary {
    fn default() -> Self {
        Self { static_entries: builtin_entries(), system: None, user: None, memory: None }
    }
}

impl AzooKeyDictionary {
    pub fn from_paths(paths: &DictionaryPaths) -> Result<Self, String> {
        let paths = paths.clone().with_defaults();
        let mut dictionary = Self::default();
        if let Some(path) = paths.system.as_deref() {
            if path.is_file() {
                // Explicit TSV must parse; a missing file is soft-skipped below.
                dictionary.static_entries.extend(parse_tsv(path, false)?);
            } else if system_dictionary_present(path) {
                dictionary.system = Some(SystemDictionary::load(path)?);
            }
            // Missing/incomplete system path: keep the built-in lexicon instead
            // of failing the whole conversion (which previously looked like a
            // no-op when callers swallowed the error, or broke captions hard).
        }
        // A complete system dictionary owns lexical scoring. Keeping the
        // compact fallback alongside it would alter official ranking and make
        // quality tests depend on a fixed phrase list instead of LOUDS data.
        if dictionary.system.is_some() {
            dictionary.static_entries.clear();
        }
        let shared_char_ids =
            dictionary.system.as_ref().map(|system| system.char_ids.clone()).unwrap_or_default();
        if let Some(path) = paths.user.as_deref() {
            if path_exists_for_dictionary(path) {
                dictionary.user =
                    Some(ExternalTrieDictionary::load(path, "user", &shared_char_ids)?);
            }
        }
        if let Some(path) = paths.memory.as_deref() {
            if path_exists_for_dictionary(path) {
                dictionary.memory =
                    Some(ExternalTrieDictionary::load(path, "memory", &shared_char_ids)?);
            }
        }
        Ok(dictionary)
    }

    /// Load the official AzooKey system dictionary from a single in-memory
    /// archive. This is the filesystem-free format used by WebAssembly and
    /// Cloudflare Workers; it contains the original LOUDS, MM, and CID files
    /// without converting them into a phrase-specific table.
    pub fn from_portable_system_dictionary(bytes: Vec<u8>) -> Result<Self, String> {
        Ok(Self {
            static_entries: Vec::new(),
            system: Some(SystemDictionary::load_portable(bytes)?),
            user: None,
            memory: None,
        })
    }

    pub fn lookup_exact(&self, reading: &str) -> Result<Vec<DictionaryEntry>, String> {
        let normalized = to_hiragana(reading);
        let mut entries: Vec<DictionaryEntry> = self
            .static_entries
            .iter()
            .filter(|entry| entry.reading == normalized)
            .cloned()
            .collect();
        // Optional dictionaries must not poison built-in hits. Unknown characters
        // or a partial LOUDS install previously returned Err and erased matches.
        if let Some(system) = &self.system {
            if let Ok(system_entries) = system.lookup_exact(&normalized) {
                entries.extend(system_entries);
            }
        }
        if let Some(user) = &self.user {
            if let Ok(user_entries) = user.lookup_exact(&normalized) {
                entries.extend(user_entries);
            }
        }
        if let Some(memory) = &self.memory {
            if let Ok(memory_entries) = memory.lookup_exact(&normalized) {
                entries.extend(memory_entries);
            }
        }
        Ok(entries)
    }

    pub fn entries_starting_at(
        &self,
        chars: &[char],
        start: usize,
        max_chars: usize,
    ) -> Result<Vec<DictionaryEntry>, String> {
        let end = (start + max_chars).min(chars.len());
        let mut entries = Vec::new();
        if start >= end {
            return Ok(entries);
        }
        // Punctuation is its own lattice edge. Look up only the exact
        // one-character mark so the official CID/MID punctuation row can
        // compete, but never continue the reading into the next clause.
        if is_boundary(chars[start]) {
            let reading: String = chars[start..=start].iter().collect();
            if let Ok(matched) = self.lookup_exact(&reading) {
                entries.extend(matched);
            }
            return Ok(entries);
        }
        for finish in (start + 1)..=end {
            // Do not look up readings that cross `、`/`。` into the next clause.
            if is_boundary(chars[finish - 1]) {
                break;
            }
            let reading: String = chars[start..finish].iter().collect();
            // Never abort the whole span on a single failed optional lookup.
            if let Ok(matched) = self.lookup_exact(&reading) {
                entries.extend(matched);
            }
        }
        Ok(entries)
    }

    pub fn connection_cost(&self, former: &DictionaryEntry, latter: &DictionaryEntry) -> f32 {
        self.class_connection_cost(former, latter)
            + self.meaning_connection_cost(former.mid, latter.mid)
    }

    /// Return the morphological class transition cost.  AzooKey applies this
    /// to every lattice edge; the content-word meaning cost is added later at
    /// clause boundaries.
    pub fn class_connection_cost(&self, former: &DictionaryEntry, latter: &DictionaryEntry) -> f32 {
        self.system
            .as_ref()
            .map(|system| system.class_connection_cost(former, latter))
            .unwrap_or(NEUTRAL_CONNECTION_COST)
    }

    /// Return the content-word bigram cost used by AzooKey's clause scorer.
    /// Keeping this separate from CID transitions prevents a frequent
    /// homophone from winning merely because it was split into extra words.
    pub fn meaning_connection_cost(&self, former_mid: u16, latter_mid: u16) -> f32 {
        self.system
            .as_ref()
            .map(|system| system.meaning_connection_cost(former_mid, latter_mid))
            .unwrap_or(NEUTRAL_CONNECTION_COST)
    }

    /// Return the connection cost from AzooKey's virtual beginning-of-sentence
    /// node to a candidate. The upstream converter applies this CID transition
    /// to the first lattice edge; omitting it makes otherwise less likely
    /// homophones (for example `感じ` over `漢字`) win at the start of a
    /// caption. Built-in/TSV dictionaries have no CID matrix, so their neutral
    /// zero cost preserves the compact-lexicon scoring behavior.
    pub fn beginning_connection_cost(&self, entry: &DictionaryEntry) -> f32 {
        self.system
            .as_ref()
            .and_then(|system| system.cid_connection_cost(BOS_CID, entry.lcid).ok())
            .unwrap_or(NEUTRAL_CONNECTION_COST)
    }

    /// Return the connection cost from a given left-side CID to a candidate.
    /// This is used when carrying context across multiple conversion calls,
    /// allowing the system to maintain grammatical state during partial
    /// recognition updates. Fails open: invalid CID returns 0.0.
    pub fn context_connection_cost(&self, former_rcid: u16, entry: &DictionaryEntry) -> f32 {
        self.system
            .as_ref()
            .and_then(|system| system.cid_connection_cost(former_rcid, entry.lcid).ok())
            .unwrap_or(NEUTRAL_CONNECTION_COST)
    }

    /// Whether a transition starts a new AzooKey clause.  This mirrors the
    /// upstream `DicdataStore.isClause` word-type table instead of embedding
    /// any reading→surface exceptions.
    pub fn is_clause_boundary(&self, former_rcid: u16, latter_lcid: u16) -> bool {
        if !self.has_system_dictionary() {
            return false;
        }
        is_clause_boundary(former_rcid, latter_lcid)
    }

    /// Whether this dictionary row contributes its MID to clause-level
    /// meaning-bigram scoring, matching AzooKey's `includeMMValueCalculation`.
    pub fn include_meaning_cost(&self, entry: &DictionaryEntry) -> bool {
        self.has_system_dictionary() && include_meaning_cost(entry)
    }

    /// Return a stable fingerprint for the loaded dictionary sources.
    ///
    /// The lattice/verifier API carries this value so a cached constraint
    /// result cannot be reused after the dictionary changes. Filesystem
    /// dictionaries use their resolved root as the revision material while
    /// portable dictionaries include their archive bytes; TSV/static entries
    /// are always included in either case.
    pub fn revision(&self) -> u64 {
        let mut hash = 0xcbf29ce484222325u64;
        revision_mix(&mut hash, b"azookey-dictionary-v1");
        for entry in &self.static_entries {
            revision_mix_entry(&mut hash, entry);
        }
        match &self.system {
            Some(system) => {
                revision_mix(&mut hash, b"system");
                match &system.source {
                    SystemDictionarySource::Filesystem(path) => {
                        revision_mix(&mut hash, path.to_string_lossy().as_bytes());
                    }
                    SystemDictionarySource::Portable(_) => {
                        revision_mix(&mut hash, b"portable");
                    }
                }
                revision_mix(&mut hash, &system.content_revision.to_le_bytes());
            }
            None => revision_mix(&mut hash, b"no-system"),
        }
        for (name, dictionary) in [("user", &self.user), ("memory", &self.memory)] {
            revision_mix(&mut hash, name.as_bytes());
            if let Some(dictionary) = dictionary {
                revision_mix(&mut hash, dictionary.root.to_string_lossy().as_bytes());
                revision_mix(&mut hash, dictionary.name.as_bytes());
                revision_mix(&mut hash, &dictionary.content_revision.to_le_bytes());
                if let Some(entries) = &dictionary.tsv_entries {
                    for entry in entries {
                        revision_mix_entry(&mut hash, entry);
                    }
                }
            }
        }
        hash
    }

    pub(crate) fn has_system_dictionary(&self) -> bool {
        self.system.is_some()
    }

    /// Give a small, bounded prior to a surface known by the compact fallback
    /// lexicon when a full system dictionary is also loaded. This only breaks
    /// near ties; CID/MID costs and system probabilities remain dominant.
    pub(crate) fn builtin_surface_bonus(&self, entry: &DictionaryEntry) -> f32 {
        if !self.has_system_dictionary() {
            return NEUTRAL_CONNECTION_COST;
        }
        if self
            .static_entries
            .iter()
            .any(|builtin| builtin.reading == entry.reading && builtin.surface == entry.surface)
        {
            BUILTIN_SURFACE_SCORE_BONUS
        } else {
            NEUTRAL_CONNECTION_COST
        }
    }

    #[cfg(test)]
    pub(crate) fn without_builtin_entries_for_test(mut self) -> Self {
        let builtin = builtin_entries();
        self.static_entries.retain(|entry| !builtin.contains(entry));
        self
    }
}

fn filesystem_dictionary_content_revision(path: &Path) -> Result<u64, String> {
    let mut files = Vec::new();
    if path.is_file() {
        files.push(path.to_path_buf());
    } else {
        collect_dictionary_files(path, path, &mut HashSet::new(), &mut files)?;
    }
    files.sort();

    let mut hash = 0xcbf29ce484222325u64;
    revision_mix(&mut hash, b"azookey-filesystem-content-v1");
    for file in files {
        let relative = file.strip_prefix(path).unwrap_or(&file);
        let name = if relative.as_os_str().is_empty() {
            file.file_name().unwrap_or_default().to_string_lossy()
        } else {
            relative.to_string_lossy()
        };
        revision_mix(&mut hash, name.as_bytes());
        let bytes = fs::read(&file)
            .map_err(|error| format!("could not fingerprint {}: {error}", file.display()))?;
        revision_mix(&mut hash, &bytes);
    }
    Ok(hash)
}

fn collect_dictionary_files(
    root: &Path,
    directory: &Path,
    visited: &mut HashSet<PathBuf>,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let canonical = directory.canonicalize().map_err(|error| {
        format!("could not resolve dictionary directory {}: {error}", directory.display())
    })?;
    if !visited.insert(canonical) {
        return Ok(());
    }
    let entries = fs::read_dir(directory).map_err(|error| {
        format!("could not list dictionary directory {}: {error}", directory.display())
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!("could not read an entry under {}: {error}", root.display())
        })?;
        let path = entry.path();
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("could not inspect {}: {error}", path.display()))?;
        if metadata.is_dir() {
            collect_dictionary_files(root, &path, visited, files)?;
        } else if metadata.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

fn revision_mix(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
    *hash ^= 0xff;
    *hash = hash.wrapping_mul(0x100000001b3);
}

fn revision_mix_entry(hash: &mut u64, entry: &DictionaryEntry) {
    revision_mix(hash, entry.reading.as_bytes());
    revision_mix(hash, entry.surface.as_bytes());
    revision_mix(hash, &entry.lcid.to_le_bytes());
    revision_mix(hash, &entry.rcid.to_le_bytes());
    revision_mix(hash, &entry.mid.to_le_bytes());
    revision_mix(hash, &entry.value.to_bits().to_le_bytes());
    revision_mix(hash, &[u8::from(entry.raw_ruby_identity), u8::from(entry.user_supplied)]);
}

fn path_exists_for_dictionary(path: &Path) -> bool {
    path.is_file() || path.is_dir()
}

#[derive(Debug, Clone)]
struct SystemEntryCacheNode {
    reading: String,
    entries: Vec<DictionaryEntry>,
    previous: Option<usize>,
    next: Option<usize>,
}

#[derive(Debug, Clone, Default)]
struct SystemEntryCache {
    indices: HashMap<String, usize>,
    nodes: Vec<SystemEntryCacheNode>,
    least_recent: Option<usize>,
    most_recent: Option<usize>,
}

impl SystemEntryCache {
    fn get(&mut self, reading: &str) -> Option<Vec<DictionaryEntry>> {
        let index = *self.indices.get(reading)?;
        self.promote(index);
        Some(self.nodes[index].entries.clone())
    }

    fn insert(&mut self, reading: String, entries: Vec<DictionaryEntry>) {
        if let Some(index) = self.indices.get(&reading).copied() {
            self.nodes[index].entries = entries;
            self.promote(index);
            return;
        }

        let index = if self.nodes.len() < SYSTEM_ENTRY_CACHE_MAX_ENTRIES {
            let index = self.nodes.len();
            self.nodes.push(SystemEntryCacheNode {
                reading: reading.clone(),
                entries,
                previous: None,
                next: None,
            });
            index
        } else {
            let index = self.least_recent.expect("a full cache has an LRU entry");
            self.detach(index);
            self.indices.remove(&self.nodes[index].reading);
            self.nodes[index].reading = reading.clone();
            self.nodes[index].entries = entries;
            index
        };
        self.indices.insert(reading, index);
        self.attach_most_recent(index);
    }

    fn promote(&mut self, index: usize) {
        if self.most_recent == Some(index) {
            return;
        }
        self.detach(index);
        self.attach_most_recent(index);
    }

    fn detach(&mut self, index: usize) {
        let previous = self.nodes[index].previous;
        let next = self.nodes[index].next;
        if let Some(previous) = previous {
            self.nodes[previous].next = next;
        } else {
            self.least_recent = next;
        }
        if let Some(next) = next {
            self.nodes[next].previous = previous;
        } else {
            self.most_recent = previous;
        }
        self.nodes[index].previous = None;
        self.nodes[index].next = None;
    }

    fn attach_most_recent(&mut self, index: usize) {
        self.nodes[index].previous = self.most_recent;
        self.nodes[index].next = None;
        if let Some(most_recent) = self.most_recent {
            self.nodes[most_recent].next = Some(index);
        } else {
            self.least_recent = Some(index);
        }
        self.most_recent = Some(index);
    }
}

#[derive(Debug, Clone)]
struct SystemDictionary {
    source: SystemDictionarySource,
    content_revision: u64,
    char_ids: HashMap<char, u8>,
    mm: Vec<f32>,
    cc_cache: RefCell<HashMap<u16, Vec<f32>>>,
    louds_cache: RefCell<HashMap<String, Louds>>,
    entry_cache: RefCell<SystemEntryCache>,
}

#[derive(Debug, Clone)]
enum SystemDictionarySource {
    Filesystem(PathBuf),
    Portable(PortableFileStore),
}

#[derive(Debug, Clone)]
struct PortableFileStore {
    bytes: Vec<u8>,
    files: HashMap<String, Range<usize>>,
}

impl SystemDictionary {
    fn load(root: &Path) -> Result<Self, String> {
        Self::from_source(SystemDictionarySource::Filesystem(root.to_path_buf()))
    }

    fn load_portable(bytes: Vec<u8>) -> Result<Self, String> {
        let source = SystemDictionarySource::Portable(PortableFileStore::parse(bytes)?);
        Self::validate_portable_components(&source)?;
        Self::from_source(source)
    }

    fn from_source(source: SystemDictionarySource) -> Result<Self, String> {
        // Hash once while loading. `AzooKeyDictionary::revision` is read for
        // every lattice, so rescanning the 34 MB official dictionary there
        // would add I/O to every interim caption. Content hashing (rather than
        // path/size/mtime metadata) detects same-size rewrites and edits that
        // preserve timestamps; the cost is paid only when a dictionary reloads.
        let content_revision = source.content_revision()?;
        let chars = source.read_utf8("louds/charID.chid")?;
        let mut char_ids = HashMap::new();
        for (index, character) in chars.chars().enumerate() {
            let id = u8::try_from(index)
                .map_err(|_| "AzooKey charID.chid has more than 256 characters".to_string())?;
            char_ids.insert(character, id);
        }
        let mm = read_f32_bytes(&source.read("mm.binary")?)?;
        if mm.len() < MID_COUNT * MID_COUNT {
            return Err(format!(
                "mm.binary is too short for the AzooKey {MID_COUNT}x{MID_COUNT} MID matrix"
            ));
        }
        if mm.iter().any(|value| !value.is_finite()) {
            return Err("mm.binary contains a non-finite connection cost".to_string());
        }
        Ok(Self {
            source,
            content_revision,
            char_ids,
            mm,
            cc_cache: RefCell::new(HashMap::new()),
            louds_cache: RefCell::new(HashMap::new()),
            entry_cache: RefCell::new(SystemEntryCache::default()),
        })
    }

    fn lookup_exact(&self, reading: &str) -> Result<Vec<DictionaryEntry>, String> {
        if let Some(entries) = self.entry_cache.borrow_mut().get(reading) {
            return Ok(entries);
        }
        let entries = self.lookup_exact_uncached(reading)?;
        // Misses are reusable lookup results too. Caching them avoids reopening
        // the same LOUDS shards for the many repeated substrings considered by
        // Viterbi, while the LRU bound prevents arbitrary ASR text from growing
        // the process for the dictionary lifetime.
        self.entry_cache.borrow_mut().insert(reading.to_string(), entries.clone());
        Ok(entries)
    }

    fn validate_portable_components(source: &SystemDictionarySource) -> Result<(), String> {
        let SystemDictionarySource::Portable(store) = source else {
            return Ok(());
        };

        // Validate every eagerly-required CID and LOUDS component before a
        // portable archive is accepted. Otherwise a corrupt archive could be
        // marked as initialized and quietly return only built-in candidates.
        for cid in 0..CID_COUNT {
            read_cc_line_bytes(store.read(&format!("cb/{cid}.binary"))?)?;
        }
        for path in store.files.keys().filter(|path| path.ends_with(".louds")) {
            let identifier = path
                .strip_prefix("louds/")
                .and_then(|path| path.strip_suffix(".louds"))
                .ok_or_else(|| {
                    "portable AzooKey dictionary has an invalid LOUDS path".to_string()
                })?;
            Louds::load(source, identifier)?;
        }
        Ok(())
    }

    fn lookup_exact_uncached(&self, reading: &str) -> Result<Vec<DictionaryEntry>, String> {
        let dictionary_reading = to_katakana(reading);
        let Some(first) = dictionary_reading.chars().next() else {
            return Ok(Vec::new());
        };
        // Characters outside charID (latin, punctuation, kanji spans) are not
        // dictionary hits — return empty instead of failing the whole convert.
        let Some(ids) = dictionary_reading
            .chars()
            .map(|character| self.char_ids.get(&character).copied())
            .collect::<Option<Vec<_>>>()
        else {
            return Ok(Vec::new());
        };
        let identifier = escaped_identifier(&first.to_string());
        let Some(node_index) = self.search_node_index(&identifier, &ids) else {
            return Ok(Vec::new());
        };
        let shard = node_index >> SHARD_SHIFT;
        let local_index = node_index & LOCAL_MASK;
        let path = format!("louds/{identifier}{shard}.loudstxt3");
        match self
            .source
            .read(&path)
            .and_then(|bytes| read_loudstxt3_entry_bytes(&bytes, local_index))
        {
            Ok(entries) => Ok(filter_system_entries(entries)),
            Err(_) => Ok(Vec::new()),
        }
    }

    fn class_connection_cost(&self, former: &DictionaryEntry, latter: &DictionaryEntry) -> f32 {
        self.cid_connection_cost(former.rcid, latter.lcid).unwrap_or(DEFAULT_CONNECTION_COST)
    }

    fn search_node_index(&self, identifier: &str, ids: &[u8]) -> Option<usize> {
        if !self.louds_cache.borrow().contains_key(identifier) {
            let louds = Louds::load(&self.source, identifier).ok()?;
            self.louds_cache.borrow_mut().insert(identifier.to_string(), louds);
        }
        self.louds_cache.borrow().get(identifier)?.search_node_index(ids)
    }

    fn meaning_connection_cost(&self, former_mid: u16, latter_mid: u16) -> f32 {
        if former_mid == BOS_EOS_MID || latter_mid == BOS_EOS_MID {
            return NEUTRAL_CONNECTION_COST;
        }
        let mid_index = usize::from(former_mid) * MID_COUNT + usize::from(latter_mid);
        self.mm.get(mid_index).copied().unwrap_or(NEUTRAL_CONNECTION_COST)
    }

    fn cid_connection_cost(&self, former: u16, latter: u16) -> Result<f32, String> {
        if !self.cc_cache.borrow().contains_key(&former) {
            let bytes = self.source.read(&format!("cb/{former}.binary"))?;
            self.cc_cache.borrow_mut().insert(former, read_cc_line_bytes(&bytes)?);
        }
        Ok(self
            .cc_cache
            .borrow()
            .get(&former)
            .and_then(|line| line.get(usize::from(latter)))
            .copied()
            .unwrap_or(DEFAULT_CONNECTION_COST))
    }
}

#[cfg(test)]
static FILESYSTEM_SOURCE_READS: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
pub(crate) fn reset_filesystem_source_read_count() {
    FILESYSTEM_SOURCE_READS.store(0, Ordering::Relaxed);
}

#[cfg(test)]
pub(crate) fn filesystem_source_read_count() -> usize {
    FILESYSTEM_SOURCE_READS.load(Ordering::Relaxed)
}

impl SystemDictionarySource {
    fn content_revision(&self) -> Result<u64, String> {
        match self {
            Self::Filesystem(root) => filesystem_dictionary_content_revision(root),
            Self::Portable(store) => {
                let mut hash = 0xcbf29ce484222325u64;
                revision_mix(&mut hash, &store.bytes);
                Ok(hash)
            }
        }
    }

    fn read(&self, relative_path: &str) -> Result<Cow<'_, [u8]>, String> {
        match self {
            Self::Filesystem(root) => {
                let path = root.join(relative_path);
                #[cfg(test)]
                FILESYSTEM_SOURCE_READS.fetch_add(1, Ordering::Relaxed);
                fs::read(&path)
                    .map(Cow::Owned)
                    .map_err(|error| format!("could not read {}: {error}", path.display()))
            }
            Self::Portable(store) => store.read(relative_path).map(Cow::Borrowed),
        }
    }

    fn read_utf8(&self, relative_path: &str) -> Result<Cow<'_, str>, String> {
        match self.read(relative_path)? {
            Cow::Borrowed(bytes) => std::str::from_utf8(bytes)
                .map(Cow::Borrowed)
                .map_err(|_| format!("{relative_path} is not UTF-8")),
            Cow::Owned(bytes) => String::from_utf8(bytes)
                .map(Cow::Owned)
                .map_err(|_| format!("{relative_path} is not UTF-8")),
        }
    }
}

impl PortableFileStore {
    fn parse(bytes: Vec<u8>) -> Result<Self, String> {
        if bytes.len() > PORTABLE_MAX_ARCHIVE_BYTES {
            return Err("portable AzooKey dictionary exceeds the maximum archive size".to_string());
        }
        if bytes.get(..PORTABLE_DICTIONARY_MAGIC.len()) != Some(PORTABLE_DICTIONARY_MAGIC) {
            return Err("portable AzooKey dictionary has an invalid magic header".to_string());
        }
        let file_count = read_u32(&bytes, PORTABLE_DICTIONARY_MAGIC.len())? as usize;
        if file_count == 0 || file_count > PORTABLE_MAX_FILE_COUNT {
            return Err("portable AzooKey dictionary has an invalid file count".to_string());
        }
        let mut offset = PORTABLE_DICTIONARY_HEADER_BYTES;
        let mut files = HashMap::with_capacity(file_count);
        for _ in 0..file_count {
            offset = parse_portable_file(&bytes, offset, &mut files)?;
        }
        if offset != bytes.len() {
            return Err("portable AzooKey dictionary has trailing bytes".to_string());
        }
        validate_portable_layout(&files)?;
        Ok(Self { bytes, files })
    }

    fn read(&self, relative_path: &str) -> Result<&[u8], String> {
        let range = self
            .files
            .get(relative_path)
            .ok_or_else(|| format!("portable AzooKey dictionary is missing {relative_path}"))?;
        Ok(&self.bytes[range.clone()])
    }
}

fn validate_portable_layout(files: &HashMap<String, Range<usize>>) -> Result<(), String> {
    if !files.contains_key("louds/charID.chid") || !files.contains_key("mm.binary") {
        return Err("portable AzooKey dictionary is missing required metadata".to_string());
    }
    let complete_cid_matrix =
        (0..CID_COUNT).all(|cid| files.contains_key(&format!("cb/{cid}.binary")));
    let louds = files.keys().filter(|path| path.ends_with(".louds")).collect::<Vec<_>>();
    let complete_louds = louds.len() == PORTABLE_LOUDS_FILE_COUNT
        && louds.iter().all(|path| {
            let chars_path = format!("{}chars2", path);
            files.contains_key(&chars_path)
        });
    let louds_chars = files.keys().filter(|path| path.ends_with(".loudschars2")).count();
    let louds_text = files.keys().filter(|path| path.ends_with(".loudstxt3")).count();
    if !complete_cid_matrix
        || !complete_louds
        || louds_chars != PORTABLE_LOUDS_FILE_COUNT
        || louds_text != PORTABLE_LOUDS_TEXT_FILE_COUNT
    {
        return Err("portable AzooKey dictionary has an incomplete caption layout".to_string());
    }
    Ok(())
}

fn parse_portable_file(
    bytes: &[u8],
    offset: usize,
    files: &mut HashMap<String, Range<usize>>,
) -> Result<usize, String> {
    let path_length = read_u16(bytes, offset)? as usize;
    let data_length = read_u32(bytes, offset + U16_BYTES)? as usize;
    if path_length == 0 || path_length > PORTABLE_MAX_PATH_BYTES {
        return Err("portable AzooKey dictionary has an invalid path length".to_string());
    }
    if data_length > PORTABLE_MAX_FILE_BYTES {
        return Err("portable AzooKey dictionary contains an oversized file".to_string());
    }
    let path_start = offset + PORTABLE_FILE_HEADER_BYTES;
    let data_start = path_start
        .checked_add(path_length)
        .ok_or_else(|| "portable AzooKey dictionary offset overflow".to_string())?;
    let data_end = data_start
        .checked_add(data_length)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| "portable AzooKey dictionary is truncated".to_string())?;
    let path = parse_portable_path(&bytes[path_start..data_start])?;
    if files.insert(path, data_start..data_end).is_some() {
        return Err("portable AzooKey dictionary contains a duplicate path".to_string());
    }
    Ok(data_end)
}

fn parse_portable_path(bytes: &[u8]) -> Result<String, String> {
    let path = std::str::from_utf8(bytes)
        .map_err(|_| "portable AzooKey dictionary path is not UTF-8".to_string())?;
    if path.starts_with('/') || path.contains("\\") || path.split('/').any(|part| part == "..") {
        return Err("portable AzooKey dictionary contains an unsafe path".to_string());
    }
    Ok(path.to_string())
}

/// AzooKey's compact word-type classification used by `isClause` and
/// `includeMMValueCalculation`.  The ranges are the stable CID groups from
/// the upstream converter; they describe morphology, not specific words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WordType {
    Boundary,
    Preposition,
    ContentWord,
    Postposition,
}

fn word_type(cid: u16) -> WordType {
    let cid = usize::from(cid);
    if cid == usize::from(BOS_CID) || cid == usize::from(EOS_CID) {
        return WordType::Boundary;
    }
    if matches!(cid, 6 | 557..=560 | 1315) {
        return WordType::Preposition; // 前置機能語
    }
    if matches!(
        cid,
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
        return WordType::ContentWord; // 内容語
    }
    WordType::Postposition // 後置機能語
}

/// True when a CID is in AzooKey's true particle / auxiliary bands.
///
/// Upstream `CIDData.isJoshi` is `147..=368`; `DicdataStore` treats
/// `147..=554` as 助詞+助動詞 for typo / prediction tables. This is **not**
/// the residual `word_type == Postposition` class, which also absorbs
/// non-grammatical gaps (e.g. 非自立名詞 `1297..=1305`).
pub(crate) fn is_postposition_cid(cid: u16) -> bool {
    is_joshi_cid(cid) || is_jodoushi_cid(cid)
}

/// 助詞 band (`CIDData.isJoshi`).
pub(crate) fn is_joshi_cid(cid: u16) -> bool {
    (147..=368).contains(&cid)
}

/// 助動詞 / copula band (DicdataStore `369..=554`).
pub(crate) fn is_jodoushi_cid(cid: u16) -> bool {
    (369..=554).contains(&cid)
}

fn is_clause_boundary(former_rcid: u16, latter_lcid: u16) -> bool {
    let latter_type = word_type(latter_lcid);
    if latter_type == WordType::Boundary {
        return false;
    }
    let former_type = word_type(former_rcid);
    if former_type == WordType::Boundary {
        return false;
    }
    matches!(latter_type, WordType::Preposition | WordType::ContentWord)
        && former_type != WordType::Preposition
}

const MEANING_CID_START: u16 = 895;
const MEANING_CID_END: u16 = 1280;
const MEANING_SPECIAL_CID_START: u16 = 1297;
const MEANING_SPECIAL_CID_END: u16 = 1305;

fn include_meaning_cost(entry: &DictionaryEntry) -> bool {
    (MEANING_CID_START..=MEANING_CID_END).contains(&entry.lcid)
        || (MEANING_CID_START..=MEANING_CID_END).contains(&entry.rcid)
        || (MEANING_SPECIAL_CID_START..=MEANING_SPECIAL_CID_END).contains(&entry.lcid)
        || (MEANING_SPECIAL_CID_START..=MEANING_SPECIAL_CID_END).contains(&entry.rcid)
        || word_type(entry.lcid) == WordType::ContentWord
        || word_type(entry.rcid) == WordType::ContentWord
}

/// AzooKey's prediction-only CID usability table. Full conversion does not
/// apply this table while building its lattice; predictive suggestions do.
#[cfg(test)]
fn prediction_usable_rcid(rcid: u16) -> bool {
    !matches!(
        rcid,
        13..=18
            | 25..=28
            | 33..=34
            | 40..=42
            | 46..=47
            | 50
            | 56..=64
            | 74..=79
            | 86..=88
            | 93..=95
            | 99..=100
            | 103
            | 107..=112
            | 119..=122
            | 127..=128
            | 134..=136
            | 140..=141
            | 144
            | 369
            | 372..=373
            | 377..=382
            | 389..=392
            | 397..=398
            | 401..=402
            | 404..=406
            | 408
            | 410..=413
            | 416..=421
            | 426..=427
            | 431
            | 433..=434
            | 437..=438
            | 441..=443
            | 447..=448
            | 450
            | 452
            | 455
            | 457
            | 462..=464
            | 470..=472
            | 476..=477
            | 480
            | 483
            | 489..=490
            | 493..=496
            | 504
            | 527..=528
            | 533..=534
            | 537
            | 540
            | 542
            | 548
            | 551
            | 553
            | 561..=562
            | 564..=567
            | 569
            | 571..=572
            | 574..=577
            | 579
            | 581..=582
            | 585
            | 587
            | 589..=591
            | 594..=598
            | 600..=601
            | 603..=604
            | 606
            | 609
            | 611
            | 614
            | 617..=618
            | 620..=622
            | 624
            | 626..=627
            | 629..=631
            | 634
            | 636
            | 638
            | 641..=642
            | 644
            | 647..=648
            | 650
            | 653..=654
            | 656
            | 659..=660
            | 662
            | 665..=666
            | 668
            | 671..=673
            | 675..=678
            | 681..=684
            | 687..=688
            | 691..=694
            | 697..=700
            | 703..=704
            | 707..=710
            | 713..=716
            | 721..=722
            | 724..=725
            | 727
            | 729..=730
            | 732..=733
            | 736..=737
            | 739..=740
            | 742
            | 744..=745
            | 747..=748
            | 750
            | 752..=753
            | 755..=756
            | 758
            | 760..=761
            | 763..=764
            | 766
            | 768..=771
            | 774..=783
            | 786..=787
            | 790..=791
            | 793..=795
            | 798
            | 800..=801
            | 804..=807
            | 810..=811
            | 814..=816
            | 820..=825
            | 829..=831
            | 835
            | 837
            | 840
            | 842
            | 845
            | 847
            | 850
            | 852
            | 855
            | 859..=860
            | 862
            | 865..=866
            | 868..=869
            | 871..=873
            | 875
            | 877..=878
            | 880..=881
            | 884..=885
            | 887..=891
            | 893
            | 895..=896
            | 898..=901
            | 903
            | 905..=906
            | 908..=911
            | 913
            | 915..=918
            | 921..=925
            | 928..=929
            | 931..=932
            | 934..=936
            | 939
            | 941
            | 943..=952
            | 958..=967
            | 973..=977
            | 983..=990
            | 995..=1002
            | 1007..=1010
            | 1015..=1018
            | 1021..=1024
            | 1029..=1036
            | 1041..=1048
            | 1057..=1058
            | 1060..=1061
            | 1063
            | 1065..=1090
            | 1104..=1168
            | 1182..=1194
            | 1208..=1215
            | 1220..=1231
            | 1240..=1243
            | 1248..=1251
            | 1256..=1263
            | 1268..=1271
            | 1276
            | 1278
    )
}

/// Keep finite system rows that pass AzooKey's full-conversion
/// `shouldBeRemoved` threshold. Prediction-only CID usability must not run
/// here: inflectional and one-kana lexical rows are needed by the full
/// Viterbi lattice.
///
/// Multi-kana hiragana identity rows are filtered by default so they do not
/// outrank ordinary kanji conversions without neural re-ranking. Sibling
/// filtering in [`filter_system_entries`] reintroduces them when the reading
/// has no competitive converted surface (rare orthography only).
fn system_entry_is_usable(entry: &DictionaryEntry) -> bool {
    // Multi-kana hiragana identity rows are not lexical conversions, but a
    // one-kana non-identity row can be a real lexical word (き -> 木).
    if is_multi_kana_hiragana_identity(entry) {
        return false;
    }
    system_entry_passes_quality_threshold(entry)
}

/// Apply the full-conversion quality filter, then restore multi-kana hiragana
/// identity rows when they carry a preferred morphology-specific sibling or
/// when no competitive converted surface exists for the same reading.
///
/// Without this sibling pass, a reading such as `とても` keeps only the rare
/// dictionary row `迚も` (near the quality floor) because the common kana
/// identity was dropped. Upstream AzooKey still exposes the identity path;
/// reintroducing it when every converted surface is rare recovers natural
/// orthography without resurrecting identity rows for ordinary words such as
/// `とうきょう` → `東京`.
fn filter_system_entries(entries: Vec<DictionaryEntry>) -> Vec<DictionaryEntry> {
    let quality_entries = entries
        .into_iter()
        .filter(|entry| {
            system_entry_is_usable(entry)
                || (is_multi_kana_hiragana_identity(entry)
                    && system_entry_passes_quality_threshold(entry))
        })
        .collect::<Vec<_>>();
    let has_competitive_converted = quality_entries
        .iter()
        .any(|entry| is_competitive_converted_system_entry(entry, &quality_entries));
    quality_entries
        .iter()
        .filter(|entry| {
            !is_multi_kana_hiragana_identity(entry)
                || !has_competitive_converted
                || has_preferred_metadata_identity_sibling(entry, &quality_entries)
        })
        .cloned()
        .collect()
}

fn system_entry_passes_quality_threshold(entry: &DictionaryEntry) -> bool {
    if !entry.value.is_finite() {
        return false;
    }
    let ruby_count = entry.reading.chars().count().max(1);
    let minimum =
        SYSTEM_DICTIONARY_VALUE_THRESHOLD + SYSTEM_DICTIONARY_LENGTH_MARGIN / ruby_count as f32;
    entry.value >= minimum
}

fn is_multi_kana_hiragana_identity(entry: &DictionaryEntry) -> bool {
    entry.reading.chars().count() >= 2 && entry.surface == entry.reading
}

/// Preserve an identity row when a converted sibling has the exact same
/// morphology metadata but a no-better dictionary value. This retains real
/// inflected/formal rows such as `いただきます` and `さます`, while avoiding
/// generic stem identities such as `ふり` and `よく` that only compete with a
/// better converted sibling in a larger clause.
fn has_preferred_metadata_identity_sibling(
    entry: &DictionaryEntry,
    siblings: &[DictionaryEntry],
) -> bool {
    if entry.lcid == DEFAULT_CID && entry.rcid == DEFAULT_CID {
        return false;
    }
    siblings.iter().any(|candidate| {
        candidate.surface != entry.surface
            && candidate.lcid == entry.lcid
            && candidate.rcid == entry.rcid
            && candidate.mid == entry.mid
            && candidate.surface != candidate.reading
            && candidate.surface.chars().any(is_kanji_char)
            && entry.value >= candidate.value
    })
}

/// A converted system surface is competitive when it is a real orthographic
/// alternative (kanji and/or katakana) with enough frequency that it should
/// suppress the multi-kana hiragana identity row.
///
/// A converted surface is competitive when its score is close to the best
/// sibling for the same reading. Comparing siblings keeps this decision
/// stable when a dictionary shard uses a different absolute score scale.
fn is_competitive_converted_system_entry(
    entry: &DictionaryEntry,
    siblings: &[DictionaryEntry],
) -> bool {
    if is_multi_kana_hiragana_identity(entry) {
        return false;
    }
    // Raw-ruby identity rows omit an explicit surface and keep the katakana
    // ruby (for example `すーぷ` → `スープ`). Those are real orthographic
    // conversions and must suppress multi-kana hiragana identity the same way
    // ordinary kanji/katakana rows do.
    let has_converted_script = entry
        .surface
        .chars()
        .any(|character| is_kanji_char(character) || is_katakana_char(character));
    if !has_converted_script {
        return false;
    }
    let best_sibling_value = siblings
        .iter()
        .filter(|candidate| candidate.surface != entry.surface)
        .map(|candidate| candidate.value)
        .max_by(f32::total_cmp);
    best_sibling_value.is_none_or(|value| entry.value + COMPETITIVE_CONVERTED_VALUE_MARGIN >= value)
}

/// Maximum score gap from the best sibling for a converted surface to suppress
/// a multi-kana hiragana identity row.
///
/// Calibrated against the accuracy corpus: a margin of 1.0 keeps the kana
/// identity for readings where hiragana is the dominant spelling (`ください`
/// identity -3.41 vs `下さい` -4.88, gap 1.48) while still suppressing it for
/// ordinary words where the kanji surface is more frequent (`とうきょう` vs
/// `東京`). A wider margin (4.0) lets `下さい` become competitive and suppress
/// `ください`, regressing `スープはください`; a margin below 1.0 begins to lose
/// should-convert words whose kanji surface is only slightly below the identity.
const COMPETITIVE_CONVERTED_VALUE_MARGIN: f32 = 1.0;

fn is_kanji_char(character: char) -> bool {
    let code = character as u32;
    (0x3400..=0x4dbf).contains(&code)
        || (0x4e00..=0x9fff).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
}

fn is_katakana_char(character: char) -> bool {
    let code = character as u32;
    (0x30a0..=0x30ff).contains(&code) || character == 'ー'
}

#[derive(Debug, Clone)]
struct ExternalTrieDictionary {
    root: PathBuf,
    name: String,
    content_revision: u64,
    char_ids: HashMap<char, u8>,
    tsv_entries: Option<Vec<DictionaryEntry>>,
}

impl ExternalTrieDictionary {
    fn load(
        path: &Path,
        name: &str,
        inherited_char_ids: &HashMap<char, u8>,
    ) -> Result<Self, String> {
        let content_revision = filesystem_dictionary_content_revision(path)?;
        if path.is_file() {
            return Ok(Self {
                root: path.to_path_buf(),
                name: name.to_string(),
                content_revision,
                char_ids: HashMap::new(),
                tsv_entries: Some(parse_tsv(path, name == "user")?),
            });
        }
        let char_ids = if inherited_char_ids.is_empty() {
            let char_path = path.join("charID.chid");
            let chars = fs::read_to_string(&char_path).map_err(|error| {
                format!(
                    "could not read {} for an AzooKey {name} dictionary: {error}",
                    char_path.display()
                )
            })?;
            chars
                .chars()
                .enumerate()
                .map(|(index, character)| {
                    u8::try_from(index)
                        .map(|id| (character, id))
                        .map_err(|_| "AzooKey charID.chid has more than 256 characters".to_string())
                })
                .collect::<Result<HashMap<_, _>, _>>()?
        } else {
            inherited_char_ids.clone()
        };
        Ok(Self {
            root: path.to_path_buf(),
            name: name.to_string(),
            content_revision,
            char_ids,
            tsv_entries: None,
        })
    }

    fn lookup_exact(&self, reading: &str) -> Result<Vec<DictionaryEntry>, String> {
        if let Some(entries) = &self.tsv_entries {
            return Ok(entries.iter().filter(|entry| entry.reading == reading).cloned().collect());
        }
        let dictionary_reading = to_katakana(reading);
        let ids = dictionary_reading
            .chars()
            .map(|character| self.char_ids.get(&character).copied())
            .collect::<Option<Vec<_>>>()
            .unwrap_or_default();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let louds = Louds::load_external(&self.root, &self.name)?;
        let Some(node_index) = louds.search_node_index(&ids) else {
            return Ok(Vec::new());
        };
        let shard = node_index >> SHARD_SHIFT;
        let local_index = node_index & LOCAL_MASK;
        let mut entries = read_loudstxt3_entry(
            &self.root.join(format!("{}{}.loudstxt3", self.name, shard)),
            local_index,
        )?;
        if self.name == "user" {
            for entry in &mut entries {
                entry.user_supplied = true;
            }
        }
        Ok(entries)
    }
}

#[derive(Debug, Clone)]
struct Louds {
    bits: Vec<u64>,
    node_ids: Vec<u8>,
    rank_zeros: Vec<usize>,
}

impl Louds {
    fn load(source: &SystemDictionarySource, identifier: &str) -> Result<Self, String> {
        let louds = source.read(&format!("louds/{identifier}.louds"))?;
        let chars = source.read(&format!("louds/{identifier}.loudschars2"))?;
        Self::from_bytes(&louds, &chars)
    }

    fn load_external(root: &Path, identifier: &str) -> Result<Self, String> {
        Self::from_files(
            &root.join(format!("{identifier}.louds")),
            &root.join(format!("{identifier}.loudschars2")),
        )
    }

    fn from_files(louds_path: &Path, chars_path: &Path) -> Result<Self, String> {
        let bytes = fs::read(louds_path)
            .map_err(|error| format!("could not read {}: {error}", louds_path.display()))?;
        let node_ids = fs::read(chars_path)
            .map_err(|error| format!("could not read {}: {error}", chars_path.display()))?;
        Self::from_bytes(&bytes, &node_ids)
    }

    fn from_bytes(bytes: &[u8], node_ids: &[u8]) -> Result<Self, String> {
        if bytes.is_empty() || !bytes.len().is_multiple_of(8) {
            return Err("AzooKey LOUDS data is not a sequence of UInt64 values".to_string());
        }
        let bits = bytes
            .chunks_exact(8)
            .map(|chunk| u64::from_le_bytes(chunk.try_into().expect("chunk is exactly 8 bytes")))
            .collect::<Vec<_>>();
        let node_count = bits.iter().map(|word| 64 - word.count_ones() as usize).sum::<usize>();
        if node_count == 0 || node_count != node_ids.len() {
            return Err("AzooKey LOUDS data does not match its character table".to_string());
        }
        let mut rank_zeros = Vec::with_capacity(bits.len() + 1);
        rank_zeros.push(0);
        for word in &bits {
            let next =
                rank_zeros.last().copied().unwrap_or_default() + 64 - word.count_ones() as usize;
            rank_zeros.push(next);
        }
        Ok(Self { bits, node_ids: node_ids.to_vec(), rank_zeros })
    }

    fn child_node_indices(&self, parent: usize) -> Range<usize> {
        if self.bits.is_empty() || parent == 0 {
            return 0..0;
        }
        let mut left = parent >> 6;
        let mut right = self.rank_zeros.len() - 1;
        while left <= right {
            let mid = (left + right) / 2;
            if self.rank_zeros[mid] >= parent {
                if mid == 0 {
                    break;
                }
                right = mid - 1;
            } else {
                left = mid + 1;
            }
        }
        if left == 0 || left >= self.rank_zeros.len() {
            return 0..0;
        }
        let index = left - 1;
        let word = self.bits[index];
        let required = parent.saturating_sub(self.rank_zeros[index]);
        let mut bit_offset = 0usize;
        for _ in 0..required {
            bit_offset =
                (!word.wrapping_shl(bit_offset as u32)).leading_zeros() as usize + bit_offset + 1;
        }
        let start = (index << 6) + bit_offset - parent + 1;
        let end = if self.rank_zeros[index + 1] == parent {
            let mut next = index + 1;
            while next < self.bits.len() && self.bits[next] == u64::MAX {
                next += 1;
            }
            if next == self.bits.len() {
                self.node_ids.len()
            } else {
                let offset = (!self.bits[next]).leading_zeros() as usize % 64;
                (next << 6) + offset - parent + 1
            }
        } else {
            let offset = ((!word.wrapping_shl(bit_offset as u32)).leading_zeros() as usize
                + bit_offset)
                % 64;
            (index << 6) + offset - parent + 1
        };
        start.min(self.node_ids.len())..end.min(self.node_ids.len())
    }

    fn search_node_index(&self, chars: &[u8]) -> Option<usize> {
        let mut node_index = 1usize;
        for character in chars {
            node_index = self
                .child_node_indices(node_index)
                .find(|index| self.node_ids.get(*index) == Some(character))?;
        }
        Some(node_index)
    }
}

fn parse_tsv(path: &Path, user_supplied: bool) -> Result<Vec<DictionaryEntry>, String> {
    let body = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let entries = body
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            (!line.is_empty() && !line.starts_with('#')).then_some(line)
        })
        .filter_map(|line| {
            let columns = line.split('\t').collect::<Vec<_>>();
            let reading = columns.first()?.trim();
            let surface = columns.get(1)?.trim();
            (!reading.is_empty() && !surface.is_empty()).then(|| DictionaryEntry {
                reading: to_hiragana(reading),
                surface: surface.to_string(),
                value: columns.get(2).and_then(|value| value.parse().ok()).unwrap_or(
                    if user_supplied {
                        DEFAULT_USER_TSV_ENTRY_VALUE
                    } else {
                        DEFAULT_TSV_ENTRY_VALUE
                    },
                ),
                lcid: columns.get(3).and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_CID),
                rcid: columns.get(4).and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_CID),
                mid: columns.get(5).and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_MID),
                raw_ruby_identity: false,
                user_supplied,
            })
        })
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return Err(format!("{} did not contain any usable dictionary entries", path.display()));
    }
    Ok(entries)
}

fn read_loudstxt3_entry(path: &Path, index: usize) -> Result<Vec<DictionaryEntry>, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("could not read {}: {error}", path.display()))?;
    read_loudstxt3_entry_bytes(&bytes, index)
}

fn read_loudstxt3_entry_bytes(bytes: &[u8], index: usize) -> Result<Vec<DictionaryEntry>, String> {
    let record_count = read_u16(bytes, 0)? as usize;
    if index >= record_count {
        return Ok(Vec::new());
    }
    let start = read_u32(bytes, LOUDSTXT3_COUNT_BYTES + index * LOUDSTXT3_OFFSET_BYTES)? as usize;
    let end = if index + 1 == record_count {
        bytes.len()
    } else {
        read_u32(bytes, LOUDSTXT3_COUNT_BYTES + (index + 1) * LOUDSTXT3_OFFSET_BYTES)? as usize
    };
    if start > end || end > bytes.len() {
        return Err("AzooKey loudstxt3 data contains an invalid offset".to_string());
    }
    parse_loudstxt3_record(&bytes[start..end])
}

fn parse_loudstxt3_record(bytes: &[u8]) -> Result<Vec<DictionaryEntry>, String> {
    if bytes.len() > PORTABLE_MAX_LOUDSTXT3_RECORD_BYTES {
        return Err("AzooKey loudstxt3 record exceeds the maximum size".to_string());
    }
    let count = read_u16(bytes, 0)? as usize;
    if count > PORTABLE_MAX_LOUDSTXT3_RECORD_ENTRIES {
        return Err("AzooKey loudstxt3 record has too many entries".to_string());
    }
    let header_end = LOUDSTXT3_COUNT_BYTES + count * LOUDSTXT3_ENTRY_BYTES;
    if bytes.len() < header_end {
        return Err("loudstxt3 record is shorter than its fixed entry header".to_string());
    }
    let fields = String::from_utf8_lossy(&bytes[header_end..]);
    let mut fields = fields.split('\t');
    // Keep the serialized ruby for the identity-surface fallback below.
    // The converter indexes readings in hiragana, but upstream uses the raw
    // ruby when a loudstxt3 row omits its surface (notably for katakana rows).
    // Normalizing first silently turns `トウキョウ` into `とうきょう`, which
    // is then rejected by the full-conversion quality filter and loses the
    // usable identity candidate entirely.
    let raw_reading = fields.next().unwrap_or_default().to_string();
    let reading = to_hiragana(&raw_reading);
    let repeated_reading_bytes = count
        .checked_mul(reading.len())
        .and_then(|bytes| bytes.checked_mul(2))
        .ok_or_else(|| "AzooKey loudstxt3 entry expansion overflows".to_string())?;
    let entry_bytes = count
        .checked_mul(std::mem::size_of::<DictionaryEntry>())
        .ok_or_else(|| "AzooKey loudstxt3 entry expansion overflows".to_string())?;
    let estimated_expansion = repeated_reading_bytes
        .checked_add(entry_bytes)
        .and_then(|estimate| estimate.checked_add(bytes.len() - header_end))
        .ok_or_else(|| "AzooKey loudstxt3 entry expansion overflows".to_string())?;
    if estimated_expansion > LOUDSTXT3_ENTRY_EXPANSION_BUDGET_BYTES {
        return Err("AzooKey loudstxt3 entry expansion exceeds the memory budget".to_string());
    }
    let mut entries = Vec::with_capacity(count);
    for index in 0..count {
        let base = LOUDSTXT3_COUNT_BYTES + index * LOUDSTXT3_ENTRY_BYTES;
        let serialized_surface = fields.next().unwrap_or_default();
        let raw_ruby_identity = serialized_surface.is_empty() && raw_reading != reading;
        let surface = if !serialized_surface.is_empty() {
            serialized_surface.to_string()
        } else {
            raw_reading.clone()
        };
        entries.push(DictionaryEntry {
            reading: reading.clone(),
            surface,
            lcid: read_u16(bytes, base)?,
            rcid: read_u16(bytes, base + U16_BYTES)?,
            mid: read_u16(bytes, base + U16_BYTES * 2)?,
            raw_ruby_identity,
            user_supplied: false,
            value: read_f32(bytes, base + LOUDSTXT3_VALUE_OFFSET)?,
        });
    }
    Ok(entries)
}

fn read_cc_line_bytes(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if !bytes.len().is_multiple_of(CID_RECORD_BYTES) || bytes.is_empty() {
        return Err("data is not an AzooKey CID connection-cost file".to_string());
    }
    let mut line = vec![DEFAULT_CONNECTION_COST; CID_COUNT];
    for (index, pair) in bytes.chunks_exact(CID_RECORD_BYTES).enumerate() {
        let cid = i32::from_le_bytes(
            pair[..FLOAT32_BYTES].try_into().expect("CID record prefix is 4 bytes"),
        );
        let value = f32::from_le_bytes(
            pair[FLOAT32_BYTES..].try_into().expect("CID record suffix is 4 bytes"),
        );
        if !(CID_DEFAULT_RECORD..CID_COUNT as i32).contains(&cid) {
            return Err("AzooKey CID data contains an invalid class ID".to_string());
        }
        if !value.is_finite() {
            return Err("AzooKey CID data contains a non-finite connection cost".to_string());
        }
        if index == 0 && cid != CID_DEFAULT_RECORD {
            return Err("AzooKey CID data has no default record".to_string());
        }
        if cid == CID_DEFAULT_RECORD {
            line.fill(value);
        } else if let Some(slot) = line.get_mut(cid as usize) {
            *slot = value;
        }
    }
    Ok(line)
}

fn read_f32_bytes(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if !bytes.len().is_multiple_of(FLOAT32_BYTES) {
        return Err("data is not a Float32 file".to_string());
    }
    Ok(bytes
        .chunks_exact(FLOAT32_BYTES)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("chunk is exactly 4 bytes")))
        .collect())
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    bytes
        .get(offset..offset + U16_BYTES)
        .and_then(|chunk| chunk.try_into().ok())
        .map(u16::from_le_bytes)
        .ok_or_else(|| "unexpected end of an AzooKey binary dictionary file".to_string())
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    bytes
        .get(offset..offset + U32_BYTES)
        .and_then(|chunk| chunk.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| "unexpected end of an AzooKey binary dictionary file".to_string())
}

fn read_f32(bytes: &[u8], offset: usize) -> Result<f32, String> {
    bytes
        .get(offset..offset + FLOAT32_BYTES)
        .and_then(|chunk| chunk.try_into().ok())
        .map(f32::from_le_bytes)
        .ok_or_else(|| "unexpected end of an AzooKey binary dictionary file".to_string())
}

fn escaped_identifier(input: &str) -> String {
    match input {
        "user" | "memory" | "user_shortcuts" => input.to_string(),
        _ => format!(
            "[{}]",
            input.encode_utf16().map(|unit| format!("{unit:04X}")).collect::<Vec<_>>().join("_")
        ),
    }
}

fn builtin_entries() -> Vec<DictionaryEntry> {
    // Compact high-frequency caption lexicon so azookey-rust is useful without
    // shipping the multi-hundred-MB upstream LOUDS dictionary. Values follow
    // AzooKey's log-probability convention (higher / less negative wins).
    [
        // Greetings / set phrases
        ("ありがとう", "ありがとう"),
        ("ありがとうございます", "ありがとうございます"),
        ("こんにちは", "こんにちは"),
        ("こんばんは", "こんばんは"),
        ("おはよう", "おはよう"),
        ("おはようございます", "おはようございます"),
        ("さようなら", "さようなら"),
        ("すみません", "すみません"),
        ("おねがい", "お願い"),
        ("おねがいします", "お願いします"),
        ("よろしくおねがいします", "よろしくお願いします"),
        ("おつかれさま", "お疲れ様"),
        ("おつかれさまです", "お疲れ様です"),
        ("おめでとう", "おめでとう"),
        ("おだいじに", "お大事に"),
        ("だいじょうぶ", "大丈夫"),
        ("ほんとう", "本当"),
        ("ほんと", "本当"),
        ("ほんとうに", "本当に"),
        ("たしかに", "確かに"),
        ("たぶん", "多分"),
        ("ぜんぜん", "全然"),
        ("たいへん", "大変"),
        ("だいじ", "大事"),
        // Time / calendar
        ("きょう", "今日"),
        ("あした", "明日"),
        ("あす", "明日"),
        ("きのう", "昨日"),
        ("ほんじつ", "本日"),
        ("こんしゅう", "今週"),
        ("せんしゅう", "先週"),
        ("らいしゅう", "来週"),
        ("こんげつ", "今月"),
        ("せんげつ", "先月"),
        ("らいげつ", "来月"),
        ("ことし", "今年"),
        ("きょねん", "去年"),
        ("らいねん", "来年"),
        ("いま", "今"),
        ("じかん", "時間"),
        ("じこく", "時刻"),
        ("よてい", "予定"),
        ("やくそく", "約束"),
        ("ふん", "分"),
        ("びょう", "秒"),
        ("しゅう", "週"),
        ("げつよう", "月曜"),
        ("かよう", "火曜"),
        ("すいよう", "水曜"),
        ("もくよう", "木曜"),
        ("きんよう", "金曜"),
        ("どよう", "土曜"),
        ("にちよう", "日曜"),
        // Speech / streaming domain
        ("はいしん", "配信"),
        ("おんせい", "音声"),
        ("おんがく", "音楽"),
        ("どうが", "動画"),
        ("がぞう", "画像"),
        ("じまく", "字幕"),
        ("ほんやく", "翻訳"),
        ("へんかん", "変換"),
        ("にんしき", "認識"),
        ("にゅうりょく", "入力"),
        ("しゅつりょく", "出力"),
        ("せってい", "設定"),
        ("ひょうじ", "表示"),
        ("かいし", "開始"),
        ("しゅうりょう", "終了"),
        ("ていし", "停止"),
        ("さいかい", "再開"),
        ("かくにん", "確認"),
        ("へんこう", "変更"),
        ("せつめい", "説明"),
        ("じょうほう", "情報"),
        ("ないよう", "内容"),
        ("もんだい", "問題"),
        ("しつもん", "質問"),
        ("かいとう", "回答"),
        ("こたえ", "答え"),
        ("いく", "行く"),
        ("いきます", "行きます"),
        ("ねん", "年"),
        ("おつかれさまでした", "お疲れ様でした"),
        ("りゆう", "理由"),
        ("ほうほう", "方法"),
        ("けっか", "結果"),
        ("げんいん", "原因"),
        ("かいけつ", "解決"),
        ("かいぜん", "改善"),
        ("たいおう", "対応"),
        ("せいこう", "成功"),
        ("しっぱい", "失敗"),
        ("けんしょう", "検証"),
        ("じょうたい", "状態"),
        ("しょり", "処理"),
        ("どうさ", "動作"),
        ("じっこう", "実行"),
        ("じどう", "自動"),
        ("きどう", "起動"),
        ("さいきどう", "再起動"),
        ("せつぞく", "接続"),
        ("せいじょう", "正常"),
        ("いじょう", "異常"),
        ("しんちょく", "進捗"),
        ("じゅんび", "準備"),
        ("かんり", "管理"),
        ("ほうこく", "報告"),
        ("しゅうせい", "修正"),
        ("かんりょう", "完了"),
        ("きろく", "記録"),
        ("りよう", "利用"),
        ("かいぎ", "会議"),
        ("しごと", "仕事"),
        ("かいしゃ", "会社"),
        ("がっこう", "学校"),
        ("がくせい", "学生"),
        ("せんせい", "先生"),
        // Language / locale
        ("にほん", "日本"),
        ("にほんご", "日本語"),
        ("かんじ", "漢字"),
        ("えいご", "英語"),
        ("ちゅうごくご", "中国語"),
        ("かんこくご", "韓国語"),
        ("せかい", "世界"),
        ("とうきょう", "東京"),
        ("おおさか", "大阪"),
        // Pronouns / deixis
        ("わたし", "私"),
        ("わたしたち", "私たち"),
        ("ぼく", "僕"),
        ("かれ", "彼"),
        ("かのじょ", "彼女"),
        ("みんな", "みんな"),
        ("みなさん", "皆さん"),
        ("じぶん", "自分"),
        ("あいて", "相手"),
        ("ともだち", "友達"),
        ("かぞく", "家族"),
        ("こども", "子供"),
        ("おとな", "大人"),
        ("ひとびと", "人々"),
        ("これ", "これ"),
        ("それ", "それ"),
        ("あれ", "あれ"),
        ("この", "この"),
        ("その", "その"),
        ("あの", "あの"),
        // Common predicates / adjectives (caption glue)
        ("です", "です"),
        ("ます", "ます"),
        ("でした", "でした"),
        ("ました", "ました"),
        ("します", "します"),
        ("する", "する"),
        ("した", "した"),
        ("なる", "なる"),
        ("ある", "ある"),
        ("いる", "いる"),
        ("できる", "できる"),
        ("わかる", "分かる"),
        ("わからない", "分からない"),
        ("おもう", "思う"),
        ("かんがえる", "考える"),
        ("おしえる", "教える"),
        ("おぼえる", "覚える"),
        ("わすれる", "忘れる"),
        ("しらべる", "調べる"),
        ("はじめる", "始める"),
        ("おわる", "終わる"),
        ("つづける", "続ける"),
        ("つづく", "続く"),
        ("なおす", "直す"),
        ("なおる", "直る"),
        ("つたえる", "伝える"),
        ("つながる", "繋がる"),
        ("うごく", "動く"),
        ("はなす", "話す"),
        ("きく", "聞く"),
        ("みる", "見る"),
        ("いく", "行く"),
        ("くる", "来る"),
        ("つかう", "使う"),
        ("つくる", "作る"),
        ("よい", "良い"),
        ("いい", "いい"),
        ("わるい", "悪い"),
        ("おおきい", "大きい"),
        ("ちいさい", "小さい"),
        ("あたらしい", "新しい"),
        ("おもしろい", "面白い"),
        ("むずかしい", "難しい"),
        ("やさしい", "優しい"),
        ("たのしい", "楽しい"),
        ("うれしい", "嬉しい"),
        ("かなしい", "悲しい"),
        ("ただしい", "正しい"),
        ("おなじ", "同じ"),
        ("かんたん", "簡単"),
        ("あんぜん", "安全"),
        ("きけん", "危険"),
        ("きもち", "気持ち"),
        ("こころ", "心"),
        ("ことば", "言葉"),
        ("いみ", "意味"),
        ("いけん", "意見"),
        ("もじ", "文字"),
        ("たんご", "単語"),
        ("ぶんしょう", "文章"),
        ("ぶんせき", "分析"),
        ("たいせつ", "大切"),
        ("じゅうよう", "重要"),
        ("ひつよう", "必要"),
        ("かのう", "可能"),
        ("さいきん", "最近"),
        ("はじめて", "初めて"),
        ("つぎ", "次"),
        ("まえ", "前"),
        ("あと", "後"),
        ("さいご", "最後"),
        ("さいしょ", "最初"),
        // Weather / everyday
        ("てんき", "天気"),
        ("あめ", "雨"),
        ("はれ", "晴れ"),
        ("くもり", "曇り"),
        // Audio / display controls
        ("おんりょう", "音量"),
        ("ちょうせい", "調整"),
        ("ろくおん", "録音"),
        ("しゅうろく", "収録"),
        ("さいせい", "再生"),
        ("ざつおん", "雑音"),
        ("がめん", "画面"),
        ("せんたく", "選択"),
        ("けってい", "決定"),
        ("ほぞん", "保存"),
        ("けんさく", "検索"),
        ("いちらん", "一覧"),
        ("がいよう", "概要"),
        ("きのう", "機能"),
        ("せいのう", "性能"),
        ("せいげん", "制限"),
        // Loanwords common in ASR captions
        ("てすと", "テスト"),
        ("しすてむ", "システム"),
        ("もでる", "モデル"),
        ("あぷり", "アプリ"),
        ("さーばー", "サーバー"),
        ("ねっとわーく", "ネットワーク"),
        ("えらー", "エラー"),
        ("ろぐ", "ログ"),
        ("でーた", "データ"),
        ("ぷろぐらむ", "プログラム"),
        ("そふとうぇあ", "ソフトウェア"),
        ("はーどうぇあ", "ハードウェア"),
        ("あかうんと", "アカウント"),
        ("ぱすわーど", "パスワード"),
        ("ぶらうざ", "ブラウザ"),
        ("うぇぶ", "ウェブ"),
        ("すまーとふぉん", "スマートフォン"),
        ("こーど", "コード"),
        ("ぷろじぇくと", "プロジェクト"),
        ("ふぁいる", "ファイル"),
        ("ふぉるだ", "フォルダ"),
        ("きーぼーど", "キーボード"),
        ("りんく", "リンク"),
        ("ぼたん", "ボタン"),
        ("めにゅー", "メニュー"),
        ("たぶ", "タブ"),
        ("ういんどう", "ウィンドウ"),
        ("えんじん", "エンジン"),
        ("さーびす", "サービス"),
        ("せきゅりてぃ", "セキュリティ"),
        ("ぷらいばしー", "プライバシー"),
        ("ばーじょん", "バージョン"),
        ("あっぷでーと", "アップデート"),
        ("いんすとーる", "インストール"),
        ("だうんろーど", "ダウンロード"),
        ("ろぐいん", "ログイン"),
        ("ろぐあうと", "ログアウト"),
        ("せっしょん", "セッション"),
        ("りくえすと", "リクエスト"),
        ("れすぽんす", "レスポンス"),
    ]
    .into_iter()
    .map(|(reading, surface)| {
        // A few high-frequency homophones are deliberately given a stronger
        // compact-lexicon prior. The upstream LOUDS dictionary has several
        // context-dependent entries for these readings; without its complete
        // clause lattice they can otherwise win with an unrelated surface
        // (`かんじ` -> `感じ`, `ねん` -> `煉ん`).
        let value = match (reading, surface) {
            ("かんじ", _)
            | ("いく", _)
            | ("いきます", _)
            | ("ねん", _)
            | ("おつかれさまでした", _) => BUILTIN_HIGH_FREQUENCY_VALUE,
            _ => BUILTIN_DEFAULT_VALUE,
        };
        DictionaryEntry::plain(reading, surface, value)
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        escaped_identifier, filesystem_dictionary_content_revision, filter_system_entries,
        is_postposition_cid, parse_loudstxt3_record, prediction_usable_rcid,
        system_entry_is_usable, word_type, AzooKeyDictionary, DictionaryEntry, DictionaryPaths,
        WordType, BOS_CID, COMPETITIVE_CONVERTED_VALUE_MARGIN, EOS_CID, MID_COUNT,
        PORTABLE_DICTIONARY_MAGIC,
    };

    #[test]
    fn filesystem_revision_tracks_same_path_same_size_content_changes() {
        let suffix = format!(
            "caption-bridge-revision-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        );
        let root = std::env::temp_dir().join(suffix);
        std::fs::create_dir_all(root.join("louds")).expect("fixture directory should be created");
        let file = root.join("louds").join("user.loudstxt3");
        std::fs::write(&file, b"alpha").expect("first fixture should write");
        let first = filesystem_dictionary_content_revision(&root).expect("first revision");

        std::fs::write(&file, b"omega").expect("same-size replacement should write");
        let changed = filesystem_dictionary_content_revision(&root).expect("changed revision");
        assert_ne!(first, changed);

        std::fs::write(&file, b"alpha").expect("original content should write again");
        let restored = filesystem_dictionary_content_revision(&root).expect("restored revision");
        assert_eq!(first, restored);

        std::fs::remove_dir_all(root).expect("fixture directory should be removed");
    }

    #[test]
    fn dictionary_revision_changes_after_same_size_custom_dictionary_rewrite() {
        let suffix = format!(
            "caption-bridge-custom-revision-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        );
        let path = std::env::temp_dir().join(format!("{suffix}.tsv"));
        std::fs::write(&path, "かな\t仮名\n").expect("first custom dictionary should write");
        let first = AzooKeyDictionary::from_paths(&DictionaryPaths {
            user: Some(path.clone()),
            ..DictionaryPaths::default()
        })
        .expect("first custom dictionary should load")
        .revision();

        std::fs::write(&path, "かな\t加奈\n").expect("same-size custom dictionary should write");
        let changed = AzooKeyDictionary::from_paths(&DictionaryPaths {
            user: Some(path.clone()),
            ..DictionaryPaths::default()
        })
        .expect("changed custom dictionary should load")
        .revision();
        assert_ne!(first, changed);

        std::fs::write(&path, "かな\t仮名\n").expect("original custom dictionary should write");
        let restored = AzooKeyDictionary::from_paths(&DictionaryPaths {
            user: Some(path.clone()),
            ..DictionaryPaths::default()
        })
        .expect("restored custom dictionary should load")
        .revision();
        assert_eq!(first, restored);

        std::fs::remove_file(path).expect("custom dictionary fixture should be removed");
    }

    #[test]
    fn reloading_after_custom_edit_starts_with_a_fresh_entry_cache() {
        let suffix = format!(
            "caption-bridge-entry-cache-reload-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        );
        let user = std::env::temp_dir().join(format!("{suffix}.tsv"));
        std::fs::write(&user, "かすたむてすと\t変更前\n")
            .expect("first custom dictionary should write");
        let paths = DictionaryPaths {
            system: Some(super::test_system_dictionary_path()),
            user: Some(user.clone()),
            ..DictionaryPaths::default()
        };
        let first = AzooKeyDictionary::from_paths(&paths).expect("first dictionary should load");
        assert!(!first.lookup_exact("かんじ").expect("system lookup should work").is_empty());
        assert!(
            !first
                .system
                .as_ref()
                .expect("system dictionary should exist")
                .entry_cache
                .borrow()
                .indices
                .is_empty(),
            "first dictionary should have a warmed entry cache"
        );
        assert!(first
            .lookup_exact("かすたむてすと")
            .expect("first custom lookup should work")
            .iter()
            .any(|entry| entry.surface == "変更前"));

        std::fs::write(&user, "かすたむてすと\t変更後\n")
            .expect("same-size custom dictionary replacement should write");
        // Desktop invalidation drops the complete AzooKeyDictionary. Rebuilding
        // it creates both a new content revision and a new empty system cache;
        // cache entries never cross the reload boundary.
        let reloaded =
            AzooKeyDictionary::from_paths(&paths).expect("updated dictionary should reload");
        assert_ne!(first.revision(), reloaded.revision());
        assert!(
            reloaded
                .system
                .as_ref()
                .expect("system dictionary should exist")
                .entry_cache
                .borrow()
                .indices
                .is_empty(),
            "reloaded dictionary must not retain the previous entry cache"
        );
        assert!(reloaded
            .lookup_exact("かすたむてすと")
            .expect("updated custom lookup should work")
            .iter()
            .any(|entry| entry.surface == "変更後"));

        std::fs::remove_file(user).expect("custom dictionary fixture should be removed");
    }

    #[test]
    fn preserves_the_upstream_shard_escaping() {
        assert_eq!(escaped_identifier("あ"), "[3042]");
        assert_eq!(escaped_identifier("🇯🇵"), "[D83C_DDEF_D83C_DDF5]");
    }

    #[test]
    fn parses_upstream_loudstxt3_record_layout() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&1285u16.to_le_bytes());
        bytes.extend_from_slice(&1285u16.to_le_bytes());
        bytes.extend_from_slice(&501u16.to_le_bytes());
        bytes.extend_from_slice(&(-3.0f32).to_le_bytes());
        bytes.extend_from_slice(&1288u16.to_le_bytes());
        bytes.extend_from_slice(&1288u16.to_le_bytes());
        bytes.extend_from_slice(&344u16.to_le_bytes());
        bytes.extend_from_slice(&(-4.0f32).to_le_bytes());
        bytes.extend_from_slice("とうきょう\t東京\t".as_bytes());

        assert_eq!(
            parse_loudstxt3_record(&bytes).expect("record should parse"),
            vec![
                DictionaryEntry {
                    reading: "とうきょう".into(),
                    surface: "東京".into(),
                    lcid: 1285,
                    rcid: 1285,
                    mid: 501,
                    raw_ruby_identity: false,
                    user_supplied: false,
                    value: -3.0
                },
                DictionaryEntry {
                    reading: "とうきょう".into(),
                    surface: "とうきょう".into(),
                    lcid: 1288,
                    rcid: 1288,
                    mid: 344,
                    raw_ruby_identity: false,
                    user_supplied: false,
                    value: -4.0
                },
            ]
        );
    }

    #[test]
    fn preserves_raw_katakana_ruby_for_missing_surface() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1285u16.to_le_bytes());
        bytes.extend_from_slice(&1285u16.to_le_bytes());
        bytes.extend_from_slice(&501u16.to_le_bytes());
        bytes.extend_from_slice(&(-3.0f32).to_le_bytes());
        bytes.extend_from_slice("トウキョウ\t".as_bytes());

        let entries = parse_loudstxt3_record(&bytes).expect("record should parse");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].reading, "とうきょう");
        assert_eq!(entries[0].surface, "トウキョウ");
        assert!(entries[0].raw_ruby_identity);
    }

    #[test]
    fn applies_upstream_full_conversion_quality_threshold_to_system_entries() {
        let one_kana = DictionaryEntry::plain("あ", "亜", -15.0);
        let short = DictionaryEntry::plain("とう", "当", -16.0);
        let short_placeholder = DictionaryEntry::plain("とう", "沼", -16.34);
        let long = DictionaryEntry::plain("とうきょう", "東京", -16.5);
        let long_placeholder = DictionaryEntry::plain("とうきょう", "沼今日", -16.7);
        let particle_identity = DictionaryEntry::plain("は", "は", -1.0);
        let hiragana_identity = DictionaryEntry::plain("てすと", "てすと", -1.0);
        let katakana_surface = DictionaryEntry::plain("てすと", "テスト", -1.0);
        let mut contraction = DictionaryEntry::plain("へいき", "平気", -1.0);
        contraction.rcid = 17;
        let mut inflection_tail = DictionaryEntry::plain("ねん", "煉ん", -1.0);
        inflection_tail.rcid = 782;
        assert!(system_entry_is_usable(&one_kana));
        assert!(system_entry_is_usable(&particle_identity));
        assert!(system_entry_is_usable(&short));
        assert!(!system_entry_is_usable(&short_placeholder));
        assert!(system_entry_is_usable(&long));
        assert!(!system_entry_is_usable(&long_placeholder));
        assert!(!system_entry_is_usable(&hiragana_identity));
        assert!(system_entry_is_usable(&katakana_surface));
        assert!(system_entry_is_usable(&contraction));
        assert!(system_entry_is_usable(&inflection_tail));
    }

    #[test]
    fn restores_multi_kana_identity_when_only_rare_kanji_exists() {
        // Sibling rule: rare-only kanji sibling ⇒ identity kept.
        let rare_kanji = DictionaryEntry::plain("とても", "迚も", -15.1);
        let identity = DictionaryEntry::plain("とても", "とても", -5.8);
        let filtered = filter_system_entries(vec![rare_kanji.clone(), identity.clone()]);
        assert!(
            filtered.iter().any(|entry| entry.surface == "とても"),
            "rare-only kanji must not suppress the common kana identity"
        );
        assert!(
            filtered.iter().any(|entry| entry.surface == "迚も"),
            "rare kanji remains available as an n-best alternative"
        );
        // A converted sibling that trails the best identity by more than the
        // relative margin remains rare.
        let near_floor_rare = DictionaryEntry::plain(
            "とても",
            "迚も",
            identity.value - COMPETITIVE_CONVERTED_VALUE_MARGIN - 0.01,
        );
        let filtered_near = filter_system_entries(vec![near_floor_rare, identity.clone()]);
        assert!(
            filtered_near.iter().any(|entry| entry.surface == "とても"),
            "kanji just below the competitive floor must keep identity"
        );
    }

    #[test]
    fn suppresses_multi_kana_identity_when_competitive_kanji_exists() {
        // Sibling rule: a competitive kanji sibling (within the relative margin)
        // suppresses the identity row.
        let common_kanji = DictionaryEntry::plain("とうきょう", "東京", -1.5);
        let identity = DictionaryEntry::plain("とうきょう", "とうきょう", -2.0);
        let filtered = filter_system_entries(vec![common_kanji.clone(), identity.clone()]);
        assert!(filtered.iter().any(|entry| entry.surface == "東京"), "common kanji must remain");
        assert!(
            filtered.iter().all(|entry| entry.surface != "とうきょう"),
            "multi-kana identity must stay suppressed when a competitive kanji exists"
        );
        // A converted sibling within the relative margin is competitive.
        let at_margin = DictionaryEntry::plain(
            "とうきょう",
            "東京",
            identity.value - COMPETITIVE_CONVERTED_VALUE_MARGIN,
        );
        let filtered_floor = filter_system_entries(vec![at_margin, identity]);
        assert!(
            filtered_floor.iter().all(|entry| entry.surface != "とうきょう"),
            "kanji at the competitive floor must suppress multi-kana identity"
        );
    }

    #[test]
    fn restores_identity_for_a_preferred_morphology_metadata_sibling() {
        let mut identity = DictionaryEntry::plain("いただきます", "いただきます", -9.0);
        identity.lcid = 981;
        identity.rcid = 491;
        identity.mid = 17;
        let mut kanji = identity.clone();
        kanji.surface = "頂きます".into();
        kanji.value = -9.5;

        let filtered = filter_system_entries(vec![identity.clone(), kanji.clone()]);
        assert!(
            filtered.iter().any(|entry| entry.surface == identity.surface),
            "a better-valued identity row with matching morphology must survive"
        );

        kanji.value = -8.5;
        let filtered_with_better_kanji = filter_system_entries(vec![identity, kanji]);
        assert!(
            filtered_with_better_kanji.iter().all(|entry| entry.surface != "いただきます"),
            "identity must remain suppressed when its matching Kanji sibling is better"
        );
    }

    #[test]
    fn suppresses_multi_kana_identity_when_competitive_katakana_exists() {
        let mut loanword = DictionaryEntry::plain("すーぷ", "スープ", -9.9);
        loanword.raw_ruby_identity = true;
        let identity = DictionaryEntry::plain("すーぷ", "すーぷ", -15.0);
        let filtered = filter_system_entries(vec![loanword.clone(), identity]);
        assert!(filtered.iter().any(|entry| entry.surface == "スープ"));
        assert!(
            filtered.iter().all(|entry| entry.surface != "すーぷ"),
            "katakana loanword rows must suppress multi-kana hiragana identity"
        );
    }

    #[test]
    fn public_dictionary_keeps_totemo_identity_against_rare_kanji() {
        let root = super::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load")
        .without_builtin_entries_for_test();
        let entries = dictionary.lookup_exact("とても").expect("lookup should complete");
        assert!(
            entries.iter().any(|entry| entry.surface == "とても"),
            "public dictionary must expose the kana identity for とても; got {entries:?}"
        );
        assert!(
            entries.iter().any(|entry| entry.surface == "迚も"),
            "rare 迚も should remain available; got {entries:?}"
        );
    }

    #[test]
    fn keeps_upstream_cid_metadata_classes_stable() {
        // These are morphology/model classes, not readings or surface words.
        // Keeping the boundaries explicit protects clause and MM scoring when
        // the dictionary format is refreshed.
        assert_eq!(word_type(BOS_CID), WordType::Boundary);
        assert_eq!(word_type(6), WordType::Preposition);
        // Residual Postposition class still includes pre-joshi gaps, but the
        // prune predicate must stay on the narrow joshi/jodoushi bands only.
        assert_eq!(word_type(54), WordType::Postposition);
        assert!(!is_postposition_cid(54));
        assert!(!super::is_joshi_cid(54));
        assert!(is_postposition_cid(147));
        assert!(is_postposition_cid(368));
        assert!(super::is_joshi_cid(368));
        assert!(is_postposition_cid(369));
        assert!(is_postposition_cid(454));
        assert!(super::is_jodoushi_cid(454));
        assert!(!is_postposition_cid(555));
        assert!(!is_postposition_cid(1285));
        assert!(!is_postposition_cid(1298));
        assert_eq!(word_type(555), WordType::ContentWord);
        assert_eq!(word_type(1315), WordType::Preposition);
        assert_eq!(word_type(EOS_CID), WordType::Boundary);

        // A few interior values exercise both ends of the upstream
        // prediction-usable table without depending on a particular word.
        assert!(!prediction_usable_rcid(13));
        assert!(!prediction_usable_rcid(561));
        assert!(!prediction_usable_rcid(1278));
        assert!(prediction_usable_rcid(619));
        assert!(prediction_usable_rcid(1285));
    }

    #[test]
    fn reads_the_public_azookey_dictionary_when_configured() {
        let root = super::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("public AzooKey dictionary should load");
        let entries =
            dictionary.lookup_exact("とうきょう").expect("public AzooKey lookup should complete");
        assert!(entries.iter().any(|entry| entry.surface == "東京"));
        let first = entries.first().expect("public dictionary should return at least one entry");
        assert!(dictionary.connection_cost(first, first).is_finite());
        assert!(dictionary.beginning_connection_cost(first).is_finite());
    }

    #[test]
    fn full_lookup_keeps_inflectional_rows_that_prediction_filters_reject() {
        let root = super::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("public AzooKey dictionary should load");
        for (reading, surface) in
            [("おこなわ", "行わ"), ("おもっ", "思っ"), ("まわっ", "回っ"), ("つかっ", "使っ")]
        {
            assert!(
                dictionary
                    .lookup_exact(reading)
                    .expect("full lookup should complete")
                    .iter()
                    .any(|entry| entry.surface == surface),
                "full lookup lost {surface} for {reading}"
            );
        }
    }

    #[test]
    fn compact_fallback_does_not_embed_context_specific_homonym_rows() {
        let dictionary = AzooKeyDictionary::default();
        for reading in ["あつい", "すーぷ", "たべたく", "そと"] {
            assert!(
                dictionary.lookup_exact(reading).expect("lookup should be non-fatal").is_empty(),
                "context-specific row unexpectedly embedded for {reading}"
            );
        }
    }

    #[test]
    fn validates_the_filesystem_free_dictionary_container_without_builtin_fallback() {
        let mm = vec![0; MID_COUNT * MID_COUNT * std::mem::size_of::<f32>()];
        let archive = complete_portable_archive(&mm);
        let dictionary = AzooKeyDictionary::from_portable_system_dictionary(archive.clone())
            .expect("minimal portable system dictionary should load");
        assert!(dictionary.has_system_dictionary());

        // The pinned upstream MM matrix has one trailing Float32 bookkeeping
        // value after the 502×502 cost table; preserve compatibility with it.
        let mut mm_with_trailing_value = mm.clone();
        mm_with_trailing_value.extend_from_slice(&0.0f32.to_le_bytes());
        assert!(AzooKeyDictionary::from_portable_system_dictionary(complete_portable_archive(
            &mm_with_trailing_value,
        ))
        .is_ok());

        // This fixture intentionally has no usable lexical records. Do not
        // use a built-in hit here: that would let a malformed portable source
        // look healthy merely because the compact fallback answered instead.
        assert!(dictionary.lookup_exact("ぬへも").expect("lookup should complete").is_empty());
        assert!(dictionary.lookup_exact("きょう").expect("lookup should complete").is_empty());

        let mut trailing = archive;
        trailing.push(0);
        assert!(AzooKeyDictionary::from_portable_system_dictionary(trailing)
            .expect_err("trailing bytes must be rejected")
            .contains("trailing bytes"));
        let duplicate = portable_archive(&[("mm.binary", &mm), ("mm.binary", &mm)]);
        assert!(AzooKeyDictionary::from_portable_system_dictionary(duplicate)
            .expect_err("duplicate paths must be rejected")
            .contains("duplicate path"));
        let unsafe_path = portable_archive(&[("../mm.binary", &mm)]);
        assert!(AzooKeyDictionary::from_portable_system_dictionary(unsafe_path)
            .expect_err("unsafe paths must be rejected")
            .contains("unsafe path"));
    }

    #[test]
    fn rejects_corrupt_portable_mm_cid_and_louds_components() {
        let mm = vec![0; MID_COUNT * MID_COUNT * std::mem::size_of::<f32>()];

        let mut corrupt_mm = complete_portable_archive(&mm);
        replace_portable_file_data(&mut corrupt_mm, "mm.binary", &f32::NAN.to_le_bytes());
        assert!(AzooKeyDictionary::from_portable_system_dictionary(corrupt_mm)
            .expect_err("non-finite MM data must reject the archive")
            .contains("non-finite"));

        let mut corrupt_cid = complete_portable_archive(&mm);
        let mut invalid_cid = Vec::new();
        invalid_cid.extend_from_slice(&0i32.to_le_bytes());
        invalid_cid.extend_from_slice(&super::DEFAULT_CONNECTION_COST.to_le_bytes());
        replace_portable_file_data(&mut corrupt_cid, "cb/0.binary", &invalid_cid);
        assert!(AzooKeyDictionary::from_portable_system_dictionary(corrupt_cid)
            .expect_err("CID data without its default record must reject the archive")
            .contains("default record"));

        let mut corrupt_louds = complete_portable_archive(&mm);
        replace_portable_file_data(&mut corrupt_louds, "louds/test0.louds", &[0; 8]);
        assert!(AzooKeyDictionary::from_portable_system_dictionary(corrupt_louds)
            .expect_err("LOUDS data inconsistent with its character table must reject the archive")
            .contains("does not match its character table"));
    }

    #[test]
    fn rejects_portable_archives_and_records_that_exceed_resource_bounds() {
        let mut oversized_archive = vec![0; super::PORTABLE_MAX_ARCHIVE_BYTES + 1];
        oversized_archive[..super::PORTABLE_DICTIONARY_MAGIC.len()]
            .copy_from_slice(super::PORTABLE_DICTIONARY_MAGIC);
        assert!(super::PortableFileStore::parse(oversized_archive)
            .expect_err("archive above the raw input limit must be rejected")
            .contains("maximum archive size"));

        let oversized_file = vec![0; super::PORTABLE_MAX_FILE_BYTES + 1];
        assert!(super::PortableFileStore::parse(portable_archive(&[(
            "mm.binary",
            &oversized_file,
        )]))
        .expect_err("member above the per-file limit must be rejected")
        .contains("oversized file"));

        let oversized_record = vec![0; super::PORTABLE_MAX_LOUDSTXT3_RECORD_BYTES + 1];
        assert!(parse_loudstxt3_record(&oversized_record)
            .expect_err("record above the per-record limit must be rejected")
            .contains("maximum size"));

        let too_many_entries =
            (super::PORTABLE_MAX_LOUDSTXT3_RECORD_ENTRIES as u16 + 1).to_le_bytes();
        assert!(parse_loudstxt3_record(&too_many_entries)
            .expect_err("record with too many rows must be rejected")
            .contains("too many entries"));

        // A valid-size record can still make every entry clone one enormous
        // reading (and again for its missing surface). Reject before building
        // the `Vec<DictionaryEntry>` or allocating any of those clones.
        let count = super::PORTABLE_MAX_LOUDSTXT3_RECORD_ENTRIES;
        let header_end = super::LOUDSTXT3_COUNT_BYTES + count * super::LOUDSTXT3_ENTRY_BYTES;
        let mut repeated_reading = vec![b'a'; super::PORTABLE_MAX_LOUDSTXT3_RECORD_BYTES];
        repeated_reading[..super::U16_BYTES].copy_from_slice(&(count as u16).to_le_bytes());
        assert!(header_end < repeated_reading.len());
        assert!(parse_loudstxt3_record(&repeated_reading)
            .expect_err("count times a long reading must stay within the expansion budget")
            .contains("memory budget"));
    }

    #[test]
    fn system_lookup_cache_keeps_bounded_misses_and_evicts_lru() {
        let mut cache = super::SystemEntryCache::default();
        for index in 0..super::SYSTEM_ENTRY_CACHE_MAX_ENTRIES {
            cache.insert(format!("cached-{index}"), Vec::new());
        }
        assert_eq!(cache.indices.len(), super::SYSTEM_ENTRY_CACHE_MAX_ENTRIES);
        assert_eq!(cache.get("cached-0"), Some(Vec::new()));

        cache.insert("newest".to_string(), Vec::new());

        assert_eq!(cache.indices.len(), super::SYSTEM_ENTRY_CACHE_MAX_ENTRIES);
        assert!(cache.indices.contains_key("cached-0"), "recently used miss must remain cached");
        assert!(
            !cache.indices.contains_key("cached-1"),
            "least-recently used miss must be evicted"
        );
        assert!(cache.indices.contains_key("newest"));
    }

    fn portable_archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut archive = PORTABLE_DICTIONARY_MAGIC.to_vec();
        archive.extend_from_slice(&(files.len() as u32).to_le_bytes());
        for (path, data) in files {
            append_portable_file(&mut archive, path, data);
        }
        archive
    }

    fn complete_portable_archive(mm: &[u8]) -> Vec<u8> {
        let file_count = 2
            + super::CID_COUNT
            + super::PORTABLE_LOUDS_FILE_COUNT * 2
            + super::PORTABLE_LOUDS_TEXT_FILE_COUNT;
        let mut archive = PORTABLE_DICTIONARY_MAGIC.to_vec();
        archive.extend_from_slice(&(file_count as u32).to_le_bytes());
        append_portable_file(&mut archive, "louds/charID.chid", "アイ".as_bytes());
        append_portable_file(&mut archive, "mm.binary", mm);
        let mut cid_line = Vec::new();
        cid_line.extend_from_slice(&super::CID_DEFAULT_RECORD.to_le_bytes());
        cid_line.extend_from_slice(&super::DEFAULT_CONNECTION_COST.to_le_bytes());
        for cid in 0..super::CID_COUNT {
            append_portable_file(&mut archive, &format!("cb/{cid}.binary"), &cid_line);
        }
        let louds = (u64::MAX ^ 1).to_le_bytes();
        for index in 0..super::PORTABLE_LOUDS_FILE_COUNT {
            append_portable_file(&mut archive, &format!("louds/test{index}.louds"), &louds);
            append_portable_file(&mut archive, &format!("louds/test{index}.loudschars2"), &[0]);
        }
        for index in 0..super::PORTABLE_LOUDS_TEXT_FILE_COUNT {
            append_portable_file(&mut archive, &format!("louds/text{index}.loudstxt3"), &[]);
        }
        archive
    }

    fn append_portable_file(archive: &mut Vec<u8>, path: &str, data: &[u8]) {
        let path = path.as_bytes();
        archive.extend_from_slice(&(path.len() as u16).to_le_bytes());
        archive.extend_from_slice(&(data.len() as u32).to_le_bytes());
        archive.extend_from_slice(path);
        archive.extend_from_slice(data);
    }

    fn replace_portable_file_data(archive: &mut [u8], target: &str, replacement: &[u8]) {
        let mut offset = super::PORTABLE_DICTIONARY_HEADER_BYTES;
        let file_count = u32::from_le_bytes(
            archive
                [super::PORTABLE_DICTIONARY_MAGIC.len()..super::PORTABLE_DICTIONARY_HEADER_BYTES]
                .try_into()
                .expect("archive header contains file count"),
        ) as usize;
        for _ in 0..file_count {
            let path_length = u16::from_le_bytes(
                archive[offset..offset + super::U16_BYTES]
                    .try_into()
                    .expect("archive file header contains path length"),
            ) as usize;
            let data_length = u32::from_le_bytes(
                archive[offset + super::U16_BYTES..offset + super::PORTABLE_FILE_HEADER_BYTES]
                    .try_into()
                    .expect("archive file header contains data length"),
            ) as usize;
            let path_start = offset + super::PORTABLE_FILE_HEADER_BYTES;
            let data_start = path_start + path_length;
            let data_end = data_start + data_length;
            if &archive[path_start..data_start] == target.as_bytes() {
                assert!(
                    replacement.len() <= data_length,
                    "replacement fits existing archive entry"
                );
                archive[data_start..data_start + replacement.len()].copy_from_slice(replacement);
                return;
            }
            offset = data_end;
        }
        panic!("fixture archive did not contain {target}");
    }

    #[test]
    fn merges_portable_user_and_learning_dictionaries() {
        let suffix = format!(
            "caption-bridge-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        );
        let user = std::env::temp_dir().join(format!("{suffix}-user.tsv"));
        let memory = std::env::temp_dir().join(format!("{suffix}-memory.tsv"));
        std::fs::write(&user, "はいしん\t配信中\nはいしん\t配信弱め\t-6\n")
            .expect("user fixture should write");
        std::fs::write(&memory, "はいしん\t配信メモリ\n").expect("memory fixture should write");

        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            user: Some(user.clone()),
            memory: Some(memory.clone()),
            ..DictionaryPaths::default()
        })
        .expect("portable external dictionaries should load");
        let entries = dictionary.lookup_exact("はいしん").expect("external lookup should complete");
        let default_user = entries
            .iter()
            .find(|entry| entry.surface == "配信中")
            .expect("default user entry should exist");
        assert!(default_user.user_supplied);
        assert_eq!(default_user.value, -1.0);
        let explicit_user = entries
            .iter()
            .find(|entry| entry.surface == "配信弱め")
            .expect("explicit user entry should exist");
        assert!(explicit_user.user_supplied);
        assert_eq!(explicit_user.value, -6.0);
        let memory_entry = entries
            .iter()
            .find(|entry| entry.surface == "配信メモリ")
            .expect("memory entry should exist");
        assert!(!memory_entry.user_supplied);
        assert_eq!(memory_entry.value, -10.0);

        let _ = std::fs::remove_file(user);
        let _ = std::fs::remove_file(memory);
    }
}
