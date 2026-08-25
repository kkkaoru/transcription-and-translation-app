use std::{collections::HashMap, fs, path::Path};

use anyhow::{Context, Result, anyhow};
use ort::{inputs, session::Session, value::TensorRef};
use tokenizers::Tokenizer;

use crate::model::onnx_runtime::init_onnx_runtime;

const MODEL_FILE: &str = "model_quant.onnx";
const VOCAB_FILE: &str = "vocab.txt";
const TOKENIZER_FILE: &str = "tokenizer.json";
const MAX_SEQUENCE_LEN: usize = 512;

#[derive(Clone, Copy)]
pub enum NamoTokenizerKind {
    Character,
    TokenizerJson,
}

pub struct NamoTurnDetectorEngine {
    session: Session,
    tokenizer: NamoTokenizer,
    pad_id: i64,
    token_ids: Vec<i64>,
    attention_mask: Vec<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NamoTurnDecision {
    pub is_end_of_turn: bool,
    pub confidence: f32,
}

impl NamoTurnDetectorEngine {
    pub fn new(model_dir: &Path, tokenizer_kind: NamoTokenizerKind) -> Result<Self> {
        init_onnx_runtime()?;

        let model_path = model_dir.join(MODEL_FILE);
        if !model_path.is_file() {
            return Err(anyhow!("Namo turn detector model not found: {}", model_path.display()));
        }

        let tokenizer = match tokenizer_kind {
            NamoTokenizerKind::Character => {
                NamoTokenizer::Character(read_character_tokenizer(&model_dir.join(VOCAB_FILE))?)
            }
            NamoTokenizerKind::TokenizerJson => {
                let tokenizer_path = model_dir.join(TOKENIZER_FILE);
                let tokenizer = context_display(
                    Tokenizer::from_file(&tokenizer_path),
                    format!("Failed to load Namo tokenizer {}", tokenizer_path.display()),
                )?;
                NamoTokenizer::TokenizerJson(Box::new(tokenizer))
            }
        };
        let pad_id = tokenizer.pad_id();
        let builder = context_display(Session::builder(), "Failed to create Namo session builder")?;
        let mut builder =
            context_display(builder.with_intra_threads(1), "Failed to configure Namo session")?;
        let session = context_display(
            builder.commit_from_file(&model_path),
            format!("Failed to load Namo model {}", model_path.display()),
        )?;

        Ok(Self {
            session,
            tokenizer,
            pad_id,
            token_ids: Vec::with_capacity(MAX_SEQUENCE_LEN),
            attention_mask: Vec::with_capacity(MAX_SEQUENCE_LEN),
        })
    }

    pub fn decide(&mut self, text: &str, max_context_tokens: u32) -> Result<NamoTurnDecision> {
        prepare_inputs(
            &self.tokenizer,
            text,
            max_context_tokens,
            self.pad_id,
            &mut self.token_ids,
            &mut self.attention_mask,
        )?;
        let sequence_len = self.token_ids.len();
        let input_ids =
            TensorRef::from_array_view(([1_usize, sequence_len], self.token_ids.as_slice()))?;
        let attention_mask =
            TensorRef::from_array_view(([1_usize, sequence_len], self.attention_mask.as_slice()))?;
        let outputs = self.session.run(inputs![
            "input_ids" => input_ids,
            "attention_mask" => attention_mask,
        ])?;

        let (_, logits) = outputs[0].try_extract_tensor::<f32>()?;
        let [not_end, end, ..] = logits else {
            return Err(anyhow!("Namo output did not contain two logits"));
        };
        let end_probability = softmax_second(*not_end, *end);
        Ok(NamoTurnDecision { is_end_of_turn: end_probability >= 0.5, confidence: end_probability })
    }
}

fn context_display<T, E: std::fmt::Display>(
    result: std::result::Result<T, E>,
    context: impl std::fmt::Display,
) -> Result<T> {
    result.map_err(|err| anyhow!("{context}: {err}"))
}

struct CharacterTokenizer {
    vocab: HashMap<char, i64>,
    cls_id: i64,
    sep_id: i64,
    unk_id: i64,
    pad_id: i64,
}

enum NamoTokenizer {
    Character(CharacterTokenizer),
    TokenizerJson(Box<Tokenizer>),
}

impl NamoTokenizer {
    fn pad_id(&self) -> i64 {
        match self {
            Self::Character(tokenizer) => tokenizer.pad_id,
            Self::TokenizerJson(tokenizer) => {
                tokenizer.get_vocab(true).get("[PAD]").copied().map_or(0, i64::from)
            }
        }
    }

