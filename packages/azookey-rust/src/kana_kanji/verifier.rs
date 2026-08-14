use crate::viterbi::{CandidatePath, Utf8BytePrefixConstraint};
use std::error::Error;
use std::fmt;

/// Capabilities exposed by a verifier backend. A caller must inspect these
/// flags before choosing a verification strategy; unsupported features are
/// represented explicitly instead of silently falling back to baseline text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifierCapabilities {
    pub prefix_constraints: bool,
    pub session_kv: bool,
    pub right_context: bool,
    pub max_candidates: usize,
    pub model_revision: String,
    pub tokenizer_revision: String,
}

impl Default for VerifierCapabilities {
    fn default() -> Self {
        Self {
            prefix_constraints: false,
            session_kv: false,
            right_context: false,
            max_candidates: 0,
            model_revision: String::new(),
            tokenizer_revision: String::new(),
        }
    }
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
}

impl SessionContext {
    pub fn new(input_prefix: impl AsRef<[u8]>, dictionary_revision: u64) -> Self {
        Self {
            input_prefix: input_prefix.as_ref().to_vec(),
            left_context: None,
            right_context: None,
            dictionary_revision,
            protocol_version: 1,
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
/// lattice caller to re-search and submit a new draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerificationState {
    Verified,
    PrefixConstraintReturned,
    Exhausted,
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

/// Cache identity for one candidate verification. It includes both model
/// layers, the complete session input/context, candidate-path/constraint
/// hashes, dictionary revision, and protocol version.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VerificationCacheKey {
    pub model_revision: String,
    pub tokenizer_revision: String,
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
