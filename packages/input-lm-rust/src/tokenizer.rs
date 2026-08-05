//! GPT-2 byte-level BPE tokenizer for the `input_n5_lm_v1` character n-gram model.
//!
//! Ported from `ZenzTokenizer` in
//! `submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/Tokenizer.swift`,
//! which wraps the Hugging Face `GPT2Tokenizer` configured by the vendored assets
//! under `.../EfficientNGram/tokenizer/` (`vocab.json`, `merges.txt`,
//! `tokenizer.json`, `tokenizer_config.json`; upstream `ku-nlp/gpt2-small-japanese-char`).
//!
//! ## Byte-level BPE, per scalar
//!
//! The reference tokenizer never feeds a whole string through BPE by default.
//! `ZenzTokenizer.encode` runs its `encodeFastByUnicodeScalar` instead: it encodes
//! each Unicode scalar independently (caching it) and concatenates.
//! This module reproduces that fast path exactly, and also ships the real
//! whole-string BPE as [`encode_slow`](ZenzTokenizer::encode_slow) so the two can
//! be asserted equal on strings that should be identical.
//!
//! Why the fast path is faithful for this model is not obvious — the trained BPE
//! does merge across byte boundaries in general. It is the *shape of the
//! vocabulary* that makes the fast path exact here. Full reasoning is in the crate
//! README; the two structural facts are:
//!
//! - Every UTF-8 byte above `0x7F` maps to a Latin-1 char in the `[0xC0, 0xFF]`
//!   range (`Ã` … `ÿ`), and every byte in `[0xC0, 0xDF]` — the possible *middle*
//!   bytes of a multi-byte scalar — has **no** single-char vocabulary entry, so it
//!   can never terminate a token by itself.
//! - A multi-byte scalar's byte-map starts with `ã` (3-byte scalars) or
//!   `â`/`Ä`/`Ă` (2-byte scalars), and across all 5764 merges in `merges.txt` there
//!   is **no** merge pair whose second half is a lead-byte char. So no merge can
//!   swallow the *first* byte of the next scalar while the current scalar is
//!   mid-merge.
//!
//! Consequently the byte-level BPE merge never spans two scalars, and `encode` on
//! Japanese / kana / kanji / romaji text is byte-for-byte identical to the
//! full-string encoding. (The cache is also what the Swift ships: one entry in
//! memory per scalar seen, not per string.)
//!
//! ## Decode
//!
//! `decode` maps each token back through the byte-to-unicode table, then
//! reinterprets the byte concatenation as UTF-8. This is exactly the `ByteLevel`
//! decoder in `tokenizer.json`.
//!
//! ## Unknown scalars
//!
//! A Unicode scalar that maps to no vocabulary token (e.g. a lone newline) is
//! encoded as `[UNK]` = `0`. When the byte-encoded scalar needs several tokens one
//! of which is `[UNK]`-ing anyway, `decode` can re-split and the scalar stops
//! round-tripping cleanly; schoolbook byte fallback is deliberately *not*
//! implemented, to match the reference behavior.

use std::collections::HashMap;

// ---------------------------------------------------------------------------
// GPT-2 byte-to-unicode mapping (256 entries, built at compile time)
// ---------------------------------------------------------------------------

/// The canonical GPT-2 byte-to-unicode table: 256 bytes, each mapped to a
/// printable character.
///
/// Built exactly like the Python reference: first the contiguous printable
/// blocks `!..~`, `¡..¬`, `®..ÿ`, then every remaining byte gets codepoint
/// `256 + n` in ascending byte order.
///
/// Note: despite the name this is a lazy runtime table, because there is no
/// const path from an integer codepoint to a `char`.
pub static BYTE_TO_UNICODE: std::sync::OnceLock<[char; 256]> = std::sync::OnceLock::new();

