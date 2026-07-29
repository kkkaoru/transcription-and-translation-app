use serde::{Deserialize, Serialize};

/// Controls the `text` field returned by the streaming recognition protocol.
///
/// `Hiragana` keeps the original ASR text in `source_text` and emits a
/// kana reading in `text` whenever UniDic has a surface-form reading. Unknown
/// tokens are preserved unchanged so no recognized content is discarded.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StreamingRecognitionTextFormat {
    Surface,
    #[default]
    Hiragana,
}
