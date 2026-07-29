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

#[derive(Debug, Clone, PartialEq)]
pub struct DictionaryEntry {
    pub reading: String,
    pub surface: String,
    pub lcid: u16,
    pub rcid: u16,
    pub mid: u16,
    /// AzooKey stores log-like costs where a more negative value is preferred.
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
    /// Root of `azooKey_dictionary_storage`, containing `louds`, `mm.binary`,
    /// and `cb`.
    pub system: Option<PathBuf>,
    /// Upstream-compatible user dictionary directory (`user.louds` and
    /// `user<N>.loudstxt3`) or a TSV fixture.
    pub user: Option<PathBuf>,
    /// Upstream-compatible learning-memory directory (`memory.louds` and
    /// `memory<N>.loudstxt3`) or a TSV fixture.
    pub memory: Option<PathBuf>,
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
        let mut dictionary = Self::default();
        if let Some(path) = paths.system.as_deref() {
            if path.is_file() {
                dictionary.static_entries.extend(parse_tsv(path)?);
            } else {
                dictionary.system = Some(SystemDictionary::load(path)?);
            }
        }
        let shared_char_ids =
            dictionary.system.as_ref().map(|system| system.char_ids.clone()).unwrap_or_default();
        if let Some(path) = paths.user.as_deref() {
            dictionary.user = Some(ExternalTrieDictionary::load(path, "user", &shared_char_ids)?);
        }
        if let Some(path) = paths.memory.as_deref() {
            dictionary.memory =
                Some(ExternalTrieDictionary::load(path, "memory", &shared_char_ids)?);
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
        if let Some(system) = &self.system {
            entries.extend(system.lookup_exact(&normalized)?);
        }
        if let Some(user) = &self.user {
            entries.extend(user.lookup_exact(&normalized)?);
        }
        if let Some(memory) = &self.memory {
            entries.extend(memory.lookup_exact(&normalized)?);
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
            entries.extend(self.lookup_exact(&reading)?);
        }
        Ok(entries)
    }

    pub fn connection_cost(&self, former: &DictionaryEntry, latter: &DictionaryEntry) -> f32 {
        self.system.as_ref().map(|system| system.connection_cost(former, latter)).unwrap_or(0.0)
    }
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
        let first = dictionary_reading
            .chars()
            .next()
            .ok_or_else(|| "empty dictionary query".to_string())?;
        let louds = Louds::load(&self.root, &escaped_identifier(&first.to_string()))?;
        let ids = dictionary_reading
            .chars()
            .map(|character| {
                self.char_ids
                    .get(&character)
                    .copied()
                    .ok_or_else(|| format!("character {character:?} is not present in charID.chid"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let Some(node_index) = louds.search_node_index(&ids) else {
            return Ok(Vec::new());
        };
        let shard = node_index >> SHARD_SHIFT;
        let local_index = node_index & LOCAL_MASK;
        let file_name = format!("{}{}.loudstxt3", escaped_identifier(&first.to_string()), shard);
        let path = self.root.join("louds").join(file_name);
        read_loudstxt3_entry(&path, local_index)
    }

    fn connection_cost(&self, former: &DictionaryEntry, latter: &DictionaryEntry) -> f32 {
        let mid_index = usize::from(former.mid) * MID_COUNT + usize::from(latter.mid);
        self.mm.get(mid_index).copied().unwrap_or(0.0)
            + self.cid_connection_cost(former.rcid, latter.lcid).unwrap_or(-25.0)
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
    [
        ("きょう", "今日"),
        ("あした", "明日"),
        ("きのう", "昨日"),
        ("はいしん", "配信"),
        ("おんせい", "音声"),
        ("にほんご", "日本語"),
        ("えいご", "英語"),
        ("ほんじつ", "本日"),
        ("じかん", "時間"),
        ("じょうほう", "情報"),
        ("かいし", "開始"),
        ("しゅうりょう", "終了"),
        ("せつめい", "説明"),
        ("ほんとう", "本当"),
        ("だいじょうぶ", "大丈夫"),
        ("ありがとう", "ありがとう"),
        ("こんにちは", "こんにちは"),
        ("こんばんは", "こんばんは"),
    ]
    .into_iter()
    .map(|(reading, surface)| DictionaryEntry::plain(reading, surface, -10.0))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        escaped_identifier, parse_loudstxt3_record, AzooKeyDictionary, DictionaryEntry,
        DictionaryPaths,
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
        std::fs::write(&user, "はいしん\t配信中\t-99\n").expect("user fixture should write");
        std::fs::write(&memory, "はいしん\t配信メモリ\t-100\n")
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