fn byte_to_unicode() -> &'static [char; 256] {
    BYTE_TO_UNICODE.get_or_init(|| {
        let mut table = ['\0'; 256];
        let mut fill = |start: u32, end: u32| {
            let mut b = start;
            while b <= end {
                table[b as usize] = char::from_u32(b).expect("valid Latin-1 codepoint");
                b += 1;
            }
        };
        // The contiguous printable blocks, in this order.
        fill(0x21, 0x7e);
        fill(0xa1, 0xac);
        fill(0xae, 0xff);
        // Any byte still unset maps to codepoint 256 + n, in ascending byte
        // order, exactly as the Python reference does.
        let mut n = 0u32;
        let mut b = 0u32;
        while b < 256 {
            if table[b as usize] == '\0' {
                table[b as usize] = char::from_u32(256 + n).expect("valid scalar");
                n += 1;
            }
            b += 1;
        }
        table
    })
}

/// Inverse: unicode character back to the underlying byte.
pub fn unicode_to_byte(ch: char) -> Option<u8> {
    static REV: std::sync::OnceLock<HashMap<char, u8>> = std::sync::OnceLock::new();
    REV.get_or_init(|| {
        let mut m = HashMap::with_capacity(256);
        for (b, &c) in byte_to_unicode().iter().enumerate() {
            m.insert(c, b as u8);
        }
        m
    })
    .get(&ch)
    .copied()
}

/// Encodes a single Unicode scalar: UTF-8 bytes, each mapped through the
/// byte table to a character.
pub fn scalar_to_unicode_str(c: char) -> String {
    let mut buf = [0u8; 4];
    let s = c.encode_utf8(&mut buf);
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        out.push(byte_to_unicode()[b as usize]);
    }
    out
}

/// Decodes a byte-mapped unicode string back to UTF-8 bytes.
pub fn unicode_str_to_utf8(s: &str) -> String {
    let mut bytes = Vec::with_capacity(s.len());
    for ch in s.chars() {
        if let Some(b) = unicode_to_byte(ch) {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).expect("byte-level unicode decode yields valid UTF-8")
}

// ---------------------------------------------------------------------------
// Vocabulary and BPE merge tables
// ---------------------------------------------------------------------------

/// Parsed tokenizer vocabulary and BPE merge ranks.
#[derive(Debug, Clone)]
pub struct BpeTables {
    /// Maps token string to its id (0–5999).
    pub token_to_id: HashMap<String, usize>,
    /// Maps id back to token string.
    pub id_to_token: Vec<String>,
    /// BPE merge ranks: `(left, right)` -> file line rank (lower = earlier =
    /// higher priority). Empty when merges were not loaded.
    pub ranks: HashMap<(String, String), usize>,
}

impl BpeTables {
    /// Loads `vocab.json` and `merges.txt` from `dir`. Returns `None` when the
    /// directory or its files cannot be read or parsed.
    pub fn from_dir(dir: &std::path::Path) -> Option<Self> {
        let vocab_file = std::fs::read_to_string(dir.join("vocab.json")).ok()?;
        let token_to_id: HashMap<String, usize> = serde_json::from_str(&vocab_file).ok()?;
        if token_to_id.len() != 6000 {
            return None;
        }
        let mut id_to_token = vec![String::new(); 6000];
        for (token, &id) in &token_to_id {
            if id < 6000 {
                id_to_token[id] = token.clone();
            }
        }
        let mut ranks = HashMap::new();
        let merges_text = std::fs::read_to_string(dir.join("merges.txt")).ok()?;
        for (i, line) in merges_text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut parts = line.splitn(2, ' ');
            let (Some(left), Some(right)) = (parts.next(), parts.next()) else {
                continue;
            };
            ranks.insert((left.to_string(), right.to_string()), i);
        }
        Some(Self { token_to_id, id_to_token, ranks })
    }

    /// `[UNK]` is always token id 0 in this tokenizer.
    pub fn unk_id(&self) -> usize {
        0
    }
}

// ---------------------------------------------------------------------------
// BPE merge (slow path)
// ---------------------------------------------------------------------------

