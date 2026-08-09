//! Shared Vibrato IPADIC pre-pass.
//!
//! Tauri desktop is the source of truth for this gate: pure kana passes
//! through unchanged, and kanji surfaces are converted with IPADIC feature 7.

use std::io::Read;

pub use vibrato::Tokenizer;

/// IPADIC comma-separated `reading` field used by the desktop pipeline.
pub const IPADIC_READING_FEATURE_INDEX: usize = 7;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MorphToken {
    pub surface: String,
    pub feature: String,
    pub char_end: usize,
}

pub fn is_kanji(character: char) -> bool {
    let code = character as u32;
    (0x3400..=0x4dbf).contains(&code)
        || (0x4e00..=0x9fff).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
}

/// True when `text` contains any CJK Unified Ideographs code point
/// (Extension A, BMP block, or Compatibility Ideographs).
pub fn contains_kanji(text: &str) -> bool {
    text.chars().any(is_kanji)
}

pub fn katakana_to_hiragana(input: &str) -> String {
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

/// Decode a zstd-compressed Vibrato dictionary and build a tokenizer.
pub fn tokenizer_from_zstd(bytes: &[u8]) -> Result<Tokenizer, String> {
    let mut decoder = ruzstd::StreamingDecoder::new(bytes)
        .map_err(|error| format!("zstd decode error: {error}"))?;
    let mut dictionary = Vec::new();
    decoder.read_to_end(&mut dictionary).map_err(|error| format!("zstd read error: {error}"))?;
    let dictionary = vibrato::Dictionary::read(dictionary.as_slice())
        .map_err(|error| format!("dictionary read error: {error}"))?;
    Ok(vibrato::Tokenizer::new(dictionary))
}

pub fn tokenize(tokenizer: &Tokenizer, text: &str) -> Vec<MorphToken> {
    let mut worker = tokenizer.new_worker();
    worker.reset_sentence(text);
    worker.tokenize();
    worker
        .token_iter()
        .map(|token| MorphToken {
            surface: token.surface().to_string(),
            feature: token.feature().to_string(),
            char_end: token.range_char().end,
        })
        .collect()
}

pub fn hiragana_with_feature_index(
    tokenizer: &Tokenizer,
    text: &str,
    feature_index: usize,
) -> String {
    tokenize(tokenizer, text)
        .into_iter()
        .map(|token| {
            token
                .feature
                .split(',')
                .nth(feature_index)
                .filter(|reading| !reading.is_empty() && *reading != "*")
                .map(katakana_to_hiragana)
                .unwrap_or(token.surface)
        })
        .collect()
}

pub fn to_hiragana(tokenizer: &Tokenizer, text: &str) -> String {
    hiragana_with_feature_index(tokenizer, text, IPADIC_READING_FEATURE_INDEX)
}

pub fn reading_for_azookey_with_feature_index(
    tokenizer: &Tokenizer,
    text: &str,
    feature_index: usize,
) -> String {
    if !contains_kanji(text) {
        return text.to_string();
    }
    hiragana_with_feature_index(tokenizer, text, feature_index)
}

/// Desktop `reading_for_azookey`: skip IPADIC when the surface has no kanji.
pub fn reading_for_azookey(tokenizer: &Tokenizer, text: &str) -> String {
    reading_for_azookey_with_feature_index(tokenizer, text, IPADIC_READING_FEATURE_INDEX)
}

#[cfg(test)]
mod tests {
    use super::{
        contains_kanji, hiragana_with_feature_index, reading_for_azookey, to_hiragana,
        tokenizer_from_zstd,
    };
    use std::io::Cursor;

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

    #[test]
    fn contains_kanji_detects_cjk_ideographs() {
        assert!(contains_kanji("東京"));
        assert!(contains_kanji("きょうは晴れ"));
        assert!(!contains_kanji("きょうははれ"));
        assert!(!contains_kanji("abc123"));
        assert!(!contains_kanji(""));
    }

    #[test]
    fn reading_conversion_uses_feature_index_and_preserves_unknown_tokens() {
        let tokenizer = tokenizer_from_zstd(&tiny_dictionary_zstd())
            .expect("zstd dictionary should initialize");
        assert_eq!(to_hiragana(&tokenizer, "東京都に京都"), "とうきょうとにきょうと");
        assert_eq!(
            hiragana_with_feature_index(&tokenizer, "東京都に京都", 7),
            "とうきょうとにきょうと"
        );
    }

    #[test]
    fn reading_for_azookey_passthrough_when_no_kanji() {
        let tokenizer = tokenizer_from_zstd(&tiny_dictionary_zstd())
            .expect("zstd dictionary should initialize");
        assert_eq!(reading_for_azookey(&tokenizer, "きょうははれ"), "きょうははれ");
        assert_eq!(reading_for_azookey(&tokenizer, "東京都に京都"), "とうきょうとにきょうと");
    }
}