    fn tokenize_into(&self, text: &str, token_ids: &mut Vec<i64>) -> Result<()> {
        token_ids.clear();
        match self {
            Self::Character(tokenizer) => {
                tokenizer.tokenize_into(text, token_ids);
                Ok(())
            }
            Self::TokenizerJson(tokenizer) => tokenizer
                .encode(text, true)
                .map(|encoding| {
                    token_ids.extend(encoding.get_ids().iter().map(|id| i64::from(*id)));
                })
                .map_err(|err| anyhow!("Failed to tokenize text for Namo: {err}")),
        }
    }
}

impl CharacterTokenizer {
    fn tokenize_into(&self, text: &str, token_ids: &mut Vec<i64>) {
        token_ids.push(self.cls_id);
        token_ids.extend(
            text.chars()
                .filter(|character| !character.is_whitespace())
                .map(|character| *self.vocab.get(&character).unwrap_or(&self.unk_id)),
        );
        token_ids.push(self.sep_id);
    }
}

fn prepare_inputs(
    tokenizer: &NamoTokenizer,
    text: &str,
    max_context_tokens: u32,
    pad_id: i64,
    token_ids: &mut Vec<i64>,
    attention_mask: &mut Vec<i64>,
) -> Result<()> {
    tokenizer.tokenize_into(text, token_ids)?;
    trim_to_context(token_ids, max_context_tokens);
    token_ids.truncate(MAX_SEQUENCE_LEN);
    let visible_len = token_ids.len();
    attention_mask.clear();
    attention_mask.resize(visible_len, 1);
    token_ids.resize(MAX_SEQUENCE_LEN, pad_id);
    attention_mask.resize(MAX_SEQUENCE_LEN, 0);
    Ok(())
}

fn trim_to_context(token_ids: &mut Vec<i64>, max_context_tokens: u32) {
    if token_ids.len() <= 2 {
        return;
    }
    let leading_special_tokens = 1;
    let trailing_special_tokens = 1;
    let payload_start = leading_special_tokens;
    let payload_end = token_ids.len().saturating_sub(trailing_special_tokens);
    let payload_len = payload_end.saturating_sub(payload_start);
    if payload_len == 0 {
        return;
    }
    let max_payload_len =
        MAX_SEQUENCE_LEN.saturating_sub(leading_special_tokens + trailing_special_tokens);
    let effective_cap = if max_context_tokens > 0 {
        max_payload_len.min(usize::try_from(max_context_tokens).unwrap_or(MAX_SEQUENCE_LEN))
    } else {
        max_payload_len
    };
    if payload_len > effective_cap {
        token_ids.drain(payload_start..payload_end - effective_cap);
    }
}

fn read_character_tokenizer(path: &Path) -> Result<CharacterTokenizer> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("Failed to read Namo vocab: {}", path.display()))?;
    Ok(character_tokenizer_from_vocab(&content))
}

fn character_tokenizer_from_vocab(content: &str) -> CharacterTokenizer {
    let mut vocab = HashMap::new();
    let mut cls_id = 101;
    let mut sep_id = 102;
    let mut unk_id = 100;
    let mut pad_id = 0;
    for (index, token) in content.lines().enumerate() {
        let token_id = i64::try_from(index).expect("vocab index fits in i64");
        match token {
            "[CLS]" => cls_id = token_id,
            "[SEP]" => sep_id = token_id,
            "[UNK]" => unk_id = token_id,
            "[PAD]" => pad_id = token_id,
            _ => {
                let mut characters = token.chars();
                if let (Some(character), None) = (characters.next(), characters.next()) {
                    vocab.insert(character, token_id);
                }
            }
        }
    }
    CharacterTokenizer { vocab, cls_id, sep_id, unk_id, pad_id }
}

fn softmax_second(first: f32, second: f32) -> f32 {
    let max = first.max(second);
    let first_exp = (first - max).exp();
    let second_exp = (second - max).exp();
    second_exp / (first_exp + second_exp)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{
        CharacterTokenizer, NamoTokenizer, character_tokenizer_from_vocab, prepare_inputs,
        softmax_second,
    };

    #[test]
    fn character_vocab_keeps_scalar_tokens_and_special_ids_without_strings() {
        let tokenizer =
            character_tokenizer_from_vocab("[PAD]\nunused\n[UNK]\n聞\n[CLS]\n[SEP]\n複数文字\n");
        let mut token_ids = Vec::new();

        tokenizer.tokenize_into("聞 未", &mut token_ids);

        assert_eq!(token_ids, vec![4, 3, 2, 5]);
        assert_eq!(tokenizer.pad_id, 0);
        assert_eq!(tokenizer.vocab, HashMap::from([('聞', 3)]));
    }

    #[test]
    fn namo_inputs_reuse_buffers_with_the_model_required_padding_mask() {
        let tokenizer = NamoTokenizer::Character(CharacterTokenizer {
            vocab: HashMap::from([('聞', 10), ('こ', 11)]),
            cls_id: 101,
            sep_id: 102,
            unk_id: 100,
            pad_id: 0,
        });
        let mut token_ids = Vec::with_capacity(512);
        let mut attention_mask = Vec::with_capacity(512);

        prepare_inputs(&tokenizer, "聞 こえますか", 3, 0, &mut token_ids, &mut attention_mask)
            .unwrap();

        assert_eq!(&token_ids[..5], &[101, 100, 100, 100, 102]);
        assert!(token_ids[5..].iter().all(|token| *token == 0));
        assert_eq!(&attention_mask[..5], &[1, 1, 1, 1, 1]);
        assert!(attention_mask[5..].iter().all(|value| *value == 0));
        assert_eq!(token_ids.capacity(), 512);
        assert_eq!(attention_mask.capacity(), 512);
    }

    #[test]
    fn softmax_second_returns_probability() {
        let probability = softmax_second(0.0, 1.0);

        assert!((0.73..=0.74).contains(&probability));
    }
}
