use crate::prompt::CandidatePrompt;
use caption_bridge_input_lm::tokenizer::{unicode_to_byte, ZenzTokenizer};
use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};

/// Zenz tokenizer adapter that always prepends the reference BOS token.
#[derive(Debug, Clone)]
pub struct ZenzPromptTokenizer {
    tokenizer: ZenzTokenizer,
}

impl ZenzPromptTokenizer {
    pub fn from_dir(directory: &Path) -> Result<Self, PromptTokenizerError> {
        let tokenizer = ZenzTokenizer::from_dir(directory)
            .ok_or_else(|| PromptTokenizerError::InvalidAssets(directory.to_path_buf()))?;
        Ok(Self { tokenizer })
    }

    pub fn from_submodule() -> Result<Self, PromptTokenizerError> {
        let tokenizer = ZenzTokenizer::from_submodule()
            .ok_or(PromptTokenizerError::SubmoduleAssetsUnavailable)?;
        Ok(Self { tokenizer })
    }

    /// Encodes one complete prompt with `addBOS: true`, matching Zenzai.
    pub fn encode_prompt(&mut self, prompt: &str) -> Vec<usize> {
        let mut tokens = Vec::with_capacity(prompt.chars().count() + 1);
        tokens.push(self.tokenizer.start_token_id());
        tokens.extend(self.tokenizer.encode(prompt));
        tokens
    }

    pub fn encode_candidate_prompt(&mut self, prompt: CandidatePrompt<'_>) -> Vec<usize> {
        self.encode_prompt(&prompt.build())
    }

    /// Candidate output follows the prompt and must not receive a second BOS.
    pub fn encode_candidate(&mut self, candidate: &str) -> Vec<usize> {
        self.tokenizer.encode(candidate)
    }

    pub fn vocab_size(&self) -> usize {
        self.tokenizer.vocab_size()
    }

    pub fn bos_token_id(&self) -> usize {
        self.tokenizer.start_token_id()
    }

    pub fn eos_token_id(&self) -> usize {
        self.tokenizer.end_token_id()
    }

    /// Raw UTF-8 piece bytes for a token, including partial marker bytes.
    ///
    /// Returning bytes rather than `String` is required for prefix constraints:
    /// byte-level BPE tokens such as the first token of an EE marker are not
    /// individually valid UTF-8.
    // Only the embedded verifier compares these against the GGUF's own
    // vocabulary, so the tables are not reachable without Candle.
    #[cfg(feature = "candle")]
    pub(crate) fn tables(&self) -> &caption_bridge_input_lm::tokenizer::BpeTables {
        self.tokenizer.tables()
    }

    pub fn token_bytes(&self, token_id: usize) -> Option<Vec<u8>> {
        self.tokenizer
            .tables()
            .id_to_token
            .get(token_id)
            .map(|token| token.chars().filter_map(unicode_to_byte).collect())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptTokenizerError {
    InvalidAssets(PathBuf),
    SubmoduleAssetsUnavailable,
}

impl fmt::Display for PromptTokenizerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidAssets(path) => {
                write!(formatter, "invalid Zenz tokenizer assets at {}", path.display())
            }
            Self::SubmoduleAssetsUnavailable => {
                formatter.write_str("vendored Zenz tokenizer assets are unavailable")
            }
        }
    }
}

impl Error for PromptTokenizerError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt::{
        build_candidate_prompt, INPUT_TAG, LEFT_CONTEXT_TAG, OUTPUT_TAG, RIGHT_CONTEXT_TAG,
    };

    #[test]
    fn prompt_has_bos_and_measured_private_use_token_ids() {
        let Ok(mut tokenizer) = ZenzPromptTokenizer::from_submodule() else {
            eprintln!("skipping: submodule tokenizer assets not present");
            return;
        };
        assert_eq!(tokenizer.bos_token_id(), 2);
        assert_eq!(tokenizer.vocab_size(), 6000);
        assert_eq!(tokenizer.encode_prompt(""), vec![2]);
        assert_eq!(
            tokenizer.encode_prompt(&build_candidate_prompt("", "", "")),
            vec![2, 172, 120, 202, 172, 120, 203],
            "no-context v3 must contain only BOS, EE00, and EE01"
        );

        let measured = [
            (INPUT_TAG, vec![172, 120, 202]),
            (OUTPUT_TAG, vec![172, 120, 203]),
            (LEFT_CONTEXT_TAG, vec![172, 120, 204]),
            (RIGHT_CONTEXT_TAG, vec![172, 120, 209]),
        ];
        for (tag, expected) in measured {
            let encoded = tokenizer.encode_candidate(&tag.to_string());
            assert_eq!(encoded, expected, "unexpected encoding for U+{:04X}", u32::from(tag));
        }
    }

    #[test]
    fn prompt_and_candidate_have_exactly_one_bos() {
        let Ok(mut tokenizer) = ZenzPromptTokenizer::from_submodule() else {
            eprintln!("skipping: submodule tokenizer assets not present");
            return;
        };
        let prompt = build_candidate_prompt("前", "後", "かな");
        let prompt_tokens = tokenizer.encode_prompt(&prompt);
        let candidate_tokens = tokenizer.encode_candidate("仮名");
        assert_eq!(prompt_tokens.first(), Some(&2));
        assert_ne!(candidate_tokens.first(), Some(&2));
    }
}
