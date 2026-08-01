use super::normalization::{to_hiragana, to_katakana};
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};

// Upstream `DicdataStore.midCount` is 502. MID 501 is the highest current
// index; `MIDData.totalCount` is an enum bookkeeping value, not matrix width.
const MID_COUNT: usize = 502;
const SHARD_SHIFT: usize = 11;
const LOCAL_MASK: usize = (1 << SHARD_SHIFT) - 1;
const DEFAULT_CID: u16 = 1285;
const DEFAULT_MID: u16 = 501;
/// AzooKey keeps BOS/EOS in the neutral meaning class.
const BOS_EOS_MID: u16 = 500;
const EOS_CID: u16 = 1316;
// AzooKey's `DicdataStore` drops low-quality system entries before building
// the lattice. Keeping those placeholder rows (often around -30) lets a
// short, unrelated surface beat a correct longer word in our Viterbi pass.
// The extra length-dependent margin mirrors upstream `shouldBeRemoved`:
// value must be at least `threshold + 2 / ruby_count`.
const SYSTEM_DICTIONARY_VALUE_THRESHOLD: f32 = -17.0;

#[derive(Debug, Clone, PartialEq)]
pub struct DictionaryEntry {
    pub reading: String,
    pub surface: String,
    pub lcid: u16,
    pub rcid: u16,
    pub mid: u16,
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

/// Map a user-supplied path onto the LOUDS dictionary root when possible.
///
/// Accepts:
/// - a TSV file
/// - `.../Dictionary` (contains `louds/charID.chid`)
/// - `.../azooKey_dictionary_storage` (auto-selects `Dictionary/`)
pub fn resolve_system_dictionary_root(path: &Path) -> PathBuf {
    if path.is_file() || system_dictionary_present(path) {
        return path.to_path_buf();
    }
    let nested = path.join("Dictionary");
    if system_dictionary_present(&nested) {
        return nested;
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
                dictionary.static_entries.extend(parse_tsv(path)?);
            } else if system_dictionary_present(path) {
                dictionary.system = Some(SystemDictionary::load(path)?);
            }
            // Missing/incomplete system path: keep the built-in lexicon instead
            // of failing the whole conversion (which previously looked like a
            // no-op when callers swallowed the error, or broke captions hard).
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
        for finish in (start + 1)..=end {
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
            .unwrap_or(0.0)
    }

    /// Return the content-word bigram cost used by AzooKey's clause scorer.
    /// Keeping this separate from CID transitions prevents a frequent
    /// homophone from winning merely because it was split into extra words.
    pub fn meaning_connection_cost(&self, former_mid: u16, latter_mid: u16) -> f32 {
        self.system
            .as_ref()
            .map(|system| system.meaning_connection_cost(former_mid, latter_mid))
            .unwrap_or(0.0)
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
            .and_then(|system| system.cid_connection_cost(0, entry.lcid).ok())
            .unwrap_or(0.0)
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

    pub(crate) fn has_system_dictionary(&self) -> bool {
        self.system.is_some()
    }

    /// Give a small, bounded prior to a surface known by the compact fallback
    /// lexicon when a full system dictionary is also loaded. This only breaks
    /// near ties; CID/MID costs and system probabilities remain dominant.
    pub(crate) fn builtin_surface_bonus(&self, entry: &DictionaryEntry) -> f32 {
        if !self.has_system_dictionary() {
            return 0.0;
        }
        if self
            .static_entries
            .iter()
            .any(|builtin| builtin.reading == entry.reading && builtin.surface == entry.surface)
        {
            1.5
        } else {
            0.0
        }
    }
}

fn path_exists_for_dictionary(path: &Path) -> bool {
    path.is_file() || path.is_dir()
}

#[derive(Debug, Clone)]
struct SystemDictionary {
    root: PathBuf,
    char_ids: HashMap<char, u8>,
    mm: Vec<f32>,
    cc_cache: RefCell<HashMap<u16, Vec<f32>>>,
}

impl SystemDictionary {
    fn load(root: &Path) -> Result<Self, String> {
        let char_path = root.join("louds").join("charID.chid");
        let chars = fs::read_to_string(&char_path)
            .map_err(|error| format!("could not read {}: {error}", char_path.display()))?;
        let mut char_ids = HashMap::new();
        for (index, character) in chars.chars().enumerate() {
            let id = u8::try_from(index)
                .map_err(|_| "AzooKey charID.chid has more than 256 characters".to_string())?;
            char_ids.insert(character, id);
        }
        let mm_path = root.join("mm.binary");
        let mm = read_f32_le(&mm_path)?;
        if mm.len() < MID_COUNT * MID_COUNT {
            return Err(format!(
                "{} is too short for the AzooKey {}x{} MID matrix",
                mm_path.display(),
                MID_COUNT,
                MID_COUNT
            ));
        }
        Ok(Self { root: root.to_path_buf(), char_ids, mm, cc_cache: RefCell::new(HashMap::new()) })
    }

    fn lookup_exact(&self, reading: &str) -> Result<Vec<DictionaryEntry>, String> {
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
        let louds = match Louds::load(&self.root, &escaped_identifier(&first.to_string())) {
            Ok(louds) => louds,
            Err(_) => return Ok(Vec::new()),
        };
        let Some(node_index) = louds.search_node_index(&ids) else {
            return Ok(Vec::new());
        };
        let shard = node_index >> SHARD_SHIFT;
        let local_index = node_index & LOCAL_MASK;
        let file_name = format!("{}{}.loudstxt3", escaped_identifier(&first.to_string()), shard);
        let path = self.root.join("louds").join(file_name);
        match read_loudstxt3_entry(&path, local_index) {
            Ok(entries) => Ok(entries.into_iter().filter(system_entry_is_usable).collect()),
            Err(_) => Ok(Vec::new()),
        }
    }

    fn class_connection_cost(&self, former: &DictionaryEntry, latter: &DictionaryEntry) -> f32 {
        self.cid_connection_cost(former.rcid, latter.lcid).unwrap_or(-25.0)
    }

    fn meaning_connection_cost(&self, former_mid: u16, latter_mid: u16) -> f32 {
        if former_mid == BOS_EOS_MID || latter_mid == BOS_EOS_MID {
            return 0.0;
        }
        let mid_index = usize::from(former_mid) * MID_COUNT + usize::from(latter_mid);
        self.mm.get(mid_index).copied().unwrap_or(0.0)
    }

    fn cid_connection_cost(&self, former: u16, latter: u16) -> Result<f32, String> {
        if !self.cc_cache.borrow().contains_key(&former) {
            let path = self.root.join("cb").join(format!("{former}.binary"));
            self.cc_cache.borrow_mut().insert(former, read_cc_line(&path)?);
        }
        Ok(self
            .cc_cache
            .borrow()
            .get(&former)
            .and_then(|line| line.get(usize::from(latter)))
            .copied()
            .unwrap_or(-25.0))
    }
}

/// AzooKey's compact word-type classification used by `isClause` and
/// `includeMMValueCalculation`.  The ranges are the stable CID groups from
/// the upstream converter; they describe morphology, not specific words.
fn word_type(cid: u16) -> u8 {
    let cid = usize::from(cid);
    if cid == 0 || cid == usize::from(EOS_CID) {
        return 3; // BOS/EOS
    }
    if matches!(cid, 5 | 6 | 557..=560 | 1315) {
        return 0; // preposition / 前置機能語
    }
    if matches!(
        cid,
        1..=5
            | 9
            | 11
            | 1281..=1282
            | 1283..=1296
            | 1306..=1309
            | 1314
            | 561..=867
    ) {
        return 1; // content word / 内容語
    }
    2 // postposition / 後置機能語
}

fn is_clause_boundary(former_rcid: u16, latter_lcid: u16) -> bool {
    let latter_type = word_type(latter_lcid);
    if latter_type == 3 {
        return false;
    }
    let former_type = word_type(former_rcid);
    if former_type == 3 {
        return false;
    }
    matches!(latter_type, 0 | 1) && former_type != 0
}

fn include_meaning_cost(entry: &DictionaryEntry) -> bool {
    (895..=1280).contains(&entry.lcid)
        || (895..=1280).contains(&entry.rcid)
        || (1297..=1305).contains(&entry.lcid)
        || (1297..=1305).contains(&entry.rcid)
        || word_type(entry.lcid) == 1
        || word_type(entry.rcid) == 1
}

fn system_entry_is_usable(entry: &DictionaryEntry) -> bool {
    if !entry.value.is_finite() {
        return false;
    }
    // AzooKey's prediction lattice excludes non-terminal inflection rows.
    // The complete upstream list is large; these compact ranges cover the
    // high-impact rows that otherwise leak into full-caption conversion here:
    // conditional contractions (15–18) and the two common inflection tails
    // observed in `ねん` candidates (774/782).
    if matches!(entry.rcid, 15..=18 | 774 | 782) {
        return false;
    }
    let is_hiragana_identity = entry.surface == entry.reading;
    // The full dictionary contains high-scoring identity rows for ordinary
    // hiragana (for example `てすと -> てすと`). In this bridge those rows can
    // outrank the compact lexicon's useful kana-to-kanji/katakana surface and
    // suppress conversion. Keep true orthographic entries (such as
    // `かたかな -> カタカナ`), but discard only multi-kana identities.
    let ruby_count = entry.reading.chars().count();
    if ruby_count >= 2 && is_hiragana_identity {
        return false;
    }
    // Single-kana system rows are mostly POS fragments, but identity rows for
    // particles (`は`, `の`, etc.) are needed to carry CID context into the
    // following word. Retain those grammar identities and drop non-identity
    // one-character rows (`と` -> `土`, names, and placeholders).
    if ruby_count < 2 && !is_hiragana_identity {
        return false;
    }
    let minimum = SYSTEM_DICTIONARY_VALUE_THRESHOLD + 2.0 / ruby_count as f32;
    entry.value >= minimum
}

#[derive(Debug, Clone)]
struct ExternalTrieDictionary {
    root: PathBuf,
    name: String,
    char_ids: HashMap<char, u8>,
    tsv_entries: Option<Vec<DictionaryEntry>>,
}

impl ExternalTrieDictionary {
    fn load(
        path: &Path,
        name: &str,
        inherited_char_ids: &HashMap<char, u8>,
    ) -> Result<Self, String> {
        if path.is_file() {
            return Ok(Self {
                root: path.to_path_buf(),
                name: name.to_string(),
                char_ids: HashMap::new(),
                tsv_entries: Some(parse_tsv(path)?),
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
        Ok(Self { root: path.to_path_buf(), name: name.to_string(), char_ids, tsv_entries: None })
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
        read_loudstxt3_entry(
            &self.root.join(format!("{}{}.loudstxt3", self.name, shard)),
            local_index,
        )
    }
}

#[derive(Debug, Clone)]
struct Louds {
    bits: Vec<u64>,
    node_ids: Vec<u8>,
    rank_zeros: Vec<usize>,
}

impl Louds {
    fn load(root: &Path, identifier: &str) -> Result<Self, String> {
        let louds = root.join("louds").join(format!("{identifier}.louds"));
        let chars = root.join("louds").join(format!("{identifier}.loudschars2"));
        Self::from_files(&louds, &chars)
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
        if bytes.len() % 8 != 0 {
            return Err(format!("{} is not a UInt64 LOUDS file", louds_path.display()));
        }
        let bits = bytes
            .chunks_exact(8)
            .map(|chunk| u64::from_le_bytes(chunk.try_into().expect("chunk is exactly 8 bytes")))
            .collect::<Vec<_>>();
        let node_ids = fs::read(chars_path)
            .map_err(|error| format!("could not read {}: {error}", chars_path.display()))?;
        let mut rank_zeros = Vec::with_capacity(bits.len() + 1);
        rank_zeros.push(0);
        for word in &bits {
            let next =
                rank_zeros.last().copied().unwrap_or_default() + 64 - word.count_ones() as usize;
            rank_zeros.push(next);
        }
        Ok(Self { bits, node_ids, rank_zeros })
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

fn parse_tsv(path: &Path) -> Result<Vec<DictionaryEntry>, String> {
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
                value: columns.get(2).and_then(|value| value.parse().ok()).unwrap_or(-10.0),
                lcid: columns.get(3).and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_CID),
                rcid: columns.get(4).and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_CID),
                mid: columns.get(5).and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_MID),
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
    let record_count = read_u16(&bytes, 0)? as usize;
    if index >= record_count {
        return Ok(Vec::new());
    }
    let start = read_u32(&bytes, 2 + index * 4)? as usize;
    let end = if index + 1 == record_count {
        bytes.len()
    } else {
        read_u32(&bytes, 2 + (index + 1) * 4)? as usize
    };
    if start > end || end > bytes.len() {
        return Err(format!("{} contains an invalid loudstxt3 offset", path.display()));
    }
    parse_loudstxt3_record(&bytes[start..end])
}

fn parse_loudstxt3_record(bytes: &[u8]) -> Result<Vec<DictionaryEntry>, String> {
    let count = read_u16(bytes, 0)? as usize;
    let header_end = 2 + count * 10;
    if bytes.len() < header_end {
        return Err("loudstxt3 record is shorter than its fixed entry header".to_string());
    }
    let fields = String::from_utf8_lossy(&bytes[header_end..])
        .split('\t')
        .map(str::to_string)
        .collect::<Vec<_>>();
    let reading = to_hiragana(&fields.first().cloned().unwrap_or_default());
    let mut entries = Vec::with_capacity(count);
    for index in 0..count {
        let base = 2 + index * 10;
        let surface = fields
            .get(index + 1)
            .filter(|surface| !surface.is_empty())
            .cloned()
            .unwrap_or_else(|| reading.clone());
        entries.push(DictionaryEntry {
            reading: reading.clone(),
            surface,
            lcid: read_u16(bytes, base)?,
            rcid: read_u16(bytes, base + 2)?,
            mid: read_u16(bytes, base + 4)?,
            value: read_f32(bytes, base + 6)?,
        });
    }
    Ok(entries)
}

fn read_cc_line(path: &Path) -> Result<Vec<f32>, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("could not read {}: {error}", path.display()))?;
    if bytes.len() % 8 != 0 || bytes.is_empty() {
        return Err(format!("{} is not an AzooKey CID connection-cost file", path.display()));
    }
    let mut line = vec![-25.0; 1319];
    for (index, pair) in bytes.chunks_exact(8).enumerate() {
        let cid = i32::from_le_bytes(pair[..4].try_into().expect("CID record prefix is 4 bytes"));
        let value = f32::from_le_bytes(pair[4..].try_into().expect("CID record suffix is 4 bytes"));
        if index == 0 && cid != -1 {
            return Err(format!("{} has no CID default record", path.display()));
        }
        if cid == -1 {
            line.fill(value);
        } else if let Some(slot) = line.get_mut(cid as usize) {
            *slot = value;
        }
    }
    Ok(line)
}

fn read_f32_le(path: &Path) -> Result<Vec<f32>, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("could not read {}: {error}", path.display()))?;
    if bytes.len() % 4 != 0 {
        return Err(format!("{} is not a Float32 file", path.display()));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("chunk is exactly 4 bytes")))
        .collect())
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    bytes
        .get(offset..offset + 2)
        .and_then(|chunk| chunk.try_into().ok())
        .map(u16::from_le_bytes)
        .ok_or_else(|| "unexpected end of an AzooKey binary dictionary file".to_string())
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    bytes
        .get(offset..offset + 4)
        .and_then(|chunk| chunk.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| "unexpected end of an AzooKey binary dictionary file".to_string())
}

