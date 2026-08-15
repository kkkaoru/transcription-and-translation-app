use crate::viterbi::{CandidatePath, PrecedingContext, Utf8BytePrefixConstraint};
use std::error::Error;
use std::fmt;

/// Capabilities exposed by a verifier backend. A caller must inspect these
/// flags before choosing a verification strategy; unsupported features are
/// represented explicitly instead of silently falling back to baseline text.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VerifierCapabilities {
    pub prefix_constraints: bool,
    pub session_kv: bool,
    pub right_context: bool,
    pub max_candidates: usize,
    pub model_revision: String,
    pub tokenizer_revision: String,
}

/// Input/context identity for one conversion session. The byte representation
/// is intentional: it is stable across Rust, HTTP, and embedded backends and
/// cannot accidentally mix normalized scalar offsets with wire bytes.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionContext {
    pub input_prefix: Vec<u8>,
    pub left_context: Option<Vec<u8>>,
    pub right_context: Option<Vec<u8>>,
    pub dictionary_revision: u64,
    pub protocol_version: u16,
    /// Canonical backend sampling/inference settings identity. Backends must
    /// encode temperature, top-p, max tokens, seed, and equivalent settings
    /// into this single revision before opening a session. Omitting a setting
    /// from the folded revision lets the cache serve results from old
    /// inference settings, so an empty revision is accepted but discouraged.
    pub inference_config_revision: String,
}

impl SessionContext {
    pub fn new(
        input_prefix: impl AsRef<[u8]>,
        dictionary_revision: u64,
        inference_config_revision: impl Into<String>,
    ) -> Self {
        Self {
            input_prefix: input_prefix.as_ref().to_vec(),
            left_context: None,
            right_context: None,
            dictionary_revision,
            protocol_version: 1,
            inference_config_revision: inference_config_revision.into(),
        }
    }
}

/// Opaque-but-inspectable session identity returned by `open_session`.
/// `model_revision` and `tokenizer_revision` are copied from capabilities so a
/// cache entry cannot cross model/tokenizer generations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifierSession {
    pub session_id: u64,
    pub context: SessionContext,
    pub model_revision: String,
    pub tokenizer_revision: String,
    pub kv_reusable: bool,
}

/// A draft presented to a verifier backend. The backend may return the first
/// byte-prefix constraint that disagrees with the draft; the caller then feeds
/// that constraint into `ConversionLattice::search`.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub prompt: Vec<u8>,
    pub candidate_path: CandidatePath,
    pub constraints: Vec<Utf8BytePrefixConstraint>,
}

impl Draft {
    pub fn new(prompt: impl AsRef<[u8]>, candidate_path: CandidatePath) -> Self {
        Self { prompt: prompt.as_ref().to_vec(), candidate_path, constraints: Vec::new() }
    }
}

/// Result state deliberately separates successful verification from every
/// degradation mode. `PrefixConstraintReturned` is not a failure: it asks the
/// lattice caller to re-search and submit a new draft. The two
/// `ExhaustedWith*` states identify which candidate source was returned when
/// the conversion-side iteration limit was reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerificationState {
    Verified,
    PrefixConstraintReturned,
    Exhausted,
    /// The conversion iteration limit was reached after a constrained lattice
    /// candidate had been selected for return.
    ExhaustedWithConstrainedCandidate,
    /// The conversion iteration limit was reached without a usable
    /// constrained candidate, so the dictionary baseline was returned.
    ExhaustedWithDictionaryFallback,
    CapabilityUnavailable,
    Error,
    UnverifiedFallback,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerificationResult {
    pub state: VerificationState,
    pub candidate_path: CandidatePath,
    pub prefix_constraint: Option<Utf8BytePrefixConstraint>,
    pub cache_key: VerificationCacheKey,
}

/// Cache identity for one candidate verification. The included semantic
/// inputs are: model/tokenizer revisions; inference-config revision; prompt
/// bytes; session input bytes, left/right context, dictionary revision, and
/// protocol version; every `CandidatePath` field (`edge_handles`, `text`,
/// `score`, `trailing`); and every constraint field (`scalar_position`,
/// `prefix`).
///
/// `VerifierSession.session_id` and `kv_reusable` are intentionally excluded:
/// they describe a backend lifecycle/transport capability, not the semantic
/// request. Reusing either value in the key would prevent equivalent requests
/// from sharing a result without improving correctness.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VerificationCacheKey {
    pub model_revision: String,
    pub tokenizer_revision: String,
    pub inference_config_revision: String,
    pub prompt_hash: u64,
    pub input_bytes_hash: u64,
    pub left_context_hash: u64,
    pub right_context_hash: u64,
    pub dictionary_revision: u64,
    pub candidate_path_hash: u64,
    pub constraint_hash: u64,
    pub protocol_version: u16,
}

impl VerificationCacheKey {
    pub fn for_draft(session: &VerifierSession, draft: &Draft) -> Self {
        Self {
            model_revision: session.model_revision.clone(),
            tokenizer_revision: session.tokenizer_revision.clone(),
            inference_config_revision: session.context.inference_config_revision.clone(),
            prompt_hash: hash_bytes(&draft.prompt),
            input_bytes_hash: hash_bytes(&session.context.input_prefix),
            left_context_hash: hash_optional_bytes(session.context.left_context.as_deref()),
            right_context_hash: hash_optional_bytes(session.context.right_context.as_deref()),
            dictionary_revision: session.context.dictionary_revision,
            candidate_path_hash: hash_candidate_path(&draft.candidate_path),
            constraint_hash: hash_constraints(&draft.constraints),
            protocol_version: session.context.protocol_version,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifierError {
    SessionClosed,
    InvalidDraft(String),
    Backend(String),
}

impl fmt::Display for VerifierError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SessionClosed => formatter.write_str("verifier session is closed"),
            Self::InvalidDraft(message) => write!(formatter, "invalid verifier draft: {message}"),
            Self::Backend(message) => write!(formatter, "verifier backend error: {message}"),
        }
    }
}