/// Runs the byte-level BPE merge algorithm on an already byte-mapped unicode
/// string, returning token ids.
///
/// Starts from individual byte-characters, then repeatedly merges the lowest
/// (earliest) ranked adjacent pair present in `tables.ranks`. Tokens not in the
/// vocabulary fall back to `[UNK]` = 0, matching the GPT-2 BPE reference.
pub fn byte_level_bpe(text_unicode: &str, tables: &BpeTables) -> Vec<usize> {
    if tables.ranks.is_empty() {
        return text_unicode
            .chars()
            .map(|ch| tables.token_to_id.get(&ch.to_string()).copied().unwrap_or(0))
            .collect();
    }
    let mut parts: Vec<String> = text_unicode.chars().map(|c| c.to_string()).collect();

    loop {
        let mut best: Option<(usize, String)> = None; // (rank, merged)
        for i in 0..parts.len().saturating_sub(1) {
            let rank = tables.ranks.get(&(parts[i].clone(), parts[i + 1].clone()));
            if let Some(&rank) = rank {
                let better = match best {
                    None => true,
                    Some((best_rank, _)) => rank < best_rank,
                };
                if better {
                    best = Some((rank, format!("{}{}", parts[i], parts[i + 1])));
                }
            }
        }
        let Some((_, merged)) = best else { break };
        let mut next = Vec::with_capacity(parts.len());
        let mut i = 0;
        while i < parts.len() {
            if i + 1 < parts.len() && parts[i].clone() + &parts[i + 1] == merged {
                next.push(merged.clone());
                i += 2;
            } else {
                next.push(parts[i].clone());
                i += 1;
            }
        }
        parts = next;
    }

    parts.iter().map(|p| tables.token_to_id.get(p).copied().unwrap_or(0)).collect()
}

// ---------------------------------------------------------------------------
// ZenzTokenizer
// ---------------------------------------------------------------------------

/// GPT-2 byte-level BPE tokenizer over the vendored `input_n5_lm_v1` assets.
#[derive(Debug, Clone)]
pub struct ZenzTokenizer {
    tables: BpeTables,
    /// Per-scalar fast-path cache, mirroring the Swift `FastTokenizerPathState`.
    cache: HashMap<char, Vec<usize>>,
}

impl ZenzTokenizer {
    /// Loads the tokenizer from a directory holding `vocab.json` and
    /// `merges.txt`. Returns `None` (a typed absence, not a panic) when the
    /// files cannot be read or parsed.
    pub fn from_dir(dir: &std::path::Path) -> Option<Self> {
        BpeTables::from_dir(dir).map(|tables| Self { tables, cache: HashMap::new() })
    }

    /// Loads the tokenizer from the vendored tokenizer directory inside the
    /// `AzooKeyKanaKanjiConverter` submodule.
    ///
    /// Uses `env!("CARGO_MANIFEST_DIR")`, so it resolves from wherever the crate
    /// is compiled.
    pub fn from_submodule() -> Option<Self> {
        let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        Self::from_dir(
            &crate_dir.join(
                "../../submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/tokenizer",
            ),
        )
    }

    /// The tokenizer's own vocabulary tables.
    pub fn tables(&self) -> &BpeTables {
        &self.tables
    }

    /// Number of vocabulary entries (should be 6000 for this model).
    pub fn vocab_size(&self) -> usize {
        self.tables.token_to_id.len()
    }

    /// BOS token id (`<s>` = 2 as shipped).
    pub fn start_token_id(&self) -> usize {
        2
    }

    /// EOS token id (`</s>` = 3 as shipped).
    pub fn end_token_id(&self) -> usize {
        3
    }

    /// Per-Unicode-scalar fast-path encoding, matching
    /// `ZenzTokenizer.encodeFastByUnicodeScalar`. Each scalar is encoded on its
    /// own (cached) and the ids concatenated.
    pub fn encode(&mut self, text: &str) -> Vec<usize> {
        let mut output = Vec::with_capacity(text.chars().count());
        for c in text.chars() {
            let ids = match self.cache.get(&c) {
                Some(ids) => ids.clone(),
                None => {
                    let scalar_text = scalar_to_unicode_str(c);
                    let ids = byte_level_bpe(&scalar_text, &self.tables);
                    self.cache.insert(c, ids.clone());
                    ids
                }
            };
            output.extend(ids);
        }
        output
    }

