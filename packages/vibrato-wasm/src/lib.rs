use std::io::Read;

use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Debug, Serialize)]
pub struct Token {
    /// 表層形。
    pub surface: String,
    /// 品詞情報 (CSV形式、辞書依存)。
    pub feature: String,
}

fn tokenizer_from_zstd(dict_zstd: &[u8]) -> Result<vibrato::Tokenizer, String> {
    let mut decoder = ruzstd::StreamingDecoder::new(dict_zstd)
        .map_err(|error| format!("zstd decode error: {error}"))?;
    let mut dictionary = Vec::new();
    decoder.read_to_end(&mut dictionary).map_err(|error| format!("zstd read error: {error}"))?;
    let dictionary = vibrato::Dictionary::read(dictionary.as_slice())
        .map_err(|error| format!("dictionary read error: {error}"))?;
    Ok(vibrato::Tokenizer::new(dictionary))
}

fn tokenize_with_tokenizer(tokenizer: &vibrato::Tokenizer, text: &str) -> Vec<Token> {
    let mut worker = tokenizer.new_worker();
    worker.reset_sentence(text);
    worker.tokenize();
    worker
        .token_iter()
        .map(|token| Token {
            surface: token.surface().to_string(),
            feature: token.feature().to_string(),
        })
        .collect()
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

fn is_kanji(character: char) -> bool {
    let code = character as u32;
    (0x3400..=0x4dbf).contains(&code)
        || (0x4e00..=0x9fff).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
}

fn contains_kanji(text: &str) -> bool {
    text.chars().any(is_kanji)
}

/// Desktop `reading_for_azookey`: skip IPADIC when the surface has no kanji.
fn reading_for_azookey(tokenizer: &vibrato::Tokenizer, text: &str, feature_index: usize) -> String {
    if !contains_kanji(text) {
        return text.to_string();
    }
    hiragana_with_feature_index(tokenizer, text, feature_index)
}

fn hiragana_with_feature_index(
    tokenizer: &vibrato::Tokenizer,
    text: &str,
    feature_index: usize,
) -> String {
    let mut worker = tokenizer.new_worker();
    worker.reset_sentence(text);
    worker.tokenize();
    worker
        .token_iter()
        .map(|token| {
            token
                .feature()
                .split(',')
                .nth(feature_index)
                .filter(|reading| !reading.is_empty() && *reading != "*")
                .map(katakana_to_hiragana)
                .unwrap_or_else(|| token.surface().to_string())
        })
        .collect()
}

#[wasm_bindgen]
pub struct VibratoTokenizer {
    tokenizer: vibrato::Tokenizer,
}

#[wasm_bindgen]
impl VibratoTokenizer {
    /// zstd 圧縮された Vibrato 辞書から Tokenizer を初期化する。
    #[wasm_bindgen(constructor)]
    pub fn new(dict_zstd: &[u8]) -> Result<VibratoTokenizer, JsError> {
        tokenizer_from_zstd(dict_zstd)
            .map(|tokenizer| Self { tokenizer })
            .map_err(|error| JsError::new(&error))
    }

    /// テキストを形態素解析し、surface/feature の配列を返す。
    pub fn tokenize(&self, text: &str) -> Result<JsValue, JsError> {
        let tokens = tokenize_with_tokenizer(&self.tokenizer, text);
        serde_wasm_bindgen::to_value(&tokens)
            .map_err(|error| JsError::new(&format!("serialization error: {error}")))
    }

    /// Convert token readings to hiragana using a dictionary feature index.
    /// UniDic CWJ uses 20 (`kana`); IPADIC uses 7 (`reading`).
    #[wasm_bindgen(js_name = toHiragana)]
    pub fn to_hiragana(&self, text: &str, feature_index: usize) -> String {
        reading_for_azookey(&self.tokenizer, text, feature_index)
    }
}

#[cfg(test)]
mod tests {
    use super::tokenizer_from_zstd;
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
    fn zstd_dictionary_tokenizes_arbitrary_text_without_phrase_lookup() {
        let tokenizer = tokenizer_from_zstd(&tiny_dictionary_zstd())
            .expect("zstd dictionary should initialize");
        let mut worker = tokenizer.new_worker();
        worker.reset_sentence("東京都に京都");
        worker.tokenize();
        let surfaces = worker.token_iter().map(|token| token.surface()).collect::<Vec<_>>();
        assert_eq!(surfaces, ["東京都", "に", "京都"]);
    }

    #[test]
    fn reading_conversion_uses_feature_index_and_preserves_unknown_tokens() {
        let tokenizer = tokenizer_from_zstd(&tiny_dictionary_zstd())
            .expect("zstd dictionary should initialize");
        assert_eq!(
            super::hiragana_with_feature_index(&tokenizer, "東京都に京都", 7),
            "とうきょうとにきょうと"
        );
    }

    #[test]
    fn reading_for_azookey_passthrough_when_no_kanji() {
        let tokenizer = tokenizer_from_zstd(&tiny_dictionary_zstd())
            .expect("zstd dictionary should initialize");
        assert_eq!(super::reading_for_azookey(&tokenizer, "きょうははれ", 7), "きょうははれ");
        assert_eq!(
            super::reading_for_azookey(&tokenizer, "東京都に京都", 7),
            "とうきょうとにきょうと"
        );
        assert!(super::contains_kanji("きょうは晴れ"));
        assert!(!super::contains_kanji("きょうははれ"));
    }
}
