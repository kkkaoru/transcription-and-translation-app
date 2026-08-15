use crate::{CandidatePrompt, PromptTokenizerError, ZenzForwardModel, ZenzPromptTokenizer};
use candle_core::{Device, IndexOp};
use caption_bridge_azookey_rust::{
    Draft, DraftVerifier, SessionContext, Utf8BytePrefixConstraint, VerificationCacheKey,
    VerificationResult, VerificationState, VerifierCapabilities, VerifierError, VerifierSession,
};
use std::collections::HashSet;
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_CANDIDATES: usize = 1;
const TOKENIZER_FNV_OFFSET: u64 = 0xcbf29ce484222325;
const TOKENIZER_FNV_PRIME: u64 = 0x100000001b3;

/// Eagerly loaded Candle implementation of AzooKey's verifier contract.
///
/// Activation policy intentionally lives above this type. If a caller opens a
/// session, this verifier evaluates it regardless of context length or whether
/// left context is present.
pub struct EmbeddedZenzDraftVerifier {
    model: ZenzForwardModel,
    tokenizer: ZenzPromptTokenizer,
    capabilities: VerifierCapabilities,
    open_sessions: HashSet<u64>,
    next_session_id: u64,
    load_elapsed: Duration,
}

impl EmbeddedZenzDraftVerifier {
    pub fn load(
        model_path: &Path,
        tokenizer_directory: &Path,
        model_revision: impl Into<String>,
        device: &Device,
    ) -> Result<Self, EmbeddedVerifierLoadError> {
        let load_started = Instant::now();
        let model_revision = model_revision.into();
        if model_revision.trim().is_empty() {
            return Err(EmbeddedVerifierLoadError::InvalidRevision(
                "model revision must not be empty".to_string(),
            ));
        }
        let tokenizer_revision = tokenizer_revision(tokenizer_directory)?;
        let tokenizer = ZenzPromptTokenizer::from_dir(tokenizer_directory)?;
        let model = ZenzForwardModel::load(model_path, device)?;
        Ok(Self {
            model,
            tokenizer,
            capabilities: VerifierCapabilities {
                prefix_constraints: true,
                session_kv: false,
                right_context: true,
                max_candidates: MAX_CANDIDATES,
                model_revision,
                tokenizer_revision,
            },
            open_sessions: HashSet::new(),
            next_session_id: 1,
            load_elapsed: load_started.elapsed(),
        })
    }

    pub fn model(&self) -> &ZenzForwardModel {
        &self.model
    }

    /// Wall-clock time spent validating tokenizer assets and loading GGUF.
    /// Callers should record this separately from per-conversion latency.
    pub fn load_elapsed(&self) -> Duration {
        self.load_elapsed
    }

    fn ensure_open(&self, session: &VerifierSession) -> Result<(), VerifierError> {
        if self.open_sessions.contains(&session.session_id) {
            Ok(())
        } else {
            Err(VerifierError::SessionClosed)
        }
    }

    fn candidate_token_pieces(
        &self,
        candidate_tokens: &[usize],
    ) -> Result<Vec<Vec<u8>>, VerifierError> {
        candidate_tokens
            .iter()
            .map(|token| {
                self.tokenizer.token_bytes(*token).ok_or_else(|| {
                    VerifierError::InvalidDraft(format!("candidate token {token} is out of range"))
                })
            })
            .collect()
    }
}

impl DraftVerifier for EmbeddedZenzDraftVerifier {
    fn capabilities(&self) -> VerifierCapabilities {
        self.capabilities.clone()
    }

    fn open_session(&mut self, context: SessionContext) -> Result<VerifierSession, VerifierError> {
        CandidatePrompt::try_from(&context)
            .map_err(|error| VerifierError::InvalidDraft(error.to_string()))?;
        if context.inference_config_revision.trim().is_empty() {
            return Err(VerifierError::InvalidDraft(
                "inference config revision must not be empty".to_string(),
            ));
        }
        let session_id = self.next_session_id;
        self.next_session_id = self.next_session_id.checked_add(1).ok_or_else(|| {
            VerifierError::Backend("embedded verifier exhausted session identifiers".to_string())
        })?;
        self.open_sessions.insert(session_id);
        Ok(VerifierSession {
            session_id,
            context,
            model_revision: self.capabilities.model_revision.clone(),
            tokenizer_revision: self.capabilities.tokenizer_revision.clone(),
            kv_reusable: false,
        })
    }