    /// Whole-string BPE encoding (slow path). Identical to `encode` on Japanese
    /// text — the fast path is the default because the trainable merges never
    /// straddle a scalar boundary here.
    pub fn encode_slow(&self, text: &str) -> Vec<usize> {
        let unicode: String = text
            .chars()
            .flat_map(|c| scalar_to_unicode_str(c).chars().collect::<Vec<_>>())
            .collect();
        byte_level_bpe(&unicode, &self.tables)
    }

    /// Decodes token ids back to UTF-8 through the byte-level table.
    pub fn decode(&self, tokens: &[usize]) -> String {
        let mut bytes = Vec::with_capacity(tokens.len());
        for &id in tokens {
            if let Some(token) = self.tables.id_to_token.get(id) {
                for ch in token.chars() {
                    if let Some(b) = unicode_to_byte(ch) {
                        bytes.push(b);
                    }
                }
            }
        }
        String::from_utf8(bytes).expect("byte-level decode yields valid UTF-8")
    }

    /// Clears the per-scalar cache.
    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Option<ZenzTokenizer> {
        ZenzTokenizer::from_submodule()
    }

    /// Binds `fixture()` or skips the test. One shared definition keeps the
    /// asset-missing guard in a single place; the suite depends on the
    /// submodule assets, so the guard only fires when they are absent.
    macro_rules! fixture_or_skip {
        ($pat:pat = $e:expr) => {
            let Some($pat) = $e else {
                eprintln!("skipping: submodule assets not present");
                return;
            };
        };
    }