impl Error for VerifierError {}

/// Backend-neutral sessionful verifier contract.
///
/// The implementor is the shared model handle. `open_session` establishes the
/// utterance/input-prefix and contexts; repeated `evaluate` calls may reuse
/// the backend KV cache when `capabilities().session_kv` is true. HTTP and
/// embedded implementations can therefore share this contract without
/// assuming llama.cpp, a particular tokenizer, or a platform accelerator.
pub trait DraftVerifier {
    fn capabilities(&self) -> VerifierCapabilities;

    fn open_session(&mut self, context: SessionContext) -> Result<VerifierSession, VerifierError>;

    fn evaluate(
        &mut self,
        session: &mut VerifierSession,
        draft: &Draft,
    ) -> Result<VerificationResult, VerifierError>;

    fn close_session(&mut self, session: VerifierSession) -> Result<(), VerifierError>;
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn hash_optional_bytes(bytes: Option<&[u8]>) -> u64 {
    match bytes {
        Some(bytes) => hash_bytes(bytes),
        None => hash_bytes(b"<none>"),
    }
}

fn hash_candidate_path(candidate: &CandidatePath) -> u64 {
    let mut bytes = Vec::new();
    for handle in &candidate.edge_handles {
        bytes.extend_from_slice(&handle.to_le_bytes());
    }
    bytes.extend_from_slice(candidate.text.as_bytes());
    bytes.extend_from_slice(&candidate.score.to_bits().to_le_bytes());
    // The trailing connection state affects the next lattice transition. Keep
    // an explicit Option discriminator so None cannot collide with Some(0, 0).
    match candidate.trailing {
        None => bytes.push(0),
        Some(PrecedingContext { rcid, mid }) => {
            bytes.push(1);
            bytes.extend_from_slice(&rcid.to_le_bytes());
            bytes.extend_from_slice(&mid.to_le_bytes());
        }
    }
    hash_bytes(&bytes)
}

fn hash_constraints(constraints: &[Utf8BytePrefixConstraint]) -> u64 {
    let mut bytes = Vec::new();
    for constraint in constraints {
        bytes.extend_from_slice(&constraint.scalar_position.to_le_bytes());
        bytes.extend_from_slice(&constraint.prefix);
        bytes.push(0xff);
    }
    hash_bytes(&bytes)
}

#[cfg(test)]
mod tests {
    use super::{Draft, SessionContext, VerificationCacheKey, VerifierSession};
    use crate::{CandidatePath, PrecedingContext, Utf8BytePrefixConstraint};

    #[test]
    fn cache_key_separates_prompt_and_constraint_revision_inputs() {
        let session = VerifierSession {
            session_id: 1,
            context: SessionContext::new("入力", 7, "default-test-v1"),
            model_revision: "model-a".to_string(),
            tokenizer_revision: "tokenizer-a".to_string(),
            kv_reusable: true,
        };
        let candidate = CandidatePath {
            edge_handles: vec![3],
            text: "漢字".to_string(),
            score: -1.0,
            trailing: None,
        };
        let first = Draft::new("prompt-a", candidate.clone());
        let second = Draft::new("prompt-b", candidate.clone());
        let first_key = VerificationCacheKey::for_draft(&session, &first);
        let second_key = VerificationCacheKey::for_draft(&session, &second);
        assert_ne!(first_key.prompt_hash, second_key.prompt_hash);

        let mut constrained = first.clone();
        constrained.constraints.push(Utf8BytePrefixConstraint::from_surface(0, "漢"));
        let constrained_key = VerificationCacheKey::for_draft(&session, &constrained);
        assert_ne!(first_key.constraint_hash, constrained_key.constraint_hash);

        let configured_session = VerifierSession {
            context: SessionContext::new("入力", 7, "temperature=0;top_p=1;max_tokens=64;seed=7"),
            ..session.clone()
        };
        let configured_key = VerificationCacheKey::for_draft(&configured_session, &first);
        assert_ne!(first_key.inference_config_revision, configured_key.inference_config_revision);

        let with_trailing = Draft::new(
            "prompt-a",
            CandidatePath {
                trailing: Some(PrecedingContext { rcid: 12, mid: 34 }),
                ..candidate.clone()
            },
        );
        let with_trailing_key = VerificationCacheKey::for_draft(&session, &with_trailing);
        assert_ne!(first_key.candidate_path_hash, with_trailing_key.candidate_path_hash);

        let with_zero_trailing = Draft::new(
            "prompt-a",
            CandidatePath {
                trailing: Some(PrecedingContext { rcid: 0, mid: 0 }),
                ..candidate.clone()
            },
        );
        let with_zero_trailing_key = VerificationCacheKey::for_draft(&session, &with_zero_trailing);
        assert_ne!(first_key.candidate_path_hash, with_zero_trailing_key.candidate_path_hash);

        let identical_key = VerificationCacheKey::for_draft(&session, &first);
        assert_eq!(first_key.candidate_path_hash, identical_key.candidate_path_hash);
    }
}