    fn evaluate(
        &mut self,
        session: &mut VerifierSession,
        draft: &Draft,
    ) -> Result<VerificationResult, VerifierError> {
        self.ensure_open(session)?;
        let cache_key = VerificationCacheKey::for_draft(session, draft);
        if draft.candidate_path.text.is_empty() {
            return Err(VerifierError::InvalidDraft("candidate text is empty".to_string()));
        }
        let prompt = CandidatePrompt::try_from(&session.context)
            .map_err(|error| VerifierError::InvalidDraft(error.to_string()))?;
        let prompt_input = to_katakana(prompt.input);
        let mut evaluation_tokens = self
            .tokenizer
            .encode_candidate_prompt(CandidatePrompt {
                left_context: prompt.left_context,
                right_context: prompt.right_context,
                input: &prompt_input,
            })
            .into_iter()
            .map(token_to_u32)
            .collect::<Result<Vec<_>, _>>()?;
        let prompt_length = evaluation_tokens.len();
        let candidate_tokens = self.tokenizer.encode_candidate(&draft.candidate_path.text);
        if candidate_tokens.is_empty() {
            return Err(VerifierError::InvalidDraft(
                "candidate did not produce any tokens".to_string(),
            ));
        }
        let candidate_pieces = self.candidate_token_pieces(&candidate_tokens)?;
        let reconstructed = candidate_pieces.concat();
        if reconstructed != draft.candidate_path.text.as_bytes() {
            return Err(VerifierError::InvalidDraft(
                "candidate tokenizer pieces did not reconstruct the candidate UTF-8".to_string(),
            ));
        }
        evaluation_tokens.extend(
            candidate_tokens.iter().copied().map(token_to_u32).collect::<Result<Vec<_>, _>>()?,
        );
        let logits = self
            .model
            .forward(&evaluation_tokens)
            .map_err(|error| VerifierError::Backend(error.to_string()))?;
        let addressed_count = addressed_candidate_tokens(&candidate_pieces, &draft.constraints);
        for offset in addressed_count..candidate_tokens.len() {
            let row = logits
                .i(prompt_length + offset - 1)
                .and_then(|row| row.to_vec1::<f32>())
                .map_err(|error| VerifierError::Backend(error.to_string()))?;
            let predicted = row
                .iter()
                .copied()
                .enumerate()
                .max_by(|left, right| left.1.total_cmp(&right.1))
                .map(|(token, _)| token)
                .ok_or_else(|| VerifierError::Backend("model returned empty logits".to_string()))?;
            if predicted != candidate_tokens[offset] {
                let mut prefix = candidate_pieces[..offset].concat();
                let predicted_piece = self.tokenizer.token_bytes(predicted).ok_or_else(|| {
                    VerifierError::Backend(format!("predicted token {predicted} is out of range"))
                })?;
                prefix.extend_from_slice(&predicted_piece);
                return Ok(VerificationResult {
                    state: VerificationState::PrefixConstraintReturned,
                    candidate_path: draft.candidate_path.clone(),
                    prefix_constraint: Some(Utf8BytePrefixConstraint::output_prefix(prefix)),
                    cache_key,
                });
            }
        }
        Ok(VerificationResult {
            state: VerificationState::Verified,
            candidate_path: draft.candidate_path.clone(),
            prefix_constraint: None,
            cache_key,
        })
    }

    fn close_session(&mut self, session: VerifierSession) -> Result<(), VerifierError> {
        if self.open_sessions.remove(&session.session_id) {
            Ok(())
        } else {
            Err(VerifierError::SessionClosed)
        }
    }
}