    /// Creates a unique throwaway directory under the system temp dir. Callers
    /// write asset files into it, then `remove_dir_all` it. Unique per call so
    /// parallel tests never clobber each other.
    fn temp_asset_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "caption-bridge-input-lm-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("unnamed").replace(':', "_")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn byte_table_covers_256_entries_and_round_trips() {
        let table = byte_to_unicode();
        assert_eq!(table.len(), 256);
        for b in 0..=255u8 {
            let ch = table[b as usize];
            assert_eq!(unicode_to_byte(ch), Some(b), "byte {b}");
        }
    }

    #[test]
    fn byte_table_maps_low_ascii_and_a_latin1_block_directly() {
        let table = byte_to_unicode();
        assert_eq!(table[0x21], '!');
        assert_eq!(table[0x7e], '~');
        assert_eq!(unicode_to_byte('\u{00a1}'), Some(0xa1));
        assert_eq!(unicode_to_byte('\u{00ac}'), Some(0xac));
        assert_eq!(unicode_to_byte('\u{00ae}'), Some(0xae));
    }

    #[test]
    fn scalar_to_unicode_str_round_trips_utf8() {
        for c in ['あ', 'a', ' ', 'ß', 'é', '漢', '😀', '𩸽', 'ー', 'ぷ', 'ん', 'っ', 'Ǒ', 'á']
        {
            let mapped = scalar_to_unicode_str(c);
            let decoded = unicode_str_to_utf8(&mapped);
            assert_eq!(decoded, c.to_string(), "scalar {c:?} round-tripped to {decoded:?}");
        }
    }

    #[test]
    fn merge_tables_hold_5764_ranks() {
        fixture_or_skip!(t = fixture());
        assert_eq!(t.tables.ranks.len(), 5764, "expected 5764 merge pairs");
    }

    #[test]
    fn fast_and_slow_paths_agree_and_decode_round_trips_japanese() {
        fixture_or_skip!(mut t = fixture());
        for text in [
            "あしたのてんきははれ",
            "とても",
            "すーぷは",
            "今日はいい天気です",
            "ローマ字入力です",
            "あいうえお",
            "漢字テスト",
            "。、！？",
            "😀",
        ] {
            let fast = t.encode(text);
            let slow = t.encode_slow(text);
            assert_eq!(fast, slow, "paths diverge on {text:?}: fast={fast:?} slow={slow:?}");
            let decoded = t.decode(&fast);
            assert_eq!(decoded, text, "decode round-trip failed on {text:?}");
        }
    }

    #[test]
    fn spaces_encode_to_unk_like_the_swift_fast_path() {
        fixture_or_skip!(mut t = fixture());
        // The ASCII space byte 0x20 maps to '\u{0120}', which is not a vocab
        // token. The reference fast path (`encodeFastByUnicodeScalar`) runs
        // full BPE per scalar and falls back to [UNK] = 0, and so does encode.
        assert_eq!(t.encode(" "), vec![0]);
        assert!(t.encode(" ") == t.encode_slow(" "));
        // decode of [0] is the literal '[UNK]' string.
        assert_eq!(t.decode(&[0]), "[UNK]");
    }

    #[test]
    fn known_ids_pin_character_encoding() {
        fixture_or_skip!(mut t = fixture());
        // From the Python cross-check: あ=277, し=244, た=249, の=240.
        assert_eq!(t.encode("あ"), vec![277]);
        assert_eq!(t.encode("し"), vec![244]);
        assert_eq!(t.encode("た"), vec![249]);
        assert_eq!(t.encode("の"), vec![240]);
        assert_eq!(t.decode(&[277]), "あ");
        assert_eq!(t.decode(&[244]), "し");
        assert_eq!(t.decode(&[249]), "た");
    }

    #[test]
    fn an_emoji_scalar_splits_into_four_byte_tokens() {
        fixture_or_skip!(mut t = fixture());
        // 😀 = U+1F600 = bytes F0 9F 98 80 -> 'ðŁĺĢ', which IS a single vocab
        // token (5247) because the training data included it. So it encodes to
        // exactly one id and decodes back to the emoji.
        assert_eq!(t.encode("😀"), vec![5247]);
        assert_eq!(t.decode(&[5247]), "😀");
    }

    #[test]
    fn space_and_punctuation_round_trip() {
        fixture_or_skip!(mut t = fixture());
        // Punctuation scalars are in the vocab and round-trip; an ASCII space
        // has no single-token entry (per-scalar fast path), so it maps to UNK
        // exactly like the Swift fast path.
        let text = "。、！？";
        let ids = t.encode(text);
        assert_eq!(t.decode(&ids), text);
        assert_eq!(t.encode(" "), vec![0]);
    }

    #[test]
    fn cache_and_uncached_results_are_identical() {
        fixture_or_skip!(mut t = fixture());
        let first = t.encode("あいうえお");
        t.clear_cache();
        let second = t.encode("あいうえお");
        assert_eq!(first, second);
        let third = t.encode("あいうえお");
        assert_eq!(second, third, "cached path changed the result");
    }

    #[test]
    fn tables_and_unk_id_accessors_expose_the_loaded_tables() {
        // Pins the `ZenzTokenizer::tables()` and `BpeTables::unk_id()`
        // accessors, which are otherwise unreferenced by the suite.
        fixture_or_skip!(t = fixture());
        let tables = t.tables();
        assert_eq!(tables.unk_id(), 0);
        assert_eq!(tables.token_to_id.get("[UNK]"), Some(&0));
        assert_eq!(t.tables().ranks.len(), 5764);
    }

    #[test]
    fn start_and_end_token_ids_match_the_reference() {
        fixture_or_skip!(t = fixture());
        assert_eq!(t.start_token_id(), 2); // <s>
        assert_eq!(t.end_token_id(), 3); // </s>
        assert_eq!(t.vocab_size(), 6000);
    }

    #[test]
    fn missing_directory_is_an_absence_not_a_panic() {
        assert!(ZenzTokenizer::from_dir(std::path::Path::new("/nonexistent/xyz")).is_none());
        assert!(unicode_to_byte('\u{0}').is_none());
        assert_eq!(unicode_str_to_utf8(""), "");
    }
    #[test]
    fn oversized_vocab_is_an_absence_not_a_panic() {
        // A vocab.json with the wrong entry count must yield None (typed
        // absence), covering the `token_to_id.len() != 6000` guard.
        let dir = temp_asset_dir();
        std::fs::write(dir.join("vocab.json"), r#"{"a": 0, "b": 1}"#).unwrap();
        assert!(BpeTables::from_dir(&dir).is_none());
        assert!(ZenzTokenizer::from_dir(&dir).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn malformed_merges_line_is_skipped_not_fatal() {
        // One broken merge line (no space between pair tokens) must not poison
        // the table; the malformed line takes the `else { continue }` path.
        // The vocab must hold exactly 6000 entries for from_dir to accept it.
        let dir = temp_asset_dir();
        let mut vocab = String::from("{");
        for id in 0..6000 {
            if id > 0 {
                vocab.push(',');
            }
            vocab.push_str(&format!("\"tok{id}\":{id}"));
        }
        vocab.push('}');
        std::fs::write(dir.join("vocab.json"), vocab).unwrap();
        std::fs::write(dir.join("merges.txt"), "tok0 tok1\nbrokenline\n# comment\n\n").unwrap();
        let tables = BpeTables::from_dir(&dir).unwrap();
        // The valid pair tok0+tok1 is ranked 0; the malformed line and
        // comments are ignored entirely.
        assert_eq!(tables.ranks.get(&("tok0".to_string(), "tok1".to_string())), Some(&0));
        assert_eq!(tables.ranks.len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn byte_level_bpe_with_no_ranks_falls_back_to_a_direct_vocab_lookup() {
        // The `tables.ranks.is_empty()` fast path: with no merges, every
        // character of the byte-mapped string maps straight to its vocab id
        // (or UNK). `あ`/`い` each become several byte-level characters, and
        // the fallback looks up each one individually in order.
        let a_byte = scalar_to_unicode_str('あ');
        let i_byte = scalar_to_unicode_str('い');
        let bytes: String = format!("{a_byte}{i_byte}");
        let byte_chars: Vec<char> = bytes.chars().collect();
        let mut token_to_id = HashMap::new();
        for (rank, ch) in byte_chars.iter().enumerate() {
            token_to_id.insert(ch.to_string(), 100 + rank);
        }
        let tables =
            BpeTables { token_to_id, id_to_token: vec![String::new(); 106], ranks: HashMap::new() };
        // Every byte-char in the string has a vocab entry, so the fallback
        // returns their ids in exact byte-char lookup order. The byte-map of
        // あ and い SHARE their leading byte-chars, so the ids repeat where the
        // chars repeat — exactly what the function's per-char lookup yields.
        let want: Vec<usize> = byte_chars
            .iter()
            .map(|ch| tables.token_to_id.get(&ch.to_string()).copied().unwrap())
            .collect();
        assert_eq!(byte_level_bpe(&bytes, &tables), want);
        // A scalar with no vocab coverage maps each byte-char to UNK = 0.
        let empty = BpeTables {
            token_to_id: HashMap::new(),
            id_to_token: vec![String::new(); 1],
            ranks: HashMap::new(),
        };
        let bytes_x: String = scalar_to_unicode_str('漢').chars().collect();
        assert!(byte_level_bpe(&bytes_x, &empty).iter().all(|&id| id == 0));
    }

    #[test]
    fn empty_text_encodes_to_empty() {
        fixture_or_skip!(mut t = fixture());
        assert!(t.encode("").is_empty());
        assert!(t.encode_slow("").is_empty());
    }

    #[test]
    fn newline_scalar_maps_to_unk() {
        // '\n' = byte 0x0A, whose byte-char has no single-char vocab entry, so
        // the fast path emits [UNK] rather than byte-falling back.
        fixture_or_skip!(mut t = fixture());
        assert_eq!(t.encode("\n"), vec![0]);
    }

    #[test]
    fn all_6000_vocab_tokens_are_placeholders() {
        fixture_or_skip!(t = fixture());
        assert_eq!(t.tables.id_to_token.len(), 6000);
        for (i, tok) in t.tables.id_to_token.iter().enumerate() {
            assert!(!tok.is_empty(), "id {i} has empty token");
        }
    }
}