fn read_f32(bytes: &[u8], offset: usize) -> Result<f32, String> {
    bytes
        .get(offset..offset + 4)
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
            | ("おつかれさまでした", _) => -5.0,
            _ => -10.0,
        };
        DictionaryEntry::plain(reading, surface, value)
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        escaped_identifier, parse_loudstxt3_record, system_entry_is_usable, AzooKeyDictionary,
        DictionaryEntry, DictionaryPaths,
    };

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
                    value: -3.0
                },
                DictionaryEntry {
                    reading: "とうきょう".into(),
                    surface: "とうきょう".into(),
                    lcid: 1288,
                    rcid: 1288,
                    mid: 344,
                    value: -4.0
                },
            ]
        );
    }

    #[test]
    fn applies_upstream_quality_threshold_to_system_entries() {
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
        assert!(!system_entry_is_usable(&one_kana));
        assert!(system_entry_is_usable(&particle_identity));
        assert!(system_entry_is_usable(&short));
        assert!(!system_entry_is_usable(&short_placeholder));
        assert!(system_entry_is_usable(&long));
        assert!(!system_entry_is_usable(&long_placeholder));
        assert!(!system_entry_is_usable(&hiragana_identity));
        assert!(system_entry_is_usable(&katakana_surface));
        assert!(!system_entry_is_usable(&contraction));
        assert!(!system_entry_is_usable(&inflection_tail));
    }

    #[test]
    fn reads_the_public_azookey_dictionary_when_configured() {
        let Ok(root) = std::env::var("AZOOKEY_DICTIONARY_ROOT") else {
            return;
        };
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.into()),
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
        std::fs::write(&user, "はいしん\t配信中\t-1\n").expect("user fixture should write");
        std::fs::write(&memory, "はいしん\t配信メモリ\t-0.5\n")
            .expect("memory fixture should write");

        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            user: Some(user.clone()),
            memory: Some(memory.clone()),
            ..DictionaryPaths::default()
        })
        .expect("portable external dictionaries should load");
        let entries = dictionary.lookup_exact("はいしん").expect("external lookup should complete");
        assert!(entries.iter().any(|entry| entry.surface == "配信中"));
        assert!(entries.iter().any(|entry| entry.surface == "配信メモリ"));

        let _ = std::fs::remove_file(user);
        let _ = std::fs::remove_file(memory);
    }
}