fn token_to_u32(token: usize) -> Result<u32, VerifierError> {
    u32::try_from(token)
        .map_err(|_| VerifierError::InvalidDraft(format!("token {token} exceeds u32")))
}

fn addressed_candidate_tokens(
    candidate_pieces: &[Vec<u8>],
    constraints: &[Utf8BytePrefixConstraint],
) -> usize {
    let output_prefixes = constraints
        .iter()
        .filter(|constraint| constraint.scalar_position == usize::MAX)
        .map(|constraint| constraint.prefix.as_slice())
        .collect::<Vec<_>>();
    let mut candidate_prefix = Vec::new();
    let mut addressed = 0;
    for piece in candidate_pieces {
        candidate_prefix.extend_from_slice(piece);
        if output_prefixes.iter().any(|constraint| constraint.starts_with(&candidate_prefix)) {
            addressed += 1;
        } else {
            break;
        }
    }
    addressed
}

fn to_katakana(input: &str) -> String {
    input
        .chars()
        .map(|character| match character {
            '\u{3041}'..='\u{3096}' => {
                char::from_u32(u32::from(character) + 0x60).unwrap_or(character)
            }
            _ => character,
        })
        .collect()
}

fn tokenizer_revision(directory: &Path) -> Result<String, EmbeddedVerifierLoadError> {
    let mut hash = TOKENIZER_FNV_OFFSET;
    for name in ["vocab.json", "merges.txt"] {
        let bytes = fs::read(directory.join(name))?;
        for byte in bytes.into_iter().chain(std::iter::once(0xff)) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(TOKENIZER_FNV_PRIME);
        }
    }
    Ok(format!("gpt2-small-japanese-char-fnv1a64-{hash:016x}"))
}

#[derive(Debug)]
pub enum EmbeddedVerifierLoadError {
    Io(std::io::Error),
    Tokenizer(PromptTokenizerError),
    Model(crate::gguf::GgufLoadError),
    InvalidRevision(String),
}

impl fmt::Display for EmbeddedVerifierLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "tokenizer asset I/O error: {error}"),
            Self::Tokenizer(error) => write!(formatter, "tokenizer load error: {error}"),
            Self::Model(error) => write!(formatter, "model load error: {error}"),
            Self::InvalidRevision(message) => formatter.write_str(message),
        }
    }
}

impl Error for EmbeddedVerifierLoadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Tokenizer(error) => Some(error),
            Self::Model(error) => Some(error),
            Self::InvalidRevision(_) => None,
        }
    }
}

impl From<std::io::Error> for EmbeddedVerifierLoadError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<PromptTokenizerError> for EmbeddedVerifierLoadError {
    fn from(error: PromptTokenizerError) -> Self {
        Self::Tokenizer(error)
    }
}

impl From<crate::gguf::GgufLoadError> for EmbeddedVerifierLoadError {
    fn from(error: crate::gguf::GgufLoadError) -> Self {
        Self::Model(error)
    }
}

#[cfg(test)]
mod tests {
    use super::{addressed_candidate_tokens, to_katakana};
    use caption_bridge_azookey_rust::Utf8BytePrefixConstraint;

    #[test]
    fn hiragana_input_is_normalized_before_prompt_encoding() {
        assert_eq!(to_katakana("とうきょうABC"), "トウキョウABC");
    }

    #[test]
    fn only_complete_candidate_tokens_covered_by_output_constraints_are_addressed() {
        let pieces = vec!["東".as_bytes().to_vec(), "京".as_bytes().to_vec()];
        let constraint = Utf8BytePrefixConstraint::output_prefix("東京".as_bytes());
        assert_eq!(addressed_candidate_tokens(&pieces, &[constraint]), 2);
        let partial = Utf8BytePrefixConstraint::output_prefix("東".as_bytes());
        assert_eq!(addressed_candidate_tokens(&pieces, &[partial]), 1);
        let edge_constraint = Utf8BytePrefixConstraint::from_surface(0, "東京");
        assert_eq!(addressed_candidate_tokens(&pieces, &[edge_constraint]), 0);
    }
}
