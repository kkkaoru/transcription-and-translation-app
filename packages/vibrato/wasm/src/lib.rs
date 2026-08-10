use caption_bridge_vibrato_core::{
    reading_for_azookey_with_feature_index, sentence_end_offsets, soft_break_offsets, tokenize,
    tokenizer_from_zstd,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Debug, Serialize)]
pub struct Token {
    /// 表層形。
    pub surface: String,
    /// 品詞情報 (CSV形式、辞書依存)。
    pub feature: String,
}

fn tokenize_with_tokenizer(
    tokenizer: &caption_bridge_vibrato_core::Tokenizer,
    text: &str,
) -> Vec<Token> {
    tokenize(tokenizer, text)
        .into_iter()
        .map(|token| Token { surface: token.surface, feature: token.feature })
        .collect()
}

#[wasm_bindgen]
pub struct VibratoTokenizer {
    tokenizer: caption_bridge_vibrato_core::Tokenizer,
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
        reading_for_azookey_with_feature_index(&self.tokenizer, text, feature_index)
    }

    /// Exclusive Unicode-scalar sentence-end offsets (Tauri IPADIC POS ∪ heuristic).
    #[wasm_bindgen(js_name = sentenceEndOffsets)]
    pub fn sentence_end_offsets(&self, text: &str) -> Vec<u32> {
        sentence_end_offsets(&self.tokenizer, text)
            .into_iter()
            .map(|offset| offset as u32)
            .collect()
    }

    /// Mid-sentence POS wrap points for caption line breaks before maxChars.
    #[wasm_bindgen(js_name = softBreakOffsets)]
    pub fn soft_break_offsets(&self, text: &str) -> Vec<u32> {
        soft_break_offsets(&self.tokenizer, text)
            .into_iter()
            .map(|offset| offset as u32)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use caption_bridge_vibrato_core::{
        contains_kanji, hiragana_with_feature_index, reading_for_azookey_with_feature_index,
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
    fn zstd_dictionary_tokenizes_arbitrary_text_without_phrase_lookup() {
        let tokenizer = tokenizer_from_zstd(&tiny_dictionary_zstd())
            .expect("zstd dictionary should initialize");
        let tokens = super::tokenize_with_tokenizer(&tokenizer, "東京都に京都");
        let surfaces = tokens.iter().map(|token| token.surface.as_str()).collect::<Vec<_>>();
        assert_eq!(surfaces, ["東京都", "に", "京都"]);
    }

    #[test]
    fn reading_conversion_uses_feature_index_and_preserves_unknown_tokens() {
        let tokenizer = tokenizer_from_zstd(&tiny_dictionary_zstd())
            .expect("zstd dictionary should initialize");
        assert_eq!(
            hiragana_with_feature_index(&tokenizer, "東京都に京都", 7),
            "とうきょうとにきょうと"
        );
    }

    #[test]
    fn reading_for_azookey_passthrough_when_no_kanji() {
        let tokenizer = tokenizer_from_zstd(&tiny_dictionary_zstd())
            .expect("zstd dictionary should initialize");
        assert_eq!(
            reading_for_azookey_with_feature_index(&tokenizer, "きょうははれ", 7),
            "きょうははれ"
        );
        assert_eq!(
            reading_for_azookey_with_feature_index(&tokenizer, "東京都に京都", 7),
            "とうきょうとにきょうと"
        );
        assert!(contains_kanji("きょうは晴れ"));
        assert!(!contains_kanji("きょうははれ"));
    }
}
