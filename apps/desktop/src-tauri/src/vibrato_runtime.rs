//! Vibrato IPADIC pre-pass: kanji → hiragana readings before AzooKey.
//!
//! Pure kana input passes through unchanged. When the ASR/Parapper text still
//! contains CJK ideographs, Vibrato feature index 7 (IPADIC reading) supplies
//! the kana reading that rescore and AzooKey expect.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// True when `text` contains any CJK Unified Ideographs code point
/// (Extension A, BMP block, or Compatibility Ideographs).
pub fn contains_kanji(text: &str) -> bool {
    text.chars().any(is_kanji)
}

fn is_kanji(character: char) -> bool {
    let code = character as u32;
    (0x3400..=0x4dbf).contains(&code)
        || (0x4e00..=0x9fff).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
}

/// Decode a zstd-compressed Vibrato dictionary and build a tokenizer.
pub fn tokenizer_from_zstd(bytes: &[u8]) -> Result<vibrato::Tokenizer, String> {
    let mut decoder = ruzstd::StreamingDecoder::new(bytes)
        .map_err(|error| format!("zstd decode error: {error}"))?;
    let mut dictionary = Vec::new();
    decoder.read_to_end(&mut dictionary).map_err(|error| format!("zstd read error: {error}"))?;
    let dictionary = vibrato::Dictionary::read(dictionary.as_slice())
        .map_err(|error| format!("dictionary read error: {error}"))?;
    Ok(vibrato::Tokenizer::new(dictionary))
}

fn katakana_to_hiragana(input: &str) -> String {
    input
        .chars()
        .map(|character| {
            if ('ァ'..='ヶ').contains(&character) {
                char::from_u32(character as u32 - ('ァ' as u32 - 'ぁ' as u32)).unwrap_or(character)
            } else {
                character
            }
        })
        .collect()
}

/// Convert token readings to hiragana using IPADIC feature index 7 (`reading`).
pub fn to_hiragana(tokenizer: &vibrato::Tokenizer, text: &str) -> String {
    const IPADIC_READING_FEATURE_INDEX: usize = 7;
    let mut worker = tokenizer.new_worker();
    worker.reset_sentence(text);
    worker.tokenize();
    worker
        .token_iter()
        .map(|token| {
            token
                .feature()
                .split(',')
                .nth(IPADIC_READING_FEATURE_INDEX)
                .filter(|reading| !reading.is_empty() && *reading != "*")
                .map(katakana_to_hiragana)
                .unwrap_or_else(|| token.surface().to_string())
        })
        .collect()
}

/// Cached Vibrato tokenizer for the desktop AzooKey pre-pass.
#[derive(Clone)]
pub struct VibratoReader {
    tokenizer: Arc<vibrato::Tokenizer>,
}

impl std::fmt::Debug for VibratoReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VibratoReader")
    }
}

impl VibratoReader {
    /// Return `text` unchanged when it has no kanji; otherwise hiragana readings.
    pub fn reading_for_azookey(&self, text: &str) -> String {
        if !contains_kanji(text) {
            return text.to_string();
        }
        to_hiragana(&self.tokenizer, text)
    }
}

/// Candidate paths for the bundled / source-tree IPADIC dictionary.
pub fn resolve_ipadic_path() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = vec![
        manifest.join("resources/vibrato/system.dic.zst"),
        manifest.join("../../../assets/vibrato/ipadic-mecab-2_7_0/system.dic.zst"),
    ];
    // Packaged Tauri apps: Resources/vibrato/system.dic.zst next to the binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            candidates.push(macos_dir.join("../Resources/vibrato/system.dic.zst"));
            candidates.push(macos_dir.join("resources/vibrato/system.dic.zst"));
            candidates.push(macos_dir.join("vibrato/system.dic.zst"));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Load a Vibrato reader from a zstd dictionary file.
pub fn load_from_path(path: &Path) -> Result<VibratoReader, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("vibrato dictionary read failed ({}): {error}", path.display()))?;
    let tokenizer = tokenizer_from_zstd(&bytes)?;
    Ok(VibratoReader { tokenizer: Arc::new(tokenizer) })
}

/// Load from the first existing IPADIC candidate path, if any.
pub fn try_default() -> Option<VibratoReader> {
    let path = resolve_ipadic_path()?;
    match load_from_path(&path) {
        Ok(reader) => Some(reader),
        Err(error) => {
            log::warn!(
                target: "pipeline_vibrato",
                "vibrato dictionary at {} failed to load: {error}",
                path.display()
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{contains_kanji, tokenizer_from_zstd, to_hiragana, VibratoReader};
    use std::io::Cursor;
    use std::sync::Arc;

    fn tiny_dictionary_zstd() -> Vec<u8> {
        let lexicon = "京都,4,4,5,京都,名詞,固有名詞,地名,一般,*,*,キョウト,京都,*,A,*,*,*,1/5\n\
東京都,5,5,9,東京都,名詞,固有名詞,地名,一般,*,*,トウキョウト,東京都,*,B,5/9,*,5/9,*\n\
に,1,1,1,に,助詞,格助詞,一般,*,*,*,ニ,ニ,*,*,*,*,*,*";
        let matrix = "10 10\n0 4 -5\n0 5 -9\n";
        let char_def = "DEFAULT 0 1 0\n";
        let unk_def = "DEFAULT,0,0,100,DEFAULT,名詞,普通名詞,*,*,*,*,*,*,*,*,*,*,*,*\n";
        let dictionary = vibrato::SystemDictionaryBuilder::from_readers(
            Cursor::new(lexicon),
            Cursor::new(matrix),
            Cursor::new(char_def),
            Cursor::new(unk_def),
        )
        .expect("tiny dictionary should build");
        let mut raw = Vec::new();
        dictionary.write(&mut raw).expect("tiny dictionary should serialize");
        zstd::stream::encode_all(raw.as_slice(), 1).expect("tiny dictionary should compress")
    }

    fn tiny_reader() -> VibratoReader {
        let tokenizer =
            tokenizer_from_zstd(&tiny_dictionary_zstd()).expect("zstd dictionary should initialize");
        VibratoReader { tokenizer: Arc::new(tokenizer) }
    }

    #[test]
    fn contains_kanji_detects_cjk_ideographs() {
        assert!(contains_kanji("東京"));
        assert!(contains_kanji("きょうは晴れ"));
        assert!(!contains_kanji("きょうははれ"));
        assert!(!contains_kanji("abc123"));
        assert!(!contains_kanji(""));
    }

    #[test]
    fn reading_conversion_uses_ipadic_feature_index() {
        let tokenizer =
            tokenizer_from_zstd(&tiny_dictionary_zstd()).expect("zstd dictionary should initialize");
        assert_eq!(to_hiragana(&tokenizer, "東京都に京都"), "とうきょうとにきょうと");
    }

    #[test]
    fn reading_for_azookey_passthrough_when_no_kanji() {
        let reader = tiny_reader();
        assert_eq!(reader.reading_for_azookey("きょうははれ"), "きょうははれ");
        assert_eq!(reader.reading_for_azookey("東京都に京都"), "とうきょうとにきょうと");
    }
}
