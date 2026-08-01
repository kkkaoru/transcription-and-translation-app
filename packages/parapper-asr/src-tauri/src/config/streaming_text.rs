use serde::{Deserialize, Serialize};

/// Controls the `text` field returned by the streaming recognition protocol.
///
/// `Hiragana` keeps the original ASR surface in `source_text` and emits a
/// kana reading in `text` whenever `UniDic` has a surface-form reading. The
/// same reading is also exposed as `azookey_input_text` by the streaming sink;
/// consumers should not infer normalizer input from the display `text` field.
/// Unknown tokens are preserved unchanged so no recognized content is discarded.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StreamingRecognitionTextFormat {
    Surface,
    #[default]
    Hiragana,
}
